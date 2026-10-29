import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import type { ReviewThread } from "../src/github/client.ts"
import { indexCommentableLines, renderPatches, reviewableFiles, type ChangedFile } from "../src/github/diff.ts"
import {
  validateFindings,
  type FindingInput,
  type MergeDangerInput,
  type ReviewSubmissionInput,
  type ValidatedReview,
} from "../src/review/findings.ts"
import {
  addressedThreads,
  applyDeltaPolicy,
  buildScope,
  chooseMode,
  coveredFiles,
  coveredMap,
  findingRecords,
  nextReviewed,
  nothingToReview,
  openBlockingAfter,
  openBotThreads,
  pathsChangedSince,
  pathsNeedingRows,
  planThreads,
  promptFiles,
  filtersInForce,
  pathFiltersSkip,
  resolveThreads,
  ReviewedRecord,
  ReviewScope,
  scopedFiles,
  stricterMergeDanger,
  submissionFromRecord,
  threadLists,
  threadsToRecheck,
  withFilteredUnfounded,
  type OpenThread,
  type StoredFinding,
} from "../src/review/incremental.ts"
import { holdsApprovalBack } from "../src/review/render.ts"

const reviewed: ReviewedRecord = { headSha: "aaa", baseRef: "main", at: 1, mode: "full", summary: "s", walkthrough: [] }

function changed(filename: string, patch: string): ChangedFile {
  return { filename, status: "modified", additions: 1, deletions: 0, patch }
}

const logo: ChangedFile = { filename: "logo.png", status: "added", additions: 0, deletions: 0 }

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
    const threads = openBotThreads(
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
  })

  it("keeps every open thread, newest first", () => {
    const many = Array.from({ length: 32 }, (_, i) => botThread(`t${i}`, { firstCommentId: i }))
    const threads = openBotThreads(many, new Map(), "andabot")
    expect(threads).toHaveLength(32)
    expect(threads.slice(0, 2).map((t) => [t.handle, t.threadId])).toEqual([
      ["T1", "t31"],
      ["T2", "t30"],
    ])
  })

  it("reads severity from the stored finding, else from the comment's label", () => {
    const stored: StoredFinding = { severity: "nitpick", title: "Stored title", quote: "const b = 3;", path: "a.ts" }
    const threads = openBotThreads(
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
      ["Something else entirely", false, undefined],
      ["Rename it", false, undefined],
      ["Total is NaN", true, undefined],
      ["Stored title", false, "const b = 3;"],
    ])
  })
})

describe("planThreads", () => {
  it("re-checks and dedupes against every open thread, not only the 30 the prompt lists", () => {
    const threads = Array.from({ length: 42 }, (_, i) =>
      botThread(`t${i + 1}`, { firstCommentId: i + 1, line: i === 41 ? null : i + 1, outdated: i === 41 }),
    )
    const plan = planThreads({
      threads,
      findings: new Map(),
      botLogin: "andabot",
      mode: "full",
      covered: new Map(),
      since: [],
    })
    expect(plan.open).toHaveLength(42)
    expect(plan.recheck.map((t) => t.threadId)).toEqual(["t42"])
    const onTheOldestThread = found({ line: 1, severity: "blocking" })
    const scoped = applyDeltaPolicy(validated([onTheOldestThread]), {
      mode: "full",
      covered: new Map(),
      open: plan.open,
    })
    expect(scoped.duplicates.map((r) => r.reason)).toEqual(["duplicates open thread T42"])
  })
})

describe("threadLists", () => {
  it("lists the threads to re-check first and caps both lists at 30 together, counting the rest", () => {
    const all = Array.from({ length: 42 }, (_, i) => open(`T${i + 1}`))
    const lists = threadLists(all, all.slice(40))
    expect(lists.recheck.map((t) => t.handle)).toEqual(["T41", "T42"])
    expect(lists.otherThreads.map((t) => t.handle)).toEqual(all.slice(0, 28).map((t) => t.handle))
    expect(lists.leftOut).toBe(12)
  })
})

