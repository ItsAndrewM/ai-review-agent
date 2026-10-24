import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import type { FindingInput, Rejected, ReviewSubmissionInput, ValidatedReview } from "../src/review/findings.ts"
import { applyDeltaPolicy, type DeltaScope, type OpenThread, type ScopedReview } from "../src/review/incremental.ts"
import { chooseReviewEvent, holdsApprovalBack } from "../src/review/render.ts"
import {
  applyVerdicts,
  verdictAfterVerify,
  VerdictInput,
  VerdictsSubmission,
  verifyCandidates,
  type VerifyReport,
} from "../src/review/verify.ts"

function finding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    path: "a.ts",
    line: 3,
    quote: "three",
    basis_kind: "defect",
    basis: "b",
    severity: "suggestion",
    title: "t",
    body: "b",
    ...overrides,
  }
}

function rejection(overrides: Partial<FindingInput> = {}, unfounded = false): Rejected {
  return { finding: finding(overrides), reason: "line 40 (RIGHT) is not in the diff of a.ts", unfounded }
}

function validated(accepted: FindingInput[], rejected: Rejected[] = []): ValidatedReview {
  return { accepted, rejected, relocated: 0, suggestionsDropped: 0 }
}

function scoped(accepted: FindingInput[], rejected: Rejected[] = [], duplicates: Rejected[] = []): ScopedReview {
  return { accepted, rejected, duplicates }
}

function thread(handle: string, overrides: Partial<OpenThread> = {}): OpenThread {
  return {
    handle,
    threadId: `thread-${handle}`,
    firstCommentId: 1,
    path: "a.ts",
    line: 3,
    side: "RIGHT",
    outdated: false,
    title: "t",
    blocking: false,
    ...overrides,
  }
}

function verdict(id: string, severity: FindingInput["severity"], overrides: Partial<VerdictInput> = {}): VerdictInput {
  return { finding: id, keep: true, severity, reason: `why ${id}`, ...overrides }
}

function submission(verdictOfModel: ReviewSubmissionInput["verdict"]): ReviewSubmissionInput {
  return {
    summary: "s",
    walkthrough: [],
    findings: [],
    verdict: verdictOfModel,
    merge_danger: { door: "two-way", blast_radius: "one module" },
  }
}

const FRESH: DeltaScope = { mode: "fresh", covered: new Map(), open: [] }

const NOTHING: VerifyReport = { dropped: [], changed: [], capped: [], notJudged: [], unknown: [] }

function judge(review: ValidatedReview, verdicts: VerdictInput[], scope: DeltaScope = FRESH) {
  const candidates = verifyCandidates(applyDeltaPolicy(review, scope))
  return applyVerdicts(review, candidates, verdicts)
}

describe("VerdictInput", () => {
  const good = { finding: "F1", keep: true, severity: "blocking", reason: "the caller awaits it" }

  it("takes a finding id, keep or drop, a severity and a reason", () => {
    expect(Value.Check(VerdictInput, good)).toBe(true)
    expect(Value.Check(VerdictsSubmission, { verdicts: [good, { ...good, finding: "F2", keep: false }] })).toBe(true)
    expect(Value.Check(VerdictsSubmission, { verdicts: [] })).toBe(true)
  })

  it.each([
    ["an empty reason", { ...good, reason: "" }],
    ["no reason", { finding: "F1", keep: true, severity: "blocking" }],
    ["a severity it doesn't know", { ...good, severity: "critical" }],
    ["a keep that isn't a boolean", { ...good, keep: "yes" }],
    ["no finding id", { keep: true, severity: "blocking", reason: "r" }],
  ])("refuses %s", (_, bad) => {
    expect(Value.Check(VerdictInput, bad)).toBe(false)
    expect(Value.Check(VerdictsSubmission, { verdicts: [good, bad] })).toBe(false)
  })

  it("refuses a submission whose verdicts aren't a list", () => {
    expect(Value.Check(VerdictsSubmission, { verdicts: good })).toBe(false)
    expect(Value.Check(VerdictsSubmission, {})).toBe(false)
  })
})

