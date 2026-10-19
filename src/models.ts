import type { Message, Provider, TranscriptContext } from "@earendil-works/pi-ai"
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options"
import { ReviewSubmission } from "./review/findings.ts"
import { isResubmitPrompt } from "./review/prompt.ts"

export function withOutputLimit(provider: Provider): Provider {
  return {
    ...provider,
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, {
        ...options,
        maxTokens: options?.maxTokens ?? clampMaxTokensToContext(model, context, model.maxTokens),
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
