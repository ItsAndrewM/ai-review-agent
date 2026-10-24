import type { PiOperationResult } from "agents/harness/pi"
import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import { MAX_PATCH_CHARS, truncateAtLine, type ChangedFile } from "../github/diff.ts"
import { errorText, type LogFields } from "../log.ts"
import { describeFailure, type TranscriptEntry } from "./failure.ts"
import {
  exceedsBasisCap,
  jsonIn,
  Severity,
  type FindingInput,
  type Rejected,
  type ReviewSubmissionInput,
  type ValidatedReview,
} from "./findings.ts"
import { applyDeltaPolicy, type DeltaScope, type ScopedReview } from "./incremental.ts"
import type { LinkedIssue } from "./linked-issues.ts"
import { dataBlock, fenceFor, MATERIAL_NOTE, neutraliseClosingTag, numberedLine } from "./prompt.ts"
import { holdsApprovalBack, holdsBlocking, type VerifyDisplay } from "./render.ts"

const MAX_REASON_CHARS = 300

export const VerdictInput = Type.Object({
  finding: Type.String({ description: "The finding's id, as the prompt lists it: F1, F2 and so on." }),
  keep: Type.Boolean({ description: "true keeps the finding; false drops it as wrong." }),
  severity: Severity,
  reason: Type.String({
    minLength: 1,
    maxLength: MAX_REASON_CHARS,
    description: `One line, at most ${MAX_REASON_CHARS} characters: why the finding stands or falls, and why at this severity.`,
  }),
})

export type VerdictInput = Static<typeof VerdictInput>

export const VerdictsSubmission = Type.Object({ verdicts: Type.Array(VerdictInput) })

export const VerifySessionId = Type.String()

export interface VerifyCandidate {
  id: string
  finding: FindingInput
  held: boolean
}

export interface FindingContext {
  candidate: VerifyCandidate
  window: string | undefined
  patch: string | undefined
  issue: string | undefined
}

export interface Judged {
  finding: FindingInput
  reason: string
}

export interface Changed extends Judged {
  from: FindingInput["severity"]
  to: FindingInput["severity"]
  revised: FindingInput
}

export interface VerifyReport {
  dropped: Judged[]
  changed: Changed[]
  capped: Judged[]
  notJudged: FindingInput[]
  unknown: string[]
}

export interface AppliedVerdicts {
  validated: ValidatedReview
  report: VerifyReport
}

type Decision =
  | { kind: "kept" }
  | { kind: "not_judged" }
  | { kind: "dropped"; reason: string }
  | { kind: "capped"; reason: string }
  | { kind: "changed"; revised: FindingInput; reason: string }

interface Decided {
  finding: FindingInput
  decision: Decision
}

export function verifyCandidates(scoped: ScopedReview): VerifyCandidate[] {
  const posted = scoped.accepted.filter((finding) => finding.severity !== "nitpick")
  const heldBack = scoped.rejected.filter(holdsApprovalBack)
  const found = [
    ...posted.map((finding) => ({ finding, held: false })),
    ...heldBack.map(({ finding }) => ({ finding, held: true })),
  ]
  return found.map((candidate, index) => ({ id: `F${index + 1}`, ...candidate }))
}

export function applyVerdicts(
  validated: ValidatedReview,
  candidates: readonly VerifyCandidate[],
  verdicts: readonly VerdictInput[],
): AppliedVerdicts {
  const { byId, unknown } = firstVerdicts(candidates, verdicts)
  const decided = candidates.map(({ id, finding }) => ({ finding, decision: decide(finding, byId.get(id)) }))
  return { validated: withDecisions(validated, decided), report: reportOf(decided, unknown) }
}

export function verdictAfterVerify(
  verdict: ReviewSubmissionInput["verdict"],
  before: ScopedReview,
  after: ScopedReview,
): ReviewSubmissionInput["verdict"] {
  if (verdict !== "request_changes") return verdict
  const cleared = holdsBlocking(before.accepted, before.rejected) && !holdsBlocking(after.accepted, after.rejected)
  return cleared ? "approve" : verdict
}

export interface VerifyDraft {
  validated: ValidatedReview
  scoped: ScopedReview
  scope: DeltaScope
  candidates: readonly VerifyCandidate[]
}

export interface Verified {
  scoped: ScopedReview
  verdict: ReviewSubmissionInput["verdict"]
  report: VerifyReport
  leftOut: FindingInput[]
}

