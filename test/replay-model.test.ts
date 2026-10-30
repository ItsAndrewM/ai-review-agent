import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { SpendBudget } from "../tools/replay/budget.ts"
import { openModel, thinkingLevelOf } from "../tools/replay/model.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function options() {
  const directory = await mkdtemp(join(tmpdir(), "replay-model-"))
  directories.push(directory)
  const budget = await SpendBudget.open(join(directory, "spend.jsonl"), 15)
  return {
    modelId: "@cf/zai-org/glm-5.3-flash",
    thinking: "low" as const,
    account: "a",
    token: "t",
    budget,
    maxTokens: 16_000,
  }
}

describe("openModel", () => {
  it("refuses a thinking level the model would clamp", async () => {
    const opened = await options()
    expect(() => openModel({ ...opened, thinking: "medium" })).toThrow(
      'Thinking level "medium" is not one @cf/zai-org/glm-5.3-flash runs; it supports low, high, max.',
    )
  })

  it("opens a supported level without a model call", async () => {
    const model = openModel({ ...(await options()), thinking: "high" })
    expect(model.id).toBe("@cf/zai-org/glm-5.3-flash")
    expect(model.thinking).toBe("high")
  })

  it("refuses a model the pinned catalog lacks", async () => {
    const opened = await options()
    expect(() => openModel({ ...opened, modelId: "@cf/nobody/none" })).toThrow(
      "Workers AI model not in the pinned pi-ai catalog: @cf/nobody/none",
    )
  })
})

describe("thinkingLevelOf", () => {
  it("defaults to low and parses a named level", () => {
    expect(thinkingLevelOf(undefined)).toBe("low")
    expect(thinkingLevelOf("high")).toBe("high")
    expect(() => thinkingLevelOf("loud")).toThrow('REVIEW_THINKING_LEVEL is "loud"')
  })
})
