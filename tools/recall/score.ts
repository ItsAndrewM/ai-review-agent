import { Type, type Static } from "typebox"
import type { FindingInput, ReviewSubmissionInput } from "../../src/review/findings.ts"
import type { ReviewAnswer } from "./conversation.ts"
import { regexOf, type ExpectedFinding, type HeadCase, type KnownFinding, type RecallSet } from "./schema.ts"

export interface Match {
  expected: string
  finding: FindingInput
  distance: number
}

export interface UnmatchedFinding {
  finding: FindingInput
  standing: "allowed" | "known_false" | "false"
  known?: string
}

export interface Matching {
  matches: Match[]
  unmatched: UnmatchedFinding[]
}

export interface RunScore {
  head: string
  run: number
  answer: ReviewAnswer
  matches: Match[]
  unmatched: UnmatchedFinding[]
  verdict: ReviewSubmissionInput["verdict"] | undefined
  summaryMatched: boolean | undefined
}

export const ExpectedScore = Type.Object({
  id: Type.String(),
  found: Type.Boolean(),
  foundIn: Type.Integer(),
  severityMatched: Type.Boolean(),
  runs: Type.Integer(),
})
export type ExpectedScore = Static<typeof ExpectedScore>

export const FalseCounts = Type.Object({
  blocking: Type.Integer(),
  suggestion: Type.Integer(),
  nitpick: Type.Integer(),
})
export type FalseCounts = Static<typeof FalseCounts>

export const HeadScore = Type.Object({
  head: Type.String(),
  expects: Type.Array(ExpectedScore),
  falseBySeverity: FalseCounts,
  verdictMatched: Type.Boolean(),
  summaryMatched: Type.Optional(Type.Boolean()),
  notPosted: Type.Integer(),
})
export type HeadScore = Static<typeof HeadScore>

export const SetScore = Type.Object({
  model: Type.String(),
  thinking: Type.String(),
  skills: Type.String(),
  found: Type.Integer(),
  expected: Type.Integer(),
  falseCount: Type.Integer(),
  severityMatched: Type.Integer(),
  verdictMatched: Type.Integer(),
  heads: Type.Array(HeadScore),
  usd: Type.Number(),
  costPerReview: Type.Number(),
  reviews: Type.Integer(),
  partial: Type.Boolean(),
})
export type SetScore = Static<typeof SetScore>

export interface BarVerdict {
  adopted: boolean
  reasons: string[]
}

const SEVERITIES = ["blocking", "suggestion", "nitpick"] as const

function describes(pattern: string, finding: FindingInput): boolean {
  const regex = regexOf(pattern)
  return regex.test(finding.title) || regex.test(finding.body) || regex.test(finding.basis)
}

function distanceTo(expected: ExpectedFinding, finding: FindingInput): number {
  const [start, end] = expected.lines
  if (finding.line >= start && finding.line <= end) return 0
  return Math.min(Math.abs(finding.line - start), Math.abs(finding.line - end))
}

function nearest(expected: ExpectedFinding, candidates: readonly FindingInput[]): Match | undefined {
  let best: Match | undefined
  for (const finding of candidates) {
    if (finding.path !== expected.path || !describes(expected.pattern, finding)) continue
    const distance = distanceTo(expected, finding)
    if (best === undefined || distance < best.distance) best = { expected: expected.id, finding, distance }
  }
  return best
}

function knownOf(known: readonly KnownFinding[], finding: FindingInput): KnownFinding | undefined {
  return known.find((entry) => entry.path === finding.path && describes(entry.pattern, finding))
}

function standingOf(head: HeadCase, finding: FindingInput): UnmatchedFinding {
  const allowed = knownOf(head.allowed, finding)
  if (allowed !== undefined) return { finding, standing: "allowed", known: allowed.id }
  const knownFalse = knownOf(head.knownFalse, finding)
  if (knownFalse !== undefined) return { finding, standing: "known_false", known: knownFalse.id }
  return { finding, standing: "false" }
}

export function matchFindings(head: HeadCase, findings: readonly FindingInput[]): Matching {
  const remaining = [...findings]
  const matches: Match[] = []
  for (const expected of head.expects) {
    const match = nearest(expected, remaining)
    if (match === undefined) continue
    matches.push(match)
    remaining.splice(remaining.indexOf(match.finding), 1)
  }
  return { matches, unmatched: remaining.map((finding) => standingOf(head, finding)) }
}

