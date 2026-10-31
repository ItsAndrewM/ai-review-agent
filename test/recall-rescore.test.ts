import { describe, expect, it } from "vitest"
import type { FindingInput } from "../src/review/findings.ts"
import type { ReviewAnswer } from "../tools/recall/conversation.ts"
import { parseResults, rescore, type ResultsFile } from "../tools/recall/rescore.ts"
import { scoreRun, scoreSet } from "../tools/recall/score.ts"
import { headCase } from "./recall-fixtures.ts"

const offTopic: FindingInput = {
  path: "src/example.ts",
  line: 40,
  quote: "q",
  severity: "nitpick",
  basis_kind: "standard",
  basis: "b",
  title: "The helper is computed twice per call",
  body: "body",
}

const answer: ReviewAnswer = {
  posted: {
    submission: {
      summary: "s",
      walkthrough: [{ path: "src/example.ts", summary: "x" }],
      findings: [offTopic],
      verdict: "request_changes",
      merge_danger: { door: "two-way", blast_radius: "r" },
    },
    accepted: [offTopic],
    rejected: [],
  },
  source: "tool",
  calls: 2,
  inputTokens: 100,
  outputTokens: 10,
  usd: 0.01,
  neurons: 909,
}

const meta = {
  model: "@cf/zai-org/glm-5.3-flash",
  thinking: "low",
  skills: "abc",
  maxOutputTokens: 16_000,
  maxReviewNeurons: 10_000,
  runs: 1,
  at: "2026-10-30T18:55:26.635Z",
  partial: false,
}

function recorded(): ResultsFile {
  const before = headCase()
  const runs = [scoreRun(before, 1, answer)]
  const score = scoreSet({ heads: [before] }, runs, meta, meta.runs)
  return parseResults(JSON.stringify({ meta, score, runs }))
}

describe("rescore", () => {
  it("re-matches a recorded run against the current set, so a new label changes the standing", () => {
    const relabelled = headCase({
      knownFalse: [{ id: "9-f1", path: "src/example.ts", pattern: "computed twice", note: "false: bounded work" }],
    })
    const results = recorded()
    expect(results.score.falseCount).toBe(1)

    const after = rescore({ heads: [relabelled] }, results)

    expect(after.score.falseCount).toBe(0)
    expect(after.runs[0]?.unmatched.map((entry) => [entry.standing, entry.known])).toEqual([["known_false", "9-f1"]])
    expect(after.meta).toEqual(meta)
    expect(after.score.model).toBe(meta.model)
  })

  it("refuses a recorded head the set no longer holds", () => {
    const results = recorded()
    expect(() => rescore({ heads: [headCase({ head: "c".repeat(40) })] }, results)).toThrow(
      `${"a".repeat(40)} is not in the set`,
    )
  })

  it("refuses text that is not a results file", () => {
    expect(() => parseResults(JSON.stringify({ meta, score: {} }))).toThrow("not a recall results file")
  })
})
