import { describe, expect, it } from "vitest"
import type { ReviewThread } from "../src/github/client.ts"
import type { ChangedFile } from "../src/github/diff.ts"
import {
  chooseMode,
  coveredFiles,
  openBotThreads,
  threadsToRecheck,
  type OpenThread,
  type ReviewedRecord,
  type StoredFinding,
} from "../src/review/incremental.ts"

const reviewed: ReviewedRecord = { headSha: "aaa", baseRef: "main", at: 1, mode: "full", summary: "s", walkthrough: [] }

function changed(filename: string, patch: string): ChangedFile {
  return { filename, status: "modified", additions: 1, deletions: 0, patch }
}

function botThread(id: string, overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id,
    resolved: false,
    outdated: false,
    path: "a.ts",
    line: 3,
    side: "RIGHT",
    firstCommentId: 100,
    firstCommentBody: "**🔴 Blocking: Total is NaN**\n\nWhy.",
    authorLogin: "andabot",
    authorIsBot: true,
    ...overrides,
  }
}

function open(handle: string, overrides: Partial<OpenThread> = {}): OpenThread {
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

describe("chooseMode", () => {
  const push = { full: false, reviewed, baseRef: "main" }

  it("starts over on a full review request, whatever came before", () => {
    expect(chooseMode({ ...push, full: true, compareStatus: "ahead" })).toBe("fresh")
  })

  it("reviews the whole pull request when nothing was reviewed before", () => {
    expect(chooseMode({ ...push, reviewed: undefined, compareStatus: undefined })).toBe("full")
  })

  it("reviews the whole pull request when history was rewritten or the compare failed", () => {
    for (const compareStatus of ["diverged", "behind", "identical", undefined] as const) {
      expect(chooseMode({ ...push, compareStatus })).toBe("full")
    }
  })

  it("reviews the whole pull request when its base branch changed", () => {
    expect(chooseMode({ ...push, baseRef: "release", compareStatus: "ahead" })).toBe("full")
  })

  it("reviews only the new commits after a fast-forward on the same base", () => {
    expect(chooseMode({ ...push, compareStatus: "ahead" })).toBe("incremental")
  })
})

describe("coveredFiles", () => {
  it("skips a file only the compare changed, as a merge from the base would", () => {
    const pr = [
      changed("a.ts", ["@@ -1,2 +1,3 @@", " one", "+two", "+three"].join("\n")),
      changed("b.ts", ["@@ -1 +1 @@", "-x", "+y"].join("\n")),
      changed("reverted.ts", ["@@ -1 +1 @@", "-p", "+q"].join("\n")),
    ]
    const delta = [
      changed("a.ts", ["@@ -1,2 +1,3 @@", " one", " two", "+three"].join("\n")),
      changed("from-main.ts", ["@@ -1 +1 @@", "-m", "+n"].join("\n")),
      changed("reverted.ts", ["@@ -1,2 +1 @@", " q", "-r"].join("\n")),
    ]
    const covered = coveredFiles(pr, delta)
    expect([...covered.keys()]).toEqual(["a.ts"])
    expect([...(covered.get("a.ts")?.right ?? [])]).toEqual([3])
  })
})

describe("openBotThreads", () => {
  it("keeps only the bot's unresolved threads and ignores a person's and CodeRabbit's", () => {
    const { open: threads, leftOut } = openBotThreads(
      [
        botThread("mine"),
        botThread("person", { authorLogin: "andrew", authorIsBot: false }),
        botThread("rabbit", { authorLogin: "coderabbitai", authorIsBot: true }),
        botThread("done", { resolved: true }),
        botThread("ghost", { authorLogin: null, authorIsBot: false }),
      ],
      new Map(),
      "andabot",
    )
    expect(threads.map((t) => [t.handle, t.threadId])).toEqual([["T1", "mine"]])
    expect(leftOut).toBe(0)
  })

  it("caps the list at 30 and counts the rest", () => {
    const many = Array.from({ length: 32 }, (_, i) => botThread(`t${i}`, { firstCommentId: i }))
    const { open: threads, leftOut } = openBotThreads(many, new Map(), "andabot")
    expect(threads).toHaveLength(30)
    expect(threads.at(-1)?.handle).toBe("T30")
    expect(leftOut).toBe(2)
  })

  it("reads severity from the stored finding, else from the comment's label", () => {
    const stored: StoredFinding = { severity: "nitpick", title: "Stored title", quote: "const b = 3;", path: "a.ts" }
    const { open: threads } = openBotThreads(
      [
        botThread("stored", { firstCommentId: 1 }),
        botThread("labelled", { firstCommentId: 2 }),
        botThread("suggestion", { firstCommentId: 3, firstCommentBody: "**🟡 Suggestion: Rename it**\n\nWhy." }),
        botThread("unlabelled", { firstCommentId: 4, firstCommentBody: "Something else entirely" }),
      ],
      new Map([[1, stored]]),
      "andabot",
    )
    expect(threads.map((t) => [t.title, t.blocking, t.quote])).toEqual([
      ["Stored title", false, "const b = 3;"],
      ["Total is NaN", true, undefined],
      ["Rename it", false, undefined],
      ["Something else entirely", false, undefined],
    ])
  })
})

describe("threadsToRecheck", () => {
  const threads = [
    open("T1", { outdated: true, line: null }),
    open("T2", { line: 3 }),
    open("T3", { line: 9 }),
    open("T4", { path: "c.ts", line: 3 }),
  ]
  const covered = new Map([["a.ts", { right: new Set([3]), left: new Set<number>() }]])

  it("takes outdated threads and those on marked lines in an incremental review", () => {
    expect(threadsToRecheck(threads, "incremental", covered).map((t) => t.handle)).toEqual(["T1", "T2"])
  })

  it("takes only outdated threads in a full review, and none when starting over", () => {
    expect(threadsToRecheck(threads, "full", covered).map((t) => t.handle)).toEqual(["T1"])
    expect(threadsToRecheck(threads, "fresh", covered)).toEqual([])
  })
})
