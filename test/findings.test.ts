import { describe, expect, it } from "vitest";
import { commentableLines } from "../src/github/diff.ts";
import { MAX_FINDINGS, toReviewComment, validateFindings, type FindingInput } from "../src/review/findings.ts";
import { chooseReviewEvent, renderSummaryComment, SUMMARY_MARKER } from "../src/review/render.ts";

const patch = ["@@ -1,3 +1,3 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", " export { a, b };"].join("\n");
const commentable = new Map([["src/x.ts", commentableLines(patch)]]);

function finding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    path: "src/x.ts",
    line: 2,
    severity: "blocking",
    title: "b changed",
    body: "Why did b change?",
    ...overrides
  };
}

describe("validateFindings", () => {
  it("accepts a finding on an added line and one on a deleted line", () => {
    const result = validateFindings([finding(), finding({ line: 2, side: "LEFT", title: "removed" })], commentable);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects unknown paths, lines outside the diff, bad ranges and left-side suggestions", () => {
    const result = validateFindings(
      [
        finding({ path: "src/other.ts" }),
        finding({ line: 40 }),
        finding({ line: 3, start_line: 4 }),
        finding({ line: 2, side: "LEFT", suggestion: "x" }),
        finding({ title: "   " })
      ],
      commentable
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'path "src/other.ts" is not a changed file',
      "line 40 (RIGHT) is not in the diff of src/x.ts",
      "start_line must be before line",
      "a suggestion needs the RIGHT side",
      "title and body are required"
    ]);
  });

  it("drops duplicates on one anchor and caps the count", () => {
    const many = Array.from({ length: MAX_FINDINGS + 2 }, (_, i) => finding({ line: (i % 3) + 1, title: `t${i}` }));
    const result = validateFindings(many, commentable);
    expect(result.accepted).toHaveLength(3);
    expect(result.rejected.every((r) => r.reason.startsWith("duplicate anchor"))).toBe(true);
  });
});

describe("toReviewComment", () => {
  it("formats severity, title, body and a suggestion block with a range", () => {
    const comment = toReviewComment(finding({ start_line: 1, line: 2, suggestion: "const b = 4;\n" }));
    expect(comment).toMatchObject({ path: "src/x.ts", line: 2, side: "RIGHT", start_line: 1, start_side: "RIGHT" });
    expect(comment.body).toBe("**🔴 Blocking: b changed**\n\nWhy did b change?\n\n```suggestion\nconst b = 4;\n```");
  });
});

describe("chooseReviewEvent", () => {
  const submission = { summary: "s", walkthrough: [], findings: [], verdict: "approve" as const };
  it("requests changes on a blocking finding, approves a clean approve verdict, else comments", () => {
    expect(chooseReviewEvent(submission, [finding()], true)).toBe("REQUEST_CHANGES");
    expect(chooseReviewEvent(submission, [finding({ severity: "nitpick" })], true)).toBe("APPROVE");
    expect(chooseReviewEvent({ ...submission, verdict: "comment" }, [], true)).toBe("COMMENT");
    expect(chooseReviewEvent(submission, [finding()], false)).toBe("COMMENT");
  });
});

describe("renderSummaryComment", () => {
  it("starts with the marker and shows counts, summary and walkthrough", () => {
    const text = renderSummaryComment({
      botLogin: "andabot",
      headSha: "0123456789abcdef",
      event: "REQUEST_CHANGES",
      submission: { summary: "Changes b.", walkthrough: [{ path: "src/x.ts", summary: "b is | now 3" }], findings: [], verdict: "request_changes" },
      accepted: [finding()],
      droppedCount: 1
    });
    expect(text.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(text).toContain("`0123456` · **Verdict:** Changes requested · 🔴 1 blocking");
    expect(text).toContain("| `src/x.ts` | b is \\| now 3 |");
    expect(text).toContain("1 finding(s) were dropped");
  });
});
