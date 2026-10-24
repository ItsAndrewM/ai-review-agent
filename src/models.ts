import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ModelThinkingLevel,
  type Provider,
  type TranscriptContext,
} from "@earendil-works/pi-ai"
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { BUDGET_REFUSAL } from "./review/budget.ts"
import { ReviewSubmission, SummarySubmission } from "./review/findings.ts"
import { BUDGET_REFUSAL_MARKER, isResubmitPrompt, isSummaryPrompt } from "./review/prompt.ts"

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

export function withForcedJson(provider: Provider): Provider {
  return {
    ...provider,
    streamSimple: (model, context, options) => {
      const format = forcedFormatOf(context)
      return provider.streamSimple(
        model,
        context,
        format === undefined
          ? options
          : { ...options, samplingParams: { ...options?.samplingParams, response_format: format } },
      )
    },
  }
}

const REVIEW_AS_JSON = { type: "json_schema", json_schema: { name: "review_submission", schema: ReviewSubmission } }
const SUMMARY_AS_JSON = { type: "json_schema", json_schema: { name: "summary_submission", schema: SummarySubmission } }

function forcedFormatOf(context: TranscriptContext) {
  const latest = latestMessage(context)
  if (latest?.role !== "user") return undefined
  const text = userText(latest)
  if (isResubmitPrompt(text)) return REVIEW_AS_JSON
  return isSummaryPrompt(text) ? SUMMARY_AS_JSON : undefined
}

function latestMessage(context: TranscriptContext) {
  return context.messages.filter((message) => message.role !== "system").at(-1)
}

export function withBudgetRefusal(provider: Provider): Provider {
  return {
    ...provider,
    streamSimple: (model, context, options) =>
      isMarkedForRefusal(context) ? refusedStream(model) : provider.streamSimple(model, context, options),
  }
}

function isMarkedForRefusal(context: TranscriptContext): boolean {
  const latest = latestMessage(context)
  return latest?.role === "user" && userText(latest) === BUDGET_REFUSAL_MARKER
}

type RefusedModel = Pick<Model<Api>, "api" | "id" | "provider">

function refusedStream(model: RefusedModel) {
  const stream = createAssistantMessageEventStream()
  stream.push({ type: "error", reason: "error", error: refusedMessage(model) })
  stream.end()
  return stream
}

function refusedMessage(model: RefusedModel): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: BUDGET_REFUSAL,
    timestamp: Date.now(),
  }
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
