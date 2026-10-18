import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { decideFlight, migratePending, StoredPending, type PendingReview } from "../src/review/flight.ts"

const pending: PendingReview = {
  headSha: "aaa",
  deliveryId: "d-1",
  operationId: "review:d-1",
  started: 1,
  checkRunId: 7,
}

describe("decideFlight", () => {
  it("starts when nothing is pending", () => {
    expect(decideFlight(undefined, "aaa", false)).toEqual({ kind: "start" })
  })

  it("skips a head whose review is still running", () => {
    expect(decideFlight(pending, "aaa", true)).toEqual({ kind: "skip", reason: "in_progress" })
  })

  it("replaces the review of an older head as superseded, running or not", () => {
    expect(decideFlight(pending, "bbb", true)).toEqual({ kind: "replace", previous: pending, because: "superseded" })
    expect(decideFlight(pending, "bbb", false)).toEqual({ kind: "replace", previous: pending, because: "superseded" })
  })

  it("replaces a review of the same head that the harness no longer runs as dead", () => {
    expect(decideFlight(pending, "aaa", false)).toEqual({ kind: "replace", previous: pending, because: "dead" })
  })
})

describe("migratePending", () => {
  it("fills the base's two-field record with the base's operation id and a start of 0", () => {
    const stored = { headSha: "aaa", deliveryId: "d-1" }
    expect(Value.Check(StoredPending, stored)).toBe(true)
    expect(migratePending(stored)).toEqual({ headSha: "aaa", deliveryId: "d-1", operationId: "review:d-1", started: 0 })
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

  it("does not accept a record without its head and delivery id", () => {
    expect(Value.Check(StoredPending, { deliveryId: "d-1", operationId: "review:d-1" })).toBe(false)
    expect(Value.Check(StoredPending, "d-1")).toBe(false)
  })
})