export function verifiedReview(
  draft: VerifyDraft,
  verdicts: readonly VerdictInput[],
  verdict: ReviewSubmissionInput["verdict"],
): Verified {
  const applied = applyVerdicts(draft.validated, draft.candidates, verdicts)
  const scoped = applyDeltaPolicy(applied.validated, draft.scope)
  return {
    scoped,
    verdict: verdictAfterVerify(verdict, draft.scoped, scoped),
    report: applied.report,
    leftOut: leftOutOf(applied.report, scoped),
  }
}

export function leftOutOf(report: VerifyReport, scoped: ScopedReview): FindingInput[] {
  const setAside = new Set([...scoped.rejected, ...scoped.duplicates].map(({ finding }) => finding))
  return report.changed.map(({ revised }) => revised).filter((revised) => setAside.has(revised))
}

function firstVerdicts(candidates: readonly VerifyCandidate[], verdicts: readonly VerdictInput[]) {
  const known = new Set(candidates.map((candidate) => candidate.id))
  const byId = new Map<string, VerdictInput>()
  const unknown: string[] = []
  for (const verdict of verdicts) {
    if (known.has(verdict.finding) && !byId.has(verdict.finding)) byId.set(verdict.finding, verdict)
    else unknown.push(verdict.finding)
  }
  return { byId, unknown }
}

function decide(finding: FindingInput, verdict: VerdictInput | undefined): Decision {
  if (verdict === undefined) return { kind: "not_judged" }
  const { reason } = verdict
  if (!verdict.keep) return { kind: "dropped", reason }
  if (verdict.severity === finding.severity) return { kind: "kept" }
  const revised = { ...finding, severity: verdict.severity }
  return exceedsBasisCap(revised) ? { kind: "capped", reason } : { kind: "changed", revised, reason }
}

function withDecisions(validated: ValidatedReview, decided: readonly Decided[]): ValidatedReview {
  const decisions = new Map(decided.map(({ finding, decision }) => [finding, decision]))
  return {
    ...validated,
    accepted: validated.accepted.flatMap((finding) => afterDecision(finding, decisions)),
    rejected: validated.rejected.flatMap((rejection) => rejectionAfterDecision(rejection, decisions)),
  }
}

function afterDecision(finding: FindingInput, decisions: ReadonlyMap<FindingInput, Decision>): FindingInput[] {
  const decision = decisions.get(finding)
  if (decision?.kind === "dropped") return []
  return [decision?.kind === "changed" ? decision.revised : finding]
}

function rejectionAfterDecision(rejection: Rejected, decisions: ReadonlyMap<FindingInput, Decision>): Rejected[] {
  return afterDecision(rejection.finding, decisions).map((finding) =>
    finding === rejection.finding ? rejection : { ...rejection, finding },
  )
}

function reportOf(decided: readonly Decided[], unknown: string[]): VerifyReport {
  const report: VerifyReport = { dropped: [], changed: [], capped: [], notJudged: [], unknown }
  for (const { finding, decision } of decided) {
    if (decision.kind === "dropped") report.dropped.push({ finding, reason: decision.reason })
    else if (decision.kind === "capped") report.capped.push({ finding, reason: decision.reason })
    else if (decision.kind === "not_judged") report.notJudged.push(finding)
    else if (decision.kind === "changed")
      report.changed.push({
        finding,
        reason: decision.reason,
        from: finding.severity,
        to: decision.revised.severity,
        revised: decision.revised,
      })
  }
  return report
}

export const VERIFY_RADIUS = 40

const VERIFY_REQUEST = `Judge these draft findings by the verify skill in your instructions, and submit your verdicts with submit_verdicts. ${MATERIAL_NOTE}`

const HELD_NOTE =
  "held back: it couldn't be placed inline; judge its claim on the code, not on whether its quote appears in the window."

export function citedWindow(content: string, line: number, startLine: number | undefined, radius: number): string {
  const first = Math.max(1, Math.min(startLine ?? line, line) - radius)
  return content
    .split("\n")
    .slice(first - 1, line + radius)
    .map((text, index) => numberedLine(first + index, text))
    .join("\n")
}

export function verifyPrompt(contexts: readonly FindingContext[]): string {
  const sections = [...contexts.map(candidateSection), ...patchesSection(contexts)]
  return [VERIFY_REQUEST, dataBlock(sections.map(neutraliseClosingTag))].join("\n\n")
}

function candidateSection({ candidate, window, issue }: FindingContext): string {
  const { id, finding, held } = candidate
  const sections = [
    `## ${id}\n${findingFields(finding, held)}`,
    `basis:\n${finding.basis}`,
    `body:\n${finding.body}`,
    windowSection(finding.side, window),
  ]
  if (finding.basis_kind === "spec" && issue !== undefined) sections.push(`linked issue:\n${issue}`)
  return sections.join("\n\n")
}

