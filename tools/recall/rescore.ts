import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import { Finding, ReviewSubmission } from "../../src/review/findings.ts"
import type { ReviewAnswer } from "./conversation.ts"
import type { HeadCase, RecallSet } from "./schema.ts"
import { scoreRun, scoreSet, SetScore, type RunScore } from "./score.ts"

const Rejected = Type.Object({ finding: Finding, reason: Type.String(), unfounded: Type.Boolean() })

const PostedReview = Type.Object({
  submission: ReviewSubmission,
  accepted: Type.Array(Finding),
  rejected: Type.Array(Rejected),
})

const ReviewSource = Type.Union([
  Type.Literal("tool"),
  Type.Literal("text"),
  Type.Literal("retry"),
  Type.Literal("retry_text"),
])

const UnpostedReason = Type.Union([
  Type.Literal("prose"),
  Type.Literal("unfit"),
  Type.Literal("incomplete"),
  Type.Literal("budget"),
  Type.Literal("turns"),
  Type.Literal("error"),
])

const RecordedAnswer = Type.Object({
  posted: Type.Optional(PostedReview),
  source: Type.Optional(ReviewSource),
  reason: Type.Optional(UnpostedReason),
  failure: Type.Optional(Type.String()),
  calls: Type.Number(),
  inputTokens: Type.Number(),
  outputTokens: Type.Number(),
  usd: Type.Number(),
  neurons: Type.Number(),
})
type RecordedAnswer = Static<typeof RecordedAnswer>

export const RunMeta = Type.Object({
  model: Type.String(),
  thinking: Type.String(),
  skills: Type.String(),
  maxOutputTokens: Type.Integer(),
  maxReviewNeurons: Type.Integer(),
  runs: Type.Integer(),
  at: Type.String(),
  partial: Type.Boolean(),
})
export type RunMeta = Static<typeof RunMeta>

export const ResultsRow = Type.Object({ head: Type.String(), run: Type.Integer(), answer: RecordedAnswer })
export type ResultsRow = Static<typeof ResultsRow>

export const ResultsFile = Type.Object({ meta: RunMeta, score: SetScore, runs: Type.Array(ResultsRow) })
export type ResultsFile = Static<typeof ResultsFile>

export interface Rescored {
  meta: RunMeta
  score: SetScore
  runs: RunScore[]
}

export function parseResults(text: string): ResultsFile {
  const value = JSON.parse(text)
  if (!Value.Check(ResultsFile, value)) throw new Error("The file is not a recall results file")
  return value
}

const answerOf = (recorded: RecordedAnswer): ReviewAnswer => ({
  ...recorded,
  posted: recorded.posted,
  source: recorded.source,
})

function headOf(set: RecallSet, sha: string): HeadCase {
  const head = set.heads.find((candidate) => candidate.head === sha)
  if (head === undefined) throw new Error(`${sha} is not in the set`)
  return head
}

export function rescoreRuns(set: RecallSet, rows: readonly ResultsRow[]): RunScore[] {
  return rows.map((row) => scoreRun(headOf(set, row.head), row.run, answerOf(row.answer)))
}

export function rescore(set: RecallSet, results: ResultsFile): Rescored {
  const runs = rescoreRuns(set, results.runs)
  const { model, thinking, skills } = results.meta
  const score = scoreSet(set, runs, { model, thinking, skills })
  return { meta: { ...results.meta, partial: score.partial }, score, runs }
}
