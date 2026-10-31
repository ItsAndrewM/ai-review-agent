import { Type, type Static } from "typebox"
import { isTransient } from "../github/errors.ts"
import { UsageTotals } from "./cost.ts"

export const GRACE_MS = 120_000

const STARTED_OUTSIDE_ANY_GRACE = 0

export const StoredPending = Type.Object({
  headSha: Type.String(),
  deliveryId: Type.String(),
  operationId: Type.Optional(Type.String()),
  started: Type.Optional(Type.Integer()),
  checkRunId: Type.Optional(Type.Integer()),
  model: Type.Optional(Type.String()),
  fingerprint: Type.Optional(Type.String()),
  rejectionsReturned: Type.Optional(Type.Boolean()),
  linkedIssues: Type.Optional(Type.Array(Type.Integer())),
  usageBefore: Type.Optional(UsageTotals),
  instructionFiles: Type.Optional(Type.Array(Type.String())),
  repoSkillsFingerprint: Type.Optional(Type.String()),
  requestChangesWorkflow: Type.Optional(Type.Boolean()),
  configError: Type.Optional(Type.String()),
  verifyModel: Type.Optional(Type.String()),
  activated: Type.Optional(Type.Array(Type.String())),
  docs: Type.Optional(Type.Array(Type.String())),
})

export type StoredPending = Static<typeof StoredPending>

export type PendingReview = StoredPending & { operationId: string; started: number }

export function migratePending(stored: StoredPending): PendingReview {
  return {
    ...stored,
    operationId: stored.operationId ?? `review:${stored.deliveryId}`,
    started: stored.started ?? STARTED_OUTSIDE_ANY_GRACE,
  }
}

export type FlightDecision =
  | { kind: "start" }
  | { kind: "skip" }
  | { kind: "resume"; previous: PendingReview }
  | { kind: "replace"; previous: PendingReview; because: "superseded" | "dead" }

export interface Liveness {
  running: boolean
  now: number
}

export function decideFlight(
  pending: PendingReview | undefined,
  headSha: string,
  liveness: Liveness,
  deliveryId: string,
): FlightDecision {
  if (pending === undefined) return { kind: "start" }
  if (pending.headSha !== headSha) return { kind: "replace", previous: pending, because: "superseded" }
  if (liveness.running) return { kind: "skip" }
  if (pending.deliveryId === deliveryId) return { kind: "resume", previous: pending }
  if (liveness.now - pending.started < GRACE_MS) return { kind: "skip" }
  return { kind: "replace", previous: pending, because: "dead" }
}

export function resumedPending(previous: PendingReview, now: number): PendingReview {
  return { ...previous, started: now }
}

export function afterReviewThrow(error: Error): "keep" | "release" {
  return isTransient(error) ? "keep" : "release"
}

export function ownsOperation(pending: PendingReview, operationId: string): boolean {
  return operationId === pending.operationId || operationId.startsWith(`${pending.operationId}:`)
}

export function reviewOperations<Operation extends { operationId: string }>(
  pending: PendingReview,
  root: readonly Operation[],
  verify: readonly Operation[],
): Operation[] {
  return [...verify, ...root].filter(({ operationId }) => ownsOperation(pending, operationId))
}

export type SubmitStanding = { kind: "post"; deliveryId: string } | { kind: "no_review" } | { kind: "not_in_flight" }

export interface SubmitCall<Conversation> {
  caller: Conversation
  root: Conversation
  pending: PendingReview | undefined
  running: string | undefined
}

export function submitStanding<Conversation>({
  caller,
  root,
  pending,
  running,
}: SubmitCall<Conversation>): SubmitStanding {
  if (caller !== root) return { kind: "not_in_flight" }
  if (pending === undefined) return { kind: "no_review" }
  if (running === undefined || !ownsOperation(pending, running)) return { kind: "not_in_flight" }
  return { kind: "post", deliveryId: pending.deliveryId }
}

export function replacedExit(
  newerHeadSha: string | undefined,
  headSha: string,
): "review.superseded" | "review.withdrawn" {
  return newerHeadSha !== undefined && newerHeadSha !== headSha ? "review.superseded" : "review.withdrawn"
}

export type RunStanding = "in_flight" | "ended" | "replaced"

export function runStanding(
  pending: PendingReview | undefined,
  deliveryId: string,
  endedDelivery: string | undefined,
): RunStanding {
  if (pending?.deliveryId === deliveryId) return "in_flight"
  return endedDelivery === deliveryId ? "ended" : "replaced"
}

export function standingAfterVerify(
  pending: PendingReview | undefined,
  deliveryId: string,
  headNow: string,
): "post" | "replaced" | "moved" {
  if (pending?.deliveryId !== deliveryId) return "replaced"
  return pending.headSha === headNow ? "post" : "moved"
}
