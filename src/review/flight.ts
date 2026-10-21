import { Type, type Static } from "typebox"
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
  | { kind: "replace"; previous: PendingReview; because: "superseded" | "dead" }

export interface Liveness {
  running: boolean
  now: number
}

export function decideFlight(pending: PendingReview | undefined, headSha: string, liveness: Liveness): FlightDecision {
  if (pending === undefined) return { kind: "start" }
  if (pending.headSha !== headSha) return { kind: "replace", previous: pending, because: "superseded" }
  if (liveness.running || liveness.now - pending.started < GRACE_MS) return { kind: "skip" }
  return { kind: "replace", previous: pending, because: "dead" }
}

export function ownsOperation(pending: PendingReview, operationId: string): boolean {
  return operationId === pending.operationId || operationId.startsWith(`${pending.operationId}:`)
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
