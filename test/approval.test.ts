import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import type { CheckRunSummary } from "../src/github/client.ts"
import { DEFAULT_CONFIG, parseConfig, type ConfigRead } from "../src/repository/config.ts"
import {
  approvalRecord,
  awaitsApproval,
  checksState,
  decideApproval,
  evaluatedApprovalOf,
  evaluatesAfterReview,
  evaluatesReviewedHead,
  evaluationWorkflow,
  lastReviewOf,
  LastReview,
  nextRecheck,
  openBlockingIn,
  RecheckJob,
  verdictAfterChecks,
  type ApprovalState,
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

  it("waits when the workflow can't be known, ahead of every other reason", () => {
    expect(outcome({ ...ready, workflow: "unknown" })).toBe("workflow_unknown")
    expect(outcome({ ...ready, workflow: "unknown", paused: true, open: false })).toBe("workflow_unknown")
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

  it("leaves out the threads a resolve just resolved, whatever the list says", () => {
    const plan = { open: [thread("T1", true), thread("T2", true), thread("T3", false)], recheck: [] }
    expect(openBlockingIn(plan, new Set(["id-T1"]))).toBe(1)
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
        shown: "REQUEST_CHANGES",
        accepted: [finding("blocking"), finding("nitpick")],
        rejected,
        at: 5,
        requestChangesWorkflow: true,
      }),
    ).toEqual({
      reviewId: 9,
      event: "REQUEST_CHANGES",
      headSha: "bbb",
      verdict: "request_changes",
      shown: "REQUEST_CHANGES",
      counts: { blocking: 1, suggestion: 0, nitpick: 1 },
      heldBack: 1,
      at: 5,
      requestChangesWorkflow: true,
    })
  })

  it("records a wait for the checks as what the summary showed", () => {
    expect(
      lastReviewOf({
        reviewId: 9,
        event: "COMMENT",
        headSha: "bbb",
        verdict: "approve",
        shown: "AWAITING_CHECKS",
        accepted: [],
        rejected: [],
        at: 5,
        requestChangesWorkflow: true,
      }),
    ).toEqual({
      reviewId: 9,
      event: "COMMENT",
      headSha: "bbb",
      verdict: "approve",
      shown: "AWAITING_CHECKS",
      counts: { blocking: 0, suggestion: 0, nitpick: 0 },
      heldBack: 0,
      at: 5,
      requestChangesWorkflow: true,
    })
  })

  it("keeps the request-changes workflow the review ran under, for the evaluation that follows it", () => {
    const facts = {
      reviewId: 9,
      event: "COMMENT",
      headSha: "bbb",
      verdict: "approve",
      shown: "COMMENT",
      accepted: [],
      rejected: [],
      at: 5,
    } as const
    expect(lastReviewOf({ ...facts, requestChangesWorkflow: false }).requestChangesWorkflow).toBe(false)
    expect(lastReviewOf({ ...facts, requestChangesWorkflow: true }).requestChangesWorkflow).toBe(true)
  })
})

describe("approvalRecord", () => {
  const previous: LastReview = {
    reviewId: 9,
    event: "REQUEST_CHANGES",
    headSha: "aaa",
    verdict: "request_changes",
    shown: "REQUEST_CHANGES",
    counts: { blocking: 1, suggestion: 2, nitpick: 0 },
    heldBack: 0,
    at: 5,
  }

  it("records the evaluation's approval with no model verdict, keeping the last review's counts", () => {
    expect(approvalRecord(previous, 10, "bbb", 6)).toStrictEqual({
      reviewId: 10,
      event: "APPROVE",
      headSha: "bbb",
      heldBack: 0,
      at: 6,
      requestChangesWorkflow: true,
      counts: { blocking: 1, suggestion: 2, nitpick: 0 },
    })
  })

  it("has no counts to keep when there is no last review, or it kept none", () => {
    const approved = {
      reviewId: 10,
      event: "APPROVE",
      headSha: "bbb",
      heldBack: 0,
      at: 6,
      requestChangesWorkflow: true,
    }
    expect(approvalRecord(undefined, 10, "bbb", 6)).toStrictEqual(approved)
    expect(approvalRecord(requested, 10, "bbb", 6)).toStrictEqual(approved)
  })

  it("is the evaluation's own approval record, with the last review's counts added", () => {
    const record = evaluatedApprovalOf({ reviewId: 10, headSha: "bbb", at: 6 })
    expect(approvalRecord(undefined, 10, "bbb", 6)).toStrictEqual(record)
    expect(approvalRecord(previous, 10, "bbb", 6)).toStrictEqual({ ...record, counts: previous.counts })
  })
})

