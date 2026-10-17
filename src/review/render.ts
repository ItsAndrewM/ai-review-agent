import type { ReviewEvent } from "../github/client.ts"
import { countBySeverity, type FindingInput, type ReviewSubmissionInput } from "./findings.ts"

export const SUMMARY_MARKER = "<!-- andabot:summary -->"

const VERDICT_LABEL = {
  APPROVE: "Approved",
  REQUEST_CHANGES: "Changes requested",
  COMMENT: "Commented",
} satisfies Record<ReviewEvent, string>

export function renderSummaryComment(input: {
  botLogin: string
  headSha: string
  event: ReviewEvent
  submission: ReviewSubmissionInput
  accepted: readonly FindingInput[]
  droppedCount: number
}): string {
  const counts = countBySeverity(input.accepted)
  const walkthrough =
    input.submission.walkthrough.length === 0
      ? "_No per-file notes._"
      : [
          "| File | Change |",
          "| --- | --- |",
          ...input.submission.walkthrough.map((w) => `| \`${w.path}\` | ${oneLine(w.summary)} |`),
        ].join("\n")
  const dropped =
    input.droppedCount > 0
      ? `\n\n<sub>${input.droppedCount} finding(s) were dropped because they did not anchor to a line in the diff.</sub>`
      : ""
  return [
    SUMMARY_MARKER,
    `## ${input.botLogin} review`,
    "",
    `**Head:** \`${input.headSha.slice(0, 7)}\` · **Verdict:** ${VERDICT_LABEL[input.event]} · 🔴 ${counts.blocking} blocking · 🟡 ${counts.suggestion} suggestions · ⚪ ${counts.nitpick} nitpicks`,
    "",
    "### Summary",
    "",
    input.submission.summary.trim(),
    "",
    "### Walkthrough",
    "",
    walkthrough,
    dropped,
    "",
    `<sub>Commands: \`@${input.botLogin} review\`, \`@${input.botLogin} full review\`, \`@${input.botLogin} help\`. Ask a question with \`@${input.botLogin} <question>\`.</sub>`,
  ].join("\n")
}

export function renderReviewBody(event: ReviewEvent, accepted: readonly FindingInput[]): string {
  const counts = countBySeverity(accepted)
  if (accepted.length === 0) {
    return event === "APPROVE"
      ? "No findings. The change looks sound to me; a human review is still required to merge."
      : "No findings to anchor to the diff. See the summary comment."
  }
  const parts: string[] = []
  if (counts.blocking > 0) parts.push(`${counts.blocking} blocking finding(s) to address before approval`)
  if (counts.suggestion > 0) parts.push(`${counts.suggestion} suggestion(s)`)
  if (counts.nitpick > 0) parts.push(`${counts.nitpick} nitpick(s)`)
  return `${parts.join(", ")}. Blocking findings are marked 🔴; the others are optional.`
}

export function chooseReviewEvent(
  submission: ReviewSubmissionInput,
  accepted: readonly FindingInput[],
  requestChangesWorkflow: boolean,
): ReviewEvent {
  const counts = countBySeverity(accepted)
  if (!requestChangesWorkflow) return "COMMENT"
  if (counts.blocking > 0) return "REQUEST_CHANGES"
  if (submission.verdict === "approve") return "APPROVE"
  return "COMMENT"
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()
}
