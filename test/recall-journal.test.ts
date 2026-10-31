import { describe, expect, it } from "vitest"
import { parseJournal, remainingReviews, resumeCommand, runsWithin, stampOfJournal } from "../tools/recall/journal.ts"
import type { ResultsRow } from "../tools/recall/rescore.ts"
import { headCase } from "./recall-fixtures.ts"

const row = {
  head: "a".repeat(40),
  run: 1,
  answer: { calls: 1, inputTokens: 10, outputTokens: 5, usd: 0.01, neurons: 9, reason: "budget" },
} satisfies ResultsRow

describe("parseJournal", () => {
  it("reads one recorded review per line, skipping blank lines", () => {
    const rows = parseJournal(`${JSON.stringify(row)}\n${JSON.stringify({ ...row, run: 2 })}\n\n`)
    expect(rows.map((entry) => entry.run)).toEqual([1, 2])
    expect(rows[0]?.answer.reason).toBe("budget")
  })

  it("names the line that is not a recorded review", () => {
    expect(() => parseJournal(`${JSON.stringify(row)}\n{"head":"x"}\n`)).toThrow("Line 2 of the journal")
  })

  it("refuses a journal that records the same review twice", () => {
    expect(() => parseJournal(`${JSON.stringify(row)}\n${JSON.stringify(row)}\n`)).toThrow(
      "Line 2 of the journal repeats aaaaaaa run 1",
    )
  })
})

describe("remainingReviews", () => {
  it("lists the reviews a journal has not recorded, in set order", () => {
    const first = headCase({ head: "a".repeat(40) })
    const second = headCase({ head: "b".repeat(40) })
    const done = [
      { head: first.head, run: 1 },
      { head: first.head, run: 2 },
      { head: first.head, run: 3 },
      { head: second.head, run: 1 },
      { head: "c".repeat(40), run: 1 },
    ]
    expect(remainingReviews([first, second], 3, done)).toEqual([
      { head: second, run: 2 },
      { head: second, run: 3 },
    ])
  })

  it("lists every review when nothing is recorded", () => {
    const only = headCase()
    expect(remainingReviews([only], 2, [])).toEqual([
      { head: only, run: 1 },
      { head: only, run: 2 },
    ])
  })
})

describe("stampOfJournal", () => {
  it("reads the run's stamp back from the journal's file name", () => {
    expect(stampOfJournal("/x/runs/2026-10-31T04-55-20.737Z.jsonl")).toBe("2026-10-31T04:55:20.737Z")
  })

  it("refuses a file that is not a run journal", () => {
    expect(() => stampOfJournal("/x/runs/spend.jsonl")).toThrow("not a run journal")
  })
})

describe("runsWithin", () => {
  it("refuses a journal recording a run above the runs asked for", () => {
    const rows = [row, { ...row, run: 3 }]
    expect(() => runsWithin(rows, 2)).toThrow("The journal records run 3 of aaaaaaa but --runs is 2")
    expect(runsWithin(rows, 3)).toBe(rows)
  })
})

describe("resumeCommand", () => {
  it("carries the model, thinking level, runs and case the journal was made with", () => {
    expect(resumeCommand({ model: "m", thinking: "high", runs: 2, onlyCase: "abc" }, "/x/runs/j.jsonl")).toBe(
      "pnpm recall --model m --thinking high --runs 2 --case abc --resume /x/runs/j.jsonl",
    )
    expect(resumeCommand({ model: "m", thinking: "low", runs: 3, onlyCase: undefined }, "/x/j.jsonl")).toBe(
      "pnpm recall --model m --thinking low --runs 3 --resume /x/j.jsonl",
    )
  })
})
