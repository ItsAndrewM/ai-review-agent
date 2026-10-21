import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import {
  decideFlight,
  GRACE_MS,
  migratePending,
  ownsOperation,
  replacedExit,
  runStanding,
  StoredPending,
  type PendingReview,
} from "../src/review/flight.ts"

const pending: PendingReview = {
  headSha: "aaa",
  deliveryId: "d-1",
  operationId: "review:d-1",
  started: 1,
  checkRunId: 7,
}

const afterGrace = pending.started + GRACE_MS

describe("decideFlight", () => {
  it("starts when nothing is pending", () => {
    expect(decideFlight(undefined, "aaa", { running: false, now: afterGrace })).toEqual({ kind: "start" })
  })

  it("skips a head whose review the harness is still running", () => {
    expect(decideFlight(pending, "aaa", { running: true, now: afterGrace })).toEqual({ kind: "skip" })
  })

  it("skips a head whose review started within the grace, when the host is between prompts and the harness lists nothing", () => {
    expect(decideFlight(pending, "aaa", { running: false, now: afterGrace - 1 })).toEqual({ kind: "skip" })
  })

  it("replaces the review of an older head as superseded, running or not", () => {
    const superseded = { kind: "replace", previous: pending, because: "superseded" }
    expect(decideFlight(pending, "bbb", { running: true, now: afterGrace })).toEqual(superseded)
    expect(decideFlight(pending, "bbb", { running: false, now: afterGrace - 1 })).toEqual(superseded)
  })

  it("replaces a review of the same head that the harness no longer runs, once the grace has passed, as dead", () => {
    expect(decideFlight(pending, "aaa", { running: false, now: afterGrace })).toEqual({
      kind: "replace",
      previous: pending,
      because: "dead",
    })
  })
})

describe("ownsOperation", () => {
  it("owns the review's prompt and its retry", () => {
    expect(ownsOperation(pending, "review:d-1")).toBe(true)
    expect(ownsOperation(pending, "review:d-1:retry")).toBe(true)
  })

  it("doesn't own another delivery's operation, even one whose id starts with this one's", () => {
    expect(ownsOperation(pending, "review:d-2")).toBe(false)
    expect(ownsOperation(pending, "review:d-10")).toBe(false)
    expect(ownsOperation(pending, "chat:d-1")).toBe(false)
  })
})

describe("replacedExit", () => {
  it("is superseded when the review that replaced this one is of another head", () => {
    expect(replacedExit({ ...pending, headSha: "bbb", deliveryId: "d-2" }, "aaa")).toBe("review.superseded")
  })

  it("is withdrawn when a newer review of the same head replaced it, or the record is gone", () => {
    expect(replacedExit({ ...pending, deliveryId: "d-2" }, "aaa")).toBe("review.withdrawn")
    expect(replacedExit(undefined, "aaa")).toBe("review.withdrawn")
  })
})

describe("runStanding", () => {
  it("is in flight while its delivery holds the pending, even one an earlier run under that id ended, as when GitHub redelivers the event", () => {
    expect(runStanding(pending, "d-1", undefined)).toBe("in_flight")
    expect(runStanding(pending, "d-1", "d-1")).toBe("in_flight")
  })

  it("is replaced when another delivery holds the pending or none does, since a replacer deletes the record before it writes its own", () => {
    expect(runStanding({ ...pending, deliveryId: "d-2" }, "d-1", undefined)).toBe("replaced")
    expect(runStanding(undefined, "d-1", undefined)).toBe("replaced")
    expect(runStanding(undefined, "d-1", "d-0")).toBe("replaced")
  })

  it("is ended once its own review ended without posting, even after another delivery takes the pending", () => {
    expect(runStanding(undefined, "d-1", "d-1")).toBe("ended")
    expect(runStanding({ ...pending, deliveryId: "d-2" }, "d-1", "d-1")).toBe("ended")
  })
})

describe("migratePending", () => {
  it("fills the base's two-field record with the base's operation id and a start of 0", () => {
    const stored = { headSha: "aaa", deliveryId: "d-1" }
    expect(Value.Check(StoredPending, stored)).toBe(true)
    expect(migratePending(stored)).toEqual({ headSha: "aaa", deliveryId: "d-1", operationId: "review:d-1", started: 0 })
  })

  it("puts a record with no start time outside the grace, so only the harness listing can keep it live", () => {
    const migrated = migratePending({ headSha: "aaa", deliveryId: "d-1" })
    expect(decideFlight(migrated, "aaa", { running: false, now: GRACE_MS })).toEqual({
      kind: "replace",
      previous: migrated,
      because: "dead",
    })
    expect(decideFlight(migrated, "aaa", { running: true, now: GRACE_MS })).toEqual({ kind: "skip" })
  })

  it("returns a full record unchanged", () => {
    expect(Value.Check(StoredPending, pending)).toBe(true)
    expect(migratePending(pending)).toEqual(pending)
  })

  it("keeps the review's attribution and its returned-rejections flag, which the submit loop reads back", () => {
    const flagged = { ...pending, model: "@cf/openai/gpt-oss-120b", fingerprint: "798ffa29", rejectionsReturned: true }
    expect(Value.Check(StoredPending, flagged)).toBe(true)
    expect(migratePending(flagged)).toEqual(flagged)
  })

  it("keeps the linked issues the prompt was built with, which the summary footer reads back", () => {
    const linked: PendingReview = { ...pending, linkedIssues: [12, 14] }
    expect(Value.Check(StoredPending, linked)).toBe(true)
    expect(migratePending(linked)).toEqual(linked)
    expect(Value.Check(StoredPending, { ...pending, linkedIssues: ["#12"] })).toBe(false)
  })

  it("does not accept a record without its head and delivery id", () => {
    expect(Value.Check(StoredPending, { deliveryId: "d-1", operationId: "review:d-1" })).toBe(false)
    expect(Value.Check(StoredPending, "d-1")).toBe(false)
  })
})
