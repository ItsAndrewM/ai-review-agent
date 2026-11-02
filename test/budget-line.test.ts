import { describe, expect, it } from "vitest"
import { summaryMarkerOf } from "../src/names.ts"
import {
  budgetLine,
  budgetSkipShown,
  QUESTION_BUDGET_REPLY,
  withBudgetLine,
  withoutBudgetLine,
} from "../src/review/budget-line.ts"
import { pausedLine, withPausedLine } from "../src/review/pause.ts"

const summary = [
  summaryMarkerOf("andabot"),
  "## andabot review",
  "",
  "**Head:** `abc1234`",
  "",
  "_Not reviewed yet._",
].join("\n")

const line = budgetLine("abcdef1234", "andabot")

describe("budgetLine", () => {
  it("names the head and when it is reviewed, with the deploy's marker", () => {
    expect(line).toBe(
      "⏳ Today's review budget is spent: `abcdef1` is reviewed after midnight UTC. <!-- andabot:budget -->",
    )
  })
})

describe("withBudgetLine", () => {
  it("puts the line right after the summary's header", () => {
    expect(withBudgetLine(summary, line, "andabot").split("\n").slice(1, 4)).toEqual(["## andabot review", "", line])
  })

  it("replaces an earlier budget line rather than stacking a second", () => {
    const later = budgetLine("9999999aaaa", "andabot")
    const twice = withBudgetLine(withBudgetLine(summary, line, "andabot"), later, "andabot")
    expect(twice.split("\n").filter((text) => text.startsWith("⏳"))).toEqual([later])
  })

  it("keeps the paused line beside it", () => {
    const paused = withPausedLine(summary, pausedLine("andrew", "andabot"), "andabot")
    const both = withBudgetLine(paused, line, "andabot")
    expect(both).toContain(line)
    expect(both).toContain(pausedLine("andrew", "andabot"))
  })

  it("leaves a body that isn't the summary comment alone", () => {
    expect(withBudgetLine("some other comment", line, "andabot")).toBe("some other comment")
  })
})

describe("withoutBudgetLine", () => {
  it("takes the line and its blank line out again", () => {
    expect(withoutBudgetLine(withBudgetLine(summary, line, "andabot"), "andabot")).toBe(summary)
  })
})

describe("budgetSkipShown", () => {
  it("is true only for the same head on the same day", () => {
    const shown = { head: "abc", day: "2026-11-01" }
    expect(budgetSkipShown(shown, "abc", "2026-11-01")).toBe(true)
    expect(budgetSkipShown(shown, "abc", "2026-11-02")).toBe(false)
    expect(budgetSkipShown(shown, "def", "2026-11-01")).toBe(false)
    expect(budgetSkipShown(undefined, "abc", "2026-11-01")).toBe(false)
  })
})

describe("QUESTION_BUDGET_REPLY", () => {
  it("says the question waits for midnight UTC", () => {
    expect(QUESTION_BUDGET_REPLY).toBe("Today's review budget is spent, so I can't answer until midnight UTC.")
  })
})
