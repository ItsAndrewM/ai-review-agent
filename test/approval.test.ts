import { describe, expect, it } from "vitest"
import type { CheckRunSummary } from "../src/github/client.ts"
import {
  awaitsApproval,
  checksState,
  decideApproval,
  evaluatesAfterReview,
  lastReviewOf,
  openBlockingIn,
  verdictAfterChecks,
  type ApprovalState,
  type LastReview,
} from "../src/review/approval.ts"
import type { FindingInput } from "../src/review/findings.ts"
import type { OpenThread } from "../src/review/incremental.ts"

const requested: LastReview = {
  reviewId: 1,
  event: "REQUEST_CHANGES",
  headSha: "bbb",
  verdict: "request_changes",
  heldBack: 0,
  at: 1,
}

const ready: ApprovalState = {
  workflow: true,
  paused: false,
  open: true,
  reviewInFlight: false,
  headSha: "bbb",
  reviewedHead: "bbb",
  lastReview: requested,
  openBlocking: 0,
  checks: "passing",
}

function outcome(state: ApprovalState): string {
  const decision = decideApproval(state)
  return decision.kind === "wait" ? decision.reason : decision.kind
}

describe("decideApproval", () => {
  it("approves a reviewed head whose request for changes has nothing left behind it", () => {
    expect(decideApproval(ready)).toEqual({ kind: "approve" })
  })

  it("never approves when the request-changes workflow is off", () => {
    expect(outcome({ ...ready, workflow: false })).toBe("workflow_off")
  })

  it("does nothing while paused", () => {
    expect(outcome({ ...ready, paused: true })).toBe("paused")
  })

  it("never approves a pull request that is closed, merged or a draft", () => {
    expect(outcome({ ...ready, open: false })).toBe("not_open")
  })

  it("waits for a review in flight, which evaluates when it ends", () => {
    expect(outcome({ ...ready, reviewInFlight: true })).toBe("review_in_flight")
  })

  it("waits for the review of the current head when the head isn't the reviewed one", () => {
    expect(outcome({ ...ready, reviewedHead: "aaa" })).toBe("not_reviewed")
    expect(outcome({ ...ready, reviewedHead: undefined })).toBe("not_reviewed")
  })

  it("waits for a review that records itself, as on a pull request last reviewed before this shipped", () => {
    expect(outcome({ ...ready, lastReview: undefined })).toBe("no_record")
  })

  it("never approves twice, whether the last approval is of this head or an earlier one", () => {
    expect(outcome({ ...ready, lastReview: { ...requested, event: "APPROVE" } })).toBe("approved")
    expect(outcome({ ...ready, lastReview: { ...requested, event: "APPROVE", headSha: "aaa" } })).toBe("approved")
  })

  it("approves a head whose last review commented only because it couldn't approve yet", () => {
    expect(decideApproval({ ...ready, lastReview: { ...requested, event: "COMMENT", verdict: "approve" } })).toEqual({
      kind: "approve",
    })
  })

  it("lets a review that only commented stand until the next review", () => {
    expect(outcome({ ...ready, lastReview: { ...requested, event: "COMMENT", verdict: "comment" } })).toBe(
      "review_stands",
    )
  })

  it("never approves when the threads couldn't be read", () => {
    expect(outcome({ ...ready, openBlocking: "unknown" })).toBe("threads_unknown")
  })

  it("waits while one of andabot's blocking threads is open", () => {
    expect(outcome({ ...ready, openBlocking: 1 })).toBe("blocking_threads")
  })

  it("never approves when the check runs couldn't be read", () => {
    expect(outcome({ ...ready, checks: "unknown" })).toBe("checks_unknown")
  })

  it("waits on a failing check", () => {
    expect(outcome({ ...ready, checks: "failing" })).toBe("checks_failing")
  })

  it("waits for checks still running", () => {
    expect(outcome({ ...ready, checks: "pending" })).toBe("checks_pending")
  })

  it("reports the first reason that holds", () => {
    expect(outcome({ ...ready, paused: true, openBlocking: 1, checks: "failing" })).toBe("paused")
  })
})

describe("awaitsApproval", () => {
  it("lifts a request for changes whatever the model's verdict", () => {
    for (const verdict of ["approve", "request_changes", "comment"] as const) {
      expect(awaitsApproval({ ...requested, verdict })).toBe(true)
    }
  })

  it("lifts a comment only when the model meant to approve", () => {
    const commented: LastReview = { reviewId: 1, event: "COMMENT", headSha: "bbb", heldBack: 0, at: 1 }
    expect(awaitsApproval({ ...commented, verdict: "approve" })).toBe(true)
    expect(awaitsApproval({ ...commented, verdict: "comment" })).toBe(false)
    expect(awaitsApproval({ ...commented, verdict: "request_changes" })).toBe(false)
    expect(awaitsApproval(commented)).toBe(false)
  })

  it("never lifts a review that held a finding back", () => {
    expect(awaitsApproval({ ...requested, heldBack: 1 })).toBe(false)
  })

  it("never lifts an approval", () => {
    expect(awaitsApproval({ ...requested, event: "APPROVE" })).toBe(false)
  })
})

