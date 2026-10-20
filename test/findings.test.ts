import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { commentableLines } from "../src/github/diff.ts"
import {
  MAX_FINDINGS,
  missingWalkthrough,
  parseWrittenReview,
  ReviewSubmission,
  toReviewComment,
  validateFindings,
  walkthroughPaths,
  type FindingInput,
  type ReviewSubmissionInput,
} from "../src/review/findings.ts"
import {
  chooseReviewEvent,
  incompleteNote,
  mergeWalkthrough,
  renderReviewBody,
  renderSummaryComment,
  renderUnpostedNote,
  renderUnpostedSummary,
  SUMMARY_MARKER,
} from "../src/review/render.ts"

const patch = ["@@ -1,3 +1,3 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", " export { a, b };"].join("\n")
const commentable = new Map([["src/x.ts", commentableLines(patch)]])

const base: ReviewSubmissionInput = {
  summary: "s",
  walkthrough: [],
  findings: [],
  verdict: "approve",
  merge_danger: { door: "two-way", blast_radius: "one module" },
}

function finding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    path: "src/x.ts",
    line: 2,
    quote: "const b = 3;",
    basis_kind: "defect",
    basis: "with an empty cart the total is NaN",
    severity: "blocking",
    title: "b changed",
    body: "Why did b change?",
    ...overrides,
  }
}

const BLOCKING_STANDARD_OR_TEST =
  "a standard or test finding cannot be blocking; grade it suggestion or nitpick, or give it the defect or spec basis it rests on"

describe("validateFindings", () => {
  it("accepts a finding on an added line and one on a deleted line", () => {
    const result = validateFindings(
      [finding(), finding({ line: 2, side: "LEFT", quote: "const b = 2;", title: "removed" })],
      commentable,
    )
    expect(result.accepted).toHaveLength(2)
    expect(result.rejected).toHaveLength(0)
  })

  it("rejects unknown paths, lines outside the diff, bad ranges and left-side suggestions", () => {
    const result = validateFindings(
      [
        finding({ path: "src/other.ts" }),
        finding({ line: 40 }),
        finding({ line: 3, start_line: 4, quote: "export { a, b };" }),
        finding({ line: 2, side: "LEFT", quote: "const b = 2;", suggestion: "x" }),
        finding({ title: "   " }),
      ],
      commentable,
    )
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'path "src/other.ts" is not a changed file',
      "line 40 (RIGHT) is not in the diff of src/x.ts",
      "start_line must be before line",
      "a suggestion needs the RIGHT side",
      "title and body are required",
    ])
  })

  it("rejects a range that leaves the diff, since GitHub refuses the whole review over one such comment", () => {
    const hunks = [
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "+const b = 2;",
      "@@ -10,2 +10,2 @@",
      " const j = 10;",
      "+const k = 11;",
    ]
    const result = validateFindings(
      [finding({ path: "src/hunks.ts", start_line: 2, line: 10, quote: "const j = 10;" })],
      new Map([["src/hunks.ts", commentableLines(hunks.join("\n"))]]),
    )
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "lines 2 to 10 (RIGHT) are not all in the diff of src/hunks.ts",
    ])
  })

  it("rejects a suggestion over 60000 characters, since one comment over GitHub's limit fails the whole review", () => {
    expect(validateFindings([finding({ suggestion: "x".repeat(60_000) })], commentable).accepted).toHaveLength(1)
    expect(
      validateFindings([finding({ suggestion: "x".repeat(60_001) })], commentable).rejected.map((r) => r.reason),
    ).toEqual(["suggestion longer than 60000 characters"])
  })

  it("rejects a finding whose rendered comment would pass GitHub's 65536-character limit", () => {
    const long = finding({ title: "t".repeat(2_000), body: "b".repeat(4_000), suggestion: "s".repeat(60_000) })
    expect(validateFindings([long], commentable).rejected.map((r) => r.reason)).toEqual([
      "comment longer than 65536 characters, GitHub's limit",
    ])
  })

  it("drops duplicates on one anchor and caps the count", () => {
    const anchors = [
      { line: 1, quote: "const a = 1;" },
      { line: 2, quote: "const b = 3;" },
      { line: 3, quote: "export { a, b };" },
    ]
    const many = Array.from({ length: MAX_FINDINGS + 2 }, (_, i) => finding({ ...anchors[i % 3], title: `t${i}` }))
    const result = validateFindings(many, commentable)
    expect(result.accepted).toHaveLength(3)
    expect(result.rejected.every((r) => r.reason.startsWith("duplicate anchor"))).toBe(true)
  })
})

