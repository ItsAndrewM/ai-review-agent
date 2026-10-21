import { fauxAssistantMessage, fauxText, type AssistantMessage, type Usage } from "@earendil-works/pi-ai"
import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import {
  callsByModel,
  ReviewSpend,
  reviewSpend,
  usageBaseline,
  spendFields,
  spendLine,
  spendSince,
  UsageTotals,
  usageTotals,
  type ModelSpend,
  type UsageLedger,
} from "../src/review/cost.ts"

const GLM = "cloudflare/@cf/zai-org/glm-5.3-flash"
const KIMI = "cloudflare/@cf/moonshotai/kimi-k2.7-code"

function usage(counts: { input: number; output: number; cacheRead?: number; usd?: number }): Usage {
  const usd = counts.usd ?? 0
  return {
    input: counts.input,
    output: counts.output,
    cacheRead: counts.cacheRead ?? 0,
    cacheWrite: 0,
    totalTokens: counts.input + counts.output + (counts.cacheRead ?? 0),
    cost: { input: usd, output: 0, cacheRead: 0, cacheWrite: 0, total: usd },
  }
}

function call(model: string): AssistantMessage {
  const [provider = "", ...id] = model.split("/")
  return { ...fauxAssistantMessage(fauxText("ok")), provider, model: id.join("/") }
}

function spend(overrides: Partial<ModelSpend>): ModelSpend {
  return {
    model: GLM,
    calls: 3,
    inputTokens: 61_204,
    cachedTokens: 40_000,
    outputTokens: 4_811,
    usd: 0.006692,
    priced: true,
    ...overrides,
  }
}

describe("usageTotals", () => {
  it("keeps the counters pi's ledger records per model, with the cost as dollars", () => {
    const totals = usageTotals({ models: { [GLM]: usage({ input: 20, output: 5, cacheRead: 40, usd: 0.25 }) } })
    expect(totals).toEqual({ [GLM]: { input: 20, output: 5, cacheRead: 40, cacheWrite: 0, usd: 0.25 } })
    expect(Value.Check(UsageTotals, totals)).toBe(true)
  })
})

describe("callsByModel", () => {
  it("counts the model's responses by provider and model, skipping the prompt and tool results", () => {
    const prompt = { role: "user" as const, content: "Review this pull request.", timestamp: 0 }
    expect(
      callsByModel([{ model: [prompt] }, { model: [call(GLM)] }, {}, { model: [call(GLM)] }, { model: [call(KIMI)] }]),
    ).toEqual(
      new Map([
        [GLM, 2],
        [KIMI, 1],
      ]),
    )
  })
})

describe("spendSince", () => {
  const before = { [GLM]: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, usd: 0.001 } }

  it("charges the review only what the ledger grew by since it started, cached input counted as input", () => {
    const after = { [GLM]: { input: 21_304, output: 4_821, cacheRead: 40_050, cacheWrite: 0, usd: 0.007692 } }
    const [glm] = spendSince(before, after, new Map([[GLM, 3]]))
    expect(glm).toMatchObject({ model: GLM, calls: 3, inputTokens: 61_204, cachedTokens: 40_000, outputTokens: 4_811 })
    expect(glm?.usd).toBeCloseTo(0.006692, 9)
  })

  it("leaves out a model the review didn't use, and keeps one whose calls reported no usage", () => {
    const after = { ...before, [KIMI]: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 } }
    expect(spendSince(before, after, new Map([[KIMI, 2]]))).toEqual([
      { model: KIMI, calls: 2, inputTokens: 0, cachedTokens: 0, outputTokens: 0, usd: 0, priced: false },
    ])
  })

  it("never charges less than nothing when the dollar sums differ only by rounding", () => {
    const summed = { [GLM]: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, usd: 0.1 + 0.2 } }
    const after = { [GLM]: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, usd: 0.3 } }
    expect(spendSince(summed, after, new Map([[GLM, 1]]))[0]?.usd).toBe(0)
  })

  it("keeps a model priced when its ledger has dollars, even if the review's share rounds to nothing", () => {
    const summed = { [GLM]: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, usd: 0.1 + 0.2 } }
    const after = { [GLM]: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, usd: 0.3 } }
    const spend = spendSince(summed, after, new Map([[GLM, 1]]))
    expect(spend[0]?.priced).toBe(true)
    expect(spendLine(spend)).toBe("1 model call · 0 in / 10 out tokens · < 1 neuron (<$0.001)")
  })

  it("marks a model unpriced when its ledger has never recorded a dollar", () => {
    const after = { [KIMI]: { input: 900, output: 120, cacheRead: 0, cacheWrite: 0, usd: 0 } }
    expect(spendSince({}, after, new Map([[KIMI, 1]]))[0]?.priced).toBe(false)
  })

  it("is a list the posted record can store", () => {
    expect(Value.Check(ReviewSpend, spendSince({}, before, new Map([[GLM, 1]])))).toBe(true)
  })
})

