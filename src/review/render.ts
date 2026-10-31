import type { ReviewEvent } from "../github/client.ts"
import type { CheckRecord, SeverityCounts } from "../records.ts"
import { CONFIG_FILE } from "../repository/config.ts"
import { secondsText } from "../sandbox/checks.ts"
import type { SandboxStatus } from "../sandbox/runs.ts"
import { spendLine, type ReviewSpend } from "./cost.ts"
import {
  checkLabel,
  countBySeverity,
  type FindingInput,
  type MergeDangerInput,
  type Rejected,
  type ReviewSubmissionInput,
  rowPath,
  type SummarySubmissionInput,
  type WalkthroughInput,
  type WrittenReview,
} from "./findings.ts"
import type { ReviewMode, SinceSection } from "./incremental.ts"
import type { ApprovalReason } from "./reasons.ts"
import type { Changed, VerifyReport } from "./verify.ts"

export interface Coverage {
  mode: ReviewMode
  from?: string
  to: string
  files: number
  resolved: number
}

export const SUMMARY_MARKER = "<!-- andabot:summary -->"

const MOST_HELD_BACK_LISTED = 5
const MOST_MISSING_LISTED = 10
const MOST_LISTED_CHARS = 100
const MOST_CONFIG_ERROR_CHARS = 300
const MOST_UNVERIFIED_REASON_CHARS = 200

export type Verdict = ReviewEvent | "AWAITING_CHECKS" | "WITHHELD"

export type VerifyDisplay =
  | { kind: "verified"; model: string; report: VerifyReport; leftOut: readonly FindingInput[] }
  | { kind: "unverified"; model: string; reason: string }

export const VERDICT_LABEL = {
  APPROVE: "Approved",
  REQUEST_CHANGES: "Changes requested",
  COMMENT: "Commented",
  AWAITING_CHECKS: "Approval waits for the checks",
  WITHHELD: "Approval withheld",
} satisfies Record<Verdict, string>

const AWAITING_CHECKS_NOTE = "I'll approve once the head's checks pass"

const VERDICT_SEGMENT = /\*\*Verdict:\*\* [^\n]*?(?= · |$)/m

export function reviewEventOf(verdict: Verdict): ReviewEvent {
  return verdict === "AWAITING_CHECKS" || verdict === "WITHHELD" ? "COMMENT" : verdict
}

export function approvalBody(headSha: string): string {
  return `Approved at \`${headSha.slice(0, 7)}\`: none of my blocking threads is open, and the checks pass. A human review is still required to merge.`
}

export function withApprovedVerdict(body: string, headSha: string): string | undefined {
  if (!body.startsWith(SUMMARY_MARKER) || !VERDICT_SEGMENT.test(body)) return undefined
  return body.replace(VERDICT_SEGMENT, `**Verdict:** Approved at \`${headSha.slice(0, 7)}\``)
}

export function renderSummaryComment(input: {
  botLogin: string
  headSha: string
  event: Verdict
  submission: ReviewSubmissionInput
  accepted: readonly FindingInput[]
  droppedCount: number
  model?: string | undefined
  skillsFingerprint?: string | undefined
  repoSkillsFingerprint?: string | undefined
  spend?: ReviewSpend | undefined
  budgetNote?: string | undefined
  linkedIssues: readonly number[]
  instructionFiles: readonly string[]
  since?: SinceSection | undefined
  verify?: VerifyDisplay | undefined
  configError?: string | undefined
  checks?: ChecksDisplay | undefined
  sandboxSeconds?: number | undefined
}): string {
  return summaryLayout({
    botLogin: input.botLogin,
    status: statusLine(input.headSha, { label: VERDICT_LABEL[input.event], counts: countBySeverity(input.accepted) }),
    content: input.submission,
    afterWalkthrough: [
      droppedLine(input.droppedCount),
      ...checksLines(input.checks),
      ...verifyLines(input.verify),
      ...sinceLines(input.since),
    ],
    footer: [
      ...reviewedBy(input.model, input.skillsFingerprint, input.repoSkillsFingerprint, input.verify),
      ...unverifiedLines(input.verify),
      ...spendLines(input.spend, input.sandboxSeconds),
      ...budgetNoteLines(input.budgetNote),
      linkedIssuesLine(input.linkedIssues),
      standardsLine(input.instructionFiles),
      commandsLine(input.botLogin),
      ...configNoteLines(input.configError),
    ],
  })
}