describe("quote verification", () => {
  const twice = ["@@ -1,1 +1,4 @@", "+const x = 1;", "+const y = 2;", "+const x = 1;", " done"].join("\n")
  const files = new Map([
    ["src/x.ts", commentableLines(patch)],
    ["src/twice.ts", commentableLines(twice)],
  ])

  it("accepts a quote that matches its line up to surrounding and repeated whitespace", () => {
    const result = validateFindings([finding({ quote: "  const  b = 3;\t" })], files)
    expect(result.accepted).toEqual([finding({ quote: "  const  b = 3;\t" })])
    expect(result.relocated).toBe(0)
  })

  it("moves a finding to the one line its quote matches, as when the model miscounts", () => {
    const result = validateFindings([finding({ line: 3, suggestion: "const b = 4;" })], files)
    expect(result.accepted).toEqual([finding({ line: 2, suggestion: "const b = 4;" })])
    expect(result.relocated).toBe(1)
  })

  it("drops the range and its suggestion when it moves a multi-line finding, since only the quoted line is verified", () => {
    const result = validateFindings([finding({ start_line: 1, line: 3, suggestion: "const b = 4;" })], files)
    expect(result.accepted).toEqual([
      {
        path: "src/x.ts",
        line: 2,
        quote: "const b = 3;",
        basis_kind: "defect",
        basis: "with an empty cart the total is NaN",
        severity: "blocking",
        title: "b changed",
        body: "Why did b change?",
      },
    ])
  })

  it("rejects a quote that matches no line in the diff, or several", () => {
    const result = validateFindings(
      [finding({ quote: "const c = 4;" }), finding({ path: "src/twice.ts", line: 2, quote: "const x = 1;" })],
      files,
    )
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "quote does not match line 2 (RIGHT) and no other line in src/x.ts matches; quote the line's own text, without its anchor or the diff's + or - marker",
      "quote matches 2 lines in src/twice.ts; anchor the right one",
    ])
  })

  it("accepts a quote carrying the diff's marker for its side, and keeps the quote without it", () => {
    const right = validateFindings([finding({ quote: "+const b = 3;" })], files)
    const left = validateFindings([finding({ side: "LEFT", quote: "-  const b = 2;" })], files)
    const moved = validateFindings([finding({ line: 3, quote: " + const b = 3;" })], files)
    expect([...right.accepted, ...left.accepted, ...moved.accepted].map((f) => [f.line, f.quote])).toEqual([
      [2, "const b = 3;"],
      [2, "const b = 2;"],
      [2, "const b = 3;"],
    ])
    expect(moved.relocated).toBe(1)
  })

  it("refuses to move a finding when the quote as written and without its marker match different lines", () => {
    const marks = new Map([["src/marks.ts", commentableLines(["@@ -0,0 +1,3 @@", "++x", "+x", "+y"].join("\n"))]])
    const result = validateFindings([finding({ path: "src/marks.ts", line: 3, quote: "+x" })], marks)
    expect(result.accepted).toEqual([])
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "quote matches 2 lines in src/marks.ts; anchor the right one",
    ])
  })

  it("keeps a quote whose own text starts with a plus, and refuses the other side's marker", () => {
    const plus = new Map([["src/plus.ts", commentableLines(["@@ -1 +1,2 @@", " a", "++x"].join("\n"))]])
    expect(validateFindings([finding({ path: "src/plus.ts", quote: "+x" })], plus).accepted[0]?.quote).toBe("+x")
    expect(validateFindings([finding({ quote: "-const b = 3;" })], files).accepted).toEqual([])
  })
})

