import { SUBMIT_REVIEW_TOOL } from "./tools.ts"

export const DEFAULT_REVIEW_NEURONS = 10_000

export const REQUESTS_PAST_BUDGET = 3

export const BUDGET_REFUSAL =
  "the review's budget was spent and the model kept calling tools after it was told to submit"

export type BudgetStanding =
  | { readonly kind: "within" }
  | { readonly kind: "spent"; readonly neurons: number; readonly budget: number }

export function reviewBudgetOf(value: string | undefined): number {
  const budget = Number(value)
  return Number.isSafeInteger(budget) && budget > 0 ? budget : DEFAULT_REVIEW_NEURONS
}

export function budgetStanding(neurons: number | undefined, budget: number): BudgetStanding {
  if (neurons !== undefined && neurons >= budget) return { kind: "spent", neurons, budget }
  return { kind: "within" }
}

export function budgetBlock(standing: BudgetStanding, toolName: string): string | undefined {
  if (standing.kind === "within" || toolName === SUBMIT_REVIEW_TOOL) return undefined
  return `Budget spent: this review has used ${spentCount(standing.neurons)} of its ${neuronCount(standing.budget)} neurons. Call ${SUBMIT_REVIEW_TOOL} now with the findings and walkthrough you have; a file you didn't get to still needs its walkthrough row, written from the diff.`
}

export function refusesRequest(standing: BudgetStanding, requestsPastBudget: number): boolean {
  return standing.kind === "spent" && requestsPastBudget >= REQUESTS_PAST_BUDGET
}

export function budgetNote(budget: number): string {
  return `_This review stopped reading early: it spent its budget of ${neuronCount(budget)} neurons._`
}

function spentCount(neurons: number): string {
  return neuronCount(Math.floor(neurons))
}

function neuronCount(neurons: number): string {
  return neurons.toLocaleString("en-US")
}
