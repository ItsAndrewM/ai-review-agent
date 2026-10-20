import { describe, expect, it } from "vitest"
import {
  checkRunTitle,
  failedCheckRun,
  isoSeconds,
  MAX_CHECK_SUMMARY_CHARS,
  postedCheckRun,
  postedEarlierCheckRun,
  replacedCheckRun,
  startedCheckRun,
  summaryCommentLink,
  supersededCheckRun,
  unchangedCheckRun,
} from "../src/review/check.ts"
import { countBySeverity, type FindingInput } from "../src/review/findings.ts"

describe("unchangedCheckRun", () => {
  it("completes the run as success when a push added no line to the diff and touched no open thread", () => {
    const update = unchangedCheckRun("abc1234567", Date.UTC(2026, 9, 19, 14, 0, 0, 500))
    expect(update.conclusion).toBe("success")
    expect(update.completed_at).toBe("2026-10-19T14:00:00Z")
    expect(update.output.title).toBe("No changes to review since `abc1234`")
    expect(update.output.summary).toBe(
      "The commits since `abc1234` add no line to the pull request's diff and touch none of its open threads, so there was nothing new to review.",
    )
  })
})

function finding(severity: FindingInput["severity"]): FindingInput {
  return { path: "src/x.ts", line: 1, quote: "q", basis_kind: "defect", basis: "x", severity, title: "t", body: "b" }
}

const at = Date.UTC(2026, 9, 17, 20, 36, 38, 123)

describe("checkRunTitle", () => {
  it("is the verdict label alone when there are no findings", () => {
    expect(checkRunTitle("APPROVE", countOf([]))).toBe("Approved")
    expect(checkRunTitle("COMMENT", countOf([]))).toBe("Commented")
  })

  it("appends the non-zero counts, singular and plural, blocking first", () => {
    expect(checkRunTitle("APPROVE", countOf(["suggestion", "suggestion"]))).toBe("Approved: 2 suggestions")
    expect(checkRunTitle("REQUEST_CHANGES", countOf(["suggestion", "blocking", "suggestion"]))).toBe(
      "Changes requested: 1 blocking, 2 suggestions",
    )
    expect(checkRunTitle("COMMENT", countOf(["nitpick"]))).toBe("Commented: 1 nitpick")
    expect(checkRunTitle("REQUEST_CHANGES", countOf(["blocking", "blocking", "nitpick"]))).toBe(
      "Changes requested: 2 blocking, 1 nitpick",
    )
  })
})

function countOf(severities: FindingInput["severity"][]) {
  return countBySeverity(severities.map(finding))
}

describe("postedEarlierCheckRun", () => {
  it("titles the run with the verdict and counts of the review an earlier run of the head posted", () => {
    const posted = { reviewId: 9, event: "REQUEST_CHANGES" as const, counts: countOf(["blocking", "suggestion"]) }
    expect(postedEarlierCheckRun(posted, "https://github.com/o/r/pull/5#issuecomment-1", at)).toEqual({
      conclusion: "success",
      completed_at: "2026-10-17T20:36:38Z",
      details_url: "https://github.com/o/r/pull/5#issuecomment-1",
      output: {
        title: "Changes requested: 1 blocking, 1 suggestion",
        summary: "Review 9 was posted by an earlier run of this head. Details opens its summary comment.",
      },
    })
  })

  it("titles the run with the verdict alone for a record from before reviews stored their counts", () => {
    expect(postedEarlierCheckRun({ reviewId: 9, event: "APPROVE" }, undefined, at).output.title).toBe("Approved")
  })
})

describe("isoSeconds", () => {
  it("formats without milliseconds", () => {
    expect(isoSeconds(at)).toBe("2026-10-17T20:36:38Z")
  })
})

