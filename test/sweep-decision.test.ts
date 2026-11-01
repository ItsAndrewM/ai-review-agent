import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import type { PendingReview } from "../src/review/flight.ts"
import {
  decidedRecord,
  decideSweep,
  factsOf,
  restartedPending,
  startedMark,
  STUCK_MS,
  StoredDecided,
  type SweepIncoming,
  type SweepState,
} from "../src/review/sweep-decision.ts"

const KEY = { installationId: 1, owner: "o", repo: "r", number: 7 }
const NOW = 10_000_000_000
const MINUTE = 60_000

const facts = { draft: false, baseRef: "main", title: "Add the sweep" }

const incoming: SweepIncoming = {
  kind: "review",
  key: KEY,
  deliveryId: "sweep:abc",
  headSha: "abc",
  full: false,
  sweep: facts,
}

const nothing: SweepState = {
  paused: false,
  posted: false,
  decided: undefined,
  pending: undefined,
  running: false,
  now: NOW,
}

function pending(overrides: Partial<PendingReview> = {}): PendingReview {
  return {
    headSha: "abc",
    deliveryId: "d-1",
    operationId: "review:d-1",
    started: NOW - 30 * MINUTE,
    checkRunId: 99,
    ...overrides,
  }
}

describe("decideSweep", () => {
  it("answers a paused pull request as known", () => {
    expect(decideSweep({ ...nothing, paused: true, posted: true }, incoming)).toEqual({
      kind: "known",
      reason: "paused",
    })
  })

  it("answers a posted head as already reviewed", () => {
    expect(decideSweep({ ...nothing, posted: true, pending: pending() }, incoming)).toEqual({
      kind: "known",
      reason: "already_reviewed",
    })
  })

  it("answers a decided head whose facts match with the reason it was decided", () => {
    const decided = decidedRecord("abc", "draft", facts)
    expect(decideSweep({ ...nothing, decided }, incoming)).toEqual({ kind: "known", reason: "draft" })
  })

  it.each([
    ["draft", { ...facts, draft: true }],
    ["baseRef", { ...facts, baseRef: "release" }],
    ["title", { ...facts, title: "WIP: Add the sweep" }],
  ])("reviews a decided head whose %s changed since", (_field, stored) => {
    const decided = decidedRecord("abc", "draft", stored)
    expect(decideSweep({ ...nothing, decided }, incoming)).toEqual({ kind: "review" })
  })

  it("answers a decided head with no stored facts on its sha alone", () => {
    const decided = decidedRecord("abc", "failed", undefined)
    expect(decideSweep({ ...nothing, decided }, incoming)).toEqual({ kind: "known", reason: "failed" })
  })

  it("reviews a head when the decided record is for another head", () => {
    const decided = decidedRecord("old", "draft", facts)
    expect(decideSweep({ ...nothing, decided }, incoming)).toEqual({ kind: "review" })
  })

  it("reviews a head when the pending is for another head", () => {
    expect(decideSweep({ ...nothing, pending: pending({ headSha: "old" }) }, incoming)).toEqual({ kind: "review" })
  })

  it("answers a running review as in progress, even past the stuck threshold", () => {
    const state = { ...nothing, pending: pending({ started: NOW - 3 * STUCK_MS }), running: true }
    expect(decideSweep(state, incoming)).toEqual({ kind: "known", reason: "in_progress" })
  })

  it("answers a review that started 29 minutes ago as in progress though nothing runs", () => {
    const state = { ...nothing, pending: pending({ started: NOW - 29 * MINUTE }) }
    expect(decideSweep(state, incoming)).toEqual({ kind: "known", reason: "in_progress" })
  })

  it("restarts a review dead for 30 minutes that the sweep never restarted", () => {
    const previous = pending({ started: NOW - STUCK_MS })
    expect(decideSweep({ ...nothing, pending: previous }, incoming)).toEqual({ kind: "restart", previous })
  })

  it("gives up on a dead review the sweep already restarted", () => {
    const previous = pending({ started: NOW - STUCK_MS, sweepRestarted: true })
    expect(decideSweep({ ...nothing, pending: previous }, incoming)).toEqual({ kind: "give_up", previous })
  })

  it("reviews a head the object has nothing stored for", () => {
    expect(decideSweep(nothing, incoming)).toEqual({ kind: "review" })
  })

  it("puts the 30-minute threshold at 30 minutes", () => {
    expect(STUCK_MS).toBe(30 * MINUTE)
  })
})

describe("restartedPending", () => {
  it("keeps the check run and gives the restart a fresh operation and delivery id", () => {
    const previous = pending({ model: "glm", linkedIssues: [4] })
    const restarted = restartedPending(previous, "abc", NOW)
    expect(restarted).toEqual({
      ...previous,
      operationId: "review:sweep:abc:restart",
      deliveryId: "sweep:abc:restart",
      started: NOW,
      sweepRestarted: true,
      sweep: "restarted",
    })
    expect(restarted.checkRunId).toBe(99)
  })
})

describe("StoredDecided", () => {
  it("keeps a record with facts and one without", () => {
    expect(Value.Check(StoredDecided, decidedRecord("abc", "path_filters", facts))).toBe(true)
    expect(Value.Check(StoredDecided, decidedRecord("abc", "gave_up", undefined))).toBe(true)
  })

  it("leaves facts off a record made without them", () => {
    expect(decidedRecord("abc", "unposted", undefined)).toEqual({ headSha: "abc", reason: "unposted" })
  })

  it("refuses a reason it does not know", () => {
    expect(Value.Check(StoredDecided, { headSha: "abc", reason: "bored" })).toBe(false)
  })
})

describe("factsOf", () => {
  const pr = {
    title: "Add the sweep",
    draft: true,
    base: { ref: "main", sha: "base", repo: { full_name: "o/r" } },
  }

  it("reads the facts a sweep lists off a pull request GitHub sent", () => {
    expect(factsOf(pr)).toEqual({ draft: true, baseRef: "main", title: "Add the sweep" })
  })

  it("reads a missing draft as not a draft, as the listing does", () => {
    const { draft: _draft, ...undrafted } = pr
    expect(factsOf(undrafted).draft).toBe(false)
  })
})

describe("startedMark", () => {
  it("marks a review the sweep starts, so its footer says so", () => {
    expect(startedMark(incoming)).toEqual({ sweep: "started" })
  })

  it("leaves a webhook's review unmarked", () => {
    const { sweep: _sweep, ...webhook } = incoming
    expect(startedMark(webhook)).toEqual({})
  })
})