export interface VerdictLine {
  label: string
  counts?: SeverityCounts
}

export interface SummaryRunInput {
  botLogin: string
  headSha: string
  verdict: VerdictLine
  summary: SummarySubmissionInput
  model: string
  skillsFingerprint: string
  linkedIssues: readonly number[]
  configError?: string | undefined
}

export function renderSummaryRun(input: SummaryRunInput): string {
  return summaryLayout({
    botLogin: input.botLogin,
    status: statusLine(input.headSha, input.verdict),
    content: input.summary,
    afterWalkthrough: [],
    footer: [
      summarizedBy(input.model, input.skillsFingerprint),
      linkedIssuesLine(input.linkedIssues),
      commandsLine(input.botLogin),
      ...configNoteLines(input.configError),
    ],
  })
}

interface SummaryLayout {
  botLogin: string
  status: string
  content: SummarySubmissionInput
  afterWalkthrough: readonly string[]
  footer: readonly string[]
}

function summaryLayout(layout: SummaryLayout): string {
  const { door, blast_radius } = layout.content.merge_danger
  return [
    SUMMARY_MARKER,
    `## ${layout.botLogin} review`,
    "",
    layout.status,
    "",
    `**Merge danger:** ${door} door · ${oneLine(blast_radius)}`,
    "",
    "### Summary",
    "",
    layout.content.summary.trim(),
    "",
    "### Walkthrough",
    "",
    walkthroughTable(layout.content.walkthrough),
    ...layout.afterWalkthrough,
    "",
    ...layout.footer,
  ].join("\n")
}

function statusLine(headSha: string, verdict: VerdictLine): string {
  const status = `**Head:** \`${headSha.slice(0, 7)}\` · **Verdict:** ${verdict.label}`
  const { counts } = verdict
  if (counts === undefined) return status
  return `${status} · 🔴 ${counts.blocking} blocking · 🟠 ${counts.major ?? 0} major · 🟡 ${counts.suggestion} suggestions · ⚪ ${counts.nitpick} nitpicks`
}

function walkthroughTable(rows: readonly WalkthroughInput[]): string {
  if (rows.length === 0) return "_No per-file notes._"
  return [
    "| File | Change |",
    "| --- | --- |",
    ...rows.map((row) => `| \`${row.path}\` | ${oneLine(row.summary)} |`),
  ].join("\n")
}

function droppedLine(droppedCount: number): string {
  return droppedCount > 0
    ? `\n\n<sub>${droppedCount} finding(s) were dropped because they failed the host's checks, even after a retry.</sub>`
    : ""
}

function commandsLine(botLogin: string): string {
  return `<sub>Commands: \`@${botLogin} review\`, \`@${botLogin} full review\`, \`@${botLogin} help\`. Ask a question with \`@${botLogin} <question>\`.</sub>`
}

function configNoteLines(error: string | undefined): string[] {
  if (error === undefined) return []
  const problem = codeSpan(cut(flattened(error), MOST_CONFIG_ERROR_CHARS))
  return ["", `_${CONFIG_FILE} was ignored: ${problem}; the defaults applied._`]
}

function sinceLines(since: SinceSection | undefined): string[] {
  if (since === undefined) return []
  const files = since.files.map((path) => `\`${path}\``).join(", ") || "none"
  return [
    "",
    `### Since \`${since.from.slice(0, 7)}\``,
    "",
    since.summary.trim(),
    ...pushDangerLines(since.merge_danger),
    "",
    `Files: ${files}. Resolved ${since.resolved} thread(s).`,
  ]
}

const ENDS_A_SENTENCE = /[.!?]$/

function pushDangerLines(danger: MergeDangerInput | undefined): string[] {
  if (danger === undefined) return []
  const radius = oneLine(danger.blast_radius)
  return ["", `This push: ${danger.door} door · ${radius}${ENDS_A_SENTENCE.test(radius) ? "" : "."}`]
}

export const MOST_CHECK_TAIL_CHARS = 2000

export interface ChecksDisplay {
  readonly status: SandboxStatus["kind"]
  readonly reason?: string | undefined
  readonly runs: readonly CheckRecord[]
}