describe("threadsToRecheck", () => {
  const threads = [
    open("T1", { outdated: true, line: null, quote: "console.log(secret)" }),
    open("T2", { line: 3 }),
    open("T3", { line: 9 }),
    open("T4", { path: "c.ts", line: 3 }),
    open("T5", { outdated: true, line: null, quote: "const kept = 1;" }),
    open("T6", { path: "b.ts", outdated: true, line: null }),
    open("T7", { path: "d.ts", outdated: true, line: null }),
    open("T8", { path: "e.ts", side: "LEFT", outdated: true, line: null, quote: "guard()" }),
  ]
  const covered = new Map([["a.ts", { right: new Set([3]), left: new Set<number>() }]])
  const since = [
    changed("a.ts", ["@@ -1,3 +1,3 @@", " one", "-console.log(secret)", " const kept = 1;", "+three"].join("\n")),
    changed("d.ts", ["@@ -1 +1 @@", "-x", "+y"].join("\n")),
    changed("e.ts", ["@@ -1 +1,2 @@", " a", "+guard()"].join("\n")),
  ]

  it("re-checks threads on marked lines and outdated threads whose code the push changed", () => {
    expect(threadsToRecheck(threads, "incremental", covered, since).map((t) => t.handle)).toEqual([
      "T1",
      "T2",
      "T7",
      "T8",
    ])
  })

  it("takes every outdated thread in a full review, and none when starting over", () => {
    expect(threadsToRecheck(threads, "full", covered, []).map((t) => t.handle)).toEqual(["T1", "T5", "T6", "T7", "T8"])
    expect(threadsToRecheck(threads, "fresh", covered, since)).toEqual([])
  })
})

describe("nothingToReview", () => {
  const incremental = { deliveryId: "d", mode: "incremental" as const, from: "aaa", threads: undefined }
  const marked = new Map([["a.ts", { right: new Set([3]), left: new Set<number>() }]])

  it("skips an incremental review only when no line is marked and no thread is to be re-checked", () => {
    expect(nothingToReview(buildScope({ ...incremental, covered: new Map() }))).toBe(true)
    expect(nothingToReview(buildScope({ ...incremental, covered: marked }))).toBe(false)
    const fixed = open("T1", { outdated: true, line: null })
    const recheckOnly = { ...incremental, covered: new Map(), threads: { open: [fixed], recheck: [fixed] } }
    expect(nothingToReview(buildScope(recheckOnly))).toBe(false)
    expect(nothingToReview(buildScope({ ...incremental, mode: "full", covered: new Map() }))).toBe(false)
  })

  it("never finds nothing to review in a full review, the mode a failed compare forces, so a failed read can't advance reviewed", () => {
    const failedCompare = chooseMode({ full: false, reviewed, baseRef: "main", compareStatus: undefined })
    expect(failedCompare).toBe("full")
    expect(nothingToReview(buildScope({ ...incremental, mode: failedCompare, covered: new Map() }))).toBe(false)
  })
})

