import { describe, expect, it } from "vitest"
import { decideFlight, type PendingReview } from "../src/review/flight.ts"

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
