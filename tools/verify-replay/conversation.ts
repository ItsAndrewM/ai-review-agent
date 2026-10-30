import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai"
import { errorText } from "../../src/log.ts"
import { parseVerdictsText, type VerdictInput } from "../../src/review/verify.ts"
import { ReplaySpendCapError } from "../replay/budget.ts"
import { ReplayTools } from "./tools.ts"

const MAX_TURNS = 16

export interface ReplayAnswer {
  readonly verdicts: readonly VerdictInput[]
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly usd: number
  readonly failure?: string
}

type Complete = (context: Context) => Promise<AssistantMessage>

export async function attemptReplay(
  system: string,
  prompt: string,
  tools: ReplayTools,
  complete: Complete,
): Promise<ReplayAnswer> {
  try {
    return await replayConversation(system, prompt, tools, complete)
  } catch (cause) {
    if (cause instanceof ReplaySpendCapError) throw cause
    return { verdicts: [], calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, failure: errorText(cause) }
  }
}

function responseUsage(
  messages: readonly AssistantMessage[],
): Pick<ReplayAnswer, "calls" | "inputTokens" | "outputTokens" | "usd"> {
  return messages.reduce(
    (total, response) => ({
      calls: total.calls + 1,
      inputTokens: total.inputTokens + response.usage.input,
      outputTokens: total.outputTokens + response.usage.output,
      usd: total.usd + response.usage.cost.total,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
  )
}

function answer(
  messages: readonly AssistantMessage[],
  verdicts: readonly VerdictInput[],
  failure?: string,
): ReplayAnswer {
  const usage = responseUsage(messages)
  return failure === undefined ? { ...usage, verdicts } : { ...usage, verdicts, failure }
}

export async function replayConversation(
  system: string,
  prompt: string,
  tools: ReplayTools,
  complete: Complete,
): Promise<ReplayAnswer> {
  const context: Context = {
    systemPrompt: system,
    tools: tools.descriptions(),
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  }
  const responses: AssistantMessage[] = []
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await complete(context)
    responses.push(response)
    if (response.stopReason === "error" || response.stopReason === "aborted")
      return answer(responses, [], response.errorMessage ?? response.stopReason)
    context.messages.push(response)
    const calls = response.content.filter((part): part is ToolCall => part.type === "toolCall")
    if (calls.length === 0) return textAnswer(responses, response)
    const submitted = await serveCalls(context, calls, tools)
    if (submitted !== undefined)
      return answer(responses, submitted, submitted.length === 0 ? "no usable verdicts" : undefined)
  }
  return answer(responses, [], `no usable verdicts after ${MAX_TURNS} model calls`)
}

function textAnswer(responses: readonly AssistantMessage[], response: AssistantMessage): ReplayAnswer {
  const text = response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const verdicts = parseVerdictsText(text)
  return answer(responses, verdicts ?? [], verdicts === undefined ? "no usable verdicts" : undefined)
}

async function serveCalls(
  context: Context,
  calls: readonly ToolCall[],
  tools: ReplayTools,
): Promise<readonly VerdictInput[] | undefined> {
  for (const call of calls) {
    const output = call.argumentsError ?? (await tools.execute(call.name, call.arguments))
    context.messages.push({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: output }],
      isError: call.argumentsError !== undefined,
      timestamp: Date.now(),
    })
    const submitted = tools.verdicts()
    if (submitted !== undefined) return submitted
  }
  return undefined
}