describe("pathsNeedingRows", () => {
  const files = [
    changed("a.ts", "@@ -1 +1 @@\n-x\n+y"),
    changed("b.ts", "@@ -1 +1 @@\n-p\n+q"),
    changed("pnpm-lock.yaml", "@@ -1 +1 @@\n-1\n+2"),
  ]
  const marked = { right: new Set([1]), left: new Set<number>() }
  const covered = new Map([
    ["a.ts", marked],
    ["pnpm-lock.yaml", marked],
  ])

  it("asks an incremental review for rows on the files it covered only, leaving out generated ones", () => {
    const scope = buildScope({ deliveryId: "d", mode: "incremental", from: "aaa", covered, threads: undefined })
    expect(pathsNeedingRows(scope, files)).toEqual(["a.ts"])
  })

  it("asks an incremental review that only re-checks threads for no rows", () => {
    const fixed = open("T1", { outdated: true, line: null })
    const threads = { open: [fixed], recheck: [fixed] }
    const scope = buildScope({ deliveryId: "d", mode: "incremental", from: "aaa", covered: new Map(), threads })
    expect(pathsNeedingRows(scope, files)).toEqual([])
  })

  it("asks a full or fresh review for a row on every changed file but the generated ones", () => {
    for (const mode of ["full", "fresh"] as const) {
      const scope = buildScope({ deliveryId: "d", mode, from: "aaa", covered, threads: undefined })
      expect(pathsNeedingRows(scope, files)).toEqual(["a.ts", "b.ts"])
    }
  })

  it("asks for every row when an incremental scope has no range, since its prompt then shows the whole diff", () => {
    const scope = buildScope({ deliveryId: "d", mode: "incremental", from: undefined, covered, threads: undefined })
    expect(pathsNeedingRows(scope, files)).toEqual(["a.ts", "b.ts"])
  })

  it("asks for no row on a file the review's path filters left out, in every mode", () => {
    for (const mode of ["full", "fresh"] as const) {
      const scope = buildScope({
        deliveryId: "d",
        mode,
        from: "aaa",
        covered,
        threads: undefined,
        pathFilters: ["!b.ts"],
      })
      expect(pathsNeedingRows(scope, files)).toEqual(["a.ts"])
    }
    const scope = buildScope({
      deliveryId: "d",
      mode: "incremental",
      from: "aaa",
      covered,
      threads: undefined,
      pathFilters: ["!a.ts"],
    })
    expect(pathsNeedingRows(scope, files)).toEqual([])
  })

  it("reads a scope stored before path filters existed as filtering nothing", () => {
    const stored = {
      deliveryId: "d",
      mode: "full" as const,
      covered: [],
      recheck: [],
      open: [],
      threadsKnown: false,
      changed: [],
    }
    expect(Value.Check(ReviewScope, stored)).toBe(true)
    expect(Value.Check(ReviewScope, { ...stored, pathFilters: ["!b.ts"] })).toBe(true)
    expect(Value.Check(ReviewScope, { ...stored, pathFilters: "!b.ts" })).toBe(false)
    expect(pathsNeedingRows(stored, files)).toEqual(["a.ts", "b.ts"])
  })
})

