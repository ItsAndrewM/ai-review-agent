import { describe, expect, it } from "vitest"
import {
  answeringGuard,
  evidenceProblem,
  ResolveThreadParameters,
  resolveOutcomeText,
} from "../src/review/thread-resolution.ts"

describe("evidenceProblem", () => {
  it("refuses empty evidence and accepts a path and line", () => {
    expect(evidenceProblem("")).toBe("no_evidence")
    expect(evidenceProblem("   ")).toBe("no_evidence")
    expect(evidenceProblem("src/a.ts:12")).toBeUndefined()
  })
})

describe("answeringGuard", () => {
  it("lets the tool act only while the root session runs the answer's own operation", () => {
    expect(answeringGuard("chat:d-1", "d-1")).toBeUndefined()
    expect(answeringGuard("review:d-2", "d-1")).toBe("not_answering")
    expect(answeringGuard(undefined, "d-1")).toBe("not_answering")
    expect(answeringGuard("chat:d-1", undefined)).toBe("not_answering")
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
