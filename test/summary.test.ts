import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import type { ChangedFile } from "../src/github/diff.ts"
import { approvalRecord, type LastReview } from "../src/review/approval.ts"
import type { SummarySubmissionInput } from "../src/review/findings.ts"
import { GRACE_MS } from "../src/review/flight.ts"
import type { ReviewedRecord } from "../src/review/incremental.ts"
import { renderSummaryRun, SUMMARY_MARKER, withApprovedVerdict, type SummaryRunInput } from "../src/review/render.ts"
import {
  oneClause,
  parseWrittenSummary,
  recordedVerdict,
  Summarizing,
  summarizedRecord,
  summaryLive,
  summaryReply,
} from "../src/review/summary.ts"

const answer = {
  summary: "Changes b from 2 to 3.",
  walkthrough: [{ path: "src/x.ts", summary: "b is now 3." }],
  merge_danger: { door: "two-way", blast_radius: "one module" },
} satisfies SummarySubmissionInput

const answerJson = JSON.stringify(answer, null, 2)

describe("parseWrittenSummary", () => {
  it("reads a summary written as JSON, bare, in a json fence or after prose", () => {
    const written = { kind: "summary", summary: answer }
    expect(parseWrittenSummary(answerJson)).toEqual(written)
    expect(parseWrittenSummary(`\`\`\`json\n${answerJson}\n\`\`\``)).toEqual(written)
    expect(parseWrittenSummary(`Here is the summary.\n\n${answerJson}\n\nThat's all.`)).toEqual(written)
  })

  it("takes a summary that carries no findings and no verdict", () => {
    const bare = {
      summary: "Changes b.",
      walkthrough: [{ path: "src/x.ts", summary: "b is now 3." }],
      merge_danger: { door: "one-way", blast_radius: "billing" },
    }
    expect(parseWrittenSummary(JSON.stringify(bare))).toEqual({ kind: "summary", summary: bare })
  })

  it("calls an answer with no JSON, broken JSON, or no walkthrough row unusable", () => {
    expect(parseWrittenSummary("The change looks sound.")).toEqual({
      kind: "unusable",
      reason: "the model didn't answer with a summary",
    })
    expect(parseWrittenSummary(answerJson.slice(0, 40))).toEqual({
      kind: "unusable",
      reason: "the model's answer wasn't valid JSON",
    })
    expect(parseWrittenSummary(JSON.stringify({ ...answer, walkthrough: [] }))).toEqual({
      kind: "unusable",
      reason: expect.stringMatching(/^the model's answer didn't fit: \/walkthrough: /),
    })
  })

  it("calls an answer without a merge danger unusable", () => {
    expect(parseWrittenSummary(JSON.stringify({ ...answer, merge_danger: undefined }))).toEqual({
      kind: "unusable",
      reason: expect.stringMatching(/^the model's answer didn't fit: \/: .*merge_danger/),
    })
  })
})

describe("summarizedRecord", () => {
  const changed = (filename: string): ChangedFile => ({ filename, status: "modified", additions: 1, deletions: 0 })
  const files = [changed("a.ts"), changed("b.ts")]
  const reviewed = {
    headSha: "abc",
    baseRef: "main",
    at: 5,
    mode: "incremental",
    summary: "old",
    walkthrough: [
      { path: "a.ts", summary: "old a" },
      { path: "b.ts", summary: "old b" },
      { path: "gone.ts", summary: "old" },
    ],
    merge_danger: { door: "one-way", blast_radius: "billing" },
    since: { from: "aaa", to: "abc", summary: "pushed", files: ["a.ts"], resolved: 1 },
  } satisfies ReviewedRecord
  const written = {
    summary: "new",
    walkthrough: [{ path: "./a.ts", summary: "new a" }],
    merge_danger: { door: "two-way", blast_radius: "one module" },
  } satisfies SummarySubmissionInput

  it("keeps the omitted requirements the last review carried, so the next incremental review still re-checks them", () => {
    const omitted = [{ issue: 121, requirement: "Unit tests cover the basis check" }]
    const record = summarizedRecord({ ...reviewed, omitted }, written, files)
    expect(record.omitted).toEqual(omitted)
    expect(record).not.toHaveProperty("since")
    expect(summarizedRecord(reviewed, written, files)).not.toHaveProperty("omitted")
  })

  it("drops a written row for a file outside the reviewable set, as the review does", () => {
    const stray = { ...written, walkthrough: [...written.walkthrough, { path: "vendor/x.js", summary: "generated" }] }
    expect(summarizedRecord(reviewed, stray, files).walkthrough.map((row) => row.path)).toEqual(["a.ts", "b.ts"])
  })

  it("replaces the summary, walkthrough and merge danger, drops the since section and keeps the head", () => {
    expect(summarizedRecord(reviewed, written, files)).toStrictEqual({
      headSha: "abc",
      baseRef: "main",
      at: 5,
      mode: "incremental",
      summary: "new",
      walkthrough: [
        { path: "a.ts", summary: "new a" },
        { path: "b.ts", summary: "old b" },
      ],
      merge_danger: { door: "two-way", blast_radius: "one module" },
    })
  })

  it("puts the model's rows ahead of the stored rows it keeps", () => {
    const row = { path: "b.ts", summary: "new b" }
    const record = summarizedRecord(reviewed, { ...written, walkthrough: [row] }, files)
    expect(record.walkthrough).toEqual([row, { path: "a.ts", summary: "old a" }])
  })

  it("keeps a stored row written as ./b.ts under b.ts", () => {
    const stored = { ...reviewed, walkthrough: [{ path: "./b.ts", summary: "old b" }] }
    expect(summarizedRecord(stored, written, files).walkthrough).toEqual([
      { path: "a.ts", summary: "new a" },
      { path: "b.ts", summary: "old b" },
    ])
  })

  it("leaves a changed file with neither a model row nor a stored row out", () => {
    const record = summarizedRecord(reviewed, written, [...files, changed("c.ts")])
    expect(record.walkthrough.map((row) => row.path)).toEqual(["a.ts", "b.ts"])
  })
})