describe("verifyCandidates", () => {
  it("numbers the accepted blocking findings and suggestions in order, and leaves nitpicks out", () => {
    const first = finding({ severity: "blocking", line: 1 })
    const nitpick = finding({ severity: "nitpick", line: 2 })
    const third = finding({ severity: "suggestion", line: 3 })
    const candidates = verifyCandidates(scoped([first, nitpick, third]))
    expect(candidates).toEqual([
      { id: "F1", finding: first, held: false },
      { id: "F2", finding: third, held: false },
    ])
    expect(candidates[0]?.finding).toBe(first)
    expect(candidates[1]?.finding).toBe(third)
  })

  it("adds the blocking findings rejected for their anchor after the accepted ones, as held", () => {
    const posted = finding({ severity: "suggestion", line: 1 })
    const anchor = rejection({ severity: "blocking", line: 40 })
    const candidates = verifyCandidates(scoped([posted], [anchor]))
    expect(candidates).toEqual([
      { id: "F1", finding: posted, held: false },
      { id: "F2", finding: anchor.finding, held: true },
    ])
    expect(candidates[1]?.finding).toBe(anchor.finding)
  })

  it("leaves out the rejections that hold nothing back, and the duplicates of open threads", () => {
    const duplicate = {
      finding: finding({ severity: "blocking" }),
      reason: "duplicates open thread T1",
      unfounded: false,
    }
    const review = scoped(
      [],
      [
        rejection({ severity: "suggestion", line: 7 }),
        rejection({ severity: "nitpick", line: 8 }),
        rejection({ severity: "blocking", line: 9 }, true),
      ],
      [duplicate],
    )
    expect(verifyCandidates(review)).toEqual([])
  })

  it("has no candidates for a review with no findings", () => {
    expect(verifyCandidates(scoped([]))).toEqual([])
  })
})

