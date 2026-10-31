import { describe, expect, it } from "vitest"
import { parseSet, pullRequestOf, regexOf } from "../tools/recall/schema.ts"
import { expecting, headCase } from "./recall-fixtures.ts"

const text = (heads: ReturnType<typeof headCase>[]) => JSON.stringify({ heads })

describe("parseSet", () => {
  it("accepts a one-head set", () => {
    const set = parseSet(text([headCase()]))
    expect(set.heads).toHaveLength(1)
    expect(set.heads[0]?.expects[0]?.id).toBe("9-1")
  })

  it("rejects a set that does not match the schema", () => {
    expect(() => parseSet('{"heads":[{"pr":9}]}')).toThrow("Recall set does not match its schema")
  })

  it("rejects a duplicate head", () => {
    expect(() => parseSet(text([headCase(), headCase({ pr: 10 })]))).toThrow(`Duplicate head ${"a".repeat(40)}`)
  })

  it("rejects a duplicate expected id across heads", () => {
    const other = headCase({ head: "c".repeat(40), expects: [expecting("9-1")] })
    expect(() => parseSet(text([headCase(), other]))).toThrow("Duplicate expected finding 9-1")
  })

  it("rejects a pattern that does not compile", () => {
    const bad = headCase({ expects: [expecting("9-2", { pattern: "(" })] })
    expect(() => parseSet(text([bad]))).toThrow("Expected finding 9-2 has an invalid pattern")
    const known = headCase({ knownFalse: [{ id: "k1", path: "src/x.ts", pattern: "[", note: "n" }] })
    expect(() => parseSet(text([known]))).toThrow("Known finding k1 has an invalid pattern")
  })

  it("rejects reversed lines", () => {
    const bad = headCase({ expects: [expecting("9-3", { lines: [12, 10] })] })
    expect(() => parseSet(text([bad]))).toThrow("Expected finding 9-3 has reversed lines")
  })
})

describe("pullRequestOf", () => {
  it("builds the pull request the prompt renders from the frozen head", () => {
    const pr = pullRequestOf(headCase({ labels: ["fixture"] }))
    expect(pr.user.login).toBe("ItsAndrewM")
    expect(pr.state).toBe("open")
    expect(pr.base).toEqual({ ref: "main", sha: "b".repeat(40), repo: { full_name: "ItsAndrewM/ai-review-agent" } })
    expect(pr.head).toEqual({ ref: "chore/tidy-the-example", sha: "a".repeat(40) })
    expect([pr.changed_files, pr.additions, pr.deletions]).toEqual([1, 3, 1])
    expect(pr.labels).toEqual([{ name: "fixture" }])
  })
})

describe("regexOf", () => {
  it("matches case-insensitively", () => {
    expect(regexOf("Wrong Total").test("the wrong total is shown")).toBe(true)
  })
})