describe("suggestions", () => {
  const diffFile = [
    "@@ -30,3 +30,3 @@",
    '     if (marker === "+") {',
    "-      right.add(newLine++)",
    "+      right.add(++newLine)",
    "     } else {",
  ]
  const reviewFile = [
    "@@ -200,8 +200,5 @@",
    "     }",
    "-    if (pr.head.sha !== incoming.headSha) {",
    "-      return",
    "-    }",
    "     if (!incoming.full && (await this.ctx.storage.get(`posted:${pr.head.sha}`))) {",
    '       log("review.skip", { reason: "already_reviewed" })',
    "       return",
    "     }",
  ]
  const listFile = ["@@ -1,2 +1,2 @@", " const list = [", "-  1,", "+  2,"]
  const files = new Map([
    ["src/diff.ts", commentableLines(diffFile.join("\n"))],
    ["src/review.ts", commentableLines(reviewFile.join("\n"))],
    ["src/list.ts", commentableLines(listFile.join("\n"))],
  ])
  const alreadyReviewed = "if (!incoming.full && (await this.ctx.storage.get(`posted:${pr.head.sha}`))) {"

  it("re-indents a suggestion written without its line's indentation, as gpt-oss wrote all five on #9", () => {
    const result = validateFindings(
      [finding({ path: "src/diff.ts", line: 31, quote: "right.add(++newLine)", suggestion: "right.add(newLine++)" })],
      files,
    )
    expect(result.accepted[0]?.suggestion).toBe("      right.add(newLine++)")
    expect(result.suggestionsDropped).toBe(0)
  })

  it("keeps the suggestion's own relative indentation when it re-indents several lines", () => {
    const result = validateFindings(
      [
        finding({
          path: "src/review.ts",
          start_line: 201,
          line: 204,
          quote: "}",
          suggestion: 'if (fresh) {\n  log("review.skip")\n  return\n}',
        }),
      ],
      files,
    )
    expect(result.accepted[0]?.suggestion).toBe('    if (fresh) {\n      log("review.skip")\n      return\n    }')
  })

  it("leaves a suggestion that already carries its line's indentation, or more of it", () => {
    for (const suggestion of ["      right.add(newLine++)", "        right.add(newLine++)"]) {
      const result = validateFindings(
        [finding({ path: "src/diff.ts", line: 31, quote: "right.add(++newLine)", suggestion })],
        files,
      )
      expect(result.accepted[0]?.suggestion).toBe(suggestion)
    }
  })

  it("drops a suggestion that would unbalance the brackets but keeps the finding, as with the guard written over line 203 of #9", () => {
    const guard = [
      "if (pr.head.sha !== incoming.headSha) {",
      '  log("review.skip", {',
      '    reason: "superseded",',
      "  });",
      "  return;",
      "}",
    ].join("\n")
    const result = validateFindings(
      [finding({ path: "src/review.ts", line: 201, quote: alreadyReviewed, suggestion: guard })],
      files,
    )
    expect(result.accepted).toEqual([finding({ path: "src/review.ts", line: 201, quote: alreadyReviewed })])
    expect(result.suggestionsDropped).toBe(1)
  })

  it("counts each kind of bracket on its own, so swapping [ for { still drops the suggestion", () => {
    const result = validateFindings(
      [finding({ path: "src/list.ts", line: 1, quote: "const list = [", suggestion: "const list = {" })],
      files,
    )
    expect(result.accepted[0]?.suggestion).toBeUndefined()
    expect(result.suggestionsDropped).toBe(1)
  })
})

describe("basis", () => {
  it("rejects an empty basis and a blocking standard or test finding", () => {
    const result = validateFindings(
      [
        finding({ basis: "  " }),
        finding({ basis_kind: "standard", basis: "Feature Envy" }),
        finding({ basis_kind: "test", basis: "checkout has no test" }),
      ],
      commentable,
    )
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "basis is required",
      BLOCKING_STANDARD_OR_TEST,
      BLOCKING_STANDARD_OR_TEST,
    ])
  })

  it("fails the schema for an empty basis, so a tool call and written JSON alike come back for a fix", () => {
    const submission = {
      ...base,
      walkthrough: [{ path: "src/x.ts", summary: "b is now 3." }],
      findings: [finding({ basis: "" })],
    }
    expect(Value.Check(ReviewSubmission, submission)).toBe(false)
    expect(Value.Check(ReviewSubmission, { ...submission, findings: [finding()] })).toBe(true)
  })

  it("accepts a blocking defect or spec finding, and a standard or test finding graded below blocking", () => {
    const result = validateFindings(
      [
        finding({ basis_kind: "spec", basis: "#7: totals are never NaN" }),
        finding({
          line: 1,
          quote: "const a = 1;",
          severity: "suggestion",
          basis_kind: "standard",
          basis: "Feature Envy",
        }),
        finding({
          line: 3,
          quote: "export { a, b };",
          severity: "nitpick",
          basis_kind: "test",
          basis: "b has no test",
        }),
      ],
      commentable,
    )
    expect(result.rejected).toEqual([])
    expect(result.accepted).toHaveLength(3)
  })

  it("renders the basis after the body and before the suggestion", () => {
    const comment = toReviewComment(finding({ suggestion: "const b = 4;" }))
    expect(comment.body).toBe(
      "**🔴 Blocking: b changed**\n\nWhy did b change?\n\n_Basis: with an empty cart the total is NaN_\n\n```suggestion\nconst b = 4;\n```",
    )
  })
})

