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
    severity: "blocking",
    title: "b changed",
    body: "Why did b change?",
    ...overrides,
  }
}

describe("validateFindings", () => {
  it("accepts a finding on an added line and one on a deleted line", () => {
    const result = validateFindings([finding(), finding({ line: 2, side: "LEFT", title: "removed" })], commentable)
    expect(result.accepted).toHaveLength(2)
    expect(result.rejected).toHaveLength(0)
  })

  it("rejects unknown paths, lines outside the diff, bad ranges and left-side suggestions", () => {
    const result = validateFindings(
      [
        finding({ path: "src/other.ts" }),
        finding({ line: 40 }),
        finding({ line: 3, start_line: 4 }),
        finding({ line: 2, side: "LEFT", suggestion: "x" }),
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

  it("drops duplicates on one anchor and caps the count", () => {
    const many = Array.from({ length: MAX_FINDINGS + 2 }, (_, i) => finding({ line: (i % 3) + 1, title: `t${i}` }))
    const result = validateFindings(many, commentable)
    expect(result.accepted).toHaveLength(3)
    expect(result.rejected.every((r) => r.reason.startsWith("duplicate anchor"))).toBe(true)
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
    expect(chooseReviewEvent(submission, [finding()], true)).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent(submission, [finding({ severity: "nitpick" })], true)).toBe("APPROVE")
    expect(chooseReviewEvent({ ...submission, verdict: "comment" }, [], true)).toBe("COMMENT")
    expect(chooseReviewEvent(submission, [finding()], false)).toBe("COMMENT")
  })
})

describe("renderSummaryComment", () => {
  it("starts with the marker and shows counts, summary and walkthrough", () => {
    const text = renderSummaryComment({
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
    })
    expect(text.startsWith(SUMMARY_MARKER)).toBe(true)
    expect(text).toContain("`0123456` · **Verdict:** Changes requested · 🔴 1 blocking")
    expect(text).toContain("| `src/x.ts` | b is \\| now 3 |")
    expect(text).toContain("1 finding(s) were dropped")
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
    const note = renderUnpostedNote({ kind: "prose", text: "The change looks sound." }, undefined)
    expect(note).toContain("couldn't be posted")
    expect(note).toContain("The change looks sound.")
  })

  it("shows nothing the model wrote unless it was prose, so its JSON stays in the log", () => {
    const submission = { summary: "Changes b.", walkthrough: [], findings: [], verdict: "approve" as const }
    expect(renderUnpostedNote({ kind: "submission", submission }, undefined)).not.toContain("Changes b.")
    expect(
      renderUnpostedNote({ kind: "unfit", problem: "/verdict: must be equal to constant" }, undefined),
    ).not.toContain("/verdict")
  })

  it("gives the reason asking again failed", () => {
    expect(renderUnpostedNote({ kind: "prose", text: "" }, "model_error: quota")).toContain("model_error: quota")
  })
})
