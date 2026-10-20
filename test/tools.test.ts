import { describe, expect, it } from "vitest"
import { GitHubClient, type PullRequestInfo } from "../src/github/client.ts"
import { createReviewExtension, readIssue, submitResult, type ReviewHost } from "../src/review/tools.ts"

const pr = {
  number: 21,
  title: "Fix totals",
  body: "Totals were NaN for an empty cart.",
  state: "open",
  user: { login: "andrew" },
  base: { ref: "main", sha: "0123456789abcdef", repo: { full_name: "o/r" } },
  head: { ref: "fix/totals.GH-7", sha: "fedcba9876543210" },
  changed_files: 0,
  additions: 0,
  deletions: 0,
  labels: [],
} satisfies PullRequestInfo

const answers = new Map([
  [
    "https://api.example/repos/o/r/issues/7",
    { status: 200, body: JSON.stringify({ number: 7, title: "Fix totals", body: "Totals are NaN.", state: "open" }) },
  ],
  ["https://api.example/repos/o/r/issues/8", { status: 404, body: "{}" }],
  [
    "https://api.example/repos/o/r/issues/9",
    {
      status: 200,
      body: JSON.stringify({ number: 9, title: "Add totals", body: "", state: "open", pull_request: {} }),
    },
  ],
])

const fakeFetch = async (input: RequestInfo | URL) => {
  const answer = answers.get(String(input))
  if (answer === undefined) return new Response(`no answer for ${String(input)}`, { status: 500 })
  return new Response(answer.body, { status: answer.status })
}

const host = {
  botLogin: () => "andabot",
  github: async () => new GitHubClient("token", "https://api.example", fakeFetch),
  pullRequest: async () => pr,
  changedFiles: async () => [],
  submitReview: async () => ({ text: "Nothing to post.", done: false }),
} satisfies ReviewHost

describe("createReviewExtension", () => {
  it("offers the model four tools, with submit_review last", () => {
    expect(createReviewExtension(host).tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_changed_files",
      "get_issue",
      "submit_review",
    ])
  })
})

describe("readIssue", () => {
  it("gives an issue's number, title, state and body", async () => {
    expect(await readIssue(host, 7)).toBe("#7: Fix totals (open)\n\nTotals are NaN.")
  })

  it("says so when the issue does not exist", async () => {
    expect(await readIssue(host, 8)).toBe("Issue #8 does not exist.")
  })

  it("says so when the number is a pull request, which GitHub's issue endpoint also serves", async () => {
    expect(await readIssue(host, 9)).toBe("#9 is a pull request, not an issue.")
  })
})

describe("submitResult", () => {
  it("ends the run when the host says the review is done", () => {
    expect(submitResult({ text: "Posted review 1.", done: true })).toEqual({
      output: [{ type: "text", text: "Posted review 1." }],
      control: { terminate: true },
    })
  })

  it("leaves the run going when the host says there is more to do, so the model can correct and submit again", () => {
    const result = submitResult({ text: "Nothing to post.", done: false })
    expect(result.output).toEqual([{ type: "text", text: "Nothing to post." }])
    expect(result).not.toHaveProperty("control")
  })
})
