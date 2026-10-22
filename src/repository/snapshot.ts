import { Type, type Static } from "typebox"

export const MAX_FILE_BYTES = 1_048_576

export const MAX_SNAPSHOT_FILES = 50_000

export const MAX_SNAPSHOT_BYTES = 419_430_400

export const MAX_GAP_FILL = 500

export interface SnapshotLimits {
  maxFileBytes: number
  maxFiles: number
  maxBytes: number
  maxGapFill: number
}

export const SNAPSHOT_LIMITS = {
  maxFileBytes: MAX_FILE_BYTES,
  maxFiles: MAX_SNAPSHOT_FILES,
  maxBytes: MAX_SNAPSHOT_BYTES,
  maxGapFill: MAX_GAP_FILL,
} satisfies SnapshotLimits

export const LEFT_OUT_REASONS = [
  "too_large",
  "binary",
  "lfs",
  "submodule",
  "symlink",
  "gap_cap",
  "snapshot_cap",
  "unlisted",
] as const

export type LeftOutReason = (typeof LEFT_OUT_REASONS)[number]

export interface LeftOut {
  path: string
  reason: LeftOutReason
}

export interface SnapshotFile {
  path: string
  content: string
}

export function isLeftOutReason(value: string): value is LeftOutReason {
  return LEFT_OUT_REASONS.some((reason) => reason === value)
}

const BINARY_SNIFF_BYTES = 8_192

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1"

const decoder = new TextDecoder()

export function classify(body: Uint8Array): "text" | "binary" | "lfs" {
  const start = body.subarray(0, BINARY_SNIFF_BYTES)
  if (start.includes(0)) {
    return "binary"
  }
  return decoder.decode(start).startsWith(LFS_POINTER_PREFIX) ? "lfs" : "text"
}

export const SnapshotRecord = Type.Object({
  sha: Type.String(),
  files: Type.Integer(),
  bytes: Type.Integer(),
  gapFilled: Type.Integer(),
  leftOut: Type.Record(Type.String(), Type.Integer()),
  capped: Type.Boolean(),
  treeTruncated: Type.Boolean(),
})

export type SnapshotRecord = Static<typeof SnapshotRecord>

export interface SnapshotFiles {
  begin(sha: string): void
  add(files: readonly SnapshotFile[]): void
  leaveOut(entries: readonly LeftOut[]): void
  finish(record: SnapshotRecord): void
  record(): SnapshotRecord | undefined
  read(path: string): string | undefined
  reasonFor(path: string): LeftOutReason | undefined
  files(): Iterable<SnapshotFile>
  paths(): Iterable<string>
  leftOut(): Iterable<LeftOut>
  has(path: string): boolean
  drop(): boolean
}

const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

export class MemorySnapshotFiles implements SnapshotFiles {
  private readonly contents = new Map<string, string>()
  private readonly reasons = new Map<string, LeftOutReason>()
  private finished: SnapshotRecord | undefined

  begin(_sha: string): void {
    this.clear()
  }

  add(files: readonly SnapshotFile[]): void {
    for (const file of files) {
      this.contents.set(file.path, file.content)
    }
  }

  leaveOut(entries: readonly LeftOut[]): void {
    for (const entry of entries) {
      this.reasons.set(entry.path, entry.reason)
    }
  }

  finish(record: SnapshotRecord): void {
    this.finished = record
  }

  record(): SnapshotRecord | undefined {
    return this.finished
  }

  read(path: string): string | undefined {
    return this.contents.get(path)
  }

  reasonFor(path: string): LeftOutReason | undefined {
    return this.reasons.get(path)
  }

  files(): Iterable<SnapshotFile> {
    return [...this.contents].map(([path, content]) => ({ path, content })).sort(byPath)
  }

  paths(): Iterable<string> {
    return [...this.contents.keys()].sort()
  }

  leftOut(): Iterable<LeftOut> {
    return [...this.reasons].map(([path, reason]) => ({ path, reason })).sort(byPath)
  }

  has(path: string): boolean {
    return this.contents.has(path)
  }

  drop(): boolean {
    const hadAnything = this.contents.size > 0 || this.reasons.size > 0 || this.finished !== undefined
    this.clear()
    return hadAnything
  }

  private clear(): void {
    this.contents.clear()
    this.reasons.clear()
    this.finished = undefined
  }
}