describe("missingWalkthrough", () => {
  it("names source and binary files without a row and ignores generated ones", () => {
    const files = [
      { filename: "src/x.ts", status: "modified", additions: 1, deletions: 0, patch },
      { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
      { filename: "pnpm-lock.yaml", status: "modified", additions: 1, deletions: 0 },
    ]
    const submission = { ...base, walkthrough: [{ path: "src/x.ts", summary: "s" }] }
    expect(missingWalkthrough(submission, walkthroughPaths(files))).toEqual(["logo.png"])
  })

  it("counts a row whose path has surrounding spaces or a leading ./", () => {
    const submission = { ...base, walkthrough: [{ path: "./src/x.ts ", summary: "s" }] }
    expect(missingWalkthrough(submission, ["src/x.ts"])).toEqual([])
  })
})

describe("walkthroughPaths", () => {
  it("lists the files that need a walkthrough row, in diff order, and skips generated ones", () => {
    const files = [
      { filename: "src/x.ts", status: "modified", additions: 1, deletions: 0, patch },
      { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
      { filename: "pnpm-lock.yaml", status: "modified", additions: 1, deletions: 0 },
    ]
    expect(walkthroughPaths(files)).toEqual(["src/x.ts", "logo.png"])
  })
})

describe("parseWrittenReview", () => {
  const submitted = {
    summary: "Changes b from 2 to 3.",
    walkthrough: [{ path: "src/x.ts", summary: "b is now 3." }],
    findings: [finding({ severity: "suggestion", body: "Name it:\n```ts\nconst three = 3\n```" })],
    verdict: "comment",
    merge_danger: { door: "two-way", blast_radius: "one module" },
  } satisfies ReviewSubmissionInput
  const submittedJson = JSON.stringify(submitted, null, 2)

  it("takes a submission written as bare JSON, as gpt-oss-120b wrote its review of #5", () => {
    expect(parseWrittenReview(submittedJson)).toEqual({ kind: "submission", submission: submitted })
  })

  it("accepts the threads a submission says the new changes fixed, and holds back a malformed list", () => {
    const withThreads = { ...submitted, addressed_threads: ["T1", "T3"] }
    expect(parseWrittenReview(JSON.stringify(withThreads))).toEqual({ kind: "submission", submission: withThreads })
    const malformed = parseWrittenReview(JSON.stringify({ ...submitted, addressed_threads: "T1" }))
    expect(malformed).toEqual({ kind: "unfit", problem: expect.stringContaining("/addressed_threads") })
  })

  it("takes a submission inside a json code fence, with prose around it and fences in its findings", () => {
    const text = `Here is the review.\n\n\`\`\`json\n${submittedJson}\n\`\`\`\n\nThat's all.`
    expect(parseWrittenReview(text)).toEqual({ kind: "submission", submission: submitted })
  })

  it("ends a bare submission at its own closing brace, past braces and quotes in its strings", () => {
    const quoting = { ...submitted, summary: 'Returns "}" where it returned "{".' }
    const text = `${JSON.stringify(quoting, null, 2)}\n\nI left {} out of the findings.`
    expect(parseWrittenReview(text)).toEqual({ kind: "submission", submission: quoting })
  })

  it("keeps prose as prose, trimmed, so it can stay the summary's note", () => {
    expect(parseWrittenReview("\n  The change looks sound.\n")).toEqual({
      kind: "prose",
      text: "The change looks sound.",
    })
  })

  it("holds back JSON that doesn't fit ReviewSubmission and says where it fails", () => {
    const written = parseWrittenReview(JSON.stringify({ ...submitted, verdict: "approved" }))
    expect(written).toEqual({ kind: "unfit", problem: expect.stringContaining("/verdict") })
  })

  it('holds back an approval with no walkthrough, the shell gpt-oss-120b put around "Review submitted." when held to JSON', () => {
    const shell = { ...base, summary: "Review submitted." }
    expect(parseWrittenReview(JSON.stringify(shell))).toEqual({
      kind: "unfit",
      problem: expect.stringContaining("/walkthrough"),
    })
  })

  it("holds back a submission without a merge danger", () => {
    const written = parseWrittenReview(JSON.stringify({ ...submitted, merge_danger: undefined }))
    expect(written).toEqual({ kind: "unfit", problem: expect.stringContaining("merge_danger") })
  })

  it("holds back a submission with an empty blast radius", () => {
    const written = parseWrittenReview(
      JSON.stringify({ ...submitted, merge_danger: { door: "two-way", blast_radius: "" } }),
    )
    expect(written).toEqual({ kind: "unfit", problem: expect.stringContaining("/merge_danger/blast_radius") })
  })

  it("holds back a finding without a basis", () => {
    const written = parseWrittenReview(JSON.stringify({ ...submitted, findings: [{ ...finding(), basis: undefined }] }))
    expect(written).toEqual({ kind: "unfit", problem: expect.stringContaining("basis") })
  })

  it("holds back JSON the output limit cut off, rather than taking it for prose", () => {
    expect(parseWrittenReview(`Review:\n${submittedJson.slice(0, 200)}`)).toMatchObject({ kind: "unfit" })
  })
})

describe("toReviewComment", () => {
  it("formats severity, title, body and a suggestion block with a range", () => {
    const comment = toReviewComment(finding({ start_line: 1, line: 2, suggestion: "const b = 4;\n" }))
    expect(comment).toMatchObject({ path: "src/x.ts", line: 2, side: "RIGHT", start_line: 1, start_side: "RIGHT" })
    expect(comment.body).toBe(
      "**🔴 Blocking: b changed**\n\nWhy did b change?\n\n_Basis: with an empty cart the total is NaN_\n\n```suggestion\nconst b = 4;\n```",
    )
  })
})

describe("chooseReviewEvent", () => {
  it("requests changes on a blocking finding, approves a clean approve verdict, else comments", () => {
    expect(chooseReviewEvent(base, [finding()], [], true)).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent(base, [finding({ severity: "nitpick" })], [], true)).toBe("APPROVE")
    expect(chooseReviewEvent({ ...base, verdict: "comment" }, [], [], true)).toBe("COMMENT")
    expect(chooseReviewEvent(base, [finding()], [], false)).toBe("COMMENT")
  })

  it("never approves while a blocking finding stands rejected, so a mis-anchored one still blocks", () => {
    expect(chooseReviewEvent(base, [], [{ finding: finding(), reason: "r" }], true)).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent(base, [], [{ finding: finding({ severity: "nitpick" }), reason: "r" }], true)).toBe(
      "APPROVE",
    )
  })

  it("lets only a defect or spec finding hold approval back, since a standard or test one graded blocking was rejected for that grade", () => {
    const rejectedAs = (kind: FindingInput["basis_kind"]) => [{ finding: finding({ basis_kind: kind }), reason: "r" }]
    expect(chooseReviewEvent(base, [], rejectedAs("standard"), true)).toBe("APPROVE")
    expect(chooseReviewEvent(base, [], rejectedAs("test"), true)).toBe("APPROVE")
    expect(chooseReviewEvent(base, [], rejectedAs("defect"), true)).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent(base, [], rejectedAs("spec"), true)).toBe("REQUEST_CHANGES")
  })

  it("requests changes while one of its blocking threads stays open, and approves once none does", () => {
    expect(chooseReviewEvent(base, [], [], true, 2)).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent(base, [], [], true, 0)).toBe("APPROVE")
    expect(chooseReviewEvent(base, [], [], false, 2)).toBe("COMMENT")
  })

  it("never approves when its open threads couldn't be read", () => {
    expect(chooseReviewEvent(base, [], [], true, "unknown")).toBe("COMMENT")
    expect(chooseReviewEvent(base, [finding()], [], true, "unknown")).toBe("REQUEST_CHANGES")
  })

  it("holds approval back for an open blocking thread even when the only rejected finding is a standard one", () => {
    const standard = [{ finding: finding({ basis_kind: "standard" }), reason: BLOCKING_STANDARD_OR_TEST }]
    expect(chooseReviewEvent(base, [], standard, true, 1)).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent(base, [], standard, true, 0)).toBe("APPROVE")
  })
})