describe("path filters", () => {
  const filters = ["!**/*.snap", "!fixtures/**"]
  const prFiles = [
    changed("src/x.ts", "@@ -1 +1 @@\n-x\n+y"),
    changed("a.snap", "@@ -1 +1 @@\n-old\n+new"),
    changed("fixtures/payload.json", "@@ -1 +1 @@\n-{}\n+[]"),
  ]

  it("take a.snap out of the prompt's files and the rows needed with !**/*.snap, while the changed files still hold it", () => {
    const shown = reviewableFiles(prFiles, filters)
    const scope = buildScope({
      deliveryId: "d",
      mode: "full",
      from: undefined,
      covered: new Map(),
      threads: undefined,
      pathFilters: filters,
    })
    expect(renderPatches(prFiles)).toContain("### a.snap")
    expect(renderPatches(shown)).not.toContain("a.snap")
    expect(renderPatches(shown)).not.toContain("fixtures/payload.json")
    expect(pathsNeedingRows(scope, prFiles)).toEqual(["src/x.ts"])
    expect(prFiles.map((file) => file.filename)).toEqual(["src/x.ts", "a.snap", "fixtures/payload.json"])
  })

  it("leave a filtered file out of an incremental review's coverage and its listing, so a push touching only one has nothing to review", () => {
    const shown = reviewableFiles(prFiles, filters)
    const since = [
      changed("a.snap", "@@ -1 +1 @@\n-old\n+new"),
      changed("fixtures/payload.json", "@@ -1 +1 @@\n-{}\n+[]"),
    ]
    const covered = coveredFiles(shown, since)
    const scope = buildScope({
      deliveryId: "d",
      mode: "incremental",
      from: "aaa",
      covered,
      threads: undefined,
      changed: pathsChangedSince(shown, since),
      pathFilters: filters,
    })
    expect(coveredFiles(prFiles, since).size).toBe(2)
    expect(covered.size).toBe(0)
    expect(nothingToReview(scope)).toBe(true)
    expect(promptFiles(shown, since, scope).others.map((file) => file.filename)).toEqual(["src/x.ts"])
  })

  it("give the scope's files, the ones its filters leave in, and every changed file for a scope stored before filters", () => {
    const older = { deliveryId: "d", mode: "full" as const, covered: [], recheck: [], open: [], threadsKnown: false }
    expect(scopedFiles({ ...older, pathFilters: filters }, prFiles).map((file) => file.filename)).toEqual(["src/x.ts"])
    expect(scopedFiles(older, prFiles)).toEqual(prFiles)
  })

  it("in force are the review's own while one is in flight, and the config's otherwise, as in a chat turn", async () => {
    const reads: string[] = []
    const configured = async () => {
      reads.push("config")
      return ["!docs/**"]
    }
    const scope = buildScope({ deliveryId: "d", mode: "full", from: undefined, covered: new Map(), threads: undefined })
    expect(await filtersInForce({ ...scope, pathFilters: filters }, configured)).toEqual(filters)
    expect(await filtersInForce({ ...scope, pathFilters: [] }, configured)).toEqual([])
    expect(reads).toEqual([])
    expect(await filtersInForce(undefined, configured)).toEqual(["!docs/**"])
    expect(reads).toEqual(["config"])
  })

  it("reject a finding on a filtered file as left out by the filters and unfounded, so even a blocking one holds no approval back", () => {
    const scope = buildScope({
      deliveryId: "d",
      mode: "full",
      from: undefined,
      covered: new Map(),
      threads: undefined,
      pathFilters: filters,
    })
    const onFile = (path: string, quote: string, severity: FindingInput["severity"]): FindingInput => ({
      path,
      line: 1,
      quote,
      basis_kind: "defect",
      basis: "a snapshot that no longer matches the component",
      severity,
      title: "t",
      body: "b",
    })
    const validated = validateFindings(
      [onFile("src/x.ts", "y", "suggestion"), onFile("a.snap", "new", "blocking"), onFile("gone.ts", "x", "blocking")],
      indexCommentableLines(scopedFiles(scope, prFiles)),
      false,
    )
    const { accepted, rejected } = withFilteredUnfounded(validated, scope)
    expect(accepted.map((finding) => finding.path)).toEqual(["src/x.ts"])
    expect(rejected.map(({ finding, reason, unfounded }) => [finding.path, reason, unfounded])).toEqual([
      ["a.snap", 'path "a.snap" is left out of the review by path_filters; drop the finding', true],
      ["gone.ts", 'path "gone.ts" is not a changed file', false],
    ])
    expect(rejected.map(holdsApprovalBack)).toEqual([false, true])
  })

  it("leave a review's rejections as they were when it has no filters", () => {
    const scope = buildScope({ deliveryId: "d", mode: "full", from: undefined, covered: new Map(), threads: undefined })
    const finding: FindingInput = {
      path: "a.snap",
      line: 9,
      quote: "q",
      basis_kind: "defect",
      basis: "b",
      severity: "blocking",
      title: "t",
      body: "b",
    }
    const validated = validateFindings([finding], indexCommentableLines(scopedFiles(scope, prFiles)), false)
    expect(withFilteredUnfounded(validated, scope)).toEqual(validated)
  })

  it("skip as path_filters only when filters leave out every changed file, and list the files only when filters exist", async () => {
    const listed: string[] = []
    const lister = (files: readonly ChangedFile[]) => async () => {
      listed.push("files")
      return files
    }
    const onlyFiltered = [
      changed("a.snap", "@@ -1 +1 @@\n-old\n+new"),
      changed("fixtures/b.json", "@@ -1 +1 @@\n-{}\n+[]"),
    ]
    expect(await pathFiltersSkip([], lister(prFiles))).toBeUndefined()
    expect(listed).toEqual([])
    expect(await pathFiltersSkip(filters, lister(onlyFiltered))).toBe("path_filters")
    expect(await pathFiltersSkip(filters, lister(prFiles))).toBeUndefined()
    expect(listed).toEqual(["files", "files"])
  })
})

