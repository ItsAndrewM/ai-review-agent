import { describe, expect, it } from "vitest"
import { compareTable, resultsFileName, resultsTable } from "../tools/recall/report.ts"
import { barVerdict, type SetScore } from "../tools/recall/score.ts"
import { expecting, headCase } from "./recall-fixtures.ts"

const head = headCase({ expects: [expecting("9-1"), expecting("9-2", { path: "src/other.ts", severity: "nitpick" })] })
const other = headCase({ pr: 10, head: "c".repeat(40), expects: [expecting("10-1")], verdict: "approve" })

const score: SetScore = {
  model: "@cf/zai-org/glm-5.3-flash",
  thinking: "low",
  skills: "abcdef0123456789",
  found: 2,
  expected: 3,
  falseCount: 1,
  severityMatched: 2,
  verdictMatched: 1,
  heads: [
    {
      head: head.head,
      expects: [
        { id: "9-1", found: true, foundIn: 3, severityMatched: true, runs: 3 },
        { id: "9-2", found: true, foundIn: 2, severityMatched: true, runs: 3 },
      ],
      falseBySeverity: { blocking: 0, suggestion: 1, nitpick: 0 },
      verdictMatched: true,
      notPosted: 0,
    },
    {
      head: other.head,
      expects: [{ id: "10-1", found: false, foundIn: 1, severityMatched: false, runs: 3 }],
      falseBySeverity: { blocking: 0, suggestion: 0, nitpick: 0 },
      verdictMatched: false,
      notPosted: 1,
    },
  ],
  usd: 0.042,
  costPerReview: 0.007,
  reviews: 6,
  partial: false,
}

describe("resultsTable", () => {
  it("has one row per expected finding and a footer with the totals", () => {
    const table = resultsTable({ heads: [head, other] }, score)
    expect(table).toContain(
      "| 9-1 | #9 `aaaaaaa` | `src/example.ts` 10-12 | 3/3 | yes | blocking | yes | request_changes yes |",
    )
    expect(table).toContain("| 9-2 | #9 `aaaaaaa` | `src/other.ts` 10-12 | 2/3 | yes | nitpick | yes |  |")
    expect(table).toContain(
      "| 10-1 | #10 `ccccccc` | `src/example.ts` 10-12 | 1/3 | no | blocking | no | approve no (1 not posted) |",
    )
    expect(table).toContain("Found 2/3 · false 1 · severity 2/3 · verdict 1/2 · $0.0070 a review · not posted 1")
    expect(table).toContain("@cf/zai-org/glm-5.3-flash at low, review@abcdef01")
  })

  it("leaves out a head the run did not score", () => {
    const unscored = headCase({ pr: 11, head: "d".repeat(40), expects: [expecting("11-1")] })
    const table = resultsTable({ heads: [head, other, unscored] }, { ...score, partial: true })
    expect(table).not.toContain("11-1")
    expect(table).toContain("(partial run)")
  })
})

describe("compareTable", () => {
  it("ends with the bar's verdict", () => {
    const candidate = { ...score, thinking: "high", found: 1, costPerReview: 0.02 }
    const table = compareTable(score, candidate, barVerdict(score, candidate))
    expect(table).toContain("| Found | 2/3 | 1/3 |")
    expect(table).toContain("| Cost a review | $0.0070 | $0.0200 |")
    expect(table.trimEnd().endsWith("Not adopted: found 1 < 2; cost per review $0.0200 vs $0.0070")).toBe(true)
    const adopted = compareTable(
      score,
      { ...score, thinking: "high" },
      barVerdict(score, { ...score, thinking: "high" }),
    )
    expect(adopted.trimEnd().endsWith("Adopted: cost per review $0.0070 vs $0.0070")).toBe(true)
  })
})

describe("resultsFileName", () => {
  it("carries the stamp, the model tail, the level and the case prefix", () => {
    expect(resultsFileName("2026-10-30T14:05:09.123Z", "@cf/zai-org/glm-5.3-flash", "low", undefined)).toBe(
      "2026-10-30T14-05-09-glm-5.3-flash-low.json",
    )
    expect(resultsFileName("2026-10-30T14:05:09.123Z", "@cf/moonshotai/kimi-k2.7-code", "high", "b7b89ae")).toBe(
      "2026-10-30T14-05-09-kimi-k2.7-code-high-case-b7b89ae.json",
    )
  })
})