describe("renderReviewBody", () => {
  it("names the blocking findings that couldn't be posted inline, since they hold approval back", () => {
    const body = renderReviewBody(
      "REQUEST_CHANGES",
      [],
      [
        { finding: finding({ title: "Total is NaN for an empty cart" }), reason: "quote matches 2 lines" },
        { finding: finding({ severity: "nitpick", title: "Rename b" }), reason: "quote matches 2 lines" },
      ],
    )
    expect(body).toBe(
      "1 blocking finding(s) couldn't be posted inline and hold approval back:\n- **Total is NaN for an empty cart** in `src/x.ts`",
    )
  })

  it("leaves out a standard or test finding rejected for its blocking grade, since it doesn't hold approval back", () => {
    const body = renderReviewBody(
      "REQUEST_CHANGES",
      [],
      [
        { finding: finding({ title: "Total is NaN for an empty cart" }), reason: "quote matches 2 lines" },
        {
          finding: finding({ basis_kind: "standard", basis: "Feature Envy", title: "Move the total into Cart" }),
          reason: BLOCKING_STANDARD_OR_TEST,
        },
      ],
    )
    expect(body).toBe(
      "1 blocking finding(s) couldn't be posted inline and hold approval back:\n- **Total is NaN for an empty cart** in `src/x.ts`",
    )
  })

  it("follows the inline counts with them when other findings were posted", () => {
    const body = renderReviewBody(
      "REQUEST_CHANGES",
      [finding({ severity: "nitpick" })],
      [{ finding: finding({ title: "Total is NaN" }), reason: "r" }],
    )
    expect(body).toBe(
      "1 nitpick(s). Blocking findings are marked 🔴; the others are optional.\n\n1 blocking finding(s) couldn't be posted inline and hold approval back:\n- **Total is NaN** in `src/x.ts`",
    )
  })

  it("lists at most five of them, with titles cut short, so the review body stays within GitHub's limit", () => {
    const rejected = Array.from({ length: 7 }, (_, i) => ({
      finding: finding({ title: `${i}`.repeat(300) }),
      reason: "r",
    }))
    const lines = renderReviewBody("REQUEST_CHANGES", [], rejected).split("\n")
    expect(lines[0]).toBe("7 blocking finding(s) couldn't be posted inline and hold approval back:")
    expect(lines[1]).toBe(`- **${"0".repeat(100)}…** in \`src/x.ts\``)
    expect(lines).toHaveLength(6)
  })
})

