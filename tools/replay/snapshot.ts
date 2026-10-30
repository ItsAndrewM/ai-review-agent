import { GrepWork, grep, tree } from "../../src/repository/search.ts"
import {
  MAX_FILE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_FILES,
  MemorySnapshotFiles,
} from "../../src/repository/snapshot.ts"
import { numberedLine } from "../../src/review/prompt.ts"
import type { GrepArgs, ReadFileArgs, TreeArgs } from "../../src/review/tools.ts"
import type { HistoricalFiles } from "./git.ts"

const MAX_FILE_TEXT = 60_000

export interface ReplaySource {
  readFile(args: ReadFileArgs): Promise<string>
  grep(args: GrepArgs): Promise<string>
  tree(args: TreeArgs): Promise<string>
}

export async function snapshotSource(head: string, base: string, files: HistoricalFiles): Promise<ReplaySource> {
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
