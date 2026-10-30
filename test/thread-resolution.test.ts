import { describe, expect, it } from "vitest"
import type { ReviewThread } from "../src/github/client.ts"
import {
  answeringFor,
  evidenceProblem,
  ResolveThreadParameters,
  resolveOutcomeText,
  startAnswering,
} from "../src/review/thread-resolution.ts"

const thread = (authorLogin: string, authorIsBot: boolean): ReviewThread => ({
  id: "T1",
  resolved: false,
  outdated: false,
  path: "a.ts",
  line: 3,
  side: "RIGHT",
  firstCommentId: 11,
  firstCommentBody: "**🟡 Suggestion: x**",
  authorLogin,
  authorIsBot,
})

describe("evidenceProblem", () => {
  it("refuses empty evidence and accepts a path and line", () => {
    expect(evidenceProblem("")).toBe("no_evidence")
    expect(evidenceProblem("   ")).toBe("no_evidence")
    expect(evidenceProblem("src/a.ts:12")).toBeUndefined()
  })
})

describe("startAnswering", () => {
  it("holds a thread only when andabot opened it, so the tool can never resolve a human's thread", () => {
    expect(startAnswering(thread("andabot", true), "andabot", "d-1")).toEqual({
      deliveryId: "d-1",
      thread: thread("andabot", true),
      resolved: false,
    })
    expect(startAnswering(thread("andrew", false), "andabot", "d-1")).toBeUndefined()
    expect(startAnswering(thread("otherbot", true), "andabot", "d-1")).toBeUndefined()
    expect(startAnswering(undefined, "andabot", "d-1")).toBeUndefined()
  })
})

describe("answeringFor", () => {
  it("finds the answer the root session is running among several in flight, and none for a review's run", () => {
    const a = { deliveryId: "d-1", thread: thread("andabot", true), resolved: false }
    const b = { deliveryId: "d-2", thread: { ...thread("andabot", true), id: "T2" }, resolved: false }
    const answers = new Map([
      ["d-1", a],
      ["d-2", b],
    ])
    expect(answeringFor("chat:d-2", answers)).toBe(b)
    expect(answeringFor("chat:d-1", answers)).toBe(a)
    expect(answeringFor("review:d-3", answers)).toBeUndefined()
    expect(answeringFor(undefined, answers)).toBeUndefined()
  })
})

describe("resolveOutcomeText", () => {
  it("says what happened, points a review at addressed_threads, and keeps an unreachable thread open", () => {
    expect(resolveOutcomeText({ kind: "resolved", reason: "fixed" })).toContain("resolved")
    expect(resolveOutcomeText({ kind: "resolved", reason: "withdrawn" })).toContain("withdrawn")
    expect(resolveOutcomeText({ kind: "refused", refusal: "no_evidence" })).toContain("evidence")
    expect(resolveOutcomeText({ kind: "refused", refusal: "not_answering" })).toContain("addressed_threads")
    expect(resolveOutcomeText({ kind: "refused", refusal: "already_resolved" })).toContain("already resolved")
    expect(resolveOutcomeText({ kind: "refused", refusal: "resolved_by_this_answer" })).toContain("this answer")
    expect(resolveOutcomeText({ kind: "refused", refusal: "unreachable" })).toContain("stays open")
  })
})

describe("ResolveThreadParameters", () => {
  it("takes a reason of fixed or withdrawn and a string of evidence", () => {
    const parameters = JSON.stringify(ResolveThreadParameters)
    expect(parameters).toContain('"fixed"')
    expect(parameters).toContain('"withdrawn"')
    expect(parameters).toContain('"evidence"')
  })
})
