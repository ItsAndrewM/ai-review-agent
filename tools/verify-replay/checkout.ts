import { citedWindow, VERIFY_RADIUS, type FindingContext } from "../../src/review/verify.ts"
import { patchHunks, type HistoricalFiles } from "../replay/git.ts"
import type { LabelledFinding } from "./schema.ts"

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