function findingFields(
  { path, line, start_line, side, severity, basis_kind, title, quote }: FindingInput,
  held: boolean,
): string {
  const fields = [`path: ${path}`, `line: ${line}`]
  if (start_line !== undefined) fields.push(`start_line: ${start_line}`)
  fields.push(
    `side: ${side ?? "RIGHT"}`,
    `severity: ${severity}`,
    `basis_kind: ${basis_kind}`,
    `title: ${title}`,
    `quote: ${quote}`,
  )
  if (held) fields.push(HELD_NOTE)
  return fields.join("\n")
}

function patchesSection(contexts: readonly FindingContext[]): string[] {
  const patches = patchesByPath(contexts)
  if (patches.size === 0) return []
  const files = [...patches].map(
    ([path, patch]) => `### ${path}\n${fenced(truncateAtLine(patch, MAX_PATCH_CHARS), "diff")}`,
  )
  return [["## Patches", ...files].join("\n\n")]
}

function patchesByPath(contexts: readonly FindingContext[]): Map<string, string> {
  const patches = new Map<string, string>()
  for (const { candidate, patch } of contexts) {
    const { path } = candidate.finding
    if (patch !== undefined && !patches.has(path)) patches.set(path, patch)
  }
  return patches
}

function windowSection(side: FindingInput["side"], window: string | undefined): string {
  const heading = `window (${side === "LEFT" ? "base" : "head"}):`
  return window === undefined ? `${heading} file unavailable` : `${heading}\n${fenced(window, "")}`
}

function fenced(text: string, language: string): string {
  const fence = fenceFor(text)
  return `${fence}${language}\n${text}\n${fence}`
}

type FileRef = "head" | "base"

export interface ContextSources {
  files: readonly ChangedFile[]
  read(path: string, ref: FileRef): Promise<string | undefined>
  unreadable(path: string, ref: FileRef, error: string): void
  issue: string | undefined
}

export function findingContexts(
  candidates: readonly VerifyCandidate[],
  sources: ContextSources,
): Promise<FindingContext[]> {
  const contents = new Map<string, Promise<string | undefined>>()
  const contentOf = (path: string, ref: FileRef): Promise<string | undefined> => {
    const key = `${ref}:${path}`
    const read = contents.get(key) ?? readOrNothing(sources, path, ref)
    contents.set(key, read)
    return read
  }
  return Promise.all(
    candidates.map(async (candidate) => {
      const { path, side } = candidate.finding
      return contextOf(candidate, await contentOf(path, side === "LEFT" ? "base" : "head"), sources)
    }),
  )
}

async function readOrNothing(sources: ContextSources, path: string, ref: FileRef): Promise<string | undefined> {
  try {
    return await sources.read(path, ref)
  } catch (cause) {
    sources.unreadable(path, ref, errorText(cause))
    return undefined
  }
}

function contextOf(candidate: VerifyCandidate, content: string | undefined, sources: ContextSources): FindingContext {
  const { path, line, start_line, basis_kind } = candidate.finding
  return {
    candidate,
    window: content === undefined ? undefined : citedWindow(content, line, start_line, VERIFY_RADIUS),
    patch: sources.files.find((file) => file.filename === path)?.patch,
    issue: basis_kind === "spec" ? sources.issue : undefined,
  }
}

export function linkedIssueText(issues: readonly LinkedIssue[]): string | undefined {
  if (issues.length === 0) return undefined
  return issues
    .map(({ number, title, body, cut }) => `#${number}: ${title}\n${body}${cut ? "\n(cut)" : ""}`)
    .join("\n\n")
}

export function parseVerdictsText(text: string): VerdictInput[] | undefined {
  const json = jsonIn(text)
  if (json === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!Value.Check(VerdictsSubmission, value)) return undefined
  return value.verdicts.length === 0 ? undefined : value.verdicts
}

export type VerifyFailure = "model" | "answer" | "backstop"

export type VerifyAttempt =
  | { kind: "verdicts"; verdicts: VerdictInput[] }
  | { kind: "failed"; failure: VerifyFailure; reason: string }

export type VerifyResult = PiOperationResult & { messages?: readonly TranscriptEntry[] }

const MOST_QUOTED_ANSWER_CHARS = 500

export function attemptOf(submitted: readonly VerdictInput[] | undefined, result: VerifyResult): VerifyAttempt {
  if (submitted !== undefined) return submittedAttempt(submitted)
  if (result.status !== "done") return { kind: "failed", failure: "model", reason: describeFailure(result) }
  const text = result.text ?? ""
  const verdicts = parseVerdictsText(text)
  if (verdicts === undefined) return { kind: "failed", failure: "answer", reason: unusableText(text) }
  return { kind: "verdicts", verdicts }
}

