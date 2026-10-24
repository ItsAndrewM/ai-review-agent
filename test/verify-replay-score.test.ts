import { describe, expect, it } from "vitest"
import type { VerdictInput } from "../src/review/verify.ts"
import { scoreRuns, type RunVerdicts } from "../tools/verify-replay/score.ts"
import { labelled, verdict } from "./verify-replay-fixtures.ts"

function run(...verdicts: VerdictInput[]): RunVerdicts {
  return { verdicts }
}

const labels = new Map([
  ["1", labelled("1", "keep")],
  ["2", labelled("2", "demote")],
  ["3", labelled("3", "promote", { severity: "suggestion" })],
  ["4", labelled("4", "drop", { severity: "suggestion" })],
  ["5", labelled("5", "drop", { severity: "suggestion" })],
])

const passing = () => run(verdict("1", true), verdict("2", false), verdict("3", true), verdict("4", false))

describe("scoreRuns", () => {
  it("passes when a majority fixes each severity target and drops half the false findings", () => {
    expect(scoreRuns([passing(), passing(), run()], labels)).toEqual({
      passes: true,
      hardRuleBroken: false,
      demoteFixed: true,
      promoteFixed: true,
      dropped: 1,
      droppable: 2,
    })
  })

  it.each([verdict("1", false), verdict("1", true, "suggestion")])(
    "fails if any run drops or demotes a true blocker: %j",
    (unsafe) => {
      const score = scoreRuns([passing(), passing(), run(unsafe)], labels)
      expect(score.hardRuleBroken).toBe(true)
      expect(score.passes).toBe(false)
    },
  )

  it("does not apply the true-blocker hard rule to nonblocking keep findings", () => {
    const nonblocking = new Map([...labels, ["6", labelled("6", "keep", { severity: "suggestion" })]])
    expect(scoreRuns([passing(), passing(), run(verdict("6", false))], nonblocking).hardRuleBroken).toBe(false)
  })

  it("counts a demotion or a drop toward the demote target", () => {
    const one = run(verdict("2", true, "nitpick"), verdict("3", true), verdict("4", false))
    expect(scoreRuns([passing(), one, run()], labels).demoteFixed).toBe(true)
    expect(scoreRuns([one, run(), run()], labels).demoteFixed).toBe(false)
  })

  it("requires promotion to blocking while kept in two runs", () => {
    const dropped = run(verdict("3", false))
    expect(scoreRuns([passing(), dropped, run()], labels).promoteFixed).toBe(false)
    expect(scoreRuns([passing(), passing(), dropped], labels).promoteFixed).toBe(true)
  })

  it("does not count a severity demotion as a dropped false finding", () => {
    const demoted = run(verdict("4", true, "nitpick"))
    expect(scoreRuns([passing(), demoted, demoted], labels).dropped).toBe(0)
  })

  it("uses the first verdict per id just as production does", () => {
    const duplicate = run(verdict("1", false), verdict("1", true))
    expect(scoreRuns([passing(), passing(), duplicate], labels).hardRuleBroken).toBe(true)
    const safe = run(verdict("1", true), verdict("1", false))
    expect(scoreRuns([passing(), passing(), safe], labels).hardRuleBroken).toBe(false)
  })

  it("keeps missing verdicts at draft severity and does not count them as fixes", () => {
    expect(scoreRuns([run(), run(), run()], labels)).toEqual({
      passes: false,
      hardRuleBroken: false,
      demoteFixed: false,
      promoteFixed: false,
      dropped: 0,
      droppable: 2,
    })
  })

  it("applies production basis caps before scoring a promotion", () => {
    const capped = new Map([
      ...labels,
      ["3", labelled("3", "promote", { severity: "suggestion", basis_kind: "standard" })],
    ])
    expect(scoreRuns([passing(), passing(), passing()], capped).promoteFixed).toBe(false)
  })

  it("cannot pass the three-run gate from one successful run", () => {
    expect(scoreRuns([passing()], labels).passes).toBe(false)
  })

  it("cannot pass an empty corpus", () => {
    expect(scoreRuns([run(), run(), run()], new Map()).passes).toBe(false)
  })
})