describe("renderReviewBody coverage", () => {
  it("says which commits and files an incremental review covered and how many threads it resolved", () => {
    const coverage = { mode: "incremental" as const, from: "abc1234567", to: "def5678901", files: 3, resolved: 2 }
    expect(renderReviewBody("COMMENT", [], [], coverage)).toBe(
      "No findings to anchor to the diff. See the summary comment.\n\n<sub>Incremental review of `abc1234..def5678`: 3 files; 2 threads resolved.</sub>",
    )
    expect(renderReviewBody("COMMENT", [], [], { ...coverage, files: 1, resolved: 1 })).toContain(
      "`abc1234..def5678`: 1 file; 1 thread resolved.",
    )
  })

  it("says a full review covered everything, and says nothing without a coverage", () => {
    expect(renderReviewBody("COMMENT", [], [], { mode: "full", to: "def5678901", files: 9, resolved: 0 })).toContain(
      "\n\n<sub>Full review.</sub>",
    )
    expect(renderReviewBody("COMMENT", [], [])).not.toContain("<sub>")
  })
})

describe("mergeWalkthrough", () => {
  it("replaces the rows of re-reviewed files, keeps the rest, and ignores rows for files it didn't cover", () => {
    const merged = mergeWalkthrough(
      [
        { path: "a.ts", summary: "old a" },
        { path: "b.ts", summary: "old b" },
      ],
      [
        { path: "a.ts", summary: "new a" },
        { path: "b.ts", summary: "not covered" },
        { path: "c.ts", summary: "new c" },
      ],
      new Set(["a.ts", "c.ts"]),
    )
    expect(merged).toEqual([
      { path: "a.ts", summary: "new a" },
      { path: "b.ts", summary: "old b" },
      { path: "c.ts", summary: "new c" },
    ])
  })

  it("matches a row's path the way the coverage check does, so ./a.ts replaces a.ts", () => {
    const merged = mergeWalkthrough(
      [{ path: "a.ts", summary: "old a" }],
      [
        { path: " ./a.ts ", summary: "new a" },
        { path: "./c.ts", summary: "new c" },
      ],
      new Set(["a.ts", "c.ts"]),
    )
    expect(merged).toEqual([
      { path: "a.ts", summary: "new a" },
      { path: "c.ts", summary: "new c" },
    ])
  })

  it("matches a stored row written as ./a.ts too, so the new a.ts row replaces it instead of joining it", () => {
    const merged = mergeWalkthrough(
      [
        { path: "./a.ts", summary: "old a" },
        { path: "b.ts", summary: "old b" },
      ],
      [{ path: "a.ts", summary: "new a" }],
      new Set(["a.ts"]),
    )
    expect(merged).toEqual([
      { path: "a.ts", summary: "new a" },
      { path: "b.ts", summary: "old b" },
    ])
  })
})

