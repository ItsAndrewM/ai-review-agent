import type { BlobText, ListedEntry, TreeListing } from "../github/client.ts"
import { errorText } from "../log.ts"
import {
  classify,
  SNAPSHOT_LIMITS,
  type LeftOut,
  type LeftOutReason,
  type SnapshotFile,
  type SnapshotFiles,
  type SnapshotLimits,
  type SnapshotRecord,
} from "./snapshot.ts"
import { readTar, type TarFile } from "./tar.ts"

export interface SnapshotSource {
  tarball(sha: string): Promise<ReadableStream<Uint8Array>>
  listing(sha: string): Promise<TreeListing>
  blobs(sha: string, paths: readonly string[]): Promise<BlobText[]>
}

export class SnapshotUnavailable extends Error {
  constructor(
    readonly step: "tarball" | "tree",
    cause: string,
  ) {
    super(`${step}: ${cause}`)
    this.name = "SnapshotUnavailable"
  }
}

const BATCH_SIZE = 200

const SYMLINK_MODE = "120000"

const decoder = new TextDecoder()

const encoder = new TextEncoder()

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

class Collector {
  files = 0
  bytes = 0
  gapFilled = 0
  capped = false
  private readonly pendingFiles: SnapshotFile[] = []
  private readonly pendingLeftOut: LeftOut[] = []
  private readonly seen = new Set<string>()
  private readonly counts: Record<string, number> = {}

  constructor(
    private readonly store: SnapshotFiles,
    private readonly limits: SnapshotLimits,
  ) {}

  has(path: string): boolean {
    return this.seen.has(path)
  }

  tryAdd(path: string, content: string, size: number): boolean {
    if (this.files + 1 > this.limits.maxFiles || this.bytes + size > this.limits.maxBytes) {
      this.capped = true
      return false
    }
    this.seen.add(path)
    this.files += 1
    this.bytes += size
    this.pendingFiles.push({ path, content })
    if (this.pendingFiles.length >= BATCH_SIZE) {
      this.flushFiles()
    }
    return true
  }

  leaveOut(path: string, reason: LeftOutReason): void {
    this.seen.add(path)
    this.counts[reason] = (this.counts[reason] ?? 0) + 1
    this.pendingLeftOut.push({ path, reason })
    if (this.pendingLeftOut.length >= BATCH_SIZE) {
      this.flushLeftOut()
    }
  }

  flush(): void {
    this.flushFiles()
    this.flushLeftOut()
  }

  record(sha: string, treeTruncated: boolean): SnapshotRecord {
    return {
      sha,
      files: this.files,
      bytes: this.bytes,
      gapFilled: this.gapFilled,
      leftOut: { ...this.counts },
      capped: this.capped,
      treeTruncated,
    }
  }

  private flushFiles(): void {
    if (this.pendingFiles.length > 0) {
      this.store.add(this.pendingFiles.splice(0))
    }
  }

  private flushLeftOut(): void {
    if (this.pendingLeftOut.length > 0) {
      this.store.leaveOut(this.pendingLeftOut.splice(0))
    }
  }
}

function collect(file: TarFile, collector: Collector): boolean {
  if (file.body === undefined) {
    collector.leaveOut(file.path, "too_large")
    return true
  }
  const kind = classify(file.body)
  if (kind !== "text") {
    collector.leaveOut(file.path, kind)
    return true
  }
  return collector.tryAdd(file.path, decoder.decode(file.body), file.body.length)
}

async function readTarball(
  source: SnapshotSource,
  sha: string,
  store: SnapshotFiles,
  limits: SnapshotLimits,
): Promise<Collector> {
  store.begin(sha)
  const collector = new Collector(store, limits)
  const gzipped = await source.tarball(sha)
  const archive = gzipped.pipeThrough(new DecompressionStream("gzip"))
  for await (const file of readTar(archive, limits.maxFileBytes)) {
    if (!collect(file, collector)) {
      break
    }
  }
  collector.flush()
  return collector
}

async function fillFromTarball(
  source: SnapshotSource,
  sha: string,
  store: SnapshotFiles,
  limits: SnapshotLimits,
): Promise<Collector> {
  try {
    return await readTarball(source, sha, store, limits)
  } catch {
    return retryTarball(source, sha, store, limits)
  }
}

async function retryTarball(
  source: SnapshotSource,
  sha: string,
  store: SnapshotFiles,
  limits: SnapshotLimits,
): Promise<Collector> {
  try {
    return await readTarball(source, sha, store, limits)
  } catch (cause) {
    throw new SnapshotUnavailable("tarball", errorText(cause))
  }
}

async function readListing(source: SnapshotSource, sha: string): Promise<TreeListing> {
  try {
    return await source.listing(sha)
  } catch (cause) {
    throw new SnapshotUnavailable("tree", errorText(cause))
  }
}

type Verdict = LeftOutReason | "gap" | "skip"

function verdictFor(entry: ListedEntry, collector: Collector, limits: SnapshotLimits): Verdict {
  if (entry.type === "tree" || collector.has(entry.path)) {
    return "skip"
  }
  if (entry.mode === SYMLINK_MODE) {
    return "symlink"
  }
  if (entry.type === "commit") {
    return "submodule"
  }
  if (entry.size !== undefined && entry.size > limits.maxFileBytes) {
    return "too_large"
  }
  return collector.capped ? "snapshot_cap" : "gap"
}

function classifyListing(entries: readonly ListedEntry[], collector: Collector, limits: SnapshotLimits): string[] {
  const candidates: string[] = []
  for (const entry of entries) {
    const verdict = verdictFor(entry, collector, limits)
    if (verdict === "gap") {
      candidates.push(entry.path)
    } else if (verdict !== "skip") {
      collector.leaveOut(entry.path, verdict)
    }
  }
  return candidates.sort(byPath)
}

function keepGapText(blob: BlobText, collector: Collector): void {
  if (blob.text === undefined) {
    collector.leaveOut(blob.path, "binary")
    return
  }
  const bytes = encoder.encode(blob.text)
  const kind = classify(bytes)
  if (kind !== "text") {
    collector.leaveOut(blob.path, kind)
  } else if (collector.tryAdd(blob.path, blob.text, bytes.length)) {
    collector.gapFilled += 1
  } else {
    collector.leaveOut(blob.path, "snapshot_cap")
  }
}

async function fillGap(
  source: SnapshotSource,
  sha: string,
  candidates: readonly string[],
  limits: SnapshotLimits,
  collector: Collector,
): Promise<void> {
  const wanted = candidates.slice(0, limits.maxGapFill)
  for (const path of candidates.slice(limits.maxGapFill)) {
    collector.leaveOut(path, "gap_cap")
  }
  if (wanted.length === 0) {
    return
  }
  for (const blob of await source.blobs(sha, wanted)) {
    keepGapText(blob, collector)
  }
}

export async function loadSnapshot(
  source: SnapshotSource,
  files: SnapshotFiles,
  sha: string,
  limits: SnapshotLimits = SNAPSHOT_LIMITS,
): Promise<SnapshotRecord> {
  const collector = await fillFromTarball(source, sha, files, limits)
  const listing = await readListing(source, sha)
  const candidates = classifyListing(listing.entries, collector, limits)
  await fillGap(source, sha, candidates, limits, collector)
  collector.flush()
  const record = collector.record(sha, listing.truncated)
  files.finish(record)
  return record
}
