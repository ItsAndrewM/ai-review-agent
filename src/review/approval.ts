import { Type, type Static } from "typebox"
import type { CheckRunSummary, ReviewEvent } from "../github/client.ts"
import { SeverityCounts } from "../records.ts"
import { configStatus, requestChangesWorkflow, type ConfigRead, type ReviewTrigger } from "../repository/config.ts"
import { countBySeverity, type FindingInput, type Rejected } from "./findings.ts"
import type { ThreadPlan } from "./incremental.ts"
import { holdsApprovalBack, type Verdict } from "./render.ts"

export const ShownVerdict = Type.Union([
  Type.Literal("APPROVE"),
  Type.Literal("REQUEST_CHANGES"),
  Type.Literal("COMMENT"),
  Type.Literal("AWAITING_CHECKS"),
  Type.Literal("WITHHELD"),
])

export const LastReview = Type.Object({
  reviewId: Type.Integer(),
  event: Type.Union([Type.Literal("APPROVE"), Type.Literal("REQUEST_CHANGES"), Type.Literal("COMMENT")]),
  headSha: Type.String(),
  verdict: Type.Optional(
    Type.Union([Type.Literal("approve"), Type.Literal("request_changes"), Type.Literal("comment")]),
  ),
  shown: Type.Optional(ShownVerdict),
  counts: Type.Optional(SeverityCounts),
  heldBack: Type.Integer(),
  withheld: Type.Optional(Type.Integer()),
  at: Type.Integer(),
  requestChangesWorkflow: Type.Optional(Type.Boolean()),
})

export type LastReview = Static<typeof LastReview>

export type ChecksState = "passing" | "pending" | "failing" | "unknown"

export type WorkflowState = boolean | "unknown"

export type WebhookTrigger = "thread_resolved" | "thread_unresolved" | "checks_completed"

export type ApprovalTrigger = WebhookTrigger | "review" | "already_reviewed" | "resolve" | "resume" | "recheck"

export type DecidedWait =
  | "workflow_unknown"
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

export type ApprovalOutcome =
  | { kind: "approved"; head: string }
  | { kind: "wait"; reason: WaitReason }
  | { kind: "failed"; transient: boolean }

export interface ApprovalState {
  workflow: WorkflowState
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
  withheld: number
  shown: Verdict
  accepted: readonly FindingInput[]
  rejected: readonly Rejected[]
  at: number
  requestChangesWorkflow: boolean
}

export interface EvaluatedApproval {
  reviewId: number
  headSha: string
  at: number
}

export interface PullRequestStanding {
  state: string
  draft?: boolean | undefined
}

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"])

export function decideApproval(state: ApprovalState): ApprovalDecision {
  const reason = pullRequestWait(state) ?? recordWait(state.lastReview) ?? liveStateWait(state)
  return reason === undefined ? { kind: "approve" } : { kind: "wait", reason }
}

function pullRequestWait(state: ApprovalState): DecidedWait | undefined {
  if (state.workflow === "unknown") return "workflow_unknown"
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
  if (last.heldBack > 0 || (last.withheld ?? 0) > 0) return false
  if (last.event === "REQUEST_CHANGES") return true
  return last.event === "COMMENT" && (last.shown === "AWAITING_CHECKS" || last.verdict === "approve")
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

export function openBlockingIn(
  plan: ThreadPlan | undefined,
  resolved: ReadonlySet<string> = new Set(),
): number | "unknown" {
  if (plan === undefined) return "unknown"
  return plan.open.filter((thread) => thread.blocking && !resolved.has(thread.threadId)).length
}

export function lastReviewOf(facts: ReviewFacts): LastReview {
  return {
    reviewId: facts.reviewId,
    event: facts.event,
    headSha: facts.headSha,
    shown: facts.shown,
    counts: countBySeverity(facts.accepted),
    heldBack: facts.rejected.filter(holdsApprovalBack).length,
    withheld: facts.withheld,
    at: facts.at,
    requestChangesWorkflow: facts.requestChangesWorkflow,
  }
}

export function evaluatedApprovalOf({ reviewId, headSha, at }: EvaluatedApproval): LastReview {
  return { reviewId, event: "APPROVE", headSha, heldBack: 0, at, requestChangesWorkflow: true }
}

export function approvalRecord(
  previous: LastReview | undefined,
  reviewId: number,
  headSha: string,
  at: number,
): LastReview {
  const approved = evaluatedApprovalOf({ reviewId, headSha, at })
  return previous?.counts === undefined ? approved : { ...approved, counts: previous.counts }
}

export function workflowUnder(read: ConfigRead, variable: string | undefined): WorkflowState {
  if (configStatus(read) === "unreadable") return "unknown"
  return requestChangesWorkflow(read.config.reviews.request_changes_workflow, variable)
}

export async function evaluationWorkflow(
  last: LastReview | undefined,
  readConfig: () => Promise<ConfigRead>,
  variable: string | undefined,
): Promise<WorkflowState> {
  if (last?.requestChangesWorkflow !== undefined) return last.requestChangesWorkflow
  return workflowUnder(await readConfig(), variable)
}

export function evaluatesReviewedHead(pr: PullRequestStanding, trigger: ReviewTrigger): boolean {
  return trigger === "push" && pr.state === "open" && pr.draft !== true
}

export function verdictAfterChecks(verdict: Verdict, checks: ChecksState | undefined): Verdict {
  return verdict === "APPROVE" && checks !== "passing" ? "AWAITING_CHECKS" : verdict
}

export function evaluatesAfterReview(last: LastReview, accepted: readonly FindingInput[]): boolean {
  return awaitsApproval(last) && countBySeverity(accepted).blocking === 0
}

export const RecheckJob = Type.Object({
  attempt: Type.Integer({ minimum: 1 }),
  delivery: Type.String(),
})

export type RecheckJob = Static<typeof RecheckJob>

export interface Recheck {
  attempt: number
  inMs: number
}

const RECHECK_DELAYS_MS = [20_000, 60_000, 300_000]

const UNSETTLED_WAITS = new Set<WaitReason>([
  "review_in_flight",
  "checks_pending",
  "checks_unknown",
  "threads_unknown",
  "workflow_unknown",
])

export function nextRecheck(trigger: ApprovalTrigger, outcome: ApprovalOutcome, attempt: number): Recheck | undefined {
  if (trigger !== "checks_completed" && trigger !== "recheck") return undefined
  if (outcome.kind === "approved" || (outcome.kind === "wait" && !UNSETTLED_WAITS.has(outcome.reason))) return undefined
  const inMs = RECHECK_DELAYS_MS[attempt]
  return inMs === undefined ? undefined : { attempt: attempt + 1, inMs }
}

export function retriesAtDoor(outcome: ApprovalOutcome, recheck: Recheck | undefined): boolean {
  return outcome.kind === "failed" && outcome.transient && recheck === undefined
}

export function ownsRecheck(trigger: ApprovalTrigger, delivery: string, scheduled: RecheckJob | undefined): boolean {
  return trigger !== "recheck" || scheduled === undefined || scheduled.delivery === delivery
}