describe("recordedVerdict", () => {
  const head = "def5678901"
  const counts = { blocking: 1, suggestion: 0, nitpick: 2 }
  const requestedChanges = {
    reviewId: 1,
    event: "REQUEST_CHANGES",
    headSha: head,
    verdict: "request_changes",
    shown: "REQUEST_CHANGES",
    counts,
    heldBack: 0,
    at: 1,
  } satisfies LastReview
  const stored = {
    headSha: "abc1234567",
    baseRef: "main",
    at: 1,
    mode: "full",
    summary: "s",
    walkthrough: [],
  } satisfies ReviewedRecord

  it("keeps the last review's verdict and counts for the head it reviewed", () => {
    expect(recordedVerdict(requestedChanges, stored, head)).toStrictEqual({ label: "Changes requested", counts })
  })

  it("names the reviewed head when the summary describes a newer one", () => {
    expect(recordedVerdict({ ...requestedChanges, headSha: "abc1234567" }, stored, head)).toStrictEqual({
      label: "Changes requested at `abc1234`",
      counts,
    })
  })

  it("shows the evaluation's approval as approved at its head", () => {
    const approval = approvalRecord(requestedChanges, 2, head, 1)
    expect(recordedVerdict(approval, stored, head)).toStrictEqual({ label: "Approved at `def5678`", counts })
    expect(recordedVerdict(approval, stored, "0123456789")).toStrictEqual({ label: "Approved at `def5678`", counts })
    expect(recordedVerdict(approvalRecord(undefined, 2, head, 1), stored, head)).toStrictEqual({
      label: "Approved at `def5678`",
    })
  })

  it("shows a review's own approval as approved, with or without the model verdict older records kept", () => {
    const own = {
      reviewId: 3,
      event: "APPROVE",
      headSha: head,
      shown: "APPROVE",
      counts: { blocking: 0, suggestion: 1, nitpick: 0 },
      heldBack: 0,
      at: 1,
    } satisfies LastReview
    expect(recordedVerdict(own, stored, head)).toStrictEqual({
      label: "Approved",
      counts: { blocking: 0, suggestion: 1, nitpick: 0 },
    })
    expect(recordedVerdict(own, stored, "0123456789")).toStrictEqual({
      label: "Approved at `def5678`",
      counts: { blocking: 0, suggestion: 1, nitpick: 0 },
    })
    expect(recordedVerdict({ ...own, verdict: "approve" }, stored, head)).toStrictEqual({
      label: "Approved",
      counts: { blocking: 0, suggestion: 1, nitpick: 0 },
    })
  })

  it("shows a withheld approval as itself", () => {
    const withheld = { ...requestedChanges, event: "COMMENT", shown: "WITHHELD", withheld: 1 } satisfies LastReview
    expect(recordedVerdict(withheld, stored, head)).toStrictEqual({ label: "Approval withheld", counts })
  })

  it("shows a wait for the checks as itself", () => {
    const waiting = {
      ...requestedChanges,
      event: "COMMENT",
      verdict: "approve",
      shown: "AWAITING_CHECKS",
    } satisfies LastReview
    expect(recordedVerdict(waiting, stored, head)).toStrictEqual({ label: "Approval waits for the checks", counts })
    expect(recordedVerdict({ ...waiting, headSha: "abc1234567" }, stored, head)).toStrictEqual({
      label: "Approval waits for the checks at `abc1234`",
      counts,
    })
  })

  it("says when there is no review, and when the review left no record", () => {
    expect(recordedVerdict(undefined, undefined, head)).toStrictEqual({ label: "Not reviewed yet" })
    expect(recordedVerdict(undefined, stored, head)).toStrictEqual({ label: "Not recorded" })
  })

  it("falls back on the event for a last review stored before it kept what it showed", () => {
    const before = {
      reviewId: 1,
      event: "COMMENT",
      verdict: "approve",
      headSha: head,
      heldBack: 0,
      at: 1,
    } satisfies LastReview
    expect(recordedVerdict(before, stored, head)).toStrictEqual({ label: "Commented" })
    const requested = { ...before, event: "REQUEST_CHANGES", verdict: "request_changes" } satisfies LastReview
    expect(recordedVerdict(requested, stored, head)).toStrictEqual({ label: "Changes requested" })
  })
})