function checkRun(overrides: Partial<CheckRunSummary> = {}): CheckRunSummary {
  return { name: "check", status: "completed", conclusion: "success", app: "github-actions", ...overrides }
}

describe("checksState", () => {
  it("passes with no runs, or with only andabot's own still running", () => {
    expect(checksState([], "andabot")).toBe("passing")
    expect(checksState([checkRun({ app: "andabot", status: "in_progress", conclusion: null })], "andabot")).toBe(
      "passing",
    )
  })

  it("passes when every other run completed as success, neutral or skipped", () => {
    const runs = ["success", "neutral", "skipped"].map((conclusion) => checkRun({ conclusion }))
    expect(checksState(runs, "andabot")).toBe("passing")
  })

  it("fails on a completed run with any other conclusion, stale included", () => {
    expect(checksState([checkRun({ conclusion: "failure" })], "andabot")).toBe("failing")
    expect(checksState([checkRun({ conclusion: "stale" })], "andabot")).toBe("failing")
  })

  it("counts a run with no app as another app's", () => {
    expect(checksState([checkRun({ app: null, conclusion: "failure" })], "andabot")).toBe("failing")
  })

  it("waits for a run that hasn't completed", () => {
    expect(checksState([checkRun({ status: "queued", conclusion: null })], "andabot")).toBe("pending")
  })

  it("reports failing over pending", () => {
    const runs = [checkRun({ status: "queued", conclusion: null }), checkRun({ conclusion: "failure" })]
    expect(checksState(runs, "andabot")).toBe("failing")
  })
})

function thread(handle: string, blocking: boolean): OpenThread {
  return {
    handle,
    threadId: `id-${handle}`,
    firstCommentId: 1,
    path: "a.ts",
    line: 1,
    side: "RIGHT",
    outdated: false,
    title: "t",
    blocking,
  }
}

describe("openBlockingIn", () => {
  it("counts the open blocking threads, or unknown when they couldn't be read", () => {
    expect(openBlockingIn(undefined)).toBe("unknown")
    expect(openBlockingIn({ open: [thread("T1", true), thread("T2", false)], recheck: [] })).toBe(1)
  })
})

function finding(severity: FindingInput["severity"]): FindingInput {
  return { path: "a.ts", line: 1, quote: "q", basis_kind: "defect", basis: "b", severity, title: "t", body: "b" }
}

describe("lastReviewOf", () => {
  it("counts only the rejections that hold approval back", () => {
    const rejected = [
      { finding: finding("blocking"), reason: "r", unfounded: false },
      { finding: finding("blocking"), reason: "r", unfounded: true },
      { finding: finding("suggestion"), reason: "r", unfounded: false },
    ]
    expect(
      lastReviewOf({
        reviewId: 9,
        event: "REQUEST_CHANGES",
        headSha: "bbb",
        verdict: "request_changes",
        rejected,
        at: 5,
      }),
    ).toEqual({ reviewId: 9, event: "REQUEST_CHANGES", headSha: "bbb", verdict: "request_changes", heldBack: 1, at: 5 })
  })
})

describe("verdictAfterChecks", () => {
  it("holds a clean review's approval until the checks pass", () => {
    expect(verdictAfterChecks("APPROVE", "passing")).toBe("APPROVE")
    for (const checks of ["pending", "failing", "unknown"] as const) {
      expect(verdictAfterChecks("APPROVE", checks)).toBe("AWAITING_CHECKS")
    }
  })

  it("leaves a request for changes and a comment as they are", () => {
    expect(verdictAfterChecks("REQUEST_CHANGES", undefined)).toBe("REQUEST_CHANGES")
    expect(verdictAfterChecks("COMMENT", "failing")).toBe("COMMENT")
  })
})

describe("evaluatesAfterReview", () => {
  it("evaluates after a review that didn't approve, unless it just posted a blocking finding", () => {
    expect(evaluatesAfterReview("APPROVE", [])).toBe(false)
    expect(evaluatesAfterReview("REQUEST_CHANGES", [finding("blocking")])).toBe(false)
    expect(evaluatesAfterReview("REQUEST_CHANGES", [finding("suggestion")])).toBe(true)
    expect(evaluatesAfterReview("COMMENT", [])).toBe(true)
  })
})
