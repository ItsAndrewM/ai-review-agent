import { budgetBlock, budgetStanding, refusesRequest, type BudgetStanding } from "../../src/review/budget.ts"

const USD_PER_THOUSAND_NEURONS = 0.011

export function neuronsOf(usd: number): number {
  return (usd / USD_PER_THOUSAND_NEURONS) * 1000
}

export class NeuronBudget {
  readonly #budget: number
  #usd = 0
  #requestsPastBudget = 0

  constructor(budget: number) {
    this.#budget = budget
  }

  add(usd: number): void {
    this.#usd += usd
  }

  neurons(): number {
    return neuronsOf(this.#usd)
  }

  standing(): BudgetStanding {
    return budgetStanding(this.neurons(), this.#budget)
  }

  blockFor(toolName: string): string | undefined {
    return budgetBlock(this.standing(), toolName)
  }

  refuses(): boolean {
    const standing = this.standing()
    if (standing.kind !== "spent") return false
    if (refusesRequest(standing, this.#requestsPastBudget)) return true
    this.#requestsPastBudget += 1
    return false
  }
}