export function scoreRun(head: HeadCase, run: number, answer: ReviewAnswer): RunScore {
  if (answer.posted === undefined) {
    return { head: head.head, run, answer, matches: [], unmatched: [], verdict: undefined, summaryMatched: undefined }
  }
  const { submission, accepted } = answer.posted
  const summaryMatched = head.summary === undefined ? undefined : regexOf(head.summary).test(submission.summary)
  return { head: head.head, run, answer, ...matchFindings(head, accepted), verdict: submission.verdict, summaryMatched }
}

function majority(count: number, runs: number): boolean {
  return count * 2 > runs
}

function expectedScore(expected: ExpectedFinding, runs: readonly RunScore[]): ExpectedScore {
  const matched = runs.map((run) => run.matches.find((match) => match.expected === expected.id))
  const foundIn = matched.filter((match) => match !== undefined).length
  const severityIn = matched.filter((match) => match?.finding.severity === expected.severity).length
  return {
    id: expected.id,
    found: majority(foundIn, runs.length),
    foundIn,
    severityMatched: majority(severityIn, runs.length),
    runs: runs.length,
  }
}

function median(counts: readonly number[]): number {
  const sorted = [...counts].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0
}

function falseBySeverity(runs: readonly RunScore[]): FalseCounts {
  const counts: FalseCounts = { blocking: 0, suggestion: 0, nitpick: 0 }
  for (const severity of SEVERITIES) {
    counts[severity] = median(
      runs.map(
        (run) =>
          run.unmatched.filter((entry) => entry.standing === "false" && entry.finding.severity === severity).length,
      ),
    )
  }
  return counts
}

function majorityOf(values: readonly (boolean | undefined)[]): boolean | undefined {
  const known = values.filter((value) => value !== undefined)
  return known.length === 0 ? undefined : majority(known.filter(Boolean).length, values.length)
}

function headScore(head: HeadCase, runs: readonly RunScore[]): HeadScore {
  const verdicts = runs.filter((run) => run.verdict === head.verdict).length
  const score: HeadScore = {
    head: head.head,
    expects: head.expects.map((expected) => expectedScore(expected, runs)),
    falseBySeverity: falseBySeverity(runs),
    verdictMatched: majority(verdicts, runs.length),
    notPosted: runs.filter((run) => run.answer.posted === undefined).length,
  }
  const summaryMatched = head.summary === undefined ? undefined : majorityOf(runs.map((run) => run.summaryMatched))
  return summaryMatched === undefined ? score : { ...score, summaryMatched }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

export function scoreSet(
  set: RecallSet,
  runs: readonly RunScore[],
  meta: Pick<SetScore, "model" | "thinking" | "skills">,
  runsPerHead: number,
): SetScore {
  const heads = set.heads.flatMap((head) => {
    const own = runs.filter((run) => run.head === head.head)
    return own.length === 0 ? [] : [headScore(head, own)]
  })
  const expects = heads.flatMap((head) => head.expects)
  const usd = sum(runs.map((run) => run.answer.usd))
  return {
    ...meta,
    found: expects.filter((expected) => expected.found).length,
    expected: expects.length,
    falseCount: sum(heads.map((head) => sum(SEVERITIES.map((severity) => head.falseBySeverity[severity])))),
    severityMatched: expects.filter((expected) => expected.severityMatched).length,
    verdictMatched: heads.filter((head) => head.verdictMatched).length,
    heads,
    usd,
    costPerReview: runs.length === 0 ? 0 : usd / runs.length,
    reviews: runs.length,
    partial: heads.length < set.heads.length || runs.length < heads.length * runsPerHead,
  }
}

export function barVerdict(baseline: SetScore, candidate: SetScore): BarVerdict {
  const reasons: string[] = []
  if (candidate.found < baseline.found) reasons.push(`found ${candidate.found} < ${baseline.found}`)
  if (candidate.falseCount > baseline.falseCount) reasons.push(`false ${candidate.falseCount} > ${baseline.falseCount}`)
  const adopted = reasons.length === 0
  reasons.push(`cost per review $${candidate.costPerReview.toFixed(4)} vs $${baseline.costPerReview.toFixed(4)}`)
  return { adopted, reasons }
}
