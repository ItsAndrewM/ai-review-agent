import { Type, type Static } from "typebox"

export interface PendingReview {
  headSha: string
  deliveryId: string
  operationId: string
  started: number
  checkRunId?: number
  model?: string
  fingerprint?: string
  rejectionsReturned?: boolean
  linkedIssues?: number[]
}

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
})

export type StoredPending = Static<typeof StoredPending>

export function migratePending(stored: StoredPending): PendingReview {
  return { ...stored, operationId: stored.operationId ?? `review:${stored.deliveryId}`, started: stored.started ?? 0 }
}

export type FlightDecision =
  | { kind: "start" }
  | { kind: "skip"; reason: "in_progress" }
  | { kind: "replace"; previous: PendingReview; because: "superseded" | "dead" }

export function decideFlight(pending: PendingReview | undefined, headSha: string, live: boolean): FlightDecision {
  if (pending === undefined) return { kind: "start" }
  if (pending.headSha !== headSha) return { kind: "replace", previous: pending, because: "superseded" }
  if (live) return { kind: "skip", reason: "in_progress" }
  return { kind: "replace", previous: pending, because: "dead" }
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
