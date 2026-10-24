import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { commentableLines } from "../src/github/diff.ts"
import { budgetNote } from "../src/review/budget.ts"
import type { ReviewSpend } from "../src/review/cost.ts"
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
  approvalBody,
  chooseReviewEvent,
  holdsBlocking,
  incompleteNote,
  mergeWalkthrough,
  renderReviewBody,
  renderSummaryComment,
  renderUnpostedNote,
  renderUnpostedSummary,
  reviewEventOf,
  SUMMARY_MARKER,
  withApprovedVerdict,
  type VerifyDisplay,
} from "../src/review/render.ts"
import type { Changed, VerifyReport } from "../src/review/verify.ts"

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

const NO_LINKED_ISSUE =
  "a spec finding needs a linked issue, and this pull request has none; if the code is wrong on its own terms, make it a defect with its failure scenario"

const specFinding = (overrides: Partial<FindingInput> = {}): FindingInput =>
  finding({ basis_kind: "spec", basis: "#7: totals are never NaN", ...overrides })

describe("validateFindings", () => {
  it("accepts a finding on an added line and one on a deleted line", () => {
    const result = validateFindings(
      [finding(), finding({ line: 2, side: "LEFT", quote: "const b = 2;", title: "removed" })],
      commentable,
      true,
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
      true,
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
      true,
    )
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "lines 2 to 10 (RIGHT) are not all in the diff of src/hunks.ts",
    ])
  })

  it("rejects a suggestion over 60000 characters, since one comment over GitHub's limit fails the whole review", () => {
    expect(validateFindings([finding({ suggestion: "x".repeat(60_000) })], commentable, true).accepted).toHaveLength(1)
    expect(
      validateFindings([finding({ suggestion: "x".repeat(60_001) })], commentable, true).rejected.map((r) => r.reason),
    ).toEqual(["suggestion longer than 60000 characters"])
  })

  it("rejects a finding whose rendered comment would pass GitHub's 65536-character limit", () => {
    const long = finding({ title: "t".repeat(2_000), body: "b".repeat(4_000), suggestion: "s".repeat(60_000) })
    expect(validateFindings([long], commentable, true).rejected.map((r) => r.reason)).toEqual([
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
    const result = validateFindings(many, commentable, true)
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
    const result = validateFindings([finding({ quote: "  const  b = 3;\t" })], files, true)
    expect(result.accepted).toEqual([finding({ quote: "  const  b = 3;\t" })])
    expect(result.relocated).toBe(0)
  })

  it("moves a finding to the one line its quote matches, as when the model miscounts", () => {
    const result = validateFindings([finding({ line: 3, suggestion: "const b = 4;" })], files, true)
    expect(result.accepted).toEqual([finding({ line: 2, suggestion: "const b = 4;" })])
    expect(result.relocated).toBe(1)
  })

  it("drops the range and its suggestion when it moves a multi-line finding, since only the quoted line is verified", () => {
    const result = validateFindings([finding({ start_line: 1, line: 3, suggestion: "const b = 4;" })], files, true)
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
      true,
    )
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "quote does not match line 2 (RIGHT) and no other line in src/x.ts matches; quote the line's own text, without its anchor or the diff's + or - marker",
      "quote matches 2 lines in src/twice.ts; anchor the right one",
    ])
  })

  it("accepts a quote carrying the diff's marker for its side, and keeps the quote without it", () => {
    const right = validateFindings([finding({ quote: "+const b = 3;" })], files, true)
    const left = validateFindings([finding({ side: "LEFT", quote: "-  const b = 2;" })], files, true)
    const moved = validateFindings([finding({ line: 3, quote: " + const b = 3;" })], files, true)
    expect([...right.accepted, ...left.accepted, ...moved.accepted].map((f) => [f.line, f.quote])).toEqual([
      [2, "const b = 3;"],
      [2, "const b = 2;"],
      [2, "const b = 3;"],
    ])
    expect(moved.relocated).toBe(1)
  })

  it("refuses to move a finding when the quote as written and without its marker match different lines", () => {
    const marks = new Map([["src/marks.ts", commentableLines(["@@ -0,0 +1,3 @@", "++x", "+x", "+y"].join("\n"))]])
    const result = validateFindings([finding({ path: "src/marks.ts", line: 3, quote: "+x" })], marks, true)
    expect(result.accepted).toEqual([])
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "quote matches 2 lines in src/marks.ts; anchor the right one",
    ])
  })

  it("keeps a quote whose own text starts with a plus, and refuses the other side's marker", () => {
    const plus = new Map([["src/plus.ts", commentableLines(["@@ -1 +1,2 @@", " a", "++x"].join("\n"))]])
    expect(validateFindings([finding({ path: "src/plus.ts", quote: "+x" })], plus, true).accepted[0]?.quote).toBe("+x")
    expect(validateFindings([finding({ quote: "-const b = 3;" })], files, true).accepted).toEqual([])
  })

  describe("a quote that carries the diff's anchor or marker", () => {
    const carried = new Map([
      [
        "src/carried.ts",
        commentableLines(["@@ -11,1 +11,4 @@", " keep", "+const x = 1", "++ item", "+item"].join("\n")),
      ],
    ])
    const carriedAt = (line: number, quote: string) =>
      validateFindings([finding({ path: "src/carried.ts", line, quote })], carried, true)

    it.each([
      "+ const x = 1",
      "+const x = 1",
      "R12 const x = 1",
      "R12 + const x = 1",
      "R12 +const x = 1",
      "R12*   +const x = 1",
      "* const x = 1",
    ])("anchors the quote %j on its line without moving it", (quote) => {
      const result = carriedAt(12, quote)
      expect(result.accepted.map((f) => [f.line, f.quote])).toEqual([[12, "const x = 1"]])
      expect(result.relocated).toBe(0)
    })

    it("anchors a LEFT quote that carries its anchor, its star and its minus", () => {
      const result = validateFindings([finding({ side: "LEFT", quote: "L2*    -const b = 2;" })], files, true)
      expect(result.accepted.map((f) => [f.line, f.quote])).toEqual([[2, "const b = 2;"]])
      expect(result.relocated).toBe(0)
    })

    it("moves a miscounted finding to the one line its quote matches once the anchor and marker are stripped", () => {
      const result = validateFindings([finding({ line: 3, quote: "R2 +const b = 3;" })], files, true)
      expect(result.accepted.map((f) => [f.line, f.quote])).toEqual([[2, "const b = 3;"]])
      expect(result.relocated).toBe(1)
    })

    it("anchors a quote as written when it matches its line, even where it begins like a marker", () => {
      const result = carriedAt(13, "+ item")
      expect(result.accepted.map((f) => [f.line, f.quote])).toEqual([[13, "+ item"]])
      expect(result.relocated).toBe(0)
    })

    it("tries the quote as written before any stripped reading, so a line that starts with a star keeps its quote", () => {
      const stars = new Map([["src/stars.ts", commentableLines(["@@ -1 +1,2 @@", " a", "+ * item"].join("\n"))]])
      const result = validateFindings([finding({ path: "src/stars.ts", quote: "* item" })], stars, true)
      expect(result.accepted.map((f) => [f.line, f.quote])).toEqual([[2, "* item"]])
    })

    it("refuses to move a finding when the quote as written and without its anchor match different lines", () => {
      const anchors = new Map([
        ["src/anchors.ts", commentableLines(["@@ -0,0 +1,3 @@", "+R2 total", "+total", "+other"].join("\n"))],
      ])
      const result = validateFindings([finding({ path: "src/anchors.ts", line: 3, quote: "R2 total" })], anchors, true)
      expect(result.accepted).toEqual([])
      expect(result.rejected.map((r) => r.reason)).toEqual([
        "quote matches 2 lines in src/anchors.ts; anchor the right one",
      ])
    })

    it("rejects a quote that matches nothing even once its anchor and marker are stripped, with the usual reason", () => {
      const result = carriedAt(12, "R12 + const y = 2")
      expect(result.accepted).toEqual([])
      expect(result.rejected.map((r) => r.reason)).toEqual([
        "quote does not match line 12 (RIGHT) and no other line in src/carried.ts matches; quote the line's own text, without its anchor or the diff's + or - marker",
      ])
    })
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
      true,
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
      true,
    )
    expect(result.accepted[0]?.suggestion).toBe('    if (fresh) {\n      log("review.skip")\n      return\n    }')
  })

  it("leaves a suggestion that already carries its line's indentation, or more of it", () => {
    for (const suggestion of ["      right.add(newLine++)", "        right.add(newLine++)"]) {
      const result = validateFindings(
        [finding({ path: "src/diff.ts", line: 31, quote: "right.add(++newLine)", suggestion })],
        files,
        true,
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
      true,
    )
    expect(result.accepted).toEqual([finding({ path: "src/review.ts", line: 201, quote: alreadyReviewed })])
    expect(result.suggestionsDropped).toBe(1)
  })

  it("counts each kind of bracket on its own, so swapping [ for { still drops the suggestion", () => {
    const result = validateFindings(
      [finding({ path: "src/list.ts", line: 1, quote: "const list = [", suggestion: "const list = {" })],
      files,
      true,
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
      true,
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
      true,
    )
    expect(result.rejected).toEqual([])
    expect(result.accepted).toHaveLength(3)
  })

  it("rejects a spec finding when no issue is linked, offering the defect kind, and accepts it when one is", () => {
    const spec = specFinding()
    const result = validateFindings([spec], commentable, false)
    expect(result.accepted).toEqual([])
    expect(result.rejected).toEqual([{ finding: spec, reason: NO_LINKED_ISSUE, unfounded: true }])
    expect(validateFindings([spec], commentable, true).accepted).toEqual([spec])
  })

  it("rejects a spec finding with no linked issue whatever its grade", () => {
    const result = validateFindings([specFinding(), specFinding({ severity: "nitpick" })], commentable, false)
    expect(result.rejected.map((r) => r.reason)).toEqual([NO_LINKED_ISSUE, NO_LINKED_ISSUE])
  })

  it("marks a rejection unfounded when its basis caused it, and not for an anchor, range, size or suggestion side", () => {
    const unfoundedOf = (findings: FindingInput[]) =>
      validateFindings(findings, commentable, false).rejected.map((r) => r.unfounded)
    expect(
      unfoundedOf([finding({ basis: "  " }), finding({ basis_kind: "test", basis: "no test" }), specFinding()]),
    ).toEqual([true, true, true])
    expect(
      unfoundedOf([
        finding({ path: "src/other.ts" }),
        finding({ quote: "const c = 4;" }),
        finding({ line: 3, start_line: 4, quote: "export { a, b };" }),
        finding({ title: "   " }),
        finding({ side: "LEFT", quote: "const b = 2;", suggestion: "x" }),
        finding({ suggestion: "x".repeat(60_001) }),
      ]),
    ).toEqual([false, false, false, false, false, false])
  })

  it("never marks a duplicate anchor or a finding past the cap unfounded, since it passed every check", () => {
    const lines = Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => `const v${i} = ${i};`)
    const crowdedPatch = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n")
    const crowded = new Map([["src/crowded.ts", commentableLines(crowdedPatch)]])
    const each = lines.map((quote, i) => finding({ path: "src/crowded.ts", line: i + 1, quote }))
    const result = validateFindings([...each, finding({ ...each[0], title: "again" })], crowded, false)
    expect(result.accepted).toHaveLength(MAX_FINDINGS)
    expect(result.rejected.map((r) => [r.reason, r.unfounded])).toEqual([
      [`more than ${MAX_FINDINGS} findings; keep the most important`, false],
      ["duplicate anchor: one comment per line, merge them", false],
    ])
  })

  it("counts a blocking standard finding as unfounded even when its quote matches no line, so it never holds approval back", () => {
    const standard = finding({ basis_kind: "standard", basis: "Feature Envy", quote: "const c = 4;" })
    const { rejected } = validateFindings([standard], commentable, true)
    expect(rejected).toEqual([{ finding: standard, reason: BLOCKING_STANDARD_OR_TEST, unfounded: true }])
    expect(chooseReviewEvent(base, [], rejected, true)).toBe("APPROVE")
  })

  it("renders the basis after the body and before the suggestion", () => {
    const comment = toReviewComment(finding({ suggestion: "const b = 4;" }))
    expect(comment.body).toBe(
      "**🔴 Blocking: b changed**\n\nWhy did b change?\n\n_Basis (defect): with an empty cart the total is NaN_\n\n```suggestion\nconst b = 4;\n```",
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
      "**🔴 Blocking: b changed**\n\nWhy did b change?\n\n_Basis (defect): with an empty cart the total is NaN_\n\n```suggestion\nconst b = 4;\n```",
    )
  })

  it("shows each finding's basis kind in its basis line, so a spec or test finding is recognisable without reading the quote", () => {
    const specComment = toReviewComment(specFinding())
    const testComment = toReviewComment(
      finding({ basis_kind: "test", basis: "checkout has no test", severity: "suggestion" }),
    )
    expect(specComment.body).toBe(
      "**🔴 Blocking: b changed**\n\nWhy did b change?\n\n_Basis (spec): #7: totals are never NaN_",
    )
    expect(testComment.body).toBe(
      "**🟡 Suggestion: b changed**\n\nWhy did b change?\n\n_Basis (test): checkout has no test_",
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
    expect(chooseReviewEvent(base, [], [{ finding: finding(), reason: "r", unfounded: false }], true)).toBe(
      "REQUEST_CHANGES",
    )
    expect(
      chooseReviewEvent(base, [], [{ finding: finding({ severity: "nitpick" }), reason: "r", unfounded: false }], true),
    ).toBe("APPROVE")
  })

  it("holds approval back for a blocking defect or spec finding rejected for anything but its basis", () => {
    const rejectedAs = (kind: FindingInput["basis_kind"]) => [
      { finding: finding({ basis_kind: kind }), reason: "r", unfounded: false },
    ]
    expect(chooseReviewEvent(base, [], rejectedAs("defect"), true)).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent(base, [], rejectedAs("spec"), true)).toBe("REQUEST_CHANGES")
  })

  it("never lets a blocking standard or test finding hold approval back, since validation rejects it for that grade", () => {
    const blocking = [
      finding({ basis_kind: "standard", basis: "Feature Envy" }),
      finding({ basis_kind: "test", basis: "checkout has no test" }),
    ]
    for (const rejectedFinding of blocking) {
      const { rejected } = validateFindings([rejectedFinding], commentable, true)
      expect(rejected.map((r) => r.reason)).toEqual([BLOCKING_STANDARD_OR_TEST])
      expect(chooseReviewEvent(base, [], rejected, true)).toBe("APPROVE")
    }
  })

  it("approves an approve verdict when the only rejection is a spec finding on a pull request with no linked issue", () => {
    const { rejected } = validateFindings([specFinding()], commentable, false)
    expect(rejected).toEqual([{ finding: specFinding(), reason: NO_LINKED_ISSUE, unfounded: true }])
    expect(chooseReviewEvent(base, [], rejected, true)).toBe("APPROVE")
  })

  it("requests changes when the only rejection is a blocking defect finding whose quote matches no line", () => {
    const { rejected } = validateFindings([finding({ quote: "const c = 4;" })], commentable, false)
    expect(rejected.map((r) => r.unfounded)).toEqual([false])
    expect(chooseReviewEvent(base, [], rejected, true)).toBe("REQUEST_CHANGES")
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
    const standard = [
      { finding: finding({ basis_kind: "standard" }), reason: BLOCKING_STANDARD_OR_TEST, unfounded: true },
    ]
    expect(chooseReviewEvent(base, [], standard, true, 1)).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent(base, [], standard, true, 0)).toBe("APPROVE")
  })
})

