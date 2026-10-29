import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { GitHubError } from "../src/github/errors.ts"
import {
  afterReviewThrow,
  decideFlight,
  resumedPending,
  GRACE_MS,
  migratePending,
  ownsOperation,
  replacedExit,
  reviewOperations,
  runStanding,
  standingAfterVerify,
  StoredPending,
  submitStanding,
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
    expect(decideFlight(undefined, "aaa", { running: false, now: afterGrace }, "other-delivery")).toEqual({
      kind: "start",
    })
  })

  it("skips a head whose review the harness is still running", () => {
    expect(decideFlight(pending, "aaa", { running: true, now: afterGrace }, "other-delivery")).toEqual({ kind: "skip" })
  })

  it("skips a head whose review started within the grace, when the host is between prompts and the harness lists nothing", () => {
    expect(decideFlight(pending, "aaa", { running: false, now: afterGrace - 1 }, "other-delivery")).toEqual({
      kind: "skip",
    })
  })

  it("replaces the review of an older head as superseded, running or not", () => {
    const superseded = { kind: "replace", previous: pending, because: "superseded" }
    expect(decideFlight(pending, "bbb", { running: true, now: afterGrace }, "other-delivery")).toEqual(superseded)
    expect(decideFlight(pending, "bbb", { running: false, now: afterGrace - 1 }, "other-delivery")).toEqual(superseded)
  })

  it("replaces a review of the same head that the harness no longer runs, once the grace has passed, as dead", () => {
    expect(decideFlight(pending, "aaa", { running: false, now: afterGrace }, "other-delivery")).toEqual({
      kind: "replace",
      previous: pending,
      because: "dead",
    })
  })
})

describe("decideFlight for the delivery that holds the pending", () => {
  it("resumes its own review when the harness lists nothing, inside or outside the grace", () => {
    const resume = { kind: "resume", previous: pending }
    expect(decideFlight(pending, "aaa", { running: false, now: afterGrace - 1 }, "d-1")).toEqual(resume)
    expect(decideFlight(pending, "aaa", { running: false, now: afterGrace }, "d-1")).toEqual(resume)
  })

  it("skips while its own review is still running", () => {
    expect(decideFlight(pending, "aaa", { running: true, now: afterGrace }, "d-1")).toEqual({ kind: "skip" })
  })

  it("supersedes its own pending for a newer head, as any delivery would", () => {
    expect(decideFlight(pending, "bbb", { running: false, now: afterGrace }, "d-1")).toEqual({
      kind: "replace",
      previous: pending,
      because: "superseded",
    })
  })
})

describe("resumedPending", () => {
  it("starts the grace afresh, so another delivery meanwhile skips rather than replacing the resumed review as dead", () => {
    const resumed = resumedPending(pending, afterGrace)
    expect(resumed).toEqual({ ...pending, started: afterGrace })
    expect(decideFlight(resumed, "aaa", { running: false, now: afterGrace + 1 }, "other-delivery")).toEqual({
      kind: "skip",
    })
  })
})