export const MOST_CHECK_TAIL_BLOCKS = 5

function checksLines(checks: ChecksDisplay | undefined): string[] {
  if (checks === undefined) return []
  if (checks.runs.length === 0) return ["", `**Checks:** ${noRunsText(checks)}`]
  const failed = checks.runs.filter((run) => run.outcome === "timeout" || run.exitCode !== 0)
  const shown = failed.slice(0, MOST_CHECK_TAIL_BLOCKS)
  const leftOut = failed.length - shown.length
  const note =
    leftOut > 0 ? ["", `_The output of ${leftOut} more failed run${leftOut === 1 ? "" : "s"} is left out._`] : []
  return ["", "**Checks:**", ...checks.runs.map(runLine), ...shown.flatMap(tailBlock), ...note]
}

function noRunsText(checks: ChecksDisplay): string {
  switch (checks.status) {
    case "off":
      return "off"
    case "spent":
      return "spent"
    case "unavailable":
      return `unavailable (${checks.reason ?? "preparation"} failed)`
    default:
      return "none"
  }
}

function runLine(run: CheckRecord): string {
  return `- ${checkLabel(run)}: ${runEnding(run)}`
}

function runEnding(run: CheckRecord): string {
  const seconds = secondsText(run.ms)
  if (run.outcome === "timeout") return `timed out after ${seconds}`
  return run.exitCode === 0 ? `passed in ${seconds}` : `failed (exit ${run.exitCode}) in ${seconds}`
}

function tailBlock(run: CheckRecord): string[] {
  const ending = run.outcome === "timeout" ? "timed out" : `exit ${run.exitCode}`
  const paths = run.paths.length === 0 ? "" : ` on ${run.paths.join(", ")}`
  const tail = run.tail.length > MOST_CHECK_TAIL_CHARS ? `…${run.tail.slice(-MOST_CHECK_TAIL_CHARS)}` : run.tail
  const fence = "`".repeat(Math.max(4, longestBacktickRun(tail) + 1))
  return ["", `<details><summary>${run.name}${paths}, ${ending}</summary>`, "", fence, tail, fence, "", "</details>"]
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
}

function verifyLines(verify: VerifyDisplay | undefined): string[] {
  if (verify?.kind !== "verified") return []
  const entries = verifyEntries(verify.report, verify.leftOut)
  if (entries.length === 0) return []
  return ["", `<details><summary>Verify: ${verifyCounts(verify.report)}</summary>`, "", ...entries, "", "</details>"]
}

function verifyEntries({ dropped, changed, notJudged }: VerifyReport, leftOut: readonly FindingInput[]): string[] {
  return [
    ...dropped.map(({ finding, reason }) => `- Dropped ${located(finding)}: ${oneLine(reason)}`),
    ...changed.map((change) => changeEntry(change, leftOut)),
    ...notJudged.map((finding) => `- Not judged: ${located(finding)}`),
  ]
}

function verifyCounts({ dropped, changed, notJudged }: VerifyReport): string {
  const parts: string[] = []
  if (dropped.length > 0) parts.push(`${dropped.length} dropped`)
  if (changed.length > 0) parts.push(`${changed.length} severity changed`)
  if (notJudged.length > 0) parts.push(`${notJudged.length} not judged`)
  return parts.join(", ")
}

function changeEntry({ finding, from, to, reason, revised }: Changed, leftOut: readonly FindingInput[]): string {
  const leftOutNote = leftOut.includes(revised) ? ", left out" : ""
  return `- ${located(finding)}: ${from} → ${to}${leftOutNote}: ${oneLine(reason)}`
}

function located(finding: FindingInput): string {
  return `${codeSpan(`${flattened(finding.path)}:${finding.line}`)} ${oneLine(finding.title)}`
}

export function mergeWalkthrough(
  stored: readonly WalkthroughInput[],
  incoming: readonly WalkthroughInput[],
  covered: ReadonlySet<string>,
): WalkthroughInput[] {
  const kept = normalisedRows(stored)
  const rows = normalisedRows(incoming)
  const replacements = new Map(rows.filter((row) => covered.has(row.path)).map((row) => [row.path, row]))
  const known = new Set(kept.map((row) => row.path))
  return [
    ...kept.map((row) => replacements.get(row.path) ?? row),
    ...[...replacements.values()].filter((row) => !known.has(row.path)),
  ]
}

