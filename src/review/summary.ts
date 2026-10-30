import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import type { ChangedFile } from "../github/diff.ts"
import { CONFIG_FILE } from "../repository/config.ts"
import { shortSha } from "../sha.ts"
import type { LastReview } from "./approval.ts"
import {
  jsonIn,
  rowPath,
  SummarySubmission,
  type MergeDangerInput,
  type SummarySubmissionInput,
  type WalkthroughInput,
} from "./findings.ts"
import { GRACE_MS, type Liveness } from "./flight.ts"
import type { ReviewedRecord } from "./incremental.ts"
import { VERDICT_LABEL, type VerdictLine } from "./render.ts"

export const Summarizing = Type.Object({
  deliveryId: Type.String(),
  operationId: Type.String(),
  started: Type.Integer(),
})

export type Summarizing = Static<typeof Summarizing>

export type WrittenSummary = { kind: "summary"; summary: SummarySubmissionInput } | { kind: "unusable"; reason: string }

export type SummaryOutcome =
  | { kind: "posted"; head: string; link: string | undefined }
  | { kind: "moved"; from: string; to: string }
  | { kind: "unusable"; reason: string }
  | { kind: "busy" }
  | { kind: "closed" }
  | { kind: "filtered" }

export function parseWrittenSummary(text: string): WrittenSummary {
  const json = jsonIn(text)
  if (json === undefined) return { kind: "unusable", reason: "the model didn't answer with a summary" }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return { kind: "unusable", reason: "the model's answer wasn't valid JSON" }
  }
  if (Value.Check(SummarySubmission, value)) return { kind: "summary", summary: value }
  const [first] = Value.Errors(SummarySubmission, value)
  return { kind: "unusable", reason: `the model's answer didn't fit: ${first?.instancePath || "/"}: ${first?.message}` }
}

export type SummarizedRecord = ReviewedRecord & { merge_danger: MergeDangerInput }

export function summarizedRecord(
  reviewed: ReviewedRecord,
  summary: SummarySubmissionInput,
  files: readonly ChangedFile[],
): SummarizedRecord {
  return {
    headSha: reviewed.headSha,
    baseRef: reviewed.baseRef,
    at: reviewed.at,
    mode: reviewed.mode,
    summary: summary.summary,
    walkthrough: summarizedRows(reviewed.walkthrough, summary.walkthrough, files),
    merge_danger: summary.merge_danger,
  }
}

function summarizedRows(
  stored: readonly WalkthroughInput[],
  written: readonly WalkthroughInput[],
  files: readonly ChangedFile[],
): WalkthroughInput[] {
  const rows = underRowPath(written)
  const answered = new Set(rows.map((row) => row.path))
  const changed = new Set(files.map((file) => file.filename))
  const kept = underRowPath(stored).filter((row) => changed.has(row.path) && !answered.has(row.path))
  return [...rows, ...kept]
}

function underRowPath(rows: readonly WalkthroughInput[]): WalkthroughInput[] {
  return rows.map((row) => ({ ...row, path: rowPath(row.path) }))
}

export function recordedVerdict(
  last: LastReview | undefined,
  reviewed: ReviewedRecord | undefined,
  headSha: string,
): VerdictLine {
  if (last === undefined) return { label: reviewed === undefined ? "Not reviewed yet" : "Not recorded" }
  const label = lastReviewLabel(last, headSha)
  return last.counts === undefined ? { label } : { label, counts: last.counts }
}

function lastReviewLabel(last: LastReview, headSha: string): string {
  if (approvedByEvaluation(last)) return atHead(VERDICT_LABEL.APPROVE, last.headSha)
  const label = VERDICT_LABEL[last.shown ?? last.event]
  return last.headSha === headSha ? label : atHead(label, last.headSha)
}

function approvedByEvaluation(last: LastReview): boolean {
  return last.event === "APPROVE" && last.shown === undefined && last.verdict === undefined
}

function atHead(label: string, headSha: string): string {
  return `${label} at \`${shortSha(headSha)}\``
}

export function summaryLive(record: Summarizing | undefined, liveness: Liveness): boolean {
  if (record === undefined) return false
  return liveness.running || liveness.now - record.started < GRACE_MS
}

export function summaryReply(outcome: SummaryOutcome, botLogin: string): string {
  switch (outcome.kind) {
    case "posted":
      return postedReply(outcome.head, outcome.link)
    case "moved":
      return `The head moved from \`${shortSha(outcome.from)}\` to \`${shortSha(outcome.to)}\` while I wrote the summary, so I didn't post it. Ask again with \`@${botLogin} summary\`.`
    case "unusable":
      return `I couldn't write the summary: ${outcome.reason}.`
    case "busy":
      return "A summary is already being written; it will update the comment when it's done."
    case "closed":
      return "The pull request is closed, so there's nothing to summarize."
    case "filtered":
      return `\`path_filters\` in \`${CONFIG_FILE}\` leave out every changed file, so there's nothing to summarize.`
  }
}

function postedReply(head: string, link: string | undefined): string {
  const summary = link === undefined ? "summary" : `[summary](${link})`
  return `Updated the ${summary} for \`${shortSha(head)}\`.`
}

export function oneClause(reason: string): string {
  return reason
    .replace(/\s+/g, " ")
    .replace(/[\s.]+$/, "")
    .trim()
}