describe("startedCheckRun", () => {
  it("is an in-progress run named after the bot, keyed by the delivery id", () => {
    const run = startedCheckRun({
      name: "andabot",
      headSha: "4c916fb1209598355958a2b9a6e172ad8293046b",
      deliveryId: "d-1",
      fileCount: 63,
      model: "@cf/openai/gpt-oss-120b",
      startedAt: at,
    })
    expect(run).toEqual({
      name: "andabot",
      head_sha: "4c916fb1209598355958a2b9a6e172ad8293046b",
      status: "in_progress",
      external_id: "d-1",
      started_at: "2026-10-17T20:36:38Z",
      output: {
        title: "Review in progress",
        summary: "Reviewing 63 files at `4c916fb` with `@cf/openai/gpt-oss-120b`.",
      },
    })
  })

  it("counts one file in the singular", () => {
    const run = startedCheckRun({
      name: "andabot",
      headSha: "abcdef0",
      deliveryId: "d",
      fileCount: 1,
      model: "m",
      startedAt: at,
    })
    expect(run.output.summary).toBe("Reviewing 1 file at `abcdef0` with `m`.")
  })
})

describe("postedCheckRun", () => {
  it("completes with success, the verdict title, the summary and the comment as details", () => {
    const update = postedCheckRun(
      "REQUEST_CHANGES",
      [finding("blocking")],
      "## andabot review",
      "https://github.com/o/r/pull/5#issuecomment-1",
      at,
    )
    expect(update).toEqual({
      conclusion: "success",
      completed_at: "2026-10-17T20:36:38Z",
      details_url: "https://github.com/o/r/pull/5#issuecomment-1",
      output: { title: "Changes requested: 1 blocking", summary: "## andabot review" },
    })
  })

  it("truncates the summary to GitHub's cap", () => {
    const update = postedCheckRun("APPROVE", [], "x".repeat(MAX_CHECK_SUMMARY_CHARS + 10), "https://example.test", at)
    expect(update.output.summary).toHaveLength(MAX_CHECK_SUMMARY_CHARS)
    expect(update.output.summary.endsWith("…")).toBe(true)
  })

  it("drops an emoji the cut would split rather than keep half of it", () => {
    const summary = `${"x".repeat(MAX_CHECK_SUMMARY_CHARS - 2)}😀 and more text`
    const update = postedCheckRun("APPROVE", [], summary, "https://example.test", at)
    expect(update.output.summary).toHaveLength(MAX_CHECK_SUMMARY_CHARS - 1)
    expect(update.output.summary.endsWith("x…")).toBe(true)
    expect(JSON.stringify(update.output.summary)).not.toContain("\\ud83d")
  })
})

describe("failedCheckRun", () => {
  it("completes with failure and the reason, with details only when there is a comment", () => {
    expect(failedCheckRun("timeout: the model did not answer", undefined, at)).toEqual({
      conclusion: "failure",
      completed_at: "2026-10-17T20:36:38Z",
      output: { title: "Review did not complete", summary: "timeout: the model did not answer" },
    })
    expect(failedCheckRun("x", "https://example.test", at).details_url).toBe("https://example.test")
  })
})

describe("supersededCheckRun", () => {
  it("completes as cancelled, naming the new head", () => {
    expect(supersededCheckRun("def5678abcdef", at)).toEqual({
      conclusion: "cancelled",
      completed_at: "2026-10-17T20:36:38Z",
      output: { title: "Superseded by def5678", summary: "A newer head, `def5678`, is being reviewed instead." },
    })
  })
})

describe("replacedCheckRun", () => {
  it("completes as cancelled without naming a head, since the newer review is of the same one", () => {
    expect(replacedCheckRun(at)).toEqual({
      conclusion: "cancelled",
      completed_at: "2026-10-17T20:36:38Z",
      output: { title: "Replaced by a newer review", summary: "A newer review of this head replaced this run." },
    })
  })
})

describe("summaryCommentLink", () => {
  it("links the comment on the pull request", () => {
    expect(summaryCommentLink({ owner: "ItsAndrewM", repo: "ai-review-agent" }, 5, 6240627672)).toBe(
      "https://github.com/ItsAndrewM/ai-review-agent/pull/5#issuecomment-6240627672",
    )
  })
})
