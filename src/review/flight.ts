import { Type, type Static } from "typebox"

export interface PendingReview {
  headSha: string
  deliveryId: string
  operationId: string
  started: number
  checkRunId?: number
}

export const StoredPending = Type.Object({
  headSha: Type.String(),
  deliveryId: Type.String(),
  operationId: Type.Optional(Type.String()),
  started: Type.Optional(Type.Integer()),
  checkRunId: Type.Optional(Type.Integer()),
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
