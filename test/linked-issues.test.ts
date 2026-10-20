import { describe, expect, it } from "vitest"
import type { Issue } from "../src/github/client.ts"
import { issueText, linkedIssueNumbers, linkedIssuesFrom, readLinkedIssues } from "../src/review/linked-issues.ts"

describe("linkedIssueNumbers", () => {
  it("reads closing keywords, then the branch's GH-n, then its trailing .n, unique and capped at three", () => {
    expect(linkedIssueNumbers("Fixes #7, closes #3, resolves #9, fixed #7 and fixes #11", "feature/x.GH-5")).toEqual([
      7, 3, 9,
    ])
    expect(linkedIssueNumbers("Fixes #7", "feature/x.GH-5.12")).toEqual([7, 5, 12])
    expect(linkedIssueNumbers(null, "fix/thing.GH-12")).toEqual([12])
    expect(linkedIssueNumbers("", "feature/thing.8")).toEqual([8])
    expect(linkedIssueNumbers("nothing", "main")).toEqual([])
  })

  it("puts a branch's GH-n ahead of its trailing .n", () => {
    expect(linkedIssueNumbers("", "fix/GH-5-thing.8")).toEqual([5, 8])
  })

  it("leaves out a bare mention when a closing keyword or the branch key names the spec, since a passing mention is no requirement", () => {
    expect(linkedIssueNumbers("Closes #12. Compare with #2.", "feature/x.GH-14")).toEqual([12, 14])
    expect(linkedIssueNumbers("See #3. Fixes #7", "main")).toEqual([7])
    expect(linkedIssueNumbers("Builds on #2", "feature/review-only-what-changed.24")).toEqual([24])
  })

  it("falls back to bare mentions only when neither a closing keyword nor the branch names an issue", () => {
    expect(linkedIssueNumbers("#2 and #3", "chore/x")).toEqual([2, 3])
    expect(linkedIssueNumbers("See #3 and #4, and #3 again", "main")).toEqual([3, 4])
  })

  it("no longer reads a trailing #n on the branch, since a branch is keyed by .n or GH-n", () => {
    expect(linkedIssueNumbers("", "feature/thing#8")).toEqual([])
  })

  it("leaves another repository's owner/repo#n alone, since its number names an issue there", () => {
    expect(linkedIssueNumbers("Needs cloudflare/agents#412 first. Fixes #2", "main")).toEqual([2])
    expect(linkedIssueNumbers("Needs cloudflare/agents#412 first. See #2", "main")).toEqual([2])
  })
})

describe("readLinkedIssues", () => {
  it("reports an issue it cannot read and goes on without it, since linked issues are optional context", async () => {
    const found = { number: 7, title: "T", body: "", state: "open" } satisfies Issue
    const reported: string[] = []
    const reads = await readLinkedIssues(
      [7, 9, 4],
      async (number) => {
        if (number === 9) throw new Error("GitHub 410 : gone")
        return number === 7 ? found : undefined
      },
      (number, error) => reported.push(`#${number} ${error}`),
    )
    expect(reads).toEqual([
      { number: 7, issue: found },
      { number: 9, issue: undefined },
      { number: 4, issue: undefined },
    ])
    expect(reported).toEqual(["#9 Error: GitHub 410 : gone"])
  })
})

describe("linkedIssuesFrom", () => {
  it("skips missing issues and pull requests, and cuts long bodies and marks them cut", () => {
    const issues = linkedIssuesFrom([
      { number: 4, issue: undefined },
      { number: 5, issue: { number: 5, title: "P", body: "", state: "open", pull_request: {} } },
      { number: 7, issue: { number: 7, title: "T", body: "x".repeat(5000), state: "open" } },
      { number: 8, issue: { number: 8, title: "U", body: null, state: "closed" } },
      { number: 9, issue: { number: 9, title: "V", body: "y".repeat(4000), state: "open" } },
    ])
    expect(issues).toEqual([
      { number: 7, title: "T", body: "x".repeat(4000), cut: true },
      { number: 8, title: "U", body: "", cut: false },
      { number: 9, title: "V", body: "y".repeat(4000), cut: false },
    ])
  })

  it("lists a transferred issue under the number the pull request named, not the one GitHub redirected to", () => {
    const issues = linkedIssuesFrom([{ number: 7, issue: { number: 107, title: "T", body: "b", state: "open" } }])
    expect(issues).toEqual([{ number: 7, title: "T", body: "b", cut: false }])
  })
})

describe("issueText", () => {
  it("gives get_issue the issue under the number asked for, or says the number is missing or a pull request", () => {
    expect(
      issueText({ number: 4, issue: { number: 104, title: "Fix totals", body: "Totals are NaN.", state: "closed" } }),
    ).toBe("#4: Fix totals (closed)\n\nTotals are NaN.")
    expect(issueText({ number: 4, issue: undefined })).toBe("Issue #4 does not exist.")
    expect(issueText({ number: 5, issue: { number: 5, title: "P", body: "", state: "open", pull_request: {} } })).toBe(
      "#5 is a pull request, not an issue.",
    )
  })
})
