import type { ReviewEvent } from "../github/client.ts"
import {
  countBySeverity,
  type FindingInput,
  type Rejected,
  type ReviewSubmissionInput,
  type WalkthroughInput,
  type WrittenReview,
} from "./findings.ts"
import type { ReviewMode, SinceSection } from "./incremental.ts"

export interface Coverage {
  mode: ReviewMode
  from?: string
  to: string
  files: number
  resolved: number
}

export const SUMMARY_MARKER = "<!-- andabot:summary -->"

const MOST_HELD_BACK_LISTED = 5
const MOST_LISTED_CHARS = 100

export const VERDICT_LABEL = {
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
  model?: string | undefined
  skillsFingerprint?: string | undefined
  since?: SinceSection | undefined
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
      ? `\n\n<sub>${input.droppedCount} finding(s) were dropped because they couldn't be posted inline, even after a retry.</sub>`
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
    ...sinceLines(input.since),
    "",
    ...reviewedBy(input.model, input.skillsFingerprint),
    `<sub>Commands: \`@${input.botLogin} review\`, \`@${input.botLogin} full review\`, \`@${input.botLogin} help\`. Ask a question with \`@${input.botLogin} <question>\`.</sub>`,
  ].join("\n")
}

function sinceLines(since: SinceSection | undefined): string[] {
  if (since === undefined) return []
  const files = since.files.map((path) => `\`${path}\``).join(", ") || "none"
  return [
    "",
    `### Since \`${since.from.slice(0, 7)}\``,
    "",
    since.summary.trim(),
    "",
    `Files: ${files}. Resolved ${since.resolved} thread(s).`,
  ]
}

export function mergeWalkthrough(
  stored: readonly WalkthroughInput[],
  incoming: readonly WalkthroughInput[],
  covered: ReadonlySet<string>,
): WalkthroughInput[] {
  const replacements = new Map(incoming.filter((row) => covered.has(row.path)).map((row) => [row.path, row]))
  const known = new Set(stored.map((row) => row.path))
  return [
    ...stored.map((row) => replacements.get(row.path) ?? row),
    ...[...replacements.values()].filter((row) => !known.has(row.path)),
  ]
}

function reviewedBy(model: string | undefined, skillsFingerprint: string | undefined): string[] {
  if (model === undefined || skillsFingerprint === undefined) return []
  return [`<sub>Reviewed by \`${model}\` with skills \`review@${skillsFingerprint.slice(0, 8)}\`.</sub>`]
}

export function renderUnpostedSummary(input: { botLogin: string; headSha: string; note: string }): string {
  return [
    SUMMARY_MARKER,
    `## ${input.botLogin} review`,
    "",
    `**Head:** \`${input.headSha.slice(0, 7)}\``,
    "",
    input.note,
  ].join("\n")
}

export function renderUnpostedNote(written: WrittenReview, retryFailure: string | undefined): string {
  const asked = retryFailure === undefined ? "even when asked again" : `and asking again failed: ${retryFailure}`
  const reason = `_The review couldn't be posted: the model didn't submit one that could be, ${asked}._`
  return written.kind === "prose" && written.text !== "" ? `${reason}\n\n${written.text}` : reason
}

export function renderReviewBody(
  event: ReviewEvent,
  accepted: readonly FindingInput[],
  rejected: readonly Rejected[],
  coverage?: Coverage,
): string {
  const body = findingsLines(event, accepted, rejected)
  const covered = coverageLine(coverage)
  return covered === undefined ? body : `${body}\n\n${covered}`
}

function findingsLines(event: ReviewEvent, accepted: readonly FindingInput[], rejected: readonly Rejected[]): string {
  const held = heldBack(rejected)
  if (held === undefined) return inlineSummary(event, accepted)
  return accepted.length === 0 ? held : `${inlineSummary(event, accepted)}\n\n${held}`
}

function coverageLine(coverage: Coverage | undefined): string | undefined {
  if (coverage === undefined) return undefined
  if (coverage.mode !== "incremental" || coverage.from === undefined) return "<sub>Full review.</sub>"
  const range = `${coverage.from.slice(0, 7)}..${coverage.to.slice(0, 7)}`
  return `<sub>Incremental review of \`${range}\`: ${plural(coverage.files, "file")}; ${plural(coverage.resolved, "thread")} resolved.</sub>`
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function heldBack(rejected: readonly Rejected[]): string | undefined {
  const blocking = rejected.filter((r) => r.finding.severity === "blocking")
  if (blocking.length === 0) return undefined
  return [
    `${blocking.length} blocking finding(s) couldn't be posted inline and hold approval back:`,
    ...blocking
      .slice(0, MOST_HELD_BACK_LISTED)
      .map((r) => `- **${clipped(r.finding.title)}** in \`${clipped(r.finding.path)}\``),
  ].join("\n")
}

function clipped(text: string): string {
  const flat = oneLine(text)
  return flat.length > MOST_LISTED_CHARS ? `${flat.slice(0, MOST_LISTED_CHARS)}…` : flat
}

function inlineSummary(event: ReviewEvent, accepted: readonly FindingInput[]): string {
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
  rejected: readonly Rejected[],
  requestChangesWorkflow: boolean,
  openBlocking?: number | "unknown",
): ReviewEvent {
  if (!requestChangesWorkflow) return "COMMENT"
  if (countBySeverity([...accepted, ...rejected.map((r) => r.finding)]).blocking > 0) return "REQUEST_CHANGES"
  if (openBlocking === "unknown") return "COMMENT"
  if ((openBlocking ?? 0) > 0) return "REQUEST_CHANGES"
  if (submission.verdict === "approve") return "APPROVE"
  return "COMMENT"
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()
}
