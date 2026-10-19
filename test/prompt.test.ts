import { describe, expect, it } from "vitest"
import type { PullRequestInfo } from "../src/github/client.ts"
import type { OpenThread } from "../src/review/incremental.ts"
import {
  answerPrompt,
  fullPrompt,
  incrementalPrompt,
  rejectionsText,
  resubmitPrompt,
  systemPrompt,
} from "../src/review/prompt.ts"

const pr: PullRequestInfo = {
  number: 7,
  title: "Fix the total",
  body: "Fixes the cart total.",
  state: "open",
  user: { login: "andrew" },
  base: { ref: "main", sha: "base0000000", repo: { full_name: "o/r" } },
  head: { ref: "fix", sha: "def5678901" },
  changed_files: 2,
  additions: 3,
  deletions: 1,
  labels: [],
}

const covered = [
  {
    filename: "a.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: ["@@ -1,2 +1,2 @@", " const a = 1;", "-const b = 2;", "+const b = 3;"].join("\n"),
  },
]
const others = [
  { filename: "b.ts", status: "modified", additions: 2, deletions: 0, patch: "@@ -1 +1,3 @@\n x\n+y\n+z" },
]

function thread(handle: string, overrides: Partial<OpenThread> = {}): OpenThread {
  return {
    handle,
    threadId: `id-${handle}`,
    firstCommentId: 1,
    path: "a.ts",
    line: 2,
    side: "RIGHT",
    outdated: false,
    title: "Total is NaN",
    blocking: true,
    ...overrides,
  }
}

const recheck = [thread("T1", { outdated: true, line: null, quote: "const b = 3;" })]
const open = [...recheck, thread("T2", { path: "b.ts", line: 7, title: "Rename y", blocking: false })]

describe("incrementalPrompt", () => {
  const text = incrementalPrompt(pr, {
    from: "abc1234567",
    covered,
    marked: new Map([["a.ts", { right: new Set([2]), left: new Set([2]) }]]),
    others,
    recheck,
    open,
    leftOut: 2,
  })

  it("names the commit range and marks the lines changed since the last review", () => {
    expect(text).toContain("`abc1234..def5678`")
    expect(text).toContain(
      "A `*` after an anchor marks a line changed since your last review. Comment only on marked lines, except for a blocking bug the new changes cause elsewhere in the diff.",
    )
    expect(text).toContain("L2*    -const b = 2;")
    expect(text).toContain("R2*    +const b = 3;")
  })

  it("lists the files the new commits didn't touch by name only", () => {
    expect(text).toContain("- `b.ts`: unchanged since the last review; read_file if needed")
    expect(text).not.toContain("+y")
  })

  it("lists the threads to re-check apart from the other open ones, and says how many were left out", () => {
    expect(text).toContain("## Threads to re-check\nT1 a.ts (outdated) — Total is NaN — code: `const b = 3;`")
    expect(text).toContain("## Other open threads\nT2 b.ts:7 — Rename y")
    expect(text).toContain("2 more open threads aren't listed.")
  })
})

describe("fullPrompt", () => {
  it("keeps today's whole diff and adds the thread lists", () => {
    const text = fullPrompt(pr, [...covered, ...others], { recheck, open, leftOut: 0 })
    expect(text).toContain("## Diff")
    expect(text).toContain("+y")
    expect(text).toContain("## Threads to re-check\nT1 a.ts (outdated)")
    expect(text).not.toContain("more open threads")
  })
})

describe("systemPrompt", () => {
  it("names the bot and only the three tools the model is given, and leaves the procedure to the skills", () => {
    const text = systemPrompt("andabot")
    expect(text.startsWith("You are andabot")).toBe(true)
    expect(text).toContain("read_file")
    expect(text).toContain("list_changed_files")
    expect(text).toContain("submit_review")
    expect(text).not.toContain("activate_skill")
    expect(text).not.toContain("read_skill_resource")
    expect(text).not.toContain("blocking")
    expect(text).not.toContain("nitpick")
    expect(text.length).toBeLessThan(900)
  })
})

describe("rejectionsText", () => {
  it("returns every rejected finding with its anchor, title and reason, not only the first few", () => {
    const rejected = [1, 2, 3, 4].map((line) => ({
      finding: { path: "src/x.ts", line, quote: "q", severity: "blocking" as const, title: `t${line}`, body: "b" },
      reason: `reason ${line}`,
    }))
    const text = rejectionsText(rejected)
    expect(text).toContain('- src/x.ts:1 "t1": reason 1\n- src/x.ts:2 "t2": reason 2\n')
    expect(text).toContain('- src/x.ts:3 "t3": reason 3\n- src/x.ts:4 "t4": reason 4\n')
  })
})

describe("resubmitPrompt", () => {
  it("passes on why the host refused the review the model wrote out, as submit_review would have", () => {
    const refusal =
      "Rejected findings:\n- src/x.ts:40: line 40 (RIGHT) is not in the diff of src/x.ts\nFix the anchors or drop these, then call submit_review again."
    expect(resubmitPrompt(refusal)).toContain(refusal)
  })

  it("still asks for submit_review when the refusal doesn't, as after a GitHub error", () => {
    expect(resubmitPrompt("Error: GitHub POST /repos/o/r/pulls/5/reviews: 502")).toContain("Call submit_review")
  })
})

describe("answerPrompt", () => {
  it("puts the answer skill before the question", () => {
    const text = answerPrompt(
      "andrew",
      "why is this a problem?",
      '<skill_content name="answer" version="1">\nx\n</skill_content>',
    )
    expect(text.startsWith('<skill_content name="answer"')).toBe(true)
    expect(text).toContain("andrew asks, in a comment on the pull request:\n\nwhy is this a problem?")
  })
})
