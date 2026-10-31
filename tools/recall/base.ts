export interface MergeInfo {
  readonly mergedAt: string | null
  readonly mergeCommitSha: string | null
}

export type MergeBase = (left: string, right: string) => Promise<string>

export async function diffBase(
  merge: MergeInfo,
  head: string,
  forkParent: string,
  mergeBase: MergeBase,
): Promise<string> {
  if (merge.mergedAt === null || merge.mergeCommitSha === null) return forkParent
  return mergeBase(`${merge.mergeCommitSha}^1`, head)
}