describe("LastReview", () => {
  const stored = { reviewId: 1, event: "COMMENT", headSha: "a", verdict: "approve", heldBack: 0, at: 1 }

  it("still reads a last review stored before it kept what the summary showed", () => {
    expect(Value.Check(LastReview, stored)).toBe(true)
  })

  it("reads what the summary showed and its counts, and rejects a verdict a summary can't show", () => {
    const counts = { blocking: 0, suggestion: 1, nitpick: 2 }
    expect(Value.Check(LastReview, { ...stored, shown: "AWAITING_CHECKS", counts })).toBe(true)
    expect(Value.Check(LastReview, { ...stored, shown: "approve" })).toBe(false)
    expect(Value.Check(LastReview, { ...stored, counts: { ...counts, blocking: "0" } })).toBe(false)
  })

  it("reads a record written before the workflow was kept, and refuses a workflow that isn't a boolean", () => {
    expect(Value.Check(LastReview, requested)).toBe(true)
    expect(Value.Check(LastReview, { ...requested, requestChangesWorkflow: false })).toBe(true)
    expect(Value.Check(LastReview, { ...requested, requestChangesWorkflow: "true" })).toBe(false)
  })
})

describe("evaluatedApprovalOf", () => {
  it("records the evaluation's own approval as made under the workflow, which it only approves under", () => {
    expect(evaluatedApprovalOf({ reviewId: 4, headSha: "bbb", at: 7 })).toEqual({
      reviewId: 4,
      event: "APPROVE",
      headSha: "bbb",
      heldBack: 0,
      at: 7,
      requestChangesWorkflow: true,
    })
  })
})

describe("evaluationWorkflow", () => {
  const read = (config: ConfigRead) => {
    const reads: string[] = []
    const reader = async (): Promise<ConfigRead> => {
      reads.push("read")
      return config
    }
    return { reader, reads }
  }
  const missing: ConfigRead = { config: structuredClone(DEFAULT_CONFIG), error: undefined, present: false }
  const workflowOff: ConfigRead = { ...parseConfig("reviews:\n  request_changes_workflow: false\n"), present: true }
  const unreadable: ConfigRead = { ...missing, error: "Error: GitHub 502 : boom" }
  const invalid: ConfigRead = { ...missing, error: "/reviews/auto must be boolean", present: true }

  it("takes the workflow the last review ran under, without reading the config", async () => {
    const { reader, reads } = read(unreadable)
    expect(await evaluationWorkflow({ ...requested, requestChangesWorkflow: false }, reader, "true")).toBe(false)
    expect(await evaluationWorkflow({ ...requested, requestChangesWorkflow: true }, reader, "false")).toBe(true)
    expect(reads).toEqual([])
  })

  it("reads the config for a record that predates the field, or no record: the file's setting, else the var", async () => {
    expect(await evaluationWorkflow(requested, read(workflowOff).reader, "true")).toBe(false)
    expect(await evaluationWorkflow(undefined, read(workflowOff).reader, "true")).toBe(false)
    expect(await evaluationWorkflow(requested, read(missing).reader, "true")).toBe(true)
    expect(await evaluationWorkflow(requested, read(missing).reader, "false")).toBe(false)
  })

  it("takes the var for an invalid file, whose defaults applied, and reads the config once", async () => {
    const { reader, reads } = read(invalid)
    expect(await evaluationWorkflow(requested, reader, "true")).toBe(true)
    expect(reads).toEqual(["read"])
  })

  it("waits on a config it couldn't read, never falling back to the var", async () => {
    expect(await evaluationWorkflow(requested, read(unreadable).reader, "true")).toBe("unknown")
    expect(await evaluationWorkflow(undefined, read(unreadable).reader, "false")).toBe("unknown")
  })
})

