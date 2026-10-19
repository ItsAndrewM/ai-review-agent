import { describe, expect, it } from "vitest"
import { issueText, linkedIssueNumbers, linkedIssuesFrom } from "../src/review/linked-issues.ts"

describe("linkedIssueNumbers", () => {
  it("prefers closing keywords, then mentions, then the branch, unique and capped at three", () => {
    expect(linkedIssueNumbers("Fixes #7 and relates to #3, see #7 and #9 and #11", "feature/x.GH-5")).toEqual([7, 3, 9])
    expect(linkedIssueNumbers(null, "fix/thing.GH-12")).toEqual([12])
    expect(linkedIssueNumbers("", "feature/thing#8")).toEqual([8])
    expect(linkedIssueNumbers("nothing", "main")).toEqual([])
  })

  it("leaves another repository's owner/repo#n alone, since its number names an issue there", () => {
    expect(linkedIssueNumbers("Needs cloudflare/agents#412 first. Fixes #2", "main")).toEqual([2])
  })
})

describe("linkedIssuesFrom", () => {
  it("skips missing issues and pull requests, and cuts long bodies", () => {
    const issues = linkedIssuesFrom([
      undefined,
      { number: 5, title: "P", body: "", state: "open", pull_request: {} },
      { number: 7, title: "T", body: "x".repeat(5000), state: "open" },
      { number: 8, title: "U", body: null, state: "closed" },
    ])
    expect(issues).toEqual([
      { number: 7, title: "T", body: "x".repeat(4000) },
      { number: 8, title: "U", body: "" },
    ])
  })
})

describe("issueText", () => {
  it("gives get_issue an issue's number, title, state and body, or says the number is missing or a pull request", () => {
    expect(issueText(4, { number: 4, title: "Fix totals", body: "Totals are NaN.", state: "closed" })).toBe(
      "#4: Fix totals (closed)\n\nTotals are NaN.",
    )
    expect(issueText(4, undefined)).toBe("Issue #4 does not exist.")
    expect(issueText(5, { number: 5, title: "P", body: "", state: "open", pull_request: {} })).toBe(
      "#5 is a pull request, not an issue.",
    )
  })
})