function submittedAttempt(submitted: readonly VerdictInput[]): VerifyAttempt {
  if (submitted.length === 0) {
    return { kind: "failed", failure: "answer", reason: "submit_verdicts was called with no verdicts" }
  }
  return { kind: "verdicts", verdicts: [...submitted] }
}

function unusableText(text: string): string {
  const answer = text.trim()
  if (answer === "") return "no submit_verdicts call, and no text"
  const quoted = answer.length > MOST_QUOTED_ANSWER_CHARS ? `${answer.slice(0, MOST_QUOTED_ANSWER_CHARS)}…` : answer
  return `no submit_verdicts call, and no verdicts in the text: ${quoted}`
}

export const VERIFY_BACKSTOP_MS = 900_000

const MS_PER_MINUTE = 60_000

export type UnverifiedCause = VerifyFailure | "budget"

const UNVERIFIED_REASONS = {
  model: "the model call failed",
  answer: "no usable answer",
  backstop: noAnswerWithin(VERIFY_BACKSTOP_MS),
  budget: "the review spent its budget",
} satisfies Record<UnverifiedCause, string>

export function unverifiedDisplay(model: string, cause: UnverifiedCause): VerifyDisplay {
  return { kind: "unverified", model, reason: UNVERIFIED_REASONS[cause] }
}

export function backstopTimer(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => clearTimeout(timeout), { once: true })
  })
}

export async function whileUnsettled<T>(signal: AbortSignal, onAbort: () => void, work: () => Promise<T>): Promise<T> {
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    return await work()
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

export async function verifyWithRetry(
  attempt: (n: 1 | 2, signal: AbortSignal) => Promise<VerifyAttempt>,
  backstopMs: number,
  timer: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<VerifyAttempt & { attempts: number }> {
  const first = await withinBackstop((signal) => attempt(1, signal), backstopMs, timer)
  if (first.kind === "verdicts") return { ...first, attempts: 1 }
  const second = await withinBackstop((signal) => attempt(2, signal), backstopMs, timer)
  return { ...second, attempts: 2 }
}

async function withinBackstop(
  run: (signal: AbortSignal) => Promise<VerifyAttempt>,
  backstopMs: number,
  timer: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<VerifyAttempt> {
  const clock = new AbortController()
  const work = new AbortController()
  const backstop = timer(backstopMs, clock.signal).then(() => backstopFailure(backstopMs))
  try {
    return await Promise.race([attemptOrFailed(() => run(work.signal)), backstop])
  } finally {
    clock.abort()
    work.abort()
  }
}

export async function attemptOrFailed(run: () => Promise<VerifyAttempt>): Promise<VerifyAttempt> {
  try {
    return await run()
  } catch (cause) {
    return { kind: "failed", failure: "model", reason: errorText(cause) }
  }
}

function backstopFailure(backstopMs: number): VerifyAttempt {
  return { kind: "failed", failure: "backstop", reason: backstopReason(backstopMs) }
}

export function backstopReason(backstopMs: number): string {
  return `backstop: ${noAnswerWithin(backstopMs)}`
}

function noAnswerWithin(ms: number): string {
  return `no answer in ${ms / MS_PER_MINUTE} minutes`
}

const SEVERITY_RANK = { nitpick: 0, suggestion: 1, blocking: 2 } satisfies Record<FindingInput["severity"], number>

export function verdictFields(
  candidates: readonly VerifyCandidate[],
  verdicts: readonly VerdictInput[],
  report: VerifyReport,
): LogFields[] {
  const findings = new Map(candidates.map(({ id, finding }) => [id, finding]))
  const capped = new Set(report.capped.map(({ finding }) => finding))
  const applied = new Set<string>()
  return verdicts.map(({ finding: id, keep, severity, reason }) => {
    const finding = findings.get(id)
    const ignored = finding === undefined || applied.has(id)
    applied.add(id)
    return {
      id,
      path: finding?.path,
      line: finding?.line,
      keep,
      from: finding?.severity,
      to: severity,
      capped: !ignored && finding !== undefined && capped.has(finding),
      ignored,
      reason,
    }
  })
}

export function verifyCounts(candidates: readonly VerifyCandidate[], report: VerifyReport): LogFields {
  const promoted = report.changed.filter(({ from, to }) => SEVERITY_RANK[to] > SEVERITY_RANK[from]).length
  return {
    kept: candidates.length - report.dropped.length - report.notJudged.length,
    dropped: report.dropped.length,
    promoted,
    demoted: report.changed.length - promoted,
    capped: report.capped.length,
    notJudged: report.notJudged.length,
    unknown: report.unknown.length,
  }
}
