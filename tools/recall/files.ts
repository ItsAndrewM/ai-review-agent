import type { ChangedFile } from "../../src/github/diff.ts"
import { patchHunks, type ChangeAt, type GitHistory } from "../replay/git.ts"

async function diffOf(git: GitHistory, base: string, head: string, change: ChangeAt): Promise<string> {
  if (change.previousPath === undefined) return git.diff(base, head, change.path)
  return git.renameDiff(base, head, change.previousPath, change.path)
}

export async function changedFilesAt(git: GitHistory, base: string, head: string): Promise<ChangedFile[]> {
  const changes = await git.changes(base, head)
  return Promise.all(
    changes.map(async (change) => {
      const patch = patchHunks(await diffOf(git, base, head, change))
      const file: ChangedFile = {
        filename: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
      }
      return patch === undefined ? file : { ...file, patch }
    }),
  )
}
