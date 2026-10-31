import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type AssistantMessage,
  type Context,
  type ModelThinkingLevel,
  type Provider,
} from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai"
import { reviewThinkingLevel, type ThinkingLevelSetting } from "../../src/models.ts"
import { requirePricedModel, type SpendBudget } from "./budget.ts"

const REQUEST_TIMEOUT_MS = 900_000

export interface ModelOptions {
  modelId: string
  thinking: ThinkingLevelSetting
  account: string
  token: string
  budget: SpendBudget
  maxTokens: number
  wrap?: (provider: Provider) => Provider
}

export interface ReplayModel {
  readonly id: string
  readonly thinking: ModelThinkingLevel
  complete(context: Context): Promise<AssistantMessage>
}

export function thinkingLevelOf(value: string | undefined): ThinkingLevelSetting {
  return reviewThinkingLevel(value ?? "low")
}

export function openModel(options: ModelOptions): ReplayModel {
  const models = createModels()
  const provider = cloudflareWorkersAIProvider()
  models.setProvider(options.wrap === undefined ? provider : options.wrap(provider))
  const model = models.getModel("cloudflare-workers-ai", options.modelId)
  if (model === undefined) throw new Error(`Workers AI model not in the pinned pi-ai catalog: ${options.modelId}`)
  requirePricedModel(options.modelId, model.cost)
  const level = options.thinking
  if (clampThinkingLevel(model, level) !== level) {
    const supported = getSupportedThinkingLevels(model).join(", ")
    throw new Error(`Thinking level "${level}" is not one ${options.modelId} runs; it supports ${supported}.`)
  }
  const settings = {
    apiKey: options.token,
    env: { CLOUDFLARE_ACCOUNT_ID: options.account },
    maxTokens: options.maxTokens,
  }
  return {
    id: options.modelId,
    thinking: level,
    complete: (context) =>
      options.budget.complete(options.modelId, context, model.cost, options.maxTokens, () => {
        const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        return level === "off"
          ? models.completeSimple(model, context, { ...settings, signal })
          : models.completeSimple(model, context, { ...settings, signal, reasoning: level })
      }),
  }
}