function normalisedRows(rows: readonly WalkthroughInput[]): WalkthroughInput[] {
  return rows.map((row) => ({ ...row, path: rowPath(row.path) }))
}

function reviewedBy(
  model: string | undefined,
  skillsFingerprint: string | undefined,
  repoSkillsFingerprint: string | undefined,
  verify: VerifyDisplay | undefined,
): string[] {
  if (model === undefined || skillsFingerprint === undefined) return []
  const repo = repoSkillsFingerprint === undefined ? [] : [`repo@${repoSkillsFingerprint.slice(0, 8)}`]
  const skills = [`review@${skillsFingerprint.slice(0, 8)}`, ...repo].map((skill) => `\`${skill}\``).join(", ")
  const verifier = verify?.kind === "verified" ? ` · verified by \`${verify.model}\`` : ""
  return [`<sub>Reviewed by \`${model}\`${verifier} with skills ${skills}.</sub>`]
}

function unverifiedLines(verify: VerifyDisplay | undefined): string[] {
  if (verify?.kind !== "unverified") return []
  const reason = cut(flattened(verify.reason), MOST_UNVERIFIED_REASON_CHARS)
  return [`<sub>Not verified by \`${verify.model}\`: ${reason}.</sub>`]
}

function summarizedBy(model: string, skillsFingerprint: string): string {
  return `<sub>Summarized by \`${model}\` with skills \`summary@${skillsFingerprint.slice(0, 8)}\`.</sub>`
}

function spendLines(spend: ReviewSpend | undefined, sandboxSeconds: number | undefined): string[] {
  const line = spend === undefined ? undefined : spendLine(spend, sandboxSeconds)
  return line === undefined ? [] : [`<sub>${line}</sub>`]
}

function budgetNoteLines(note: string | undefined): string[] {
  return note === undefined ? [] : [note]
}

function linkedIssuesLine(numbers: readonly number[]): string {
  const listed = numbers.length === 0 ? "none" : numbers.map((number) => `#${number}`).join(", ")
  return `<sub>Linked issues: ${listed}</sub>`
}

function standardsLine(paths: readonly string[]): string {
  const listed = paths.length === 0 ? "none" : paths.map(codeSpan).join(", ")
  return `<sub>Standards: ${listed}</sub>`
}

function codeSpan(text: string): string {
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``
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

export function incompleteNote(missing: readonly string[]): string {
  const listed = missing
    .slice(0, MOST_MISSING_LISTED)
    .map((path) => `\`${path}\``)
    .join(", ")
  const unlisted = missing.length - MOST_MISSING_LISTED
  const rest = unlisted > 0 ? ` and ${unlisted} more` : ""
  return `_The review did not complete: no walkthrough row for ${listed}${rest}._`
}

export type RetryOutcome =
  | { kind: "unanswered" }
  | { kind: "failed"; reason: string }
  | { kind: "refused"; refusal: string }

export function renderUnpostedNote(written: WrittenReview, retry: RetryOutcome): string {
  const reason = `_The review couldn't be posted: the model didn't submit one that could be, ${askedAgain(retry)}._`
  return written.kind === "prose" && written.text !== "" ? `${reason}\n\n${written.text}` : reason
}

function askedAgain(retry: RetryOutcome): string {
  switch (retry.kind) {
    case "unanswered":
      return "even when asked again"
    case "failed":
      return `and asking again failed: ${retry.reason}`
    case "refused":
      return `and the host refused the review it submitted when asked again: ${retry.refusal.replace(/\s+/g, " ").replace(/\.$/, "")}`
  }
}

export function renderReviewBody(
  event: Verdict,
  accepted: readonly FindingInput[],
  rejected: readonly Rejected[],
  coverage?: Coverage,
  reasons: readonly ApprovalReason[] = [],
): string {
  const parts = [...findingsLines(event, accepted, rejected, reasons), coverageLine(coverage)]
  return parts.filter((part) => part !== undefined).join("\n\n")
}

function findingsLines(
  event: Verdict,
  accepted: readonly FindingInput[],
  rejected: readonly Rejected[],
  reasons: readonly ApprovalReason[],
): (string | undefined)[] {
  const held = heldBack(rejected)
  const summary = held !== undefined && accepted.length === 0 ? undefined : inlineSummary(event, accepted)
  return [summary, reasonLines(reasons), held]
}

function reasonLines(reasons: readonly ApprovalReason[]): string | undefined {
  if (reasons.length === 0) return undefined
  return ["Not approved because:", ...reasons.map((reason) => `- ${reasonLine(reason)}`)].join("\n")
}

function reasonLine(reason: ApprovalReason): string {
  switch (reason.kind) {
    case "omitted_requirement":
      return `#${reason.issue} asks for “${oneLine(reason.requirement)}”, and the diff leaves it out.`
    case "not_for_merging":
      return `The description says “${oneLine(reason.quote)}”.`
    case "budget_cut":
      return `The review stopped reading early at its budget of ${neurons(reason.budget)}; ask for a \`full review\` to review it in full.`
  }
}

function neurons(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "neuron" : "neurons"}`
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
  const blocking = rejected.filter(holdsApprovalBack)
  if (blocking.length === 0) return undefined
  return [
    `${blocking.length} blocking finding(s) couldn't be posted inline and hold approval back:`,
    ...blocking
      .slice(0, MOST_HELD_BACK_LISTED)
      .map(
        (r) =>
          `- **${clipped(r.finding.title, MOST_LISTED_CHARS)}** in \`${clipped(r.finding.path, MOST_LISTED_CHARS)}\``,
      ),
  ].join("\n")
}

