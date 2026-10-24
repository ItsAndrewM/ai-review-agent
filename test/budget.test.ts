import { fauxAssistantMessage, isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import {
  BUDGET_REFUSAL,
  budgetBlock,
  budgetNote,
  budgetStanding,
  DEFAULT_REVIEW_NEURONS,
  refusesRequest,
  REQUESTS_PAST_BUDGET,
  reviewBudgetOf,
} from "../src/review/budget.ts"

const WITHIN = { kind: "within" } as const

const SPENT = { kind: "spent", neurons: 12_345.6, budget: 10_000 } as const

const BLOCK =
  "Budget spent: this review has used 12,345 of its 10,000 neurons. Call submit_review now with the findings and walkthrough you have; a file you didn't get to still needs its walkthrough row, written from the diff."

describe("reviewBudgetOf", () => {
  it("defaults to 10,000 neurons, one day of Workers AI's free allowance", () => {
    expect(DEFAULT_REVIEW_NEURONS).toBe(10_000)
  })

  it("parses the var's text as a whole number of neurons", () => {
    expect(reviewBudgetOf("5000")).toBe(5_000)
  })

  it.each([undefined, "", "0", "-1", "1.5", "abc"])(
    "falls back to the default when the var is %j, which isn't a positive whole number",
    (value) => {
      expect(reviewBudgetOf(value)).toBe(10_000)
    },
  )
})

describe("budgetStanding", () => {
  it("is within while the review has spent less than its budget", () => {
    expect(budgetStanding(9_999.9, 10_000)).toEqual(WITHIN)
  })

  it("is spent from the moment the review has spent its budget, and stays spent past it", () => {
    expect(budgetStanding(10_000, 10_000)).toEqual({ kind: "spent", neurons: 10_000, budget: 10_000 })
    expect(budgetStanding(48_471, 10_000)).toEqual({ kind: "spent", neurons: 48_471, budget: 10_000 })
  })

  it("is within when the spend can't be priced, so a model without a price is never stopped", () => {
    expect(budgetStanding(undefined, 10_000)).toEqual(WITHIN)
  })

  it("is within when the spend isn't a number, rather than stopping a review on a figure nobody can read", () => {
    expect(budgetStanding(Number.NaN, 10_000)).toEqual(WITHIN)
  })
})

describe("budgetBlock", () => {
  it("blocks nothing while the review is within its budget", () => {
    expect(budgetBlock(WITHIN, "read_file")).toBeUndefined()
  })

  it("lets submit_review through once the budget is spent, so the review can still be posted", () => {
    expect(budgetBlock(SPENT, "submit_review")).toBeUndefined()
  })

  it("tells the model to submit now when it calls read_file past the budget, the neurons rounded down", () => {
    expect(budgetBlock(SPENT, "read_file")).toBe(BLOCK)
  })

  it("blocks every other tool the same way", () => {
    const others = ["grep", "tree", "list_changed_files", "get_issue", "activate_skill", "read_skill_resource"]
    for (const tool of others) expect(budgetBlock(SPENT, tool)).toBe(BLOCK)
  })

  it.each([
    [1, "1 neuron"],
    [2, "2 neurons"],
    [1_000, "1,000 neurons"],
  ])("counts a budget of %d as %s", (budget, counted) => {
    const standing = { kind: "spent", neurons: budget + 0.7, budget } as const
    expect(budgetBlock(standing, "read_file")).toContain(
      `this review has used ${budget.toLocaleString("en-US")} of its ${counted}. Call submit_review now`,
    )
  })
})

describe("refusesRequest", () => {
  it("lets the first three requests past the budget through, for the answer to the block and a resubmission, with one to spare", () => {
    for (const requestsPastBudget of [0, 1, 2]) expect(refusesRequest(SPENT, requestsPastBudget)).toBe(false)
  })

  it("refuses the fourth request past the budget, and every one after it", () => {
    expect(REQUESTS_PAST_BUDGET).toBe(3)
    for (const requestsPastBudget of [3, 4, 10]) expect(refusesRequest(SPENT, requestsPastBudget)).toBe(true)
  })

  it("refuses nothing while the review is within its budget, however many requests were made", () => {
    for (const requestsPastBudget of [0, 3, 10]) expect(refusesRequest(WITHIN, requestsPastBudget)).toBe(false)
  })
})

describe("BUDGET_REFUSAL", () => {
  const failed = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage })

  it("says the budget was spent and the review didn't submit within the requests allowed past it, whatever used them", () => {
    expect(BUDGET_REFUSAL).toBe(
      "the review's budget was spent and it didn't submit within the model requests allowed past it",
    )
  })

  it("holds no number, since Pi Durable's generation task retries a failure that pi-ai's classifier reads as transient, such as one that mentions 500", () => {
    expect(isRetryableAssistantError(failed("the review spent 10,500 neurons"))).toBe(true)
    expect(isRetryableAssistantError(failed(BUDGET_REFUSAL))).toBe(false)
    expect(BUDGET_REFUSAL).not.toMatch(/\d/)
  })

  it("isn't read as a context overflow, which Pi Durable would compact and ask again instead of failing the run", () => {
    expect(isContextOverflow(failed("prompt is too long: 213462 tokens > 200000 maximum"))).toBe(true)
    expect(isContextOverflow(failed(BUDGET_REFUSAL))).toBe(false)
  })
})

describe("budgetNote", () => {
  it("tells a reader the review stopped reading early, and the budget it spent", () => {
    expect(budgetNote(10_000)).toBe("_This review stopped reading early: it spent its budget of 10,000 neurons._")
  })

  it.each([
    [1, "1 neuron"],
    [2, "2 neurons"],
  ])("counts a budget of %d as %s", (budget, counted) => {
    expect(budgetNote(budget)).toBe(`_This review stopped reading early: it spent its budget of ${counted}._`)
  })
})
