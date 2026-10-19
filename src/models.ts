import type { Message, ModelThinkingLevel, Provider, TranscriptContext } from "@earendil-works/pi-ai"
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { ReviewSubmission } from "./review/findings.ts"
import { isResubmitPrompt } from "./review/prompt.ts"

const DEFAULT_OUTPUT_LIMIT = 16_000

export function outputLimitOf(value: string): number {
  const limit = Number(value)
  return Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_OUTPUT_LIMIT
}

export function withOutputLimit(provider: Provider, limit: number): Provider {
  return {
    ...provider,
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, {
        ...options,
        maxTokens: options?.maxTokens ?? clampMaxTokensToContext(model, context, Math.min(model.maxTokens, limit)),
      }),
  }
}

export function withForcedResubmission(provider: Provider): Provider {
  return {
    ...provider,
    streamSimple: (model, context, options) =>
      provider.streamSimple(
        model,
        context,
        awaitsResubmission(context)
          ? { ...options, samplingParams: { ...options?.samplingParams, response_format: REVIEW_AS_JSON } }
          : options,
      ),
  }
}

const REVIEW_AS_JSON = { type: "json_schema", json_schema: { name: "review_submission", schema: ReviewSubmission } }

function awaitsResubmission(context: TranscriptContext): boolean {
  const latest = context.messages.filter((message) => message.role !== "system").at(-1)
  return latest?.role === "user" && isResubmitPrompt(userText(latest))
}

function userText(message: Extract<Message, { role: "user" }>): string {
  if (!Array.isArray(message.content)) return message.content
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

const ThinkingLevelSetting = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
])

export function reviewThinkingLevel(setting: string): ModelThinkingLevel {
  if (Value.Check(ThinkingLevelSetting, setting)) return setting
  throw new Error(
    `REVIEW_THINKING_LEVEL is "${setting}"; it must be one of off, minimal, low, medium, high, xhigh or max.`,
  )
}