function clipped(text: string, most: number): string {
  return cut(oneLine(text), most)
}

function cut(text: string, most: number): string {
  return text.length > most ? `${text.slice(0, most)}…` : text
}

function inlineSummary(event: Verdict, accepted: readonly FindingInput[]): string {
  if (accepted.length === 0) return noFindings(event)
  const line = countsLine(accepted)
  return event === "AWAITING_CHECKS" ? `${line} ${AWAITING_CHECKS_NOTE}.` : line
}

function noFindings(event: Verdict): string {
  if (event === "APPROVE")
    return "No findings. The change looks sound to me; a human review is still required to merge."
  if (event === "AWAITING_CHECKS") {
    return `No findings. The change looks sound to me; ${AWAITING_CHECKS_NOTE}, and a human review is still required to merge.`
  }
  if (event === "WITHHELD") {
    return "No findings. Approval is withheld for the reasons below; a human review is still required to merge."
  }
  return "No findings to anchor to the diff. See the summary comment."
}

function countsLine(accepted: readonly FindingInput[]): string {
  const counts = countBySeverity(accepted)
  const parts: string[] = []
  if (counts.blocking > 0) parts.push(`${counts.blocking} blocking finding(s) to address before approval`)
  if (counts.major > 0) parts.push(`${counts.major} major finding(s) worth fixing`)
  if (counts.suggestion > 0) parts.push(`${counts.suggestion} suggestion(s)`)
  if (counts.nitpick > 0) parts.push(`${counts.nitpick} nitpick(s)`)
  return `${parts.join(", ")}. Blocking findings are marked 🔴 and gate approval; the others don't.`
}

export interface ReviewDecisionInput {
  accepted: readonly FindingInput[]
  rejected: readonly Rejected[]
  workflow: boolean
  openBlocking: number | "unknown"
  reasons: readonly ApprovalReason[]
}

export function decideReviewVerdict(input: ReviewDecisionInput): Verdict {
  if (!input.workflow) return "COMMENT"
  if (holdsBlocking(input.accepted, input.rejected)) return "REQUEST_CHANGES"
  if (input.openBlocking !== "unknown" && input.openBlocking > 0) return "REQUEST_CHANGES"
  if (input.reasons.length > 0) return "WITHHELD"
  return input.openBlocking === "unknown" ? "AWAITING_CHECKS" : "APPROVE"
}

export function holdsApprovalBack({ finding, unfounded }: Rejected): boolean {
  return !unfounded && finding.severity === "blocking"
}

export function holdsBlocking(accepted: readonly FindingInput[], rejected: readonly Rejected[]): boolean {
  return countBySeverity(accepted).blocking > 0 || rejected.some(holdsApprovalBack)
}

function flattened(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function oneLine(text: string): string {
  return flattened(text).replace(/\|/g, "\\|")
}
