import type { GitHubClient } from "./github/client.ts"
import { errorText, log, logError } from "./log.ts"

export async function reactWithEyes(
  github: GitHubClient,
  subjectId: string | undefined,
  number: number,
): Promise<void> {
  if (subjectId === undefined) return
  try {
    await github.addEyesReaction(subjectId)
    log("reaction.added", { number, subject: subjectId })
  } catch (error) {
    logError("reaction.failed", { number, subject: subjectId, error: errorText(error) })
  }
}
