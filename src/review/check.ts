import type { CheckRunConclusion, CheckRunOutput, CreateCheckRun, RepoRef, UpdateCheckRun } from "../github/client.ts"
import type { PostedReview } from "../records.ts"
import { shortSha } from "../sha.ts"
import { countBySeverity, type FindingInput } from "./findings.ts"
import { VERDICT_LABEL, type Verdict } from "./render.ts"

export const MAX_CHECK_SUMMARY_CHARS = 65_535

const TRAILING_HIGH_SURROGATE = /[\ud800-\udbff]$/

export interface CheckRunStart {
  name: string
  headSha: string
  deliveryId: string
  fileCount: number
  model: string
  startedAt: number
}

export function startedCheckRun(start: CheckRunStart): CreateCheckRun {
  const files = counted(start.fileCount, "file")
  return {
    name: start.name,
    head_sha: start.headSha,
    status: "in_progress",
    external_id: start.deliveryId,
    started_at: isoSeconds(start.startedAt),
    output: checkOutput(
      "Review in progress",
      `Reviewing ${files} at \`${shortSha(start.headSha)}\` with \`${start.model}\`.`,
    ),
  }
}

export function postedCheckRun(
  event: Verdict,
  accepted: readonly FindingInput[],
  summary: string,
  detailsUrl: string | undefined,
  completedAt: number,
): UpdateCheckRun {
  const title = checkRunTitle(event, countBySeverity(accepted))
  return completedCheckRun("success", checkOutput(title, summary), detailsUrl, completedAt)
}

export function postedEarlierCheckRun(
  posted: Pick<PostedReview, "reviewId" | "event" | "counts">,
  detailsUrl: string | undefined,
  completedAt: number,
): UpdateCheckRun {
  const title = posted.counts === undefined ? VERDICT_LABEL[posted.event] : checkRunTitle(posted.event, posted.counts)
  const earlier = `Review ${posted.reviewId} was posted by an earlier run of this head.`
  const summary = detailsUrl === undefined ? earlier : `${earlier} Details opens its summary comment.`
  return completedCheckRun("success", checkOutput(title, summary), detailsUrl, completedAt)
}

export function failedCheckRun(reason: string, detailsUrl: string | undefined, completedAt: number): UpdateCheckRun {
  return completedCheckRun("failure", checkOutput("Review did not complete", reason), detailsUrl, completedAt)
}

export function supersededCheckRun(newHeadSha: string, completedAt: number): UpdateCheckRun {
  const head = shortSha(newHeadSha)
  const output = checkOutput(`Superseded by ${head}`, `A newer head, \`${head}\`, is being reviewed instead.`)
  return completedCheckRun("cancelled", output, undefined, completedAt)
}

export function unchangedCheckRun(sinceSha: string, completedAt: number): UpdateCheckRun {
  const since = shortSha(sinceSha)
  const output = checkOutput(
    `No changes to review since \`${since}\``,
    `The commits since \`${since}\` add no line to the pull request's diff and touch none of its open threads, so there was nothing new to review.`,
  )
  return completedCheckRun("success", output, undefined, completedAt)
}

export function replacedCheckRun(completedAt: number): UpdateCheckRun {
  const output = checkOutput("Replaced by a newer review", "A newer review of this head replaced this run.")
  return completedCheckRun("cancelled", output, undefined, completedAt)
}

export function checkRunTitle(event: Verdict, counts: Record<FindingInput["severity"], number>): string {
  const parts: string[] = []
  if (counts.blocking > 0) parts.push(`${counts.blocking} blocking`)
  if (counts.suggestion > 0) parts.push(counted(counts.suggestion, "suggestion"))
  if (counts.nitpick > 0) parts.push(counted(counts.nitpick, "nitpick"))
  const label = VERDICT_LABEL[event]
  return parts.length === 0 ? label : `${label}: ${parts.join(", ")}`
}

export function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")
}

export function summaryCommentLink(ref: RepoRef, number: number, commentId: number): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${number}#issuecomment-${commentId}`
}

function completedCheckRun(
  conclusion: CheckRunConclusion,
  output: CheckRunOutput,
  detailsUrl: string | undefined,
  completedAt: number,
): UpdateCheckRun {
  const update: UpdateCheckRun = { conclusion, completed_at: isoSeconds(completedAt), output }
  if (detailsUrl !== undefined) update.details_url = detailsUrl
  return update
}

function checkOutput(title: string, summary: string): CheckRunOutput {
  if (summary.length <= MAX_CHECK_SUMMARY_CHARS) return { title, summary }
  const kept = summary.slice(0, MAX_CHECK_SUMMARY_CHARS - 1).replace(TRAILING_HIGH_SURROGATE, "")
  return { title, summary: `${kept}…` }
}

function counted(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`
}
