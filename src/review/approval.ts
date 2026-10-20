import { Type, type Static } from "typebox"
import type { CheckRunSummary, ReviewEvent } from "../github/client.ts"
import { countBySeverity, type FindingInput, type Rejected, type ReviewSubmissionInput } from "./findings.ts"
import type { ThreadPlan } from "./incremental.ts"
import { holdsApprovalBack } from "./render.ts"

export const LastReview = Type.Object({
  reviewId: Type.Integer(),
  event: Type.Union([Type.Literal("APPROVE"), Type.Literal("REQUEST_CHANGES"), Type.Literal("COMMENT")]),
  headSha: Type.String(),
  verdict: Type.Optional(
    Type.Union([Type.Literal("approve"), Type.Literal("request_changes"), Type.Literal("comment")]),
  ),
  heldBack: Type.Integer(),
  at: Type.Integer(),
})

export type LastReview = Static<typeof LastReview>

export type ChecksState = "passing" | "pending" | "failing" | "unknown"

export type WebhookTrigger = "thread_resolved" | "thread_unresolved" | "checks_completed"

export type ApprovalTrigger = WebhookTrigger | "review"

export type DecidedWait =
  | "workflow_off"
  | "paused"
  | "not_open"
  | "review_in_flight"
  | "not_reviewed"
  | "no_record"
  | "approved"
  | "review_stands"
  | "threads_unknown"
  | "blocking_threads"
  | "checks_unknown"
  | "checks_failing"
  | "checks_pending"

export type WaitReason = DecidedWait | "head_moved" | "approving"

export type ApprovalDecision = { kind: "approve" } | { kind: "wait"; reason: DecidedWait }

export interface ApprovalState {
  workflow: boolean
  paused: boolean
  open: boolean
  reviewInFlight: boolean
  headSha: string
  reviewedHead: string | undefined
  lastReview: LastReview | undefined
  openBlocking: number | "unknown"
  checks: ChecksState
}

export interface ReviewFacts {
  reviewId: number
  event: ReviewEvent
  headSha: string
  verdict: ReviewSubmissionInput["verdict"]
  rejected: readonly Rejected[]
  at: number
}

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"])

export function decideApproval(state: ApprovalState): ApprovalDecision {
  const reason = pullRequestWait(state) ?? recordWait(state.lastReview) ?? liveStateWait(state)
  return reason === undefined ? { kind: "approve" } : { kind: "wait", reason }
}

function pullRequestWait(state: ApprovalState): DecidedWait | undefined {
  if (!state.workflow) return "workflow_off"
  if (state.paused) return "paused"
  if (!state.open) return "not_open"
  if (state.reviewInFlight) return "review_in_flight"
  if (state.reviewedHead !== state.headSha) return "not_reviewed"
  return undefined
}

function recordWait(last: LastReview | undefined): DecidedWait | undefined {
  if (last === undefined) return "no_record"
  if (last.event === "APPROVE") return "approved"
  if (!awaitsApproval(last)) return "review_stands"
  return undefined
}

function liveStateWait(state: ApprovalState): DecidedWait | undefined {
  if (state.openBlocking === "unknown") return "threads_unknown"
  if (state.openBlocking > 0) return "blocking_threads"
  return checksWait(state.checks)
}

function checksWait(checks: ChecksState): DecidedWait | undefined {
  switch (checks) {
    case "unknown":
      return "checks_unknown"
    case "failing":
      return "checks_failing"
    case "pending":
      return "checks_pending"
    case "passing":
      return undefined
  }
}

export function awaitsApproval(last: LastReview): boolean {
  if (last.heldBack > 0) return false
  return last.event === "REQUEST_CHANGES" || (last.event === "COMMENT" && last.verdict === "approve")
}

export function checksState(runs: readonly CheckRunSummary[], botLogin: string): Exclude<ChecksState, "unknown"> {
  const others = runs.filter((run) => run.app !== botLogin)
  if (others.some(completedWithoutPassing)) return "failing"
  if (others.some((run) => run.status !== "completed")) return "pending"
  return "passing"
}

function completedWithoutPassing(run: CheckRunSummary): boolean {
  return run.status === "completed" && !PASSING_CONCLUSIONS.has(run.conclusion ?? "")
}

export function openBlockingIn(plan: ThreadPlan | undefined): number | "unknown" {
  if (plan === undefined) return "unknown"
  return plan.open.filter((thread) => thread.blocking).length
}

export function lastReviewOf(facts: ReviewFacts): LastReview {
  return {
    reviewId: facts.reviewId,
    event: facts.event,
    headSha: facts.headSha,
    verdict: facts.verdict,
    heldBack: facts.rejected.filter(holdsApprovalBack).length,
    at: facts.at,
  }
}

export function evaluatesAfterReview(event: ReviewEvent, accepted: readonly FindingInput[]): boolean {
  return event !== "APPROVE" && countBySeverity(accepted).blocking === 0
}