describe("renderSummaryRun", () => {
  const run = {
    botLogin: "andabot",
    headSha: "def5678901",
    verdict: { label: "Changes requested at `abc1234`", counts: { blocking: 1, suggestion: 0, nitpick: 2 } },
    summary: {
      summary: "  new\n",
      walkthrough: [
        { path: "a.ts", summary: "new a" },
        { path: "b.ts", summary: "old | b" },
      ],
      merge_danger: { door: "two-way", blast_radius: "one module" },
    },
    model: "@cf/zai-org/glm-5.3-flash",
    skillsFingerprint: "89abcdef01234567",
    linkedIssues: [27],
  } satisfies SummaryRunInput

  it("shows the summarized head, the recorded verdict and the fresh summary, with no since section", () => {
    const text = renderSummaryRun(run)
    expect(text.startsWith(SUMMARY_MARKER)).toBe(true)
    expect(text).toContain(
      "**Head:** `def5678` · **Verdict:** Changes requested at `abc1234` · 🔴 1 blocking · 🟠 0 major · 🟡 0 suggestions · ⚪ 2 nitpicks\n\n**Merge danger:** two-way door · one module\n\n### Summary\n\nnew",
    )
    expect(text).toContain("### Summary\n\nnew\n\n### Walkthrough\n\n| File | Change |")
    expect(text).toContain("| File | Change |\n| --- | --- |\n| `a.ts` | new a |\n| `b.ts` | old \\| b |")
    expect(text).toContain(
      "<sub>Summarized by `@cf/zai-org/glm-5.3-flash` with skills `summary@89abcdef`.</sub>\n<sub>Linked issues: #27",
    )
    expect(text).not.toContain("### Since")
  })

  it("ends with the credit, the linked issues and the commands, without a review's standards or cost", () => {
    const text = renderSummaryRun(run)
    expect(
      text.endsWith(
        [
          "| `b.ts` | old \\| b |",
          "",
          "<sub>Summarized by `@cf/zai-org/glm-5.3-flash` with skills `summary@89abcdef`.</sub>",
          "<sub>Linked issues: #27</sub>",
          "<sub>Commands: `@andabot review`, `@andabot full review`, `@andabot help`. Ask a question with `@andabot <question>`.</sub>",
        ].join("\n"),
      ),
    ).toBe(true)
    expect(text).not.toContain("Standards")
    expect(text).not.toContain("Reviewed by")
    expect(text).not.toContain("dropped")
  })

  it("ends with the config note when .andabot.yaml was ignored, so a summary says what the review would", () => {
    const text = renderSummaryRun({ ...run, configError: "invalid YAML: bad indent" })
    expect(text.endsWith("_.andabot.yaml was ignored: `invalid YAML: bad indent`; the defaults applied._")).toBe(true)
    expect(renderSummaryRun(run)).not.toContain("was ignored")
  })

  it("says none when no issue is linked, and names the bot by its login", () => {
    const text = renderSummaryRun({ ...run, botLogin: "reviewer-bot", linkedIssues: [] })
    expect(text).toContain("## reviewer-bot review\n")
    expect(text).toContain("<sub>Linked issues: none</sub>\n<sub>Commands: `@reviewer-bot review`")
  })

  it("shows a verdict without counts alone", () => {
    const text = renderSummaryRun({ ...run, verdict: { label: "Not reviewed yet" } })
    expect(text).toContain("**Head:** `def5678` · **Verdict:** Not reviewed yet\n\n**Merge danger:**")
    expect(text).not.toContain("blocking")
  })

  it("says so when the model wrote no per-file notes", () => {
    const text = renderSummaryRun({ ...run, summary: { ...run.summary, walkthrough: [] } })
    expect(text).toContain("### Walkthrough\n\n_No per-file notes._\n\n<sub>Summarized by")
  })

  it("can be rewritten as an approval later", () => {
    expect(withApprovedVerdict(renderSummaryRun(run), "fedcba9876")).toContain(
      "**Head:** `def5678` · **Verdict:** Approved at `fedcba9` · 🔴 1 blocking · 🟠 0 major · 🟡 0 suggestions · ⚪ 2 nitpicks\n",
    )
    const unreviewed = renderSummaryRun({ ...run, verdict: { label: "Not reviewed yet" } })
    expect(withApprovedVerdict(unreviewed, "fedcba9876")).toContain("**Verdict:** Approved at `fedcba9`\n")
  })
})

