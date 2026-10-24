import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai"
import { afterEach, describe, expect, it } from "vitest"
import { ReplaySpendCapError, SpendBudget, requirePricedModel } from "../tools/verify-replay/budget.ts"
import { attemptReplay } from "../tools/verify-replay/conversation.ts"
import { ReplayTools } from "../tools/verify-replay/tools.ts"

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function journal(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "verify-budget-"))
  directories.push(directory)
  return join(directory, "spend.jsonl")
}

const context = { messages: [{ role: "user" as const, content: "judge the finding", timestamp: 0 }] }
const rates = { input: 0.95, output: 4 }
const response = {
  ...fauxAssistantMessage([fauxText("done")]),
  usage: {
    ...fauxAssistantMessage([fauxText("done")]).usage,
    cost: { input: 0.05, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
  },
}

describe("SpendBudget", () => {
  it("refuses an unpriced model before any inference can evade the spend limit", () => {
    expect(() => requirePricedModel("unpriced", { input: 0, output: 0 })).toThrow("spend cap cannot bound it")
    expect(() => requirePricedModel("partly-priced", { input: 0.95, output: 0 })).toThrow("spend cap cannot bound it")
    expect(() => requirePricedModel("priced", rates)).not.toThrow()
  })

  it("shares the $2 cap between separate model invocations through its journal", async () => {
    const path = await journal()
    const budget = await SpendBudget.open(path, 0.15)
    let calls = 0
    await budget.complete("model", context, rates, 16_000, async () => {
      calls++
      return response
    })
    const resumed = await SpendBudget.open(path, 0.15)
    await expect(
      resumed.complete("model", context, rates, 16_000, async () => {
        calls++
        return response
      }),
    ).rejects.toThrow("replay spend cap")
    expect(calls).toBe(1)
  })

  it("keeps its reserve when a request throws so retrying cannot omit uncertain spend", async () => {
    const path = await journal()
    const budget = await SpendBudget.open(path, 0.15)
    await expect(
      budget.complete("model", context, rates, 16_000, async () => {
        throw new Error("transport failed")
      }),
    ).rejects.toThrow("transport failed")
    const resumed = await SpendBudget.open(path, 0.15)
    await expect(resumed.complete("model", context, rates, 16_000, async () => response)).rejects.toThrow(
      "replay spend cap",
    )
    expect((await readFile(path, "utf8")).split("\n").filter(Boolean)).toHaveLength(1)
  })

  it("stops the replay when the cap is reached instead of scoring every remaining batch as unjudged", async () => {
    const tools = new ReplayTools({ readFile: async () => "", grep: async () => "", tree: async () => "" })
    await expect(
      attemptReplay("system", "finding", tools, async () => {
        throw new ReplaySpendCapError(2)
      }),
    ).rejects.toThrow("replay spend cap")
  })
})