describe("holdsBlocking", () => {
  const rejectedAs = (overrides: Partial<FindingInput>, unfounded = false) => ({
    finding: finding(overrides),
    reason: "r",
    unfounded,
  })

  it("holds while a blocking finding is accepted, or rejected and held back", () => {
    expect(holdsBlocking([finding()], [])).toBe(true)
    expect(holdsBlocking([], [rejectedAs({})])).toBe(true)
    expect(holdsBlocking([finding({ severity: "nitpick" })], [rejectedAs({})])).toBe(true)
  })

  it("holds nothing when every finding is a suggestion or a nitpick", () => {
    expect(holdsBlocking([], [])).toBe(false)
    const graded = [finding({ severity: "suggestion" }), finding({ severity: "nitpick" })]
    expect(holdsBlocking(graded, [rejectedAs({ severity: "suggestion" })])).toBe(false)
  })

  it("ignores a rejected blocking finding whose basis is unfounded, since it holds nothing back", () => {
    expect(holdsBlocking([], [rejectedAs({}, true)])).toBe(false)
  })
})

describe("renderReviewBody", () => {
  it("names the blocking findings that couldn't be posted inline, since they hold approval back", () => {
    const body = renderReviewBody(
      "REQUEST_CHANGES",
      [],
      [
        {
          finding: finding({ title: "Total is NaN for an empty cart" }),
          reason: "quote matches 2 lines",
          unfounded: false,
        },
        {
          finding: finding({ severity: "nitpick", title: "Rename b" }),
          reason: "quote matches 2 lines",
          unfounded: false,
        },
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
        {
          finding: finding({ title: "Total is NaN for an empty cart" }),
          reason: "quote matches 2 lines",
          unfounded: false,
        },
        {
          finding: finding({ basis_kind: "standard", basis: "Feature Envy", title: "Move the total into Cart" }),
          reason: BLOCKING_STANDARD_OR_TEST,
          unfounded: true,
        },
      ],
    )
    expect(body).toBe(
      "1 blocking finding(s) couldn't be posted inline and hold approval back:\n- **Total is NaN for an empty cart** in `src/x.ts`",
    )
  })

  it("names a blocking defect finding rejected for its anchor and not a spec finding rejected for want of a linked issue", () => {
    const { rejected } = validateFindings(
      [
        specFinding({ title: "Departs from #7" }),
        finding({ title: "Total is NaN for an empty cart", quote: "const c = 4;" }),
      ],
      commentable,
      false,
    )
    expect(renderReviewBody("REQUEST_CHANGES", [], rejected)).toBe(
      "1 blocking finding(s) couldn't be posted inline and hold approval back:\n- **Total is NaN for an empty cart** in `src/x.ts`",
    )
  })

  it("follows the inline counts with them when other findings were posted", () => {
    const body = renderReviewBody(
      "REQUEST_CHANGES",
      [finding({ severity: "nitpick" })],
      [{ finding: finding({ title: "Total is NaN" }), reason: "r", unfounded: false }],
    )
    expect(body).toBe(
      "1 nitpick(s). Blocking findings are marked 🔴; the others are optional.\n\n1 blocking finding(s) couldn't be posted inline and hold approval back:\n- **Total is NaN** in `src/x.ts`",
    )
  })

  it("lists at most five of them, with titles cut short, so the review body stays within GitHub's limit", () => {
    const rejected = Array.from({ length: 7 }, (_, i) => ({
      finding: finding({ title: `${i}`.repeat(300) }),
      reason: "r",
      unfounded: false,
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
      instructionFiles: [],
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
      instructionFiles: [],
      since: { from: "abc1234567", to: "def5678901", summary: "Fixed the total.", files: ["a.ts"], resolved: 0 },
    })
    expect(text).toContain("⚪ 0 nitpicks\n\n**Merge danger:** two-way door · one module\n\n### Summary")
    expect(text.indexOf("### Since `abc1234`")).toBeLessThan(text.indexOf("<sub>Linked issues: #24</sub>"))
  })

  const summaryWith = (attribution: {
    model?: string
    skillsFingerprint?: string
    repoSkillsFingerprint?: string
    linkedIssues?: number[]
    spend?: ReviewSpend
    budgetNote?: string
    instructionFiles?: string[]
    configError?: string
    verify?: VerifyDisplay
  }) =>
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
      instructionFiles: [],
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
      instructionFiles: [],
    })
    expect(text).toContain("**Merge danger:** one-way door · billing and the invoices table\n\n### Summary")
  })

  it("names the repository's skills after the built-in ones in the skills claim when the review was offered them", () => {
    const text = summaryWith({
      model: "@cf/zai-org/glm-5.3-flash",
      skillsFingerprint: "06bcba08ffffffff",
      repoSkillsFingerprint: "1a2b3c4d5e6f7a8b",
    })
    expect(text).toContain(
      "<sub>Reviewed by `@cf/zai-org/glm-5.3-flash` with skills `review@06bcba08`, `repo@1a2b3c4d`.</sub>\n<sub>",
    )
  })

  it("claims no repository skill when the review was offered none, and no skill at all without the model and the built-in fingerprint", () => {
    const text = summaryWith({ model: "@cf/zai-org/glm-5.3-flash", skillsFingerprint: "06bcba08ffffffff" })
    expect(text).toContain("with skills `review@06bcba08`.</sub>")
    expect(text).not.toContain("repo@")
    expect(summaryWith({ model: "@cf/zai-org/glm-5.3-flash", repoSkillsFingerprint: "1a2b3c4d" })).not.toContain(
      "Reviewed by",
    )
  })

  it("leaves the skills claim out when the build that ran the review recorded no model or fingerprint", () => {
    expect(summaryWith({})).not.toContain("Reviewed by")
    expect(summaryWith({ model: "@cf/openai/gpt-oss-120b" })).not.toContain("Reviewed by")
    expect(summaryWith({})).toContain(
      "even after a retry.</sub>\n\n<sub>Linked issues: none</sub>\n<sub>Standards: none</sub>\n<sub>Commands: `@andabot review`",
    )
  })

  it("names the linked issues the review read on the line after the skills claim", () => {
    const text = summaryWith({
      model: "@cf/openai/gpt-oss-120b",
      skillsFingerprint: "89abcdef01234567",
      linkedIssues: [12, 14],
    })
    expect(text).toContain("`review@89abcdef`.</sub>\n<sub>Linked issues: #12, #14</sub>\n<sub>Standards: none</sub>")
  })

  it("names the standards the review rendered on the line after the linked issues, each in backticks", () => {
    const text = summaryWith({
      linkedIssues: [12],
      instructionFiles: ["CLAUDE.md", ".github/instructions/ts.instructions.md"],
    })
    expect(text).toContain(
      "<sub>Linked issues: #12</sub>\n<sub>Standards: `CLAUDE.md`, `.github/instructions/ts.instructions.md`</sub>\n<sub>Commands:",
    )
  })

  it("says none on the standards line when no standard was rendered", () => {
    expect(summaryWith({ instructionFiles: [] })).toContain(
      "<sub>Linked issues: none</sub>\n<sub>Standards: none</sub>\n<sub>Commands:",
    )
  })

  it("keeps a path instruction's glob literal, since its stars would otherwise render as emphasis", () => {
    expect(summaryWith({ instructionFiles: [".andabot.yaml: **/*.ts", "CLAUDE.md"] })).toContain(
      "<sub>Standards: `.andabot.yaml: **/*.ts`, `CLAUDE.md`</sub>",
    )
  })

  it("wraps a path that holds a backtick in a double-backtick span, so the footer's code span cannot end early", () => {
    expect(summaryWith({ instructionFiles: ["docs/a`b.md", "CLAUDE.md"] })).toContain(
      "<sub>Standards: `` docs/a`b.md ``, `CLAUDE.md`</sub>",
    )
  })

  it("ends with a note naming the error as code under the footer lines when .andabot.yaml was ignored", () => {
    expect(summaryWith({ configError: "/reviews/auto must be boolean" })).toMatch(
      /<sub>Commands: [^\n]*<\/sub>\n\n_\.andabot\.yaml was ignored: `\/reviews\/auto must be boolean`; the defaults applied\._$/,
    )
  })

  it("keeps the stars of an unquoted glob's YAML error literal, since the note's error is code", () => {
    const error = "invalid YAML: Unresolved alias (the anchor must be set before the alias): */*.snap"
    expect(summaryWith({ configError: error })).toContain(
      "\n\n_.andabot.yaml was ignored: `invalid YAML: Unresolved alias (the anchor must be set before the alias): */*.snap`; the defaults applied._",
    )
  })

  it("wraps an error that holds a backtick in a double-backtick span, as the Standards line does", () => {
    expect(summaryWith({ configError: "/reviews/a`b schema is false" })).toContain(
      "_.andabot.yaml was ignored: `` /reviews/a`b schema is false ``; the defaults applied._",
    )
  })

  it("flattens the error's whitespace onto the note's one line, leaving its pipes and markup as written", () => {
    const error = "Error: GitHub 502 : <html>\n  <body>bad\tgateway | retry</body>\r\n</html>\n"
    expect(summaryWith({ configError: error })).toContain(
      "\n\n_.andabot.yaml was ignored: `Error: GitHub 502 : <html> <body>bad gateway | retry</body> </html>`; the defaults applied._",
    )
  })

  it("cuts an error longer than 300 characters to 300 and an ellipsis", () => {
    expect(summaryWith({ configError: "x".repeat(301) })).toContain(
      `_.andabot.yaml was ignored: \`${"x".repeat(300)}…\`; the defaults applied._`,
    )
    expect(summaryWith({ configError: "y".repeat(300) })).toContain(
      `_.andabot.yaml was ignored: \`${"y".repeat(300)}\`; the defaults applied._`,
    )
  })

  it("adds no note when the file was missing or valid", () => {
    const text = summaryWith({})
    expect(text).not.toContain(".andabot.yaml was ignored")
    expect(text).toMatch(/<sub>Commands: [^\n]*<\/sub>$/)
  })

  it("says what the review cost on the line after the skills claim", () => {
    const text = summaryWith({
      model: "@cf/zai-org/glm-5.3-flash",
      skillsFingerprint: "89abcdef01234567",
      spend: [
        {
          model: "cloudflare/@cf/zai-org/glm-5.3-flash",
          calls: 3,
          inputTokens: 61_204,
          cachedTokens: 40_000,
          outputTokens: 4_811,
          usd: 0.006692,
          priced: true,
        },
      ],
    })
    expect(text).toContain(
      "`review@89abcdef`.</sub>\n<sub>3 model calls · 61k in / 4.8k out tokens · ≈ 608 neurons ($0.007)</sub>\n<sub>Linked issues: none</sub>",
    )
  })

  it("leaves the cost line out when the review recorded no spend", () => {
    const text = summaryWith({ model: "@cf/zai-org/glm-5.3-flash", skillsFingerprint: "89abcdef01234567", spend: [] })
    expect(text).toContain("`review@89abcdef`.</sub>\n<sub>Linked issues: none</sub>")
  })

  it("says the review stopped reading early on the line after the cost line", () => {
    const text = summaryWith({
      model: "@cf/zai-org/glm-5.3-flash",
      skillsFingerprint: "89abcdef01234567",
      spend: [
        {
          model: "cloudflare/@cf/zai-org/glm-5.3-flash",
          calls: 3,
          inputTokens: 61_204,
          cachedTokens: 40_000,
          outputTokens: 4_811,
          usd: 0.006692,
          priced: true,
        },
      ],
      budgetNote: budgetNote(10_000),
    })
    expect(text).toContain(
      "≈ 608 neurons ($0.007)</sub>\n_This review stopped reading early: it spent its budget of 10,000 neurons._\n<sub>Linked issues: none</sub>",
    )
  })

  it("puts the budget note after the skills claim when the review recorded no spend", () => {
    const text = summaryWith({
      model: "@cf/zai-org/glm-5.3-flash",
      skillsFingerprint: "89abcdef01234567",
      budgetNote: budgetNote(10_000),
    })
    expect(text).toContain(
      "`review@89abcdef`.</sub>\n_This review stopped reading early: it spent its budget of 10,000 neurons._\n<sub>Linked issues: none</sub>",
    )
  })

  it("adds no budget note when the review stayed within its budget", () => {
    expect(summaryWith({})).not.toContain("stopped reading early")
  })

  describe("when verify ran", () => {
    const REVIEW_MODEL = "@cf/zai-org/glm-5.3-flash"
    const VERIFY_MODEL = "@cf/moonshotai/kimi-k2.7-code"
    const attributed = { model: REVIEW_MODEL, skillsFingerprint: "89abcdef01234567" }

    const verified = (parts: Partial<VerifyReport> = {}, leftOut: FindingInput[] = []): VerifyDisplay => ({
      kind: "verified",
      model: VERIFY_MODEL,
      report: { dropped: [], changed: [], capped: [], notJudged: [], unknown: [], ...parts },
      leftOut,
    })

    const unverified = (reason: string): VerifyDisplay => ({ kind: "unverified", model: VERIFY_MODEL, reason })

    const demotion = (original: FindingInput, to: FindingInput["severity"], reason: string): Changed => ({
      finding: original,
      reason,
      from: original.severity,
      to,
      revised: finding({ ...original, severity: to }),
    })

    it("lists a drop, a severity change and an unjudged finding in a collapsed Verify section", () => {
      const text = summaryWith({
        verify: verified({
          dropped: [
            {
              finding: finding({ path: "src/a.ts", line: 10, title: "Wrong total" }),
              reason: "the guard on line 9 covers it",
            },
          ],
          changed: [
            demotion(
              finding({ path: "src/b.ts", line: 20, title: "Stale cache" }),
              "suggestion",
              "the cache is rebuilt on the next call",
            ),
          ],
          notJudged: [finding({ path: "src/c.ts", line: 30, title: "Odd name", severity: "suggestion" })],
        }),
      })
      expect(text).toContain(
        [
          "<details><summary>Verify: 1 dropped, 1 severity changed, 1 not judged</summary>",
          "",
          "- Dropped `src/a.ts:10` Wrong total: the guard on line 9 covers it",
          "- `src/b.ts:20` Stale cache: blocking → suggestion: the cache is rebuilt on the next call",
          "- Not judged: `src/c.ts:30` Odd name",
          "",
          "</details>",
        ].join("\n"),
      )
    })

    it("puts the section after the dropped line and before the since section, a blank line from each", () => {
      const text = renderSummaryComment({
        botLogin: "andabot",
        headSha: "def5678901",
        event: "COMMENT",
        submission: { ...base, summary: "The whole PR.", verdict: "comment" },
        accepted: [],
        droppedCount: 2,
        linkedIssues: [],
        instructionFiles: [],
        since: { from: "abc1234567", to: "def5678901", summary: "Fixed the total.", files: ["a.ts"], resolved: 0 },
        verify: verified({ notJudged: [finding({ title: "Odd name" })] }),
      })
      expect(text).toContain(
        "even after a retry.</sub>\n\n<details><summary>Verify: 1 not judged</summary>\n\n- Not judged: `src/x.ts:2` Odd name\n\n</details>\n\n### Since `abc1234`",
      )
    })

    it("puts the section a blank line above the footer when the review has no since section", () => {
      const text = summaryWith({ ...attributed, verify: verified({ notJudged: [finding()] }) })
      expect(text).toContain("\n\n</details>\n\n<sub>Reviewed by `@cf/zai-org/glm-5.3-flash`")
    })

    it("leaves the section out when verify dropped, changed and skipped nothing, even if it capped a promotion or named an unknown id", () => {
      const capped = [{ finding: finding({ severity: "nitpick" }), reason: "a promotion past the cap" }]
      for (const verify of [verified(), verified({ capped, unknown: ["F9"] })]) {
        expect(summaryWith({ ...attributed, verify })).not.toContain("<details>")
      }
    })

    it("doesn't list a capped promotion or an unknown id in a section that other entries open", () => {
      const text = summaryWith({
        verify: verified({
          dropped: [{ finding: finding({ title: "Wrong total" }), reason: "covered" }],
          capped: [{ finding: finding({ title: "Capped title" }), reason: "capped reason" }],
          unknown: ["F9"],
        }),
      })
      expect(text).toContain("<summary>Verify: 1 dropped</summary>")
      expect(text).not.toContain("Capped title")
      expect(text).not.toContain("capped reason")
      expect(text).not.toContain("F9")
    })

    it("names only the parts of the summary line that are above zero", () => {
      const dropped = { finding: finding(), reason: "r" }
      const changed = demotion(finding(), "suggestion", "r")
      const summaryOf = (parts: Partial<VerifyReport>) => summaryWith({ verify: verified(parts) })
      expect(summaryOf({ notJudged: [finding()] })).toContain("<summary>Verify: 1 not judged</summary>")
      expect(summaryOf({ dropped: [dropped, dropped] })).toContain("<summary>Verify: 2 dropped</summary>")
      expect(summaryOf({ changed: [changed] })).toContain("<summary>Verify: 1 severity changed</summary>")
      expect(summaryOf({ dropped: [dropped], notJudged: [finding()] })).toContain(
        "<summary>Verify: 1 dropped, 1 not judged</summary>",
      )
    })

    it("says a demotion left the finding out, matching it by object identity, and shows the other changes as they are", () => {
      const left = demotion(finding({ path: "src/a.ts", line: 4, title: "Odd branch" }), "nitpick", "a style point")
      const stays = demotion(finding({ path: "src/b.ts", line: 8, title: "Slow loop" }), "suggestion", "not a defect")
      const text = summaryWith({
        verify: verified({ changed: [left, stays] }, [left.revised, { ...stays.revised }]),
      })
      expect(text).toContain("<summary>Verify: 2 severity changed</summary>")
      expect(text).toContain(
        "- `src/a.ts:4` Odd branch: blocking → nitpick, left out: a style point\n- `src/b.ts:8` Slow loop: blocking → suggestion: not a defect\n",
      )
    })

    it("flattens a title and a reason onto the entry's line and escapes their pipes", () => {
      const text = summaryWith({
        verify: verified({ dropped: [{ finding: finding({ title: "a | b\nc" }), reason: "it is\n  fine | really" }] }),
      })
      expect(text).toContain("\n- Dropped `src/x.ts:2` a \\| b c: it is fine \\| really\n")
    })

    it("wraps a location that holds a backtick in a double-backtick span, so the entry's code span cannot end early", () => {
      const text = summaryWith({ verify: verified({ notJudged: [finding({ path: "docs/a`b.md", line: 3 })] }) })
      expect(text).toContain("\n- Not judged: `` docs/a`b.md:3 `` b changed\n")
    })

    it("names both models in the reviewed-by line when verified, before the skills", () => {
      expect(summaryWith({ ...attributed, verify: verified() })).toContain(
        "<sub>Reviewed by `@cf/zai-org/glm-5.3-flash` · verified by `@cf/moonshotai/kimi-k2.7-code` with skills `review@89abcdef`.</sub>\n<sub>Linked issues: none</sub>",
      )
      expect(summaryWith({ ...attributed, repoSkillsFingerprint: "1a2b3c4d5e6f7a8b", verify: verified() })).toContain(
        "verified by `@cf/moonshotai/kimi-k2.7-code` with skills `review@89abcdef`, `repo@1a2b3c4d`.</sub>",
      )
    })

    it("leaves the verified claim out with the reviewed-by line when the build recorded no model or fingerprint", () => {
      const text = summaryWith({ verify: verified() })
      expect(text).not.toContain("Reviewed by")
      expect(text).not.toContain("verified by")
    })

    it("adds the unverified line after the reviewed-by line, and no section", () => {
      const text = summaryWith({ ...attributed, verify: unverified("no_model") })
      expect(text).toContain(
        "<sub>Reviewed by `@cf/zai-org/glm-5.3-flash` with skills `review@89abcdef`.</sub>\n<sub>Not verified by `@cf/moonshotai/kimi-k2.7-code`: no_model.</sub>\n<sub>Linked issues: none</sub>",
      )
      expect(text).not.toContain("· verified by")
      expect(text).not.toContain("<details>")
    })

    it("flattens the unverified reason onto one line and cuts one longer than 200 characters to 200 and an ellipsis", () => {
      expect(summaryWith({ verify: unverified("the model\n  did not\tanswer") })).toContain(
        "<sub>Not verified by `@cf/moonshotai/kimi-k2.7-code`: the model did not answer.</sub>",
      )
      expect(summaryWith({ verify: unverified("x".repeat(201)) })).toContain(`: ${"x".repeat(200)}….</sub>`)
      expect(summaryWith({ verify: unverified("y".repeat(200)) })).toContain(`: ${"y".repeat(200)}.</sub>`)
    })

    it("orders the footer as reviewed-by with the verifier, the unverified line, the cost line, then the budget note", () => {
      const spent = {
        ...attributed,
        spend: [
          {
            model: "cloudflare/@cf/zai-org/glm-5.3-flash",
            calls: 3,
            inputTokens: 61_204,
            cachedTokens: 40_000,
            outputTokens: 4_811,
            usd: 0.006692,
            priced: true,
          },
        ],
        budgetNote: budgetNote(10_000),
      }
      const cost = "<sub>3 model calls · 61k in / 4.8k out tokens · ≈ 608 neurons ($0.007)</sub>"
      const note = "_This review stopped reading early: it spent its budget of 10,000 neurons._"
      expect(summaryWith({ ...spent, verify: verified() })).toContain(
        [
          "<sub>Reviewed by `@cf/zai-org/glm-5.3-flash` · verified by `@cf/moonshotai/kimi-k2.7-code` with skills `review@89abcdef`.</sub>",
          cost,
          note,
          "<sub>Linked issues: none</sub>",
        ].join("\n"),
      )
      expect(summaryWith({ ...spent, verify: unverified("the review spent its budget") })).toContain(
        [
          "<sub>Reviewed by `@cf/zai-org/glm-5.3-flash` with skills `review@89abcdef`.</sub>",
          "<sub>Not verified by `@cf/moonshotai/kimi-k2.7-code`: the review spent its budget.</sub>",
          cost,
          note,
          "<sub>Linked issues: none</sub>",
        ].join("\n"),
      )
    })
  })

  it("shows the wait as the verdict", () => {
    const text = renderSummaryComment({
      botLogin: "andabot",
      headSha: "0123456789abcdef",
      event: "AWAITING_CHECKS",
      submission: base,
      accepted: [],
      droppedCount: 0,
      linkedIssues: [],
      instructionFiles: [],
    })
    expect(text).toContain("`0123456` · **Verdict:** Approval waits for the checks · 🔴 0 blocking")
  })
})