describe("summaryLive", () => {
  const record = { deliveryId: "d1", operationId: "summary:d1", started: 1_000_000 }

  it("counts a summary as running while Pi lists it or within the grace after it started", () => {
    expect(summaryLive(undefined, { running: false, now: record.started })).toBe(false)
    expect(summaryLive(undefined, { running: true, now: record.started })).toBe(false)
    expect(summaryLive(record, { running: true, now: record.started + 10 * GRACE_MS })).toBe(true)
    expect(summaryLive(record, { running: false, now: record.started + GRACE_MS - 1 })).toBe(true)
    expect(summaryLive(record, { running: false, now: record.started + GRACE_MS })).toBe(false)
  })
})

describe("the stored summary records", () => {
  it("reads a summary in flight with its delivery, operation and start", () => {
    const record = { deliveryId: "d1", operationId: "summary:d1", started: 1_000_000 }
    expect(Value.Check(Summarizing, record)).toBe(true)
    expect(Value.Check(Summarizing, { ...record, started: undefined })).toBe(false)
    expect(Value.Check(Summarizing, { ...record, started: 1.5 })).toBe(false)
    expect(Value.Check(Summarizing, { ...record, operationId: 7 })).toBe(false)
  })
})

describe("summaryReply", () => {
  it("links the comment it updated", () => {
    expect(summaryReply({ kind: "posted", head: "def5678901", link: "https://x" }, "andabot")).toBe(
      "Updated the [summary](https://x) for `def5678`.",
    )
  })

  it("names the head alone when it has no comment to link", () => {
    expect(summaryReply({ kind: "posted", head: "def5678901", link: undefined }, "andabot")).toBe(
      "Updated the summary for `def5678`.",
    )
  })

  it("says the head moved and how to ask again, by the bot's login", () => {
    const moved = { kind: "moved", from: "abc1234567", to: "def5678901" } as const
    expect(summaryReply(moved, "andabot")).toBe(
      "The head moved from `abc1234` to `def5678` while I wrote the summary, so I didn't post it. Ask again with `@andabot summary`.",
    )
    expect(summaryReply(moved, "reviewer-bot")).toContain("Ask again with `@reviewer-bot summary`.")
  })

  it("says why the model's answer couldn't be used", () => {
    expect(summaryReply({ kind: "unusable", reason: "the model's answer wasn't valid JSON" }, "andabot")).toBe(
      "I couldn't write the summary: the model's answer wasn't valid JSON.",
    )
  })

  it("says a summary is already being written", () => {
    expect(summaryReply({ kind: "busy" }, "andabot")).toBe(
      "A summary is already being written; it will update the comment when it's done.",
    )
  })

  it("says a closed pull request has nothing to summarize", () => {
    expect(summaryReply({ kind: "closed" }, "andabot")).toBe(
      "The pull request is closed, so there's nothing to summarize.",
    )
  })

  it("says the filters leave nothing to summarize", () => {
    expect(summaryReply({ kind: "filtered" }, "andabot")).toBe(
      "`path_filters` in `.andabot.yaml` leave out every changed file, so there's nothing to summarize.",
    )
  })
})

describe("oneClause", () => {
  it("flattens a provider's reason to one line with single spaces and no closing period", () => {
    expect(oneClause("model_error: Upstream failed.\n Try later.")).toBe("model_error: Upstream failed. Try later")
  })

  it("trims the ends and drops every closing period, so the unusable reply ends in one", () => {
    const reason = oneClause("  Error: the read timed out...\n\n")
    expect(reason).toBe("Error: the read timed out")
    expect(summaryReply({ kind: "unusable", reason }, "andabot")).toBe(
      "I couldn't write the summary: Error: the read timed out.",
    )
  })

  it("leaves a reason that is one clause already as it is", () => {
    expect(oneClause("the model's answer wasn't valid JSON")).toBe("the model's answer wasn't valid JSON")
  })
})