describe("renderSummaryComment", () => {
  it("adds a section for what changed since the last full review", () => {
    const text = renderSummaryComment({
      botLogin: "andabot",
      headSha: "def5678901",
      event: "COMMENT",
      submission: { ...base, summary: "The whole PR.", verdict: "comment" },
      accepted: [],
      droppedCount: 0,
      linkedIssues: [],
      since: {
        from: "abc1234567",
        to: "def5678901",
        summary: "Fixed the total.",
        files: ["a.ts", "b.ts"],
        resolved: 1,
      },
    })
    expect(text).toContain("### Summary\n\nThe whole PR.")
    expect(text).toContain("### Since `abc1234`\n\nFixed the total.\n\nFiles: `a.ts`, `b.ts`. Resolved 1 thread(s).")
  })

  it("keeps the merge danger under the verdict and the linked issues in the footer when it adds the since section", () => {
    const text = renderSummaryComment({
      botLogin: "andabot",
      headSha: "def5678901",
      event: "COMMENT",
      submission: { ...base, summary: "The whole PR.", verdict: "comment" },
      accepted: [],
      droppedCount: 0,
      linkedIssues: [24],
      since: { from: "abc1234567", to: "def5678901", summary: "Fixed the total.", files: ["a.ts"], resolved: 0 },
    })
    expect(text).toContain("⚪ 0 nitpicks\n\n**Merge danger:** two-way door · one module\n\n### Summary")
    expect(text.indexOf("### Since `abc1234`")).toBeLessThan(text.indexOf("<sub>Linked issues: #24</sub>"))
  })

  const summaryWith = (attribution: { model?: string; skillsFingerprint?: string; linkedIssues?: number[] }) =>
    renderSummaryComment({
      botLogin: "andabot",
      headSha: "0123456789abcdef",
      event: "REQUEST_CHANGES",
      submission: {
        summary: "Changes b.",
        walkthrough: [{ path: "src/x.ts", summary: "b is | now 3" }],
        findings: [],
        verdict: "request_changes",
        merge_danger: { door: "two-way", blast_radius: "one module" },
      },
      accepted: [finding()],
      droppedCount: 1,
      linkedIssues: [],
      ...attribution,
    })

  it("starts with the marker and shows counts, summary and walkthrough", () => {
    const text = summaryWith({ model: "@cf/openai/gpt-oss-120b", skillsFingerprint: "89abcdef01234567" })
    expect(text.startsWith(SUMMARY_MARKER)).toBe(true)
    expect(text).toContain("`0123456` · **Verdict:** Changes requested · 🔴 1 blocking")
    expect(text).toContain("| `src/x.ts` | b is \\| now 3 |")
    expect(text).toContain(
      "<sub>1 finding(s) were dropped because they failed the host's checks, even after a retry.</sub>",
    )
    expect(text).toContain("**Merge danger:** two-way door · one module")
    expect(text).toContain("<sub>Reviewed by `@cf/openai/gpt-oss-120b` with skills `review@89abcdef`.</sub>")
  })

  it("puts the merge danger on the line under the verdict, before the summary", () => {
    expect(summaryWith({})).toContain("⚪ 0 nitpicks\n\n**Merge danger:** two-way door · one module\n\n### Summary")
  })

  it("flattens a multi-line blast radius onto the merge-danger line", () => {
    const text = renderSummaryComment({
      botLogin: "andabot",
      headSha: "0123456789abcdef",
      event: "COMMENT",
      submission: { ...base, merge_danger: { door: "one-way", blast_radius: "billing\n  and the\tinvoices table\n" } },
      accepted: [],
      droppedCount: 0,
      linkedIssues: [],
    })
    expect(text).toContain("**Merge danger:** one-way door · billing and the invoices table\n\n### Summary")
  })

  it("leaves the skills claim out when the build that ran the review recorded no model or fingerprint", () => {
    expect(summaryWith({})).not.toContain("Reviewed by")
    expect(summaryWith({ model: "@cf/openai/gpt-oss-120b" })).not.toContain("Reviewed by")
    expect(summaryWith({})).toContain(
      "even after a retry.</sub>\n\n<sub>Linked issues: none</sub>\n<sub>Commands: `@andabot review`",
    )
  })

  it("names the linked issues the review read on the line after the skills claim", () => {
    const text = summaryWith({
      model: "@cf/openai/gpt-oss-120b",
      skillsFingerprint: "89abcdef01234567",
      linkedIssues: [12, 14],
    })
    expect(text).toContain("`review@89abcdef`.</sub>\n<sub>Linked issues: #12, #14</sub>\n<sub>Commands:")
  })
})

