import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { GrepWork, grep, tree } from "../../src/repository/search.ts"
import {
  MAX_FILE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_FILES,
  MemorySnapshotFiles,
} from "../../src/repository/snapshot.ts"
import { numberedLine } from "../../src/review/prompt.ts"
import type { ReadFileArgs } from "../../src/review/tools.ts"
import { citedWindow, VERIFY_RADIUS, type FindingContext } from "../../src/review/verify.ts"
import type { LabelledFinding } from "./schema.ts"
import type { ReplaySource } from "./tools.ts"

const execute = promisify(execFile)
const MAX_GIT_OUTPUT = 24 * 1024 * 1024
const MAX_FILE_TEXT = 60_000

export interface HistoricalFiles {
  read(sha: string, path: string): Promise<string | undefined>
  diff(base: string, head: string, path: string): Promise<string>
  paths(sha: string): Promise<string[]>
}

export class GitFiles implements HistoricalFiles {
  readonly #root: string
  readonly #paths = new Map<string, Promise<string[]>>()

  constructor(root: string) {
    this.#root = root
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await execute("git", args, {
      cwd: this.#root,
      env: { ...process.env, GIT_MASTER: "1" },
      maxBuffer: MAX_GIT_OUTPUT,
      encoding: "utf8",
    })
    return stdout
  }

  paths(sha: string): Promise<string[]> {
    const known =
      this.#paths.get(sha) ??
      this.git("ls-tree", "-r", "-z", "--name-only", sha).then((text) => text.split("\0").filter(Boolean))
    this.#paths.set(sha, known)
    return known
  }

  async read(sha: string, path: string): Promise<string | undefined> {
    if (!(await this.paths(sha)).includes(path)) return undefined
    return this.git("show", `${sha}:${path}`)
  }

  diff(base: string, head: string, path: string): Promise<string> {
    return this.git("diff", base, head, "--", path)
  }
}

export function patchHunks(diff: string): string | undefined {
  const start = diff.indexOf("@@ ")
  return start < 0 ? undefined : diff.slice(start).trimEnd()
}

export async function replayContexts(
  entries: readonly LabelledFinding[],
  files: HistoricalFiles,
): Promise<FindingContext[]> {
  return Promise.all(
    entries.map(async (entry, index) => {
      const { path, side, line, start_line } = entry.finding
      const content = await files.read(side === "LEFT" ? entry.base : entry.head, path)
      const patch = patchHunks(entry.patch ?? (await files.diff(entry.base, entry.head, path)))
      return {
        candidate: { id: `F${index + 1}`, finding: entry.finding, held: false },
        window: content === undefined ? undefined : citedWindow(content, line, start_line, VERIFY_RADIUS),
        patch,
        issue: entry.finding.basis_kind === "spec" ? entry.issue : undefined,
      }
    }),
  )
}

export async function replaySource(head: string, base: string, files: HistoricalFiles): Promise<ReplaySource> {
  const snapshot = new MemorySnapshotFiles()
  const paths = await files.paths(head)
  let bytes = 0
  snapshot.begin(head)
  for (const path of paths.slice(0, MAX_SNAPSHOT_FILES)) {
    const content = await files.read(head, path)
    if (content === undefined) continue
    const size = Buffer.byteLength(content)
    if (size > MAX_FILE_BYTES || content.includes("\0")) {
      snapshot.leaveOut([{ path, reason: size > MAX_FILE_BYTES ? "too_large" : "binary" }])
      continue
    }
    if (bytes + size > MAX_SNAPSHOT_BYTES) {
      snapshot.leaveOut([{ path, reason: "snapshot_cap" }])
      continue
    }
    bytes += size
    snapshot.add([{ path, content }])
  }
  snapshot.finish({
    sha: head,
    files: paths.length,
    bytes,
    gapFilled: 0,
    leftOut: {},
    capped: paths.length > MAX_SNAPSHOT_FILES,
    treeTruncated: false,
  })
  const work = new GrepWork()
  return {
    readFile: async ({ path, ref }: ReadFileArgs) => {
      const sha = ref === "base" ? base : head
      const content =
        ref === "base" ? await files.read(base, path) : (snapshot.read(path) ?? (await files.read(head, path)))
      if (content === undefined) return `${path} does not exist at ${ref ?? "head"} (${sha.slice(0, 7)}).`
      const text = content
        .split("\n")
        .map((line, index) => numberedLine(index + 1, line))
        .join("\n")
      return text.length > MAX_FILE_TEXT
        ? `${text.slice(0, MAX_FILE_TEXT)}\n... (truncated at ${MAX_FILE_TEXT} characters)`
        : text
    },
    grep: async (query) => grep(snapshot, query, work),
    tree: async ({ path, depth }) => tree(snapshot, path, depth),
  }
}