describe("applyVerdicts", () => {
  it("leaves a finding as it was when the verdict keeps it at its severity, and reports nothing", () => {
    const blocker = finding({ severity: "blocking", line: 1 })
    const advice = finding({ severity: "suggestion", line: 2 })
    const nitpick = finding({ severity: "nitpick", line: 3 })
    const anchor = rejection({ severity: "blocking", line: 40 })
    const review = { ...validated([blocker, advice, nitpick], [anchor]), relocated: 2, suggestionsDropped: 1 }
    const result = judge(review, [verdict("F1", "blocking"), verdict("F2", "suggestion"), verdict("F3", "blocking")])
    expect(result.validated).toEqual(review)
    expect(result.validated.accepted[0]).toBe(blocker)
    expect(result.validated.accepted[1]).toBe(advice)
    expect(result.validated.accepted[2]).toBe(nitpick)
    expect(result.validated.rejected[0]).toBe(anchor)
    expect(result.report).toEqual(NOTHING)
  })

  it("removes a dropped finding and reports it with the verdict's reason", () => {
    const first = finding({ severity: "blocking", line: 1 })
    const second = finding({ severity: "suggestion", line: 2 })
    const third = finding({ severity: "suggestion", line: 3 })
    const result = judge(validated([first, second, third]), [
      verdict("F1", "blocking"),
      verdict("F2", "suggestion", { keep: false, reason: "the caller checks it" }),
      verdict("F3", "suggestion"),
    ])
    expect(result.validated.accepted).toEqual([first, third])
    expect(result.report).toEqual({ ...NOTHING, dropped: [{ finding: second, reason: "the caller checks it" }] })
  })

  it("removes a dropped held finding from the rejected list and keeps the other rejections", () => {
    const posted = finding({ severity: "blocking", line: 1 })
    const anchor = rejection({ severity: "blocking", line: 40 })
    const unposted = rejection({ severity: "suggestion", line: 41 })
    const result = judge(validated([posted], [anchor, unposted]), [
      verdict("F1", "blocking"),
      verdict("F2", "blocking", { keep: false, reason: "no caller does that" }),
    ])
    expect(result.validated.accepted).toEqual([posted])
    expect(result.validated.rejected).toEqual([unposted])
    expect(result.report).toEqual({ ...NOTHING, dropped: [{ finding: anchor.finding, reason: "no caller does that" }] })
  })

  it.each(["defect", "spec"] as const)("promotes a suggestion with the %s basis to blocking", (basis) => {
    const advice = finding({ severity: "suggestion", basis_kind: basis })
    const result = judge(validated([advice]), [verdict("F1", "blocking", { reason: "it loses data" })])
    expect(result.validated.accepted).toEqual([{ ...advice, severity: "blocking" }])
    expect(result.report).toEqual({
      ...NOTHING,
      changed: [
        {
          finding: advice,
          reason: "it loses data",
          from: "suggestion",
          to: "blocking",
          revised: { ...advice, severity: "blocking" },
        },
      ],
    })
    expect(advice.severity).toBe("suggestion")
  })

  it.each(["standard", "test"] as const)(
    "keeps a %s suggestion a suggestion when the verdict says blocking, and reports it as capped",
    (basis) => {
      const advice = finding({ severity: "suggestion", basis_kind: basis })
      const result = judge(validated([advice]), [verdict("F1", "blocking", { reason: "it breaks the rule" })])
      expect(result.validated.accepted[0]).toBe(advice)
      expect(result.report).toEqual({ ...NOTHING, capped: [{ finding: advice, reason: "it breaks the rule" }] })
    },
  )

  it("lets a standard suggestion be demoted, since the cap stops only a promotion to blocking", () => {
    const advice = finding({ severity: "suggestion", basis_kind: "standard" })
    const result = judge(validated([advice]), [verdict("F1", "nitpick", { reason: "style only" })])
    expect(result.validated.accepted).toEqual([{ ...advice, severity: "nitpick" }])
    expect(result.report).toEqual({
      ...NOTHING,
      changed: [
        {
          finding: advice,
          reason: "style only",
          from: "suggestion",
          to: "nitpick",
          revised: { ...advice, severity: "nitpick" },
        },
      ],
    })
  })

  it("drops a standard suggestion the verdict drops, whatever severity the verdict carries", () => {
    const advice = finding({ severity: "suggestion", basis_kind: "test" })
    const result = judge(validated([advice]), [verdict("F1", "blocking", { keep: false, reason: "it is covered" })])
    expect(result.validated.accepted).toEqual([])
    expect(result.report).toEqual({ ...NOTHING, dropped: [{ finding: advice, reason: "it is covered" }] })
  })

  it("demotes a blocking finding and reports the change", () => {
    const blocker = finding({ severity: "blocking", line: 1 })
    const result = judge(validated([blocker]), [verdict("F1", "suggestion", { reason: "the caller awaits it" })])
    expect(result.validated.accepted).toEqual([{ ...blocker, severity: "suggestion" }])
    expect(result.report).toEqual({
      ...NOTHING,
      changed: [
        {
          finding: blocker,
          reason: "the caller awaits it",
          from: "blocking",
          to: "suggestion",
          revised: { ...blocker, severity: "suggestion" },
        },
      ],
    })
    expect(result.report.changed[0]?.revised).toBe(result.validated.accepted[0])
    expect(blocker.severity).toBe("blocking")
  })

  it("keeps a demoted held finding rejected at its new severity, where it no longer holds approval back", () => {
    const anchor = rejection({ severity: "blocking", line: 40 })
    const result = judge(validated([], [anchor]), [verdict("F1", "suggestion", { reason: "harmless" })])
    expect(result.validated.rejected).toEqual([{ ...anchor, finding: { ...anchor.finding, severity: "suggestion" } }])
    expect(result.validated.rejected.map(holdsApprovalBack)).toEqual([false])
    expect(holdsApprovalBack(anchor)).toBe(true)
    expect(result.report).toEqual({
      ...NOTHING,
      changed: [
        {
          finding: anchor.finding,
          reason: "harmless",
          from: "blocking",
          to: "suggestion",
          revised: { ...anchor.finding, severity: "suggestion" },
        },
      ],
    })
    expect(result.report.changed[0]?.revised).toBe(result.validated.rejected[0]?.finding)
  })

  it("leaves a finding without a verdict as drafted, and lists it as not judged", () => {
    const first = finding({ severity: "blocking", line: 1 })
    const second = finding({ severity: "suggestion", line: 2 })
    const anchor = rejection({ severity: "blocking", line: 40 })
    const result = judge(validated([first, second], [anchor]), [verdict("F2", "suggestion", { keep: false })])
    expect(result.validated.accepted).toEqual([first])
    expect(result.validated.rejected).toEqual([anchor])
    expect(result.report.notJudged).toEqual([first, anchor.finding])
    expect(result.report.dropped).toHaveLength(1)
  })

  it("judges nothing and drops nothing when verify gave no verdicts", () => {
    const blocker = finding({ severity: "blocking", line: 1 })
    const anchor = rejection({ severity: "blocking", line: 40 })
    const review = validated([blocker], [anchor])
    const result = judge(review, [])
    expect(result.validated).toEqual(review)
    expect(result.report).toEqual({ ...NOTHING, notJudged: [blocker, anchor.finding] })
  })

  it("ignores a verdict for an id no candidate has, and lists the id as unknown", () => {
    const first = finding({ severity: "blocking", line: 1 })
    const second = finding({ severity: "suggestion", line: 2 })
    const result = judge(validated([first, second]), [
      verdict("F1", "blocking"),
      verdict("F2", "suggestion"),
      verdict("F9", "nitpick", { keep: false }),
    ])
    expect(result.validated.accepted).toEqual([first, second])
    expect(result.report).toEqual({ ...NOTHING, unknown: ["F9"] })
  })

  it("lists every ignored verdict, in the order verify gave them", () => {
    const only = finding({ severity: "blocking", line: 1 })
    const result = judge(validated([only]), [
      verdict("F2", "blocking", { keep: false }),
      verdict("F1", "blocking"),
      verdict("F2", "blocking"),
      verdict("F1", "nitpick"),
    ])
    expect(result.validated.accepted).toEqual([only])
    expect(result.report).toEqual({ ...NOTHING, unknown: ["F2", "F2", "F1"] })
  })

  it("applies the first of two verdicts for one finding, and lists the id of the ignored one as unknown", () => {
    const only = finding({ severity: "blocking", line: 1 })
    const dropFirst = judge(validated([only]), [
      verdict("F1", "blocking", { keep: false, reason: "first" }),
      verdict("F1", "blocking", { reason: "second" }),
    ])
    expect(dropFirst.validated.accepted).toEqual([])
    expect(dropFirst.report).toEqual({ ...NOTHING, dropped: [{ finding: only, reason: "first" }], unknown: ["F1"] })
    const keepFirst = judge(validated([only]), [
      verdict("F1", "blocking", { reason: "first" }),
      verdict("F1", "blocking", { keep: false, reason: "second" }),
    ])
    expect(keepFirst.validated.accepted).toEqual([only])
    expect(keepFirst.report).toEqual({ ...NOTHING, unknown: ["F1"] })
  })

  it("matches a candidate to its finding by identity, so two equal findings are told apart", () => {
    const posted = finding({ severity: "blocking", line: 1 })
    const twin = rejection({ severity: "blocking", line: 1 })
    expect(twin.finding).toEqual(posted)
    const result = judge(validated([posted], [twin]), [
      verdict("F1", "blocking"),
      verdict("F2", "blocking", { keep: false }),
    ])
    expect(result.validated.accepted).toHaveLength(1)
    expect(result.validated.accepted[0]).toBe(posted)
    expect(result.validated.rejected).toEqual([])
  })

  it("does not change the review it was given", () => {
    const review = validated(
      [finding({ severity: "blocking", line: 1 }), finding({ severity: "suggestion", line: 2 })],
      [rejection({ severity: "blocking", line: 40 })],
    )
    const before = structuredClone(review)
    judge(review, [
      verdict("F1", "suggestion"),
      verdict("F2", "blocking", { keep: false }),
      verdict("F3", "suggestion"),
    ])
    expect(review).toEqual(before)
  })
})