describe("renderUnpostedSummary", () => {
  it("starts with the marker, so the next review edits the same comment, and shows the head and the note", () => {
    const text = renderUnpostedSummary({
      botLogin: "andabot",
      headSha: "0123456789abcdef",
      note: "_The review did not complete: model_error._",
    })
    expect(text.startsWith(SUMMARY_MARKER)).toBe(true)
    expect(text).toContain("`0123456`")
    expect(text).toContain("_The review did not complete: model_error._")
  })
})

describe("renderUnpostedNote", () => {
  it("says the review couldn't be posted and keeps the model's prose as the note", () => {
    const note = renderUnpostedNote({ kind: "prose", text: "The change looks sound." }, { kind: "unanswered" })
    expect(note).toContain("couldn't be posted")
    expect(note).toContain("The change looks sound.")
  })

  it("shows nothing the model wrote unless it was prose, so its JSON stays in the log", () => {
    const submission = { ...base, summary: "Changes b." }
    expect(renderUnpostedNote({ kind: "submission", submission }, { kind: "unanswered" })).not.toContain("Changes b.")
    expect(
      renderUnpostedNote({ kind: "unfit", problem: "/verdict: must be equal to constant" }, { kind: "unanswered" }),
    ).not.toContain("/verdict")
  })

  it("gives the reason asking again failed", () => {
    const note = renderUnpostedNote({ kind: "prose", text: "" }, { kind: "failed", reason: "model_error: quota" })
    expect(note).toContain("model_error: quota")
  })

  it("gives the reason the host refused the review the model submitted when asked again", () => {
    const refusal = "Error: GitHub POST /repos/o/r/pulls/5/reviews: 502"
    const note = renderUnpostedNote({ kind: "prose", text: "Looks risky." }, { kind: "refused", refusal })
    expect(note).toContain(`refused the review it submitted when asked again: ${refusal}`)
  })

  it("keeps a refusal that runs over several lines inside the note's one italic line", () => {
    const note = renderUnpostedNote(
      { kind: "prose", text: "" },
      { kind: "refused", refusal: "Not posted:\n the head moved." },
    )
    expect(note).toBe(
      "_The review couldn't be posted: the model didn't submit one that could be, and the host refused the review it submitted when asked again: Not posted: the head moved._",
    )
  })
})

describe("incompleteNote", () => {
  it("names each file without a row in backticks, inside the one italic line", () => {
    expect(incompleteNote(["a", "b"])).toBe("_The review did not complete: no walkthrough row for `a`, `b`._")
  })

  it("keeps an underscore in a path from ending the italics", () => {
    expect(incompleteNote(["src/_private_.ts"])).toBe(
      "_The review did not complete: no walkthrough row for `src/_private_.ts`._",
    )
  })

  it("lists all ten files when there are ten, with no count of the rest", () => {
    const ten = Array.from("abcdefghij")
    expect(incompleteNote(ten)).toBe(
      "_The review did not complete: no walkthrough row for `a`, `b`, `c`, `d`, `e`, `f`, `g`, `h`, `i`, `j`._",
    )
  })

  it("lists ten files and counts the rest, so a pull request with no rows at all can't flood the summary or the check run", () => {
    const twelve = Array.from("abcdefghijkl")
    expect(incompleteNote(twelve)).toBe(
      "_The review did not complete: no walkthrough row for `a`, `b`, `c`, `d`, `e`, `f`, `g`, `h`, `i`, `j` and 2 more._",
    )
  })
})