describe("promptFiles", () => {
  it("shows a file whose only new changes left the diff when one of its threads is to be re-checked", () => {
    const prFiles = [
      changed("a.ts", "@@ -1 +1 @@\n-x\n+y"),
      changed("b.ts", "@@ -1 +1 @@\n-p\n+q"),
      changed("c.ts", ""),
    ]
    const since = [changed("a.ts", "@@ -1 +1 @@\n-x\n+y"), changed("gone.ts", "@@ -1 +0,0 @@\n-debug()")]
    const gone = open("T1", { path: "gone.ts", outdated: true, line: null, quote: "debug()" })
    const scope = buildScope({
      deliveryId: "d",
      mode: "incremental",
      from: "aaa",
      covered: new Map([["a.ts", { right: new Set([1]), left: new Set<number>() }]]),
      threads: { open: [gone], recheck: [gone] },
    })
    const files = promptFiles(prFiles, since, scope)
    expect(files.covered.map((f) => f.filename)).toEqual(["a.ts"])
    expect(files.recheckOnly.map((f) => f.filename)).toEqual(["gone.ts"])
    expect(files.others.map((f) => f.filename)).toEqual(["b.ts", "c.ts"])
  })

  it("sets a file the push changed without a marked line apart from the files it didn't touch", () => {
    const prFiles = [changed("a.ts", "@@ -1 +1 @@\n-x\n+y"), logo, changed("b.ts", "@@ -1 +1 @@\n-p\n+q")]
    const scope = buildScope({
      deliveryId: "d",
      mode: "incremental",
      from: "aaa",
      covered: new Map([["a.ts", { right: new Set([1]), left: new Set<number>() }]]),
      threads: undefined,
      changed: ["a.ts", "logo.png"],
    })
    const files = promptFiles(prFiles, [changed("a.ts", "@@ -1 +1 @@\n-x\n+y"), logo], scope)
    expect(files.changedOutside.map((f) => f.filename)).toEqual(["logo.png"])
    expect(files.others.map((f) => f.filename)).toEqual(["b.ts"])
  })
})

describe("pathsChangedSince", () => {
  it("takes the pull request's files the push changed, binary ones included, and leaves out what only the base changed", () => {
    const prFiles = [changed("a.ts", "@@ -1 +1 @@\n-x\n+y"), logo, changed("b.ts", "@@ -1 +1 @@\n-p\n+q")]
    const since = [changed("a.ts", "@@ -1 +1 @@\n-x\n+y"), logo, changed("from-main.ts", "@@ -1 +1 @@\n-m\n+n")]
    expect(pathsChangedSince(prFiles, since)).toEqual(["a.ts", "logo.png"])
  })
})

