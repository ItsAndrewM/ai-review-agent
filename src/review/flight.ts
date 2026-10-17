export interface PendingReview {
  headSha: string
  deliveryId: string
  operationId: string
  started: number
  checkRunId?: number
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