describe("evaluatesReviewedHead", () => {
  it("evaluates approval when a push finds its head already reviewed on an open pull request that is ready", () => {
    expect(evaluatesReviewedHead({ state: "open", draft: false }, "push")).toBe(true)
    expect(evaluatesReviewedHead({ state: "open" }, "push")).toBe(true)
  })

  it("leaves a draft, a closed pull request and a command alone", () => {
    expect(evaluatesReviewedHead({ state: "open", draft: true }, "push")).toBe(false)
    expect(evaluatesReviewedHead({ state: "closed", draft: false }, "push")).toBe(false)
    expect(evaluatesReviewedHead({ state: "open", draft: false }, "command")).toBe(false)
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

describe("nextRecheck", () => {
  const pending = { kind: "wait", reason: "checks_pending" } as const

  it("re-checks a CI-completed evaluation that still reads the checks as pending 20 seconds, 1 minute and 5 minutes later, then stops", () => {
    expect(nextRecheck("checks_completed", pending, 0)).toEqual({ attempt: 1, inMs: 20_000 })
    expect(nextRecheck("recheck", pending, 1)).toEqual({ attempt: 2, inMs: 60_000 })
    expect(nextRecheck("recheck", pending, 2)).toEqual({ attempt: 3, inMs: 300_000 })
    expect(nextRecheck("recheck", pending, 3)).toBeUndefined()
  })

  it("re-checks while the review is in flight, when a read fails and when the evaluation throws", () => {
    for (const reason of ["review_in_flight", "checks_unknown", "threads_unknown", "workflow_unknown"] as const) {
      expect(nextRecheck("checks_completed", { kind: "wait", reason }, 0)).toEqual({ attempt: 1, inMs: 20_000 })
    }
    expect(nextRecheck("recheck", { kind: "failed" }, 1)).toEqual({ attempt: 2, inMs: 60_000 })
  })

  it("stops once the answer is final", () => {
    expect(nextRecheck("recheck", { kind: "approved", head: "bbb" }, 1)).toBeUndefined()
    const final = [
      "approved",
      "approving",
      "head_moved",
      "checks_failing",
      "blocking_threads",
      "review_stands",
      "not_reviewed",
      "no_record",
      "paused",
      "not_open",
      "workflow_off",
    ] as const
    for (const reason of final) {
      expect(nextRecheck("checks_completed", { kind: "wait", reason }, 0)).toBeUndefined()
    }
  })

  it("leaves an evaluation no CI-completed event started to the events still to come", () => {
    for (const trigger of [
      "review",
      "thread_resolved",
      "thread_unresolved",
      "already_reviewed",
      "resolve",
      "resume",
    ] as const) {
      expect(nextRecheck(trigger, pending, 0)).toBeUndefined()
    }
  })
})

describe("RecheckJob", () => {
  it("reads a stored re-check, and refuses one without a positive whole attempt or a delivery", () => {
    expect(Value.Check(RecheckJob, { attempt: 2, delivery: "d" })).toBe(true)
    expect(Value.Check(RecheckJob, { attempt: 0, delivery: "d" })).toBe(false)
    expect(Value.Check(RecheckJob, { attempt: 1.5, delivery: "d" })).toBe(false)
    expect(Value.Check(RecheckJob, { attempt: 2 })).toBe(false)
  })
})
