import { describe, expect, it } from "vitest"
import type { ReviewThread } from "../src/github/client.ts"
import type { ChangedFile } from "../src/github/diff.ts"
import type { FindingInput, ReviewSubmissionInput, ValidatedReview } from "../src/review/findings.ts"
import {
  addressedThreads,
  applyDeltaPolicy,
  buildScope,
  chooseMode,
  coveredFiles,
  coveredMap,
  findingRecords,
  nextReviewed,
  openBlockingAfter,
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
    for (const compareStatus of ["diverged", "behind", undefined] as const) {
      expect(chooseMode({ ...push, compareStatus })).toBe("full")
    }
  })

  it("treats an unchanged head as an incremental review with nothing new, not a full one", () => {
    expect(chooseMode({ ...push, compareStatus: "identical" })).toBe("incremental")
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

  it("leaves a merge from the base unmarked when it only changed context lines of the pull request's hunk", () => {
    const mergedOnly = coveredFiles(
      [changed("a.ts", ["@@ -1,5 +1,5 @@", " a", " b", "-c", "+C", " d", " E"].join("\n"))],
      [changed("a.ts", ["@@ -3,3 +3,3 @@", " C", " d", "-e", "+E"].join("\n"))],
    )
    expect(mergedOnly.size).toBe(0)

    const both = coveredFiles(
      [changed("a.ts", ["@@ -1,5 +1,5 @@", " a", " b", "-c", "+CC", " d", " E"].join("\n"))],
      [changed("a.ts", ["@@ -3,3 +3,3 @@", "-C", "+CC", " d", "-e", "+E"].join("\n"))],
    )
    expect([...(both.get("a.ts")?.right ?? [])]).toEqual([3])
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

  it("counts every open blocking thread, including those past the cap, so approval can't skip them", () => {
    const blockers = Array.from({ length: 31 }, (_, i) => botThread(`b${i}`, { firstCommentId: i }))
    const nit = botThread("nit", { firstCommentId: 99, firstCommentBody: "**⚪ Nitpick: Spacing**" })
    expect(openBotThreads([...blockers, nit], new Map(), "andabot").blocking).toBe(31)
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

function found(overrides: Partial<FindingInput> = {}): FindingInput {
  return { path: "a.ts", line: 3, quote: "three", severity: "suggestion", title: "t", body: "b", ...overrides }
}

function validated(accepted: FindingInput[]): ValidatedReview {
  return { accepted, rejected: [], relocated: 0, suggestionsDropped: 0 }
}

describe("applyDeltaPolicy", () => {
  const covered = new Map([["a.ts", { right: new Set([3]), left: new Set<number>() }]])

  it("rejects a non-blocking finding off the marked lines and keeps a blocking one", () => {
    const onMarked = found({ line: 3 })
    const offMarked = found({ line: 5 })
    const blockingOff = found({ line: 6, severity: "blocking" })
    const uncoveredFile = found({ path: "b.ts", line: 2 })
    const result = applyDeltaPolicy(validated([onMarked, offMarked, blockingOff, uncoveredFile]), {
      mode: "incremental",
      covered,
      open: [],
    })
    expect(result.accepted).toEqual([onMarked, blockingOff])
    expect(result.rejected.map((r) => [r.finding.line, r.reason])).toEqual([
      [5, "line 5 was not changed since the last review; only a blocking finding may go elsewhere"],
      [2, "line 2 was not changed since the last review; only a blocking finding may go elsewhere"],
    ])
    expect(result.duplicates).toEqual([])
  })

  it("sets aside a duplicate of an open thread by line or by quote", () => {
    const threads = [open("T1", { line: 3, quote: "three" }), open("T2", { line: 9, quote: "const nine = 9;" })]
    const sameLine = found({ line: 3, quote: "something else" })
    const sameQuote = found({ line: 4, quote: "  const  nine = 9; " })
    const unique = found({ line: 7, quote: "seven" })
    const result = applyDeltaPolicy(validated([sameLine, sameQuote, unique]), { mode: "full", covered, open: threads })
    expect(result.accepted).toEqual([unique])
    expect(result.duplicates.map((r) => r.reason)).toEqual(["duplicates open thread T1", "duplicates open thread T2"])
    expect(result.rejected).toEqual([])
  })

  it("passes a fresh review through untouched, keeping what validation rejected", () => {
    const earlier = { finding: found({ line: 40 }), reason: "line 40 (RIGHT) is not in the diff of a.ts" }
    const input = { ...validated([found({ line: 5 })]), rejected: [earlier] }
    const result = applyDeltaPolicy(input, { mode: "fresh", covered, open: [open("T1", { line: 5 })] })
    expect(result).toEqual({ accepted: input.accepted, rejected: [earlier], duplicates: [] })
  })
})

describe("addressedThreads", () => {
  const recheck = [open("T1"), open("T3")]

  it("resolves only handles from the re-check list, once each", () => {
    const { resolve, unknown } = addressedThreads(["T1", "T2", "T3", "T1"], recheck)
    expect(resolve.map((t) => t.handle)).toEqual(["T1", "T3"])
    expect(unknown).toEqual(["T2"])
  })

  it("resolves nothing when the model listed no threads", () => {
    expect(addressedThreads(undefined, recheck)).toEqual({ resolve: [], unknown: [] })
  })
})

describe("the review scope", () => {
  const covered = new Map([["a.ts", { right: new Set([3, 4]), left: new Set([2]) }]])
  const listed = { open: [open("T1", { blocking: true }), open("T2")], leftOut: 1, blocking: 3 }
  const threads = { listed, recheck: [listed.open[0] ?? open("T1")] }

  it("keeps the range only for an incremental review and records whether threads were read", () => {
    const incremental = buildScope({ deliveryId: "d-1", mode: "incremental", from: "aaa", covered, threads })
    expect(incremental).toMatchObject({ deliveryId: "d-1", mode: "incremental", from: "aaa", threadsKnown: true })
    expect(incremental).toMatchObject({ leftOut: 1, blockingOpen: 3 })
    expect(incremental.recheck.map((t) => t.handle)).toEqual(["T1"])
    const full = buildScope({ deliveryId: "d-1", mode: "full", from: "aaa", covered: new Map(), threads: undefined })
    expect(full.from).toBeUndefined()
    expect(full).toMatchObject({ threadsKnown: false, open: [], recheck: [], blockingOpen: 0 })
  })

  it("round-trips its covered lines through the stored record", () => {
    const scope = buildScope({ deliveryId: "d-1", mode: "incremental", from: "aaa", covered, threads })
    expect(coveredMap(scope)).toEqual(covered)
  })

  it("counts the blocking threads left open after this review's resolutions, unless they couldn't be read", () => {
    const scope = buildScope({ deliveryId: "d-1", mode: "incremental", from: "aaa", covered, threads })
    expect(openBlockingAfter(scope, [])).toBe(3)
    expect(openBlockingAfter(scope, [open("T1", { blocking: true }), open("T2")])).toBe(2)
    const unread = buildScope({ deliveryId: "d-1", mode: "full", from: undefined, covered, threads: undefined })
    expect(openBlockingAfter(unread, [])).toBe("unknown")
  })
})

describe("findingRecords", () => {
  it("matches each posted comment to its finding by path, line and side", () => {
    const right = found({ line: 3, quote: "three", severity: "blocking", title: "Right" })
    const left = found({ line: 3, side: "LEFT", quote: "old three", title: "Left" })
    const records = findingRecords(
      [right, left],
      [
        { id: 11, reviewId: 7, path: "a.ts", line: 3, side: "RIGHT" },
        { id: 12, reviewId: 7, path: "a.ts", line: 3, side: "LEFT" },
        { id: 13, reviewId: 7, path: "a.ts", line: null, side: null },
      ],
    )
    expect(records).toEqual(
      new Map([
        [11, { severity: "blocking", title: "Right", quote: "three", path: "a.ts" }],
        [12, { severity: "suggestion", title: "Left", quote: "old three", path: "a.ts" }],
      ]),
    )
  })
})

describe("nextReviewed", () => {
  const submission: ReviewSubmissionInput = {
    summary: "This push fixes the total.",
    walkthrough: [{ path: "a.ts", summary: "new a" }],
    findings: [],
    verdict: "comment",
  }
  const previous: ReviewedRecord = {
    headSha: "aaa",
    baseRef: "main",
    at: 1,
    mode: "full",
    summary: "The whole PR.",
    walkthrough: [
      { path: "a.ts", summary: "old a" },
      { path: "b.ts", summary: "old b" },
    ],
  }
  const covered = new Map([["a.ts", { right: new Set([3]), left: new Set<number>() }]])

  it("starts over from a full review's summary and walkthrough", () => {
    const scope = buildScope({ deliveryId: "d", mode: "full", from: undefined, covered: new Map(), threads: undefined })
    expect(nextReviewed({ previous, scope, headSha: "bbb", baseRef: "main", at: 2, submission, resolved: 0 })).toEqual({
      headSha: "bbb",
      baseRef: "main",
      at: 2,
      mode: "full",
      summary: "This push fixes the total.",
      walkthrough: [{ path: "a.ts", summary: "new a" }],
    })
  })

  it("keeps the last full summary and adds a since section on an incremental review", () => {
    const scope = buildScope({ deliveryId: "d", mode: "incremental", from: "aaa", covered, threads: undefined })
    expect(nextReviewed({ previous, scope, headSha: "bbb", baseRef: "main", at: 2, submission, resolved: 1 })).toEqual({
      headSha: "bbb",
      baseRef: "main",
      at: 2,
      mode: "incremental",
      summary: "The whole PR.",
      walkthrough: [
        { path: "a.ts", summary: "new a" },
        { path: "b.ts", summary: "old b" },
      ],
      since: { from: "aaa", to: "bbb", summary: "This push fixes the total.", files: ["a.ts"], resolved: 1 },
    })
  })
})
