import { Type, type Static } from "typebox"
import type { PullRequestInfo } from "../github/client.ts"
import { SweepFacts, type ReviewIncoming } from "./delivery.ts"
import type { PendingReview, StoredPending } from "./flight.ts"

export const STUCK_MS = 1_800_000

export const DecidedReason = Type.Union([
  Type.Literal("auto"),
  Type.Literal("draft"),
  Type.Literal("base_branch"),
  Type.Literal("title_keyword"),
  Type.Literal("path_filters"),
  Type.Literal("failed"),
  Type.Literal("unposted"),
  Type.Literal("unchanged"),
  Type.Literal("gave_up"),
])

export type DecidedReason = Static<typeof DecidedReason>

export const StoredDecided = Type.Object({
  headSha: Type.String(),
  reason: DecidedReason,
  facts: Type.Optional(SweepFacts),
})

export type StoredDecided = Static<typeof StoredDecided>

export type SweepIncoming = ReviewIncoming & { sweep: SweepFacts }

export type SweepOutcome =
  | { kind: "reviewed" }
  | { kind: "restarted" }
  | { kind: "gave_up" }
  | { kind: "known"; reason: string }

export interface SweepState {
  paused: boolean
  posted: boolean
  decided: StoredDecided | undefined
  pending: PendingReview | undefined
  running: boolean
  now: number
}

export type SweepDecision =
  | { kind: "known"; reason: string }
  | { kind: "review" }
  | { kind: "restart"; previous: PendingReview }
  | { kind: "give_up"; previous: PendingReview }

export function decideSweep(state: SweepState, incoming: SweepIncoming): SweepDecision {
  if (state.paused) return { kind: "known", reason: "paused" }
  if (state.posted) return { kind: "known", reason: "already_reviewed" }
  const { decided } = state
  if (decided !== undefined && decidedMatches(decided, incoming)) return { kind: "known", reason: decided.reason }
  return decidePending(state, incoming.headSha)
}

function decidedMatches(decided: StoredDecided, incoming: SweepIncoming): boolean {
  if (decided.headSha !== incoming.headSha) return false
  if (decided.facts === undefined) return true
  return sameFacts(decided.facts, incoming.sweep)
}

function sameFacts(stored: SweepFacts, listed: SweepFacts): boolean {
  return stored.draft === listed.draft && stored.baseRef === listed.baseRef && stored.title === listed.title
}

function decidePending({ pending, running, now }: SweepState, headSha: string): SweepDecision {
  if (pending === undefined || pending.headSha !== headSha) return { kind: "review" }
  if (running || now - pending.started < STUCK_MS) return { kind: "known", reason: "in_progress" }
  if (pending.sweepRestarted === true) return { kind: "give_up", previous: pending }
  return { kind: "restart", previous: pending }
}

export function restartedPending(previous: PendingReview, headSha: string, now: number): PendingReview {
  const { rejectionsReturned: _returned, activated: _activated, usageBefore: _usage, ...kept } = previous
  return {
    ...kept,
    operationId: `review:sweep:${headSha}:restart`,
    deliveryId: `sweep:${headSha}:restart`,
    started: now,
    sweepRestarted: true,
    sweep: "restarted",
  }
}

const SETTINGS_REASONS: ReadonlySet<DecidedReason> = new Set([
  "auto",
  "draft",
  "base_branch",
  "title_keyword",
  "path_filters",
])

export function decidedRecord(headSha: string, reason: DecidedReason, facts: SweepFacts | undefined): StoredDecided {
  return facts === undefined || !SETTINGS_REASONS.has(reason) ? { headSha, reason } : { headSha, reason, facts }
}

export function mayRecordDecided(pending: PendingReview | undefined, headSha: string, deliveryId: string): boolean {
  return pending === undefined || pending.headSha !== headSha || pending.deliveryId === deliveryId
}

export function settledAtStart(pending: PendingReview | undefined, deliveryId: string): boolean {
  return pending?.deliveryId === deliveryId
}

export function factsOf(pr: Pick<PullRequestInfo, "title" | "draft" | "base">): SweepFacts {
  return { draft: pr.draft ?? false, baseRef: pr.base.ref, title: pr.title }
}

export function startedMark(incoming: ReviewIncoming): Pick<StoredPending, "sweep"> {
  return incoming.sweep === undefined ? {} : { sweep: "started" }
}