describe("renderReviewBody when approval waits for the checks", () => {
  it("says a clean review approves once the checks pass", () => {
    expect(renderReviewBody("AWAITING_CHECKS", [], [])).toBe(
      "No findings. The change looks sound to me; I'll approve once the head's checks pass, and a human review is still required to merge.",
    )
  })

  it("keeps the findings line and adds the wait", () => {
    expect(renderReviewBody("AWAITING_CHECKS", [finding({ severity: "suggestion" })], [])).toBe(
      "1 suggestion(s). Blocking findings are marked 🔴; the others are optional. I'll approve once the head's checks pass.",
    )
  })
})

describe("withApprovedVerdict", () => {
  const requested = renderSummaryComment({
    botLogin: "andabot",
    headSha: "0123456789abcdef",
    event: "REQUEST_CHANGES",
    submission: { ...base, verdict: "request_changes" },
    accepted: [finding()],
    droppedCount: 0,
    linkedIssues: [],
    instructionFiles: [],
  })

  it("rewrites a request for changes as the approval of its head and keeps the rest of the line", () => {
    const rewritten = withApprovedVerdict(requested, "def5678901")
    expect(rewritten).toContain("`0123456` · **Verdict:** Approved at `def5678` · 🔴 1 blocking · 🟡 0 suggestions")
    expect(rewritten?.replace("Approved at `def5678`", "Changes requested")).toBe(requested)
  })

  it("replaces an earlier approval's verdict", () => {
    const twice = withApprovedVerdict(withApprovedVerdict(requested, "def5678901") ?? "", "fedcba9876")
    expect(twice).toContain("**Verdict:** Approved at `fedcba9` · 🔴 1 blocking")
    expect(twice).not.toContain("def5678")
  })

  it("leaves an unposted review's summary alone", () => {
    const unposted = renderUnpostedSummary({
      botLogin: "andabot",
      headSha: "0123456789abcdef",
      note: "_The review did not complete._",
    })
    expect(withApprovedVerdict(unposted, "def5678901")).toBeUndefined()
  })

  it("leaves a comment that isn't the summary alone", () => {
    expect(withApprovedVerdict("**Verdict:** Changes requested", "def5678901")).toBeUndefined()
  })
})

describe("approvalBody", () => {
  it("names the approved head and why it was approved", () => {
    expect(approvalBody("def5678abcdef")).toBe(
      "Approved at `def5678`: none of my blocking threads is open, and the checks pass. A human review is still required to merge.",
    )
  })
})

describe("reviewEventOf", () => {
  it("posts a wait for the checks as a comment and every other verdict as itself", () => {
    expect(reviewEventOf("AWAITING_CHECKS")).toBe("COMMENT")
    expect(reviewEventOf("APPROVE")).toBe("APPROVE")
    expect(reviewEventOf("REQUEST_CHANGES")).toBe("REQUEST_CHANGES")
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
