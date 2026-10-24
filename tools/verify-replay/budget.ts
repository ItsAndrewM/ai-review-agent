import { existsSync } from "node:fs"
import { appendFile, readFile } from "node:fs/promises"
import type { AssistantMessage, Context } from "@earendil-works/pi-ai"
import { Type } from "typebox"
import { Value } from "typebox/value"

const JournalEntry = Type.Object({
  id: Type.String(),
  model: Type.String(),
  kind: Type.Union([Type.Literal("reserve"), Type.Literal("settle")]),
  usd: Type.Number(),
  timestamp: Type.Integer(),
})

export interface ModelRates {
  readonly input: number
  readonly output: number
}

export function requirePricedModel(model: string, rates: ModelRates): void {
  if (Number.isFinite(rates.input) && rates.input > 0 && Number.isFinite(rates.output) && rates.output > 0) return
  throw new Error(`Workers AI model ${model} has no complete price in the catalog; the spend cap cannot bound it.`)
}

export class ReplaySpendCapError extends Error {
  constructor(limit: number) {
    super(`The $${limit.toFixed(2)} replay spend cap would be exceeded; no model call made.`)
  }
}

function upperBound(context: Context, rates: ModelRates, maxTokens: number): number {
  const bytes = Buffer.byteLength(JSON.stringify(context))
  return (2 * (bytes * rates.input + maxTokens * rates.output)) / 1_000_000
}

export class SpendBudget {
  readonly #path: string
  readonly #limit: number
  #spent: number

  private constructor(path: string, limit: number, spent: number) {
    this.#path = path
    this.#limit = limit
    this.#spent = spent
  }

  static async open(path: string, limit: number): Promise<SpendBudget> {
    if (!existsSync(path)) return new SpendBudget(path, limit, 0)
    const entries = (await readFile(path, "utf8")).split("\n").filter(Boolean)
    let spent = 0
    for (const line of entries) {
      const value = JSON.parse(line)
      if (!Value.Check(JournalEntry, value)) throw new Error("Replay spend journal is malformed")
      spent += value.usd
    }
    return new SpendBudget(path, limit, spent)
  }

  private async record(id: string, model: string, kind: "reserve" | "settle", usd: number): Promise<void> {
    await appendFile(this.#path, `${JSON.stringify({ id, model, kind, usd, timestamp: Date.now() })}\n`)
    this.#spent += usd
  }

  async complete(
    model: string,
    context: Context,
    rates: ModelRates,
    maxTokens: number,
    request: () => Promise<AssistantMessage>,
  ): Promise<AssistantMessage> {
    const reserve = upperBound(context, rates, maxTokens)
    if (this.#spent + reserve > this.#limit) throw new ReplaySpendCapError(this.#limit)
    const id = crypto.randomUUID()
    await this.record(id, model, "reserve", reserve)
    const response = await request()
    if (response.stopReason !== "error" && response.stopReason !== "aborted")
      await this.record(id, model, "settle", response.usage.cost.total - reserve)
    return response
  }
}