describe("applyVerdicts with the delta rules", () => {
  it("judges only what the delta rules let through, and leaves the rest of the review as it was", () => {
    const covered = new Map([["a.ts", { right: new Set([3]), left: new Set<number>() }]])
    const scope: DeltaScope = { mode: "incremental", covered, open: [thread("T1", { line: 5 })] }
    const onPush = finding({ severity: "suggestion", line: 3 })
    const offPush = finding({ severity: "suggestion", line: 9, quote: "nine" })
    const onThread = finding({ severity: "suggestion", line: 5, quote: "five" })
    const review = validated([offPush, onPush, onThread])
    const candidates = verifyCandidates(applyDeltaPolicy(review, scope))
    expect(candidates).toEqual([{ id: "F1", finding: onPush, held: false }])
    const applied = applyVerdicts(review, candidates, [verdict("F1", "suggestion", { keep: false })])
    expect(applied.validated.accepted).toEqual([offPush, onThread])
    expect(applied.report).toEqual({ ...NOTHING, dropped: [{ finding: onPush, reason: "why F1" }] })
  })

  it("rejects a blocking finding off the push's lines once verify demotes it, and the report names the rejected finding", () => {
    const covered = new Map([["a.ts", { right: new Set([3]), left: new Set<number>() }]])
    const scope: DeltaScope = { mode: "incremental", covered, open: [] }
    const elsewhere = finding({ severity: "blocking", line: 9, quote: "nine" })
    const review = validated([elsewhere])
    expect(applyDeltaPolicy(review, scope).accepted).toEqual([elsewhere])
    const applied = judge(review, [verdict("F1", "suggestion")], scope)
    const after = applyDeltaPolicy(applied.validated, scope)
    expect(after.accepted).toEqual([])
    expect(after.rejected).toEqual([
      {
        finding: { ...elsewhere, severity: "suggestion" },
        reason: "line 9 was not changed since the last review; only a blocking finding may go elsewhere",
        unfounded: false,
      },
    ])
    expect(applied.report.changed).toHaveLength(1)
    expect(applied.report.changed[0]?.finding).toBe(elsewhere)
    expect(applied.report.changed[0]?.revised).toBe(after.rejected[0]?.finding)
  })

  it("sets a blocking finding on a non-blocking thread's line aside once verify demotes it, and the report names the duplicate", () => {
    const scope: DeltaScope = { mode: "full", covered: new Map(), open: [thread("T1", { line: 3 })] }
    const onThread = finding({ severity: "blocking", line: 3 })
    const review = validated([onThread])
    expect(applyDeltaPolicy(review, scope).accepted).toEqual([onThread])
    const applied = judge(review, [verdict("F1", "suggestion")], scope)
    const after = applyDeltaPolicy(applied.validated, scope)
    expect(after.accepted).toEqual([])
    expect(after.duplicates).toEqual([
      { finding: { ...onThread, severity: "suggestion" }, reason: "duplicates open thread T1", unfounded: false },
    ])
    expect(applied.report.changed).toHaveLength(1)
    expect(applied.report.changed[0]?.finding).toBe(onThread)
    expect(applied.report.changed[0]?.revised).toBe(after.duplicates[0]?.finding)
  })

  const onChangedLine: DeltaScope = {
    mode: "incremental",
    covered: new Map([["a.ts", { right: new Set([3]), left: new Set<number>() }]]),
    open: [],
  }

  it.each([
    ["a fresh scope", FRESH],
    ["an incremental scope, on a line the push changed", onChangedLine],
  ])(
    "accepts a demoted finding the delta rules still let through in %s, and the report names the accepted finding",
    (_, scope) => {
      const blocker = finding({ severity: "blocking", line: 3 })
      const applied = judge(validated([blocker]), [verdict("F1", "suggestion")], scope)
      const after = applyDeltaPolicy(applied.validated, scope)
      expect(after.accepted).toEqual([{ ...blocker, severity: "suggestion" }])
      expect(after.rejected).toEqual([])
      expect(after.duplicates).toEqual([])
      expect(applied.report.changed).toHaveLength(1)
      expect(applied.report.changed[0]?.revised).toBe(after.accepted[0])
    },
  )

  it("leaves a demoted held finding in the rejected list, and the report names that finding", () => {
    const anchor = rejection({ severity: "blocking", line: 40 })
    const applied = judge(validated([], [anchor]), [verdict("F1", "suggestion")], onChangedLine)
    const after = applyDeltaPolicy(applied.validated, onChangedLine)
    expect(after.rejected.map(holdsApprovalBack)).toEqual([false])
    expect(after.accepted).toEqual([])
    expect(applied.report.changed).toHaveLength(1)
    expect(applied.report.changed[0]?.revised).toBe(after.rejected[0]?.finding)
  })
})

