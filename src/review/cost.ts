import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { EntryRecord, UsageState } from "@earendil-works/pi-durable"
import { Type, type Static } from "typebox"
import { errorText, logError, type LogFields } from "../log.ts"

const USD_PER_THOUSAND_NEURONS = 0.011

const UsageTally = Type.Object({
  input: Type.Integer(),
  output: Type.Integer(),
  cacheRead: Type.Integer(),
  cacheWrite: Type.Integer(),
  usd: Type.Number(),
})

type UsageTally = Static<typeof UsageTally>

export const UsageTotals = Type.Record(Type.String(), UsageTally)

export type UsageTotals = Static<typeof UsageTotals>

const ModelSpend = Type.Object({
  model: Type.String(),
  calls: Type.Integer(),
  inputTokens: Type.Integer(),
  cachedTokens: Type.Integer(),
  outputTokens: Type.Integer(),
  usd: Type.Number(),
  priced: Type.Boolean(),
})

export type ModelSpend = Static<typeof ModelSpend>

export const ReviewSpend = Type.Array(ModelSpend)

export type ReviewSpend = Static<typeof ReviewSpend>

const NO_USAGE: UsageTally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 }

export interface UsageLedger {
  usage(): Promise<Pick<UsageState, "models">>
  messages(): Promise<readonly Pick<EntryRecord, "model">[]>
}

export async function usageBaseline(ledger: UsageLedger): Promise<UsageTotals | undefined> {
  try {
    return usageTotals(await ledger.usage())
  } catch (error) {
    logError("review.usage_unreadable", { when: "start", error: errorText(error) })
    return undefined
  }
}

export async function reviewSpend(ledger: UsageLedger, before: UsageTotals | undefined): Promise<ReviewSpend> {
  if (before === undefined) return []
  try {
    const calls = callsByModel(await ledger.messages())
    return spendSince(before, usageTotals(await ledger.usage()), calls)
  } catch (error) {
    logError("review.usage_unreadable", { when: "spend", error: errorText(error) })
    return []
  }
}

export function usageTotals(state: Pick<UsageState, "models">): UsageTotals {
  return Object.fromEntries(
    Object.entries(state.models).map(([model, usage]) => [
      model,
      {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        usd: usage.cost.total,
      },
    ]),
  )
}

export function callsByModel(entries: readonly Pick<EntryRecord, "model">[]): Map<string, number> {
  const calls = new Map<string, number>()
  for (const message of entries.flatMap((entry) => entry.model ?? []).filter(isAssistant)) {
    const model = `${message.provider}/${message.model}`
    calls.set(model, (calls.get(model) ?? 0) + 1)
  }
  return calls
}

export function spendSince(before: UsageTotals, after: UsageTotals, calls: ReadonlyMap<string, number>): ReviewSpend {
  const models = [...new Set([...Object.keys(after), ...calls.keys()])]
  return models
    .map((model) => modelSpend(model, before[model] ?? NO_USAGE, after[model] ?? NO_USAGE, calls.get(model) ?? 0))
    .filter((spend) => spend.calls > 0 || tokensOf(spend) > 0)
}

function modelSpend(model: string, before: UsageTally, after: UsageTally, calls: number): ModelSpend {
  const grown = (key: keyof UsageTally) => Math.max(0, after[key] - before[key])
  return {
    model,
    calls,
    inputTokens: grown("input") + grown("cacheRead") + grown("cacheWrite"),
    cachedTokens: grown("cacheRead"),
    outputTokens: grown("output"),
    usd: grown("usd"),
    priced: after.usd > 0,
  }
}

export function neuronsSince(before: UsageTotals, after: UsageTotals): number | undefined {
  const grown = spendSince(before, after, new Map<string, number>())
  const priced = grown.filter((model) => !isUnpriced(model))
  if (grown.length > 0 && priced.length === 0) return undefined
  return neuronsOf(sum(priced, (model) => model.usd))
}

interface SpendTotals {
  calls: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  usd: number
  unpriced: string[]
}

function totalsOf(spend: ReviewSpend): SpendTotals {
  return {
    calls: sum(spend, (model) => model.calls),
    inputTokens: sum(spend, (model) => model.inputTokens),
    cachedTokens: sum(spend, (model) => model.cachedTokens),
    outputTokens: sum(spend, (model) => model.outputTokens),
    usd: sum(spend, (model) => model.usd),
    unpriced: spend.filter(isUnpriced).map((model) => model.model),
  }
}