describe("spendLine", () => {
  it("shows the calls, the tokens and the cost in neurons and dollars", () => {
    expect(spendLine([spend({})])).toBe("3 model calls · 61k in / 4.8k out tokens · ≈ 608 neurons ($0.007)")
  })

  it("says call, not calls, for a single response", () => {
    expect(spendLine([spend({ calls: 1, inputTokens: 900, outputTokens: 120 })])).toMatch(
      /^1 model call · 900 in \/ 120 out tokens · /,
    )
  })

  it("rounds the tokens to what a reader can take in at a glance", () => {
    const tokens = (inputTokens: number) => spendLine([spend({ inputTokens, outputTokens: 1_000 })])
    expect(tokens(999)).toContain(" 999 in / 1k out ")
    expect(tokens(9_949)).toContain(" 9.9k in ")
    expect(tokens(9_950)).toContain(" 10k in ")
    expect(tokens(999_499)).toContain(" 999k in ")
    expect(tokens(999_500)).toContain(" 1M in ")
    expect(tokens(1_249_999)).toContain(" 1.2M in ")
  })

  it("separates thousands of neurons and floors tiny dollar amounts at a tenth of a cent", () => {
    expect(spendLine([spend({ usd: 0.1 })])).toContain("≈ 9,091 neurons ($0.100)")
    expect(spendLine([spend({ usd: 0.000_005 })])).toContain(" · < 1 neuron (<$0.001)")
  })

  it("adds up every model the review used", () => {
    const line = spendLine([spend({ usd: 0.005 }), spend({ model: KIMI, calls: 1, usd: 0.006 })])
    expect(line).toBe("4 model calls · 122k in / 9.6k out tokens · ≈ 1,000 neurons ($0.011)")
  })

  it("calls the cost unknown when the model has no price, rather than calling the review free", () => {
    expect(spendLine([spend({ usd: 0, priced: false })])).toBe(
      "3 model calls · 61k in / 4.8k out tokens · cost unknown",
    )
  })

  it("prices what it can and names each model it couldn't", () => {
    expect(spendLine([spend({}), spend({ model: KIMI, calls: 1, usd: 0, priced: false })])).toBe(
      "4 model calls · 122k in / 9.6k out tokens · ≈ 608 neurons ($0.007) + unpriced @cf/moonshotai/kimi-k2.7-code",
    )
  })

  it("calls the cost unknown when the only model with tokens is unpriced, beside one whose calls reported none", () => {
    const silent = spend({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, usd: 0, priced: true })
    expect(spendLine([spend({ model: KIMI, usd: 0, priced: false }), silent])).toBe(
      "6 model calls · 61k in / 4.8k out tokens · cost unknown",
    )
  })

  it("says the usage went unreported when no call counted a token", () => {
    expect(spendLine([spend({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, usd: 0 })])).toBe(
      "3 model calls · usage not reported",
    )
  })

  it("has nothing to say when the review made no calls", () => {
    expect(spendLine([])).toBeUndefined()
  })
})

describe("spendFields", () => {
  it("logs the exact totals, the models with their calls, and the cost to a tenth of a neuron", () => {
    expect(spendFields([spend({}), spend({ model: KIMI, calls: 1, usd: 0.01 })])).toEqual({
      calls: 4,
      inputTokens: 122_408,
      cachedTokens: 80_000,
      outputTokens: 9_622,
      models: `${GLM}:3 ${KIMI}:1`,
      neurons: 1517.5,
      usd: expect.closeTo(0.016692, 12),
    })
  })

  it("leaves the cost out when any model is unpriced, so a query never averages in a false zero", () => {
    const fields = spendFields([spend({}), spend({ model: KIMI, calls: 1, usd: 0, priced: false })])
    expect(fields).toMatchObject({ calls: 4, inputTokens: 122_408 })
    expect(fields).not.toHaveProperty("neurons")
    expect(fields).not.toHaveProperty("usd")
  })

  it("leaves the cost out when the usage went unreported", () => {
    const fields = spendFields([spend({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, usd: 0 })])
    expect(fields).not.toHaveProperty("neurons")
    expect(fields).not.toHaveProperty("usd")
  })

  it("logs nothing for a review with no recorded spend", () => {
    expect(spendFields(undefined)).toEqual({})
  })
})

describe("reading the ledger", () => {
  const ledger = (state: { models: Record<string, Usage> }, calls: AssistantMessage[]): UsageLedger => ({
    usage: async () => state,
    messages: async () => calls.map((message) => ({ model: [message] })),
  })
  const broken: UsageLedger = {
    usage: async () => Promise.reject(new Error("storage closed")),
    messages: async () => Promise.reject(new Error("storage closed")),
  }

  it("takes the baseline as the ledger stands", async () => {
    const state = { models: { [GLM]: usage({ input: 20, output: 5, usd: 0.25 }) } }
    expect(await usageBaseline(ledger(state, []))).toEqual({
      [GLM]: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, usd: 0.25 },
    })
  })

  it("starts the review with no baseline when the ledger can't be read, rather than failing it", async () => {
    expect(await usageBaseline(broken)).toBeUndefined()
  })

  it("measures the spend since the baseline, with the calls from the transcript", async () => {
    const before = { [GLM]: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, usd: 0.25 } }
    const state = { models: { [GLM]: usage({ input: 120, output: 25, usd: 0.5 }) } }
    expect(await reviewSpend(ledger(state, [call(GLM), call(GLM)]), before)).toEqual([
      { model: GLM, calls: 2, inputTokens: 100, cachedTokens: 0, outputTokens: 20, usd: 0.25, priced: true },
    ])
  })

  it("has no spend for a review that started with no baseline, so the summary posts without a cost line", async () => {
    const state = { models: { [GLM]: usage({ input: 120, output: 25, usd: 0.5 }) } }
    expect(await reviewSpend(ledger(state, [call(GLM)]), undefined)).toEqual([])
  })

  it("has no spend when the ledger can't be read at the end, so the review still posts", async () => {
    expect(await reviewSpend(broken, {})).toEqual([])
  })
})