describe("verdictAfterVerify", () => {
  const withBlocker = scoped([finding({ severity: "blocking" })])
  const withHeld = scoped([], [rejection({ severity: "blocking", line: 40 })])
  const withoutBlocker = scoped(
    [finding({ severity: "suggestion" })],
    [rejection({ severity: "suggestion", line: 41 })],
  )

  it("approves a request for changes once verify has cleared every blocking finding, accepted or held back", () => {
    expect(verdictAfterVerify("request_changes", withBlocker, withoutBlocker)).toBe("approve")
    expect(verdictAfterVerify("request_changes", withHeld, withoutBlocker)).toBe("approve")
  })

  it("keeps the request for changes while a blocking finding remains, accepted or held back", () => {
    expect(verdictAfterVerify("request_changes", withBlocker, withBlocker)).toBe("request_changes")
    expect(verdictAfterVerify("request_changes", withBlocker, withHeld)).toBe("request_changes")
    expect(verdictAfterVerify("request_changes", withHeld, withBlocker)).toBe("request_changes")
    expect(verdictAfterVerify("request_changes", withHeld, withHeld)).toBe("request_changes")
  })

  it("keeps the request for changes when there was nothing blocking for verify to clear", () => {
    expect(verdictAfterVerify("request_changes", withoutBlocker, withoutBlocker)).toBe("request_changes")
  })

  it("ignores a rejected blocking finding that holds nothing back", () => {
    const unfounded = scoped([], [rejection({ severity: "blocking", line: 42 }, true)])
    expect(verdictAfterVerify("request_changes", unfounded, withoutBlocker)).toBe("request_changes")
    expect(verdictAfterVerify("request_changes", withBlocker, unfounded)).toBe("approve")
  })

  it.each(["comment", "approve"] as const)("leaves %s as it was, whatever verify did", (original) => {
    const cases = [
      { before: withBlocker, after: withoutBlocker },
      { before: withHeld, after: withoutBlocker },
      { before: withBlocker, after: withBlocker },
      { before: withoutBlocker, after: withoutBlocker },
    ]
    for (const { before, after } of cases) expect(verdictAfterVerify(original, before, after)).toBe(original)
  })

  it("lets a review whose only blocking finding verify demoted approve, where it would have posted as a comment", () => {
    const review = validated([finding({ severity: "blocking", line: 1 })])
    const before = applyDeltaPolicy(review, FRESH)
    const applied = judge(review, [verdict("F1", "suggestion")])
    const after = applyDeltaPolicy(applied.validated, FRESH)
    const adjusted = verdictAfterVerify("request_changes", before, after)
    expect(adjusted).toBe("approve")
    expect(chooseReviewEvent(submission(adjusted), after.accepted, after.rejected, true, 0)).toBe("APPROVE")
    expect(chooseReviewEvent(submission("request_changes"), after.accepted, after.rejected, true, 0)).toBe("COMMENT")
  })
})
