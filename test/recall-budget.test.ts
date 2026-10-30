import { describe, expect, it } from "vitest"
import { budgetBlock, budgetStanding } from "../src/review/budget.ts"
import { NeuronBudget, neuronsOf } from "../tools/recall/budget.ts"

describe("neuronsOf", () => {
  it("converts dollars at production's rate", () => {
    expect(neuronsOf(0.011)).toBeCloseTo(1000, 6)
  })
})

describe("NeuronBudget", () => {
  it("tallies spend and blocks every tool but submit_review once the budget is spent", () => {
    const budget = new NeuronBudget(10_000)
    budget.add(0.05)
    expect(budget.neurons()).toBeCloseTo(4545.4545, 3)
    expect(budget.blockFor("read_file")).toBeUndefined()
    budget.add(0.07)
    expect(budget.blockFor("read_file")).toBe(budgetBlock(budgetStanding(budget.neurons(), 10_000), "read_file"))
    expect(budget.blockFor("read_file")).toContain("Budget spent: this review has used 10,909 of its 10,000 neurons.")
    expect(budget.blockFor("submit_review")).toBeUndefined()
  })

  it("refuses the request after three more requests past the budget", () => {
    const budget = new NeuronBudget(10_000)
    budget.add(0.2)
    expect([budget.refuses(), budget.refuses(), budget.refuses()]).toEqual([false, false, false])
    expect(budget.refuses()).toBe(true)
  })

  it("never refuses within the budget", () => {
    const budget = new NeuronBudget(10_000)
    expect([budget.refuses(), budget.refuses(), budget.refuses(), budget.refuses()]).toEqual([
      false,
      false,
      false,
      false,
    ])
  })
})
