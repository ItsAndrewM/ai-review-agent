import { describe, expect, it } from "vitest"
import type { FindingInput } from "../src/review/findings.ts"
import type { ReviewAnswer } from "../tools/recall/conversation.ts"
import { barVerdict, matchFindings, scoreRun, scoreSet, type RunScore, type SetScore } from "../tools/recall/score.ts"
import { expecting, headCase } from "./recall-fixtures.ts"

function finding(
  path: string,
  line: number,
  title: string,
  severity: FindingInput["severity"] = "blocking",
): FindingInput {
  return { path, line, quote: "q", severity, basis_kind: "defect", basis: "b", title, body: "body" }
}

function posted(
  findings: FindingInput[],
  verdict: "approve" | "request_changes" | "comment" = "request_changes",
  summary = "s",
): ReviewAnswer {
  return {
    posted: {
      submission: {
        summary,
        walkthrough: [{ path: "src/example.ts", summary: "x" }],
        findings,
        verdict,
        merge_danger: { door: "two-way", blast_radius: "r" },
      },
      accepted: findings,
      rejected: [],
    },
    source: "tool",
    calls: 2,
    inputTokens: 100,
    outputTokens: 10,
    usd: 0.01,
    neurons: 909,
  }
}

const unposted: ReviewAnswer = {
  posted: undefined,
  source: undefined,
  reason: "budget",
  calls: 4,
  inputTokens: 0,
  outputTokens: 0,
  usd: 0.2,
  neurons: 18181,
}

describe("matchFindings", () => {
  it("matches by path and pattern over title, body and basis", () => {
    const head = headCase()
    const { matches, unmatched } = matchFindings(head, [
      finding("src/example.ts", 11, "The total is wrong for an empty input"),
      finding("src/other.ts", 11, "wrong total"),
    ])
    expect(matches.map(({ expected, finding: { path } }) => [expected, path])).toEqual([["9-1", "src/example.ts"]])
    expect(unmatched.map(({ finding: { path }, standing }) => [path, standing])).toEqual([["src/other.ts", "false"]])
  })

  it("takes the finding nearest the expected lines and leaves the other unmatched", () => {
    const head = headCase()
    const far = finding("src/example.ts", 40, "wrong total far away")
    const near = finding("src/example.ts", 13, "wrong total nearby")
    const { matches, unmatched } = matchFindings(head, [far, near])
    expect(matches).toEqual([{ expected: "9-1", finding: near, distance: 1 }])
    expect(unmatched.map(({ finding: { title } }) => title)).toEqual(["wrong total far away"])
  })

  it("classifies an unmatched finding as allowed or known false by its head's lists", () => {
    const head = headCase({
      allowed: [{ id: "a1", path: "src/example.ts", pattern: "missing test", note: "true" }],
      knownFalse: [{ id: "f1", path: "src/example.ts", pattern: "spread.*undefined", note: "false" }],
    })
    const { unmatched } = matchFindings(head, [
      finding("src/example.ts", 2, "Missing test for the clamp", "nitpick"),
      finding("src/example.ts", 3, "Spreading undefined throws"),
      finding("src/example.ts", 4, "Something else"),
    ])
    expect(unmatched.map(({ standing, known }) => [standing, known])).toEqual([
      ["allowed", "a1"],
      ["known_false", "f1"],
      ["false", undefined],
    ])
  })
})

describe("scoreRun", () => {
  it("records the verdict, the summary match and the matches of a posted run", () => {
    const head = headCase({ summary: "footer" })
    const run = scoreRun(head, 1, posted([finding("src/example.ts", 10, "wrong total")], "comment", "the footer line"))
    expect([run.head, run.run, run.verdict, run.summaryMatched]).toEqual([head.head, 1, "comment", true])
    expect(run.matches.map(({ expected }) => expected)).toEqual(["9-1"])
  })

  it("records an unposted run with nothing matched", () => {
    const run = scoreRun(headCase(), 2, unposted)
    expect([run.matches, run.unmatched, run.verdict, run.summaryMatched]).toEqual([[], [], undefined, undefined])
  })
})

function runsOf(head: ReturnType<typeof headCase>, answers: ReviewAnswer[]): RunScore[] {
  return answers.map((answer, index) => scoreRun(head, index + 1, answer))
}

describe("scoreSet", () => {
  const meta = { model: "glm", thinking: "low", skills: "abc" }

  it("counts a finding found by 2 of 3 runs and not by 1 of 3, severity and verdict by majority too", () => {
    const head = headCase({ expects: [expecting("9-1"), expecting("9-2", { path: "src/other.ts", pattern: "leak" })] })
    const hit = finding("src/example.ts", 10, "wrong total", "suggestion")
    const leak = finding("src/other.ts", 10, "leak")
    const runs = runsOf(head, [
      posted([hit, leak], "request_changes"),
      posted([{ ...hit, severity: "blocking" }], "request_changes"),
      posted([], "approve"),
    ])
    const score = scoreSet({ heads: [head] }, runs, meta)
    expect(score.heads[0]?.expects).toEqual([
      { id: "9-1", found: true, foundIn: 2, severityMatched: false, runs: 3 },
      { id: "9-2", found: false, foundIn: 1, severityMatched: false, runs: 3 },
    ])
    expect([score.found, score.expected, score.severityMatched, score.verdictMatched]).toEqual([1, 2, 0, 1])
    expect(score.heads[0]?.verdictMatched).toBe(true)
    expect(score.reviews).toBe(3)
    expect(score.costPerReview).toBeCloseTo(0.01, 6)
  })

  it("counts false findings by the per-head majority and not-posted runs", () => {
    const head = headCase()
    const noise = finding("src/example.ts", 30, "Noise", "nitpick")
    const runs = runsOf(head, [posted([noise, { ...noise, line: 31 }]), posted([noise]), unposted])
    const score = scoreSet({ heads: [head] }, runs, meta)
    expect(score.heads[0]?.falseBySeverity).toEqual({ blocking: 0, suggestion: 0, nitpick: 1 })
    expect(score.falseCount).toBe(1)
    expect(score.heads[0]?.notPosted).toBe(1)
    expect(score.usd).toBeCloseTo(0.22, 6)
  })
})

describe("barVerdict", () => {
  const base = (changes: Partial<SetScore>): SetScore => ({
    model: "glm",
    thinking: "low",
    skills: "abc",
    found: 3,
    expected: 4,
    falseCount: 1,
    severityMatched: 2,
    verdictMatched: 1,
    heads: [],
    usd: 0.03,
    costPerReview: 0.01,
    reviews: 3,
    ...changes,
  })

  it("rejects a lower found-count and a higher false count, naming both numbers", () => {
    expect(barVerdict(base({}), base({ found: 2 }))).toEqual({
      adopted: false,
      reasons: ["found 2 < 3", "cost per review $0.0100 vs $0.0100"],
    })
    expect(barVerdict(base({}), base({ falseCount: 2 })).reasons[0]).toBe("false 2 > 1")
  })

  it("adopts an equal run with the cost shown", () => {
    expect(barVerdict(base({}), base({ costPerReview: 0.05 }))).toEqual({
      adopted: true,
      reasons: ["cost per review $0.0500 vs $0.0100"],
    })
  })
})