function found(overrides: Partial<FindingInput> = {}): FindingInput {
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

  it("still posts a blocking finding on the line of an open thread that isn't blocking", () => {
    const threads = [open("T1", { line: 3 }), open("T2", { line: 9, blocking: true })]
    const blockingOnNitpick = found({ line: 3, severity: "blocking" })
    const suggestionOnBlocker = found({ line: 9, quote: "nine" })
    const result = applyDeltaPolicy(validated([blockingOnNitpick, suggestionOnBlocker]), {
      mode: "full",
      covered,
      open: threads,
    })
    expect(result.accepted).toEqual([blockingOnNitpick])
    expect(result.duplicates.map((r) => r.reason)).toEqual(["duplicates open thread T2"])
  })

  it("matches a thread by its quote only once GitHub reports it outdated", () => {
    const threads = [open("T1", { line: 3, quote: "}" }), open("T2", { outdated: true, line: null, quote: "}" })]
    const sameTextElsewhere = found({ path: "b.ts", line: 7, quote: "}" })
    const result = applyDeltaPolicy(validated([sameTextElsewhere]), {
      mode: "full",
      covered,
      open: [...threads, open("T3", { path: "b.ts", line: 2, quote: "}" })],
    })
    expect(result.accepted).toEqual([sameTextElsewhere])
    const moved = found({ line: 12, quote: "}" })
    expect(applyDeltaPolicy(validated([moved]), { mode: "full", covered, open: threads }).duplicates).toEqual([
      { finding: moved, reason: "duplicates open thread T2", unfounded: false },
    ])
  })

  it("sets aside a duplicate of an open thread by line or by quote", () => {
    const threads = [
      open("T1", { line: 3, quote: "three" }),
      open("T2", { outdated: true, line: null, quote: "const nine = 9;" }),
    ]
    const sameLine = found({ line: 3, quote: "something else" })
    const sameQuote = found({ line: 4, quote: "  const  nine = 9; " })
    const unique = found({ line: 7, quote: "seven" })
    const result = applyDeltaPolicy(validated([sameLine, sameQuote, unique]), { mode: "full", covered, open: threads })
    expect(result.accepted).toEqual([unique])
    expect(result.duplicates.map((r) => r.reason)).toEqual(["duplicates open thread T1", "duplicates open thread T2"])
    expect(result.rejected).toEqual([])
  })

  it("passes a fresh review through untouched, keeping what validation rejected", () => {
    const earlier = {
      finding: found({ line: 40 }),
      reason: "line 40 (RIGHT) is not in the diff of a.ts",
      unfounded: false,
    }
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
  const blocker = open("T1", { blocking: true })
  const threads = {
    open: [blocker, open("T2"), open("T3", { blocking: true }), open("T4", { blocking: true })],
    recheck: [blocker],
  }

  it("keeps the range only for an incremental review and records whether threads were read", () => {
    const incremental = buildScope({ deliveryId: "d-1", mode: "incremental", from: "aaa", covered, threads })
    expect(incremental).toMatchObject({ deliveryId: "d-1", mode: "incremental", from: "aaa", threadsKnown: true })
    expect(incremental.open.map((t) => t.handle)).toEqual(["T1", "T2", "T3", "T4"])
    expect(incremental.recheck.map((t) => t.handle)).toEqual(["T1"])
    const full = buildScope({ deliveryId: "d-1", mode: "full", from: "aaa", covered: new Map(), threads: undefined })
    expect(full.from).toBeUndefined()
    expect(full).toMatchObject({ threadsKnown: false, open: [], recheck: [] })
  })

  it("counts every open blocking thread, including those the prompt's lists leave out", () => {
    const blockers = Array.from({ length: 31 }, (_, i) => open(`T${i + 1}`, { blocking: true }))
    const scope = buildScope({
      deliveryId: "d-1",
      mode: "full",
      from: undefined,
      covered: new Map(),
      threads: { open: [...blockers, open("T32")], recheck: [] },
    })
    expect(openBlockingAfter(scope, [])).toBe(31)
  })

  it("keeps a fresh review's open threads with none to re-check, so its event counts the blocking ones", () => {
    const scope = buildScope({
      deliveryId: "d",
      mode: "fresh",
      from: undefined,
      covered: new Map(),
      threads: { open: [open("T1", { blocking: true }), open("T2")], recheck: [] },
    })
    expect(scope).toMatchObject({ threadsKnown: true, recheck: [] })
    expect(openBlockingAfter(scope, [])).toBe(1)
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

describe("resolveThreads", () => {
  it("returns only the threads GitHub resolved, so a failed resolution still blocks approval", async () => {
    const resolver = {
      resolveReviewThread: (threadId: string): Promise<void> =>
        threadId === "thread-T2" ? Promise.reject(new Error("GitHub GraphQL: 502")) : Promise.resolve(),
    }
    const fixed = open("T1", { blocking: true })
    const stillOpen = open("T2", { blocking: true })
    const attempt = await resolveThreads(resolver, [fixed, stillOpen])
    expect(attempt.resolved).toEqual([fixed])
    expect(attempt.failed).toEqual([{ thread: stillOpen, error: "Error: GitHub GraphQL: 502" }])
    const scope = buildScope({
      deliveryId: "d-1",
      mode: "incremental",
      from: "aaa",
      covered: new Map(),
      threads: { open: [fixed, stillOpen], recheck: [fixed, stillOpen] },
    })
    expect(openBlockingAfter(scope, attempt.resolved)).toBe(1)
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

const oneWay = { door: "one-way", blast_radius: "every invoice" } satisfies MergeDangerInput
const twoWay = { door: "two-way", blast_radius: "the totals" } satisfies MergeDangerInput

describe("stricterMergeDanger", () => {
  it("keeps the previous one-way judgement when the push judges a two-way door", () => {
    expect(stricterMergeDanger(oneWay, twoWay)).toEqual(oneWay)
  })

  it("takes the push's one-way judgement over a previous two-way door", () => {
    expect(stricterMergeDanger(twoWay, oneWay)).toEqual(oneWay)
  })

  it("takes the push's judgement when both doors are two-way, or both are one-way", () => {
    const later = { door: "two-way", blast_radius: "the cart page" } satisfies MergeDangerInput
    const laterOneWay = { door: "one-way", blast_radius: "the ledger" } satisfies MergeDangerInput
    expect(stricterMergeDanger(twoWay, later)).toEqual(later)
    expect(stricterMergeDanger(oneWay, laterOneWay)).toEqual(laterOneWay)
  })

  it("takes the push's judgement when there is no previous one", () => {
    expect(stricterMergeDanger(undefined, twoWay)).toEqual(twoWay)
    expect(stricterMergeDanger(undefined, oneWay)).toEqual(oneWay)
  })
})

describe("ReviewedRecord", () => {
  const stored = { headSha: "aaa", baseRef: "main", at: 1, mode: "full", summary: "s", walkthrough: [] }

  it("accepts a stored record from before it kept the merge danger", () => {
    expect(Value.Check(ReviewedRecord, stored)).toBe(true)
  })

  it("accepts a merge danger and refuses a malformed one", () => {
    expect(Value.Check(ReviewedRecord, { ...stored, merge_danger: oneWay })).toBe(true)
    expect(Value.Check(ReviewedRecord, { ...stored, merge_danger: { door: "sideways", blast_radius: "x" } })).toBe(
      false,
    )
    expect(Value.Check(ReviewedRecord, { ...stored, merge_danger: { door: "one-way", blast_radius: "" } })).toBe(false)
  })
})

describe("nextReviewed", () => {
  const submission: ReviewSubmissionInput = {
    summary: "This push fixes the total.",
    walkthrough: [{ path: "a.ts", summary: "new a" }],
    findings: [],
    verdict: "comment",
    merge_danger: twoWay,
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
  const incremental = buildScope({ deliveryId: "d", mode: "incremental", from: "aaa", covered, threads: undefined })
  const reviewedAfter = (before: ReviewedRecord, scope: ReviewScope, pushed: ReviewSubmissionInput = submission) =>
    nextReviewed({ previous: before, scope, headSha: "bbb", baseRef: "main", at: 2, submission: pushed, resolved: 1 })

  it("starts over from a full review's summary, walkthrough and merge danger", () => {
    const scope = buildScope({ deliveryId: "d", mode: "full", from: undefined, covered: new Map(), threads: undefined })
    expect(reviewedAfter({ ...previous, merge_danger: oneWay }, scope)).toEqual({
      headSha: "bbb",
      baseRef: "main",
      at: 2,
      mode: "full",
      summary: "This push fixes the total.",
      walkthrough: [{ path: "a.ts", summary: "new a" }],
      merge_danger: twoWay,
    })
  })

  it("stores the submission's merge danger on a fresh review, whatever the last review judged", () => {
    const scope = buildScope({
      deliveryId: "d",
      mode: "fresh",
      from: undefined,
      covered: new Map(),
      threads: undefined,
    })
    expect(reviewedAfter({ ...previous, merge_danger: oneWay }, scope).merge_danger).toEqual(twoWay)
  })

  it("keeps the last full summary and adds a since section on an incremental review", () => {
    expect(reviewedAfter(previous, incremental)).toEqual({
      headSha: "bbb",
      baseRef: "main",
      at: 2,
      mode: "incremental",
      summary: "The whole PR.",
      walkthrough: [
        { path: "a.ts", summary: "new a" },
        { path: "b.ts", summary: "old b" },
      ],
      merge_danger: twoWay,
      since: { from: "aaa", to: "bbb", summary: "This push fixes the total.", files: ["a.ts"], resolved: 1 },
    })
  })

  it("keeps a one-way door across an incremental review that judges a two-way one", () => {
    expect(reviewedAfter({ ...previous, merge_danger: oneWay }, incremental).merge_danger).toEqual(oneWay)
  })

  it("takes the push's one-way door across an incremental review that follows a two-way one", () => {
    const pushed = { ...submission, merge_danger: oneWay }
    expect(reviewedAfter({ ...previous, merge_danger: twoWay }, incremental, pushed).merge_danger).toEqual(oneWay)
  })

  it("takes the push's merge danger when the stored record predates it", () => {
    expect(reviewedAfter(previous, incremental).merge_danger).toEqual(twoWay)
  })

  it("keeps the row the model wrote for a file the push changed without a marked line", () => {
    const scope = buildScope({
      deliveryId: "d",
      mode: "incremental",
      from: "aaa",
      covered,
      threads: undefined,
      changed: ["a.ts", "logo.png"],
    })
    const withLogo = {
      ...submission,
      walkthrough: [...submission.walkthrough, { path: "logo.png", summary: "adds a logo" }],
    }
    const next = nextReviewed({
      previous,
      scope,
      headSha: "bbb",
      baseRef: "main",
      at: 2,
      submission: withLogo,
      resolved: 0,
    })
    expect(next.walkthrough).toEqual([
      { path: "a.ts", summary: "new a" },
      { path: "b.ts", summary: "old b" },
      { path: "logo.png", summary: "adds a logo" },
    ])
  })
})

describe("submissionFromRecord", () => {
  const pushed: ReviewSubmissionInput = {
    summary: "This push fixes the total.",
    walkthrough: [{ path: "a.ts", summary: "new a" }],
    findings: [],
    verdict: "comment",
    merge_danger: { door: "two-way", blast_radius: "the total" },
  }
  const record: ReviewedRecord = {
    headSha: "aaa",
    baseRef: "main",
    at: 1,
    mode: "incremental",
    summary: "The whole PR.",
    walkthrough: [
      { path: "a.ts", summary: "new a" },
      { path: "b.ts", summary: "old b" },
    ],
  }

  it("shows the record's summary, walkthrough and merge danger in place of the push's", () => {
    const oneWay = { door: "one-way" as const, blast_radius: "the migration" }
    const shown = submissionFromRecord(pushed, { ...record, merge_danger: oneWay })
    expect(shown.summary).toBe("The whole PR.")
    expect(shown.walkthrough).toEqual(record.walkthrough)
    expect(shown.merge_danger).toEqual(oneWay)
    expect(shown.findings).toEqual([])
  })

  it("keeps the push's merge danger when the record predates the field", () => {
    expect(submissionFromRecord(pushed, record).merge_danger).toEqual(pushed.merge_danger)
  })
})