export const SANDBOX_USD_PER_SECOND = 0.00002056

export function sandboxUsd(seconds: number): number {
  return seconds * SANDBOX_USD_PER_SECOND
}

export function sandboxFields(seconds: number | undefined): LogFields {
  if (seconds === undefined || seconds <= 0) return {}
  return { sandboxSeconds: seconds, sandboxUsd: sandboxUsd(seconds) }
}

export function spendLine(spend: ReviewSpend, sandboxSeconds?: number): string | undefined {
  if (spend.length === 0) return undefined
  const totals = totalsOf(spend)
  const calls = `${totals.calls} model call${totals.calls === 1 ? "" : "s"}`
  if (tokensOf(totals) === 0) return [calls, "usage not reported", ...sandboxPart(sandboxSeconds)].join(" · ")
  const tokens = `${tokenCount(totals.inputTokens)} in / ${tokenCount(totals.outputTokens)} out tokens`
  const price = priceText(totals, spend.filter((model) => tokensOf(model) > 0).length)
  return [calls, tokens, price, ...sandboxPart(sandboxSeconds)].join(" · ")
}

function sandboxPart(seconds: number | undefined): string[] {
  if (seconds === undefined || seconds <= 0) return []
  return [`sandbox ${durationText(seconds)} (${dollarText(sandboxUsd(seconds))})`]
}

function durationText(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return [hours > 0 ? `${hours}h` : "", minutes > 0 || hours > 0 ? `${minutes}m` : "", `${rest}s`]
    .filter((part) => part !== "")
    .join(" ")
}

function priceText(totals: SpendTotals, modelsWithTokens: number): string {
  if (totals.unpriced.length === modelsWithTokens) return "cost unknown"
  const price = `${neuronText(neuronsOf(totals.usd))} (${dollarText(totals.usd)})`
  if (totals.unpriced.length === 0) return price
  return `${price} + unpriced ${totals.unpriced.map(modelName).join(", ")}`
}

export function spendFields(spend: ReviewSpend | undefined): LogFields {
  if (spend === undefined || spend.length === 0) return {}
  const totals = totalsOf(spend)
  const fields: LogFields = {
    calls: totals.calls,
    inputTokens: totals.inputTokens,
    cachedTokens: totals.cachedTokens,
    outputTokens: totals.outputTokens,
    models: spend.map((model) => `${model.model}:${model.calls}`).join(" "),
  }
  if (totals.unpriced.length > 0 || tokensOf(totals) === 0) return fields
  return { ...fields, neurons: Math.round(neuronsOf(totals.usd) * 10) / 10, usd: totals.usd }
}

function isUnpriced(spend: ModelSpend): boolean {
  return tokensOf(spend) > 0 && !spend.priced
}

function tokensOf(spend: Pick<ModelSpend, "inputTokens" | "outputTokens">): number {
  return spend.inputTokens + spend.outputTokens
}

function neuronsOf(usd: number): number {
  return (usd / USD_PER_THOUSAND_NEURONS) * 1000
}

function neuronText(neurons: number): string {
  const rounded = Math.round(neurons)
  if (rounded === 0) return "< 1 neuron"
  return `≈ ${rounded.toLocaleString("en-US")} ${rounded === 1 ? "neuron" : "neurons"}`
}

function dollarText(usd: number): string {
  return usd < 0.0005 ? "<$0.001" : `$${usd.toFixed(3)}`
}

function tokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  if (tokens < 9_950) return `${tenths(tokens / 1_000)}k`
  if (tokens < 999_500) return `${Math.round(tokens / 1_000)}k`
  return `${tenths(tokens / 1_000_000)}M`
}

function tenths(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "")
}

function modelName(model: string): string {
  return model.slice(model.indexOf("/") + 1)
}

function sum(spend: ReviewSpend, count: (model: ModelSpend) => number): number {
  return spend.reduce((total, model) => total + count(model), 0)
}

function isAssistant(message: NonNullable<EntryRecord["model"]>[number]): message is AssistantMessage {
  return message.role === "assistant"
}
