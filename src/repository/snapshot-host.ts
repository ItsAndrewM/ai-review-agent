import type { GitHubClient, RepoRef } from "../github/client.ts"
import { errorText, log, logError, type LogFields } from "../log.ts"
import type { SearchAccess } from "../review/tools.ts"
import { shortSha } from "../sha.ts"
import { SnapshotUnavailable, type SnapshotSource } from "./load-snapshot.ts"
import { GrepWork, MAX_SEARCH_CALLS } from "./search.ts"
import type { SnapshotFiles, SnapshotRecord } from "./snapshot.ts"

export interface SnapshotFailure {
  step: "tarball" | "tree" | "load"
  reason: string
}

export function snapshotSource(github: GitHubClient, ref: RepoRef): SnapshotSource {
  return {
    tarball: (sha) => github.downloadTarball(ref, sha),
    listing: (sha) => github.getTreeListing(ref, sha),
    blobs: (sha, paths) => github.getBlobTexts(ref, sha, paths),
  }
}

export function leftOutText(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).filter(([, count]) => count > 0)
  if (entries.length === 0) return "none"
  return entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(",")
}

export function loadedFields(number: number, record: SnapshotRecord, ms: number): LogFields {
  return {
    number,
    head: shortSha(record.sha),
    files: record.files,
    bytes: record.bytes,
    leftOut: leftOutText(record.leftOut),
    gapFilled: record.gapFilled,
    capped: record.capped,
    treeTruncated: record.treeTruncated,
    ms,
  }
}

export function snapshotFailure(cause: unknown): SnapshotFailure {
  if (cause instanceof SnapshotUnavailable) {
    return { step: cause.step, reason: `the repository's ${cause.step} could not be read from GitHub` }
  }
  return { step: "load", reason: "the repository's files could not be loaded" }
}

export type RunEnd = "review_end" | "answer_end"

export type IdleDropReason = "stale" | "closed"

export type DropReason = RunEnd | IdleDropReason

export interface SearchHead {
  number: number
  sha: string
}

export type LoadInto = (files: SnapshotFiles, sha: string) => Promise<SnapshotRecord>

export class SnapshotRuns {
  #active = 0
  #calls = { grep: 0, tree: 0 }
  #work = new GrepWork()
  #failure: string | undefined
  #loading: { sha: string; access: Promise<SearchAccess> } | undefined

  constructor(
    private readonly files: () => SnapshotFiles,
    private readonly loadInto: LoadInto,
  ) {}

  usage() {
    return { greps: this.#calls.grep, trees: this.#calls.tree, grepWork: this.#work.units() }
  }

  start(): void {
    this.#active += 1
  }

  async end(number: number, reason: RunEnd): Promise<void> {
    this.#active = Math.max(0, this.#active - 1)
    if (this.#active > 0) return
    await this.#loadsSettled()
    if (this.#active > 0) return
    this.#drop(number, reason)
  }

  async #loadsSettled(): Promise<void> {
    while (this.#loading !== undefined) {
      await this.#loading.access
    }
  }

  dropIdle(number: number, reason: IdleDropReason): void {
    if (this.#active > 0 || this.#loading !== undefined) return
    this.#drop(number, reason)
  }

  async access(tool: "grep" | "tree", head: () => Promise<SearchHead>): Promise<SearchAccess> {
    if (this.#failure !== undefined) return { kind: "unavailable", reason: this.#failure }
    if (this.#calls.grep + this.#calls.tree >= MAX_SEARCH_CALLS) return { kind: "spent" }
    this.#calls[tool] += 1
    const { number, sha } = await head()
    const files = this.files()
    if (files.record()?.sha === sha) return { kind: "ready", files, work: this.#work }
    return this.#sharedLoad(number, sha)
  }

  async #sharedLoad(number: number, sha: string): Promise<SearchAccess> {
    const inFlight = this.#loading
    if (inFlight?.sha === sha) return inFlight.access
    if (inFlight) {
      await inFlight.access
      return this.#sharedLoad(number, sha)
    }
    const access = this.#load(number, sha).finally(() => {
      if (this.#loading?.access === access) this.#loading = undefined
    })
    this.#loading = { sha, access }
    return access
  }

  async #load(number: number, sha: string): Promise<SearchAccess> {
    const started = Date.now()
    try {
      const files = this.files()
      const replaced = files.record()?.sha
      if (replaced !== undefined && replaced !== sha) log("snapshot.dropped", { number, reason: "new_head" })
      const record = await this.loadInto(files, sha)
      log("snapshot.loaded", loadedFields(number, record, Date.now() - started))
      return { kind: "ready", files, work: this.#work }
    } catch (cause) {
      const failure = snapshotFailure(cause)
      this.#failure = failure.reason
      logError("snapshot.failed", { number, head: shortSha(sha), step: failure.step, error: errorText(cause) })
      return { kind: "unavailable", reason: failure.reason }
    }
  }

  #drop(number: number, reason: DropReason): void {
    try {
      if (this.files().drop()) log("snapshot.dropped", { number, reason })
    } catch (cause) {
      logError("snapshot.drop_failed", { number, reason, error: errorText(cause) })
    }
    this.#failure = undefined
    this.#calls = { grep: 0, tree: 0 }
    this.#work = new GrepWork()
  }
}