describe("afterReviewThrow", () => {
  it("keeps the pending and the check run for a transient error, and releases them for a final one", () => {
    expect(afterReviewThrow(new GitHubError("GitHub 522 /x", 522, "/x"))).toBe("keep")
    expect(afterReviewThrow(new GitHubError("GitHub 404 /x", 404, "/x"))).toBe("release")
    expect(afterReviewThrow(new Error("model returned nothing"))).toBe("release")
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

describe("reviewOperations", () => {
  const root = [
    { operationId: "review:d-1", session: "1", status: "running" },
    { operationId: "chat:d-9", session: "1", status: "queued" },
  ]
  const verify = [
    { operationId: "review:d-1:verify:1", session: "3", status: "running" },
    { operationId: "review:d-0:verify:2", session: "3", status: "queued" },
  ]

  it("keeps the review's own operations in the root and verify sessions, and nothing else", () => {
    expect(
      reviewOperations(pending, root, verify)
        .map(({ operationId }) => operationId)
        .sort(),
    ).toEqual(["review:d-1", "review:d-1:verify:1"])
  })

  it("lists verify's operations first, since the review's submit_review call waits on verify, and aborting the call waits for it to return", () => {
    expect(reviewOperations(pending, root, verify)).toEqual([verify[0], root[0]])
  })

  it("has nothing for a session that has nothing pending", () => {
    expect(reviewOperations(pending, [], [])).toEqual([])
  })
})

describe("replacedExit", () => {
  it("is superseded when the newer review, or the pull request when its record isn't written yet, is at another head", () => {
    expect(replacedExit("bbb", "aaa")).toBe("review.superseded")
  })

  it("is withdrawn when a newer review of the same head replaced it", () => {
    expect(replacedExit("aaa", "aaa")).toBe("review.withdrawn")
  })

  it("is withdrawn when the newer head can't be read, rather than guessing a push", () => {
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

describe("standingAfterVerify", () => {
  it("posts while the review still holds the pending and the pull request is at the head it reviewed", () => {
    expect(standingAfterVerify(pending, "d-1", "aaa")).toBe("post")
  })

  it("is replaced when no review is pending or another delivery holds it, since a replacer deletes the record before it writes its own", () => {
    expect(standingAfterVerify(undefined, "d-1", "aaa")).toBe("replaced")
    expect(standingAfterVerify({ ...pending, deliveryId: "d-2" }, "d-1", "aaa")).toBe("replaced")
  })

  it("has moved when the pull request is at another head than the one its pending review started at", () => {
    expect(standingAfterVerify(pending, "d-1", "bbb")).toBe("moved")
  })

  it("is replaced rather than moved when the pending isn't its own, since that record's head says nothing about this review", () => {
    expect(standingAfterVerify(undefined, "d-1", "bbb")).toBe("replaced")
    expect(standingAfterVerify({ ...pending, deliveryId: "d-2" }, "d-1", "bbb")).toBe("replaced")
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
    expect(decideFlight(migrated, "aaa", { running: false, now: GRACE_MS }, "other-delivery")).toEqual({
      kind: "replace",
      previous: migrated,
      because: "dead",
    })
    expect(decideFlight(migrated, "aaa", { running: true, now: GRACE_MS }, "other-delivery")).toEqual({ kind: "skip" })
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

  it("keeps the usage ledger as it stood when the review started, which its spend is measured from", () => {
    const usageBefore = {
      "cloudflare/@cf/zai-org/glm-5.3-flash": { input: 20, output: 5, cacheRead: 40, cacheWrite: 0, usd: 0.25 },
    }
    expect(Value.Check(StoredPending, { ...pending, usageBefore })).toBe(true)
    expect(migratePending({ ...pending, usageBefore })).toEqual({ ...pending, usageBefore })
    expect(Value.Check(StoredPending, { ...pending, usageBefore: { glm: { input: 20 } } })).toBe(false)
  })

  it("keeps the linked issues the prompt was built with, which the summary footer reads back", () => {
    const linked: PendingReview = { ...pending, linkedIssues: [12, 14] }
    expect(Value.Check(StoredPending, linked)).toBe(true)
    expect(migratePending(linked)).toEqual(linked)
    expect(Value.Check(StoredPending, { ...pending, linkedIssues: ["#12"] })).toBe(false)
  })

  it("keeps the instruction files the standards were rendered from, which the summary footer reads back", () => {
    const standards: PendingReview = { ...pending, instructionFiles: ["apps/web/CLAUDE.md", "CLAUDE.md"] }
    expect(Value.Check(StoredPending, standards)).toBe(true)
    expect(migratePending(standards)).toEqual(standards)
    expect(Value.Check(StoredPending, { ...pending, instructionFiles: "CLAUDE.md" })).toBe(false)
  })

  it("keeps the fingerprint of the repository skills the review was offered, which the summary footer reads back", () => {
    const offered: PendingReview = { ...pending, repoSkillsFingerprint: "1a2b3c4d".repeat(8) }
    expect(Value.Check(StoredPending, offered)).toBe(true)
    expect(migratePending(offered)).toEqual(offered)
    expect(Value.Check(StoredPending, { ...pending, repoSkillsFingerprint: 5 })).toBe(false)
  })

  it("keeps the request-changes workflow and the ignored config's error the run started with, which the publish reads back", () => {
    const settled: PendingReview = {
      ...pending,
      requestChangesWorkflow: false,
      configError: "/reviews/auto must be boolean",
    }
    expect(Value.Check(StoredPending, settled)).toBe(true)
    expect(migratePending(settled)).toEqual(settled)
    expect(Value.Check(StoredPending, { ...pending, requestChangesWorkflow: "true" })).toBe(false)
    expect(Value.Check(StoredPending, { ...pending, configError: 5 })).toBe(false)
  })

  it("keeps the verify model the run resolved when it started, which the verify step reads back", () => {
    const verified: PendingReview = { ...pending, verifyModel: "@cf/x/y" }
    expect(Value.Check(StoredPending, verified)).toBe(true)
    expect(migratePending(verified)).toEqual(verified)
    expect(Value.Check(StoredPending, { ...pending, verifyModel: 5 })).toBe(false)
  })

  it("does not accept a record without its head and delivery id", () => {
    expect(Value.Check(StoredPending, { deliveryId: "d-1", operationId: "review:d-1" })).toBe(false)
    expect(Value.Check(StoredPending, "d-1")).toBe(false)
  })
})

describe("submitStanding", () => {
  it("refuses a submit_review call from any conversation but the root, even while its review is in flight, so a summary session can never post as the review", () => {
    expect(submitStanding({ caller: 2, root: 1, pending, running: "review:d-1" })).toEqual({ kind: "not_in_flight" })
  })

  it("has nothing to post for the root when no review is pending", () => {
    expect(submitStanding({ caller: 1, root: 1, pending: undefined, running: undefined })).toEqual({
      kind: "no_review",
    })
  })

  it("posts only for the root's running operation that the pending review owns", () => {
    expect(submitStanding({ caller: 1, root: 1, pending, running: "review:d-1" })).toEqual({
      kind: "post",
      deliveryId: "d-1",
    })
    expect(submitStanding({ caller: 1, root: 1, pending, running: "review:d-1:retry" })).toEqual({
      kind: "post",
      deliveryId: "d-1",
    })
    expect(submitStanding({ caller: 1, root: 1, pending, running: "summary:d-9:abc1234" })).toEqual({
      kind: "not_in_flight",
    })
    expect(submitStanding({ caller: 1, root: 1, pending, running: undefined })).toEqual({ kind: "not_in_flight" })
  })
})
