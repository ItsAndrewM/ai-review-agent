import { describe, expect, it } from "vitest"
import { commentableLines } from "../src/github/diff.ts"
import {
  MAX_FINDINGS,
  parseWrittenReview,
  toReviewComment,
  validateFindings,
  type FindingInput,
  type ReviewSubmissionInput,
} from "../src/review/findings.ts"
import {
  chooseReviewEvent,
  renderReviewBody,
  renderSummaryComment,
  renderUnpostedNote,
  renderUnpostedSummary,
  SUMMARY_MARKER,
} from "../src/review/render.ts"

const patch = ["@@ -1,3 +1,3 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", " export { a, b };"].join("\n")
const commentable = new Map([["src/x.ts", commentableLines(patch)]])

function finding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    path: "src/x.ts",
    line: 2,
    quote: "const b = 3;",
    severity: "blocking",
    title: "b changed",
    body: "Why did b change?",
    ...overrides,
  }
}

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
      "quote does not match line 2 (RIGHT) and no other line in src/x.ts matches",
      "quote matches 2 lines in src/twice.ts; anchor the right one",
    ])
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

describe("parseWrittenReview", () => {
  const submitted = {
    summary: "Changes b from 2 to 3.",
    walkthrough: [{ path: "src/x.ts", summary: "b is now 3." }],
    findings: [finding({ severity: "suggestion", body: "Name it:\n```ts\nconst three = 3\n```" })],
    verdict: "comment",
  } satisfies ReviewSubmissionInput
  const submittedJson = JSON.stringify(submitted, null, 2)

  it("takes a submission written as bare JSON, as gpt-oss-120b wrote its review of #5", () => {
    expect(parseWrittenReview(submittedJson)).toEqual({ kind: "submission", submission: submitted })
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
    const shell = { summary: "Review submitted.", walkthrough: [], findings: [], verdict: "approve" }
    expect(parseWrittenReview(JSON.stringify(shell))).toEqual({
      kind: "unfit",
      problem: expect.stringContaining("/walkthrough"),
    })
  })

  it("holds back JSON the output limit cut off, rather than taking it for prose", () => {
    expect(parseWrittenReview(`Review:\n${submittedJson.slice(0, 200)}`)).toMatchObject({ kind: "unfit" })
  })
})

describe("toReviewComment", () => {
  it("formats severity, title, body and a suggestion block with a range", () => {
    const comment = toReviewComment(finding({ start_line: 1, line: 2, suggestion: "const b = 4;\n" }))
    expect(comment).toMatchObject({ path: "src/x.ts", line: 2, side: "RIGHT", start_line: 1, start_side: "RIGHT" })
    expect(comment.body).toBe("**🔴 Blocking: b changed**\n\nWhy did b change?\n\n```suggestion\nconst b = 4;\n```")
  })
})

describe("chooseReviewEvent", () => {
  const submission = { summary: "s", walkthrough: [], findings: [], verdict: "approve" as const }
  it("requests changes on a blocking finding, approves a clean approve verdict, else comments", () => {
    expect(chooseReviewEvent(submission, [finding()], [], true)).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent(submission, [finding({ severity: "nitpick" })], [], true)).toBe("APPROVE")
    expect(chooseReviewEvent({ ...submission, verdict: "comment" }, [], [], true)).toBe("COMMENT")
    expect(chooseReviewEvent(submission, [finding()], [], false)).toBe("COMMENT")
  })

  it("never approves while a blocking finding stands rejected, so a mis-anchored one still blocks", () => {
    expect(chooseReviewEvent(submission, [], [{ finding: finding(), reason: "r" }], true)).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent(submission, [], [{ finding: finding({ severity: "nitpick" }), reason: "r" }], true)).toBe(
      "APPROVE",
    )
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

describe("renderSummaryComment", () => {
  const summaryWith = (attribution: { model?: string; skillsFingerprint?: string }) =>
    renderSummaryComment({
      botLogin: "andabot",
      headSha: "0123456789abcdef",
      event: "REQUEST_CHANGES",
      submission: {
        summary: "Changes b.",
        walkthrough: [{ path: "src/x.ts", summary: "b is | now 3" }],
        findings: [],
        verdict: "request_changes",
      },
      accepted: [finding()],
      droppedCount: 1,
      ...attribution,
    })

  it("starts with the marker and shows counts, summary and walkthrough", () => {
    const text = summaryWith({ model: "@cf/openai/gpt-oss-120b", skillsFingerprint: "89abcdef01234567" })
    expect(text.startsWith(SUMMARY_MARKER)).toBe(true)
    expect(text).toContain("`0123456` · **Verdict:** Changes requested · 🔴 1 blocking")
    expect(text).toContain("| `src/x.ts` | b is \\| now 3 |")
    expect(text).toContain("1 finding(s) were dropped")
    expect(text).toContain("<sub>Reviewed by `@cf/openai/gpt-oss-120b` with skills `review@89abcdef`.</sub>")
  })

  it("leaves the skills claim out when the build that ran the review recorded no model or fingerprint", () => {
    expect(summaryWith({})).not.toContain("Reviewed by")
    expect(summaryWith({ model: "@cf/openai/gpt-oss-120b" })).not.toContain("Reviewed by")
    expect(summaryWith({})).toContain("even after a retry.</sub>\n\n<sub>Commands: `@andabot review`")
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
    const submission = { summary: "Changes b.", walkthrough: [], findings: [], verdict: "approve" as const }
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
