import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import { MAX_PATCH_CHARS, truncateAtLine } from "../github/diff.ts"
import {
  countBySeverity,
  exceedsBasisCap,
  jsonIn,
  Severity,
  type FindingInput,
  type Rejected,
  type ReviewSubmissionInput,
  type ValidatedReview,
} from "./findings.ts"
import type { ScopedReview } from "./incremental.ts"
import { dataBlock, fenceFor, MATERIAL_NOTE, neutraliseClosingTag, numberedLine } from "./prompt.ts"
import { holdsApprovalBack } from "./render.ts"

export const VerdictInput = Type.Object({
  finding: Type.String({ description: "The id the finding was listed under, such as F1." }),
  keep: Type.Boolean({ description: "true to keep the finding, false to drop it as wrong." }),
  severity: Severity,
  reason: Type.String({
    minLength: 1,
    description: "One line on why the finding stands or falls, and why at this severity.",
  }),
})

export type VerdictInput = Static<typeof VerdictInput>

export const VerdictsSubmission = Type.Object({ verdicts: Type.Array(VerdictInput) })

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
  return verdict === "request_changes" && hasBlockingFinding(before) && !hasBlockingFinding(after) ? "approve" : verdict
}

function hasBlockingFinding({ accepted, rejected }: ScopedReview): boolean {
  return countBySeverity(accepted).blocking > 0 || rejected.some(holdsApprovalBack)
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
