import type { GitHubClient, RepoRef } from "../github/client.ts"
import type { LogFields } from "../log.ts"
import { shortSha } from "../sha.ts"
import { SnapshotUnavailable, type SnapshotSource } from "./load-snapshot.ts"
import type { SnapshotRecord } from "./snapshot.ts"

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
