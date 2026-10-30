import type { AssistantMessage, Context, Message, ToolCall } from "@earendil-works/pi-ai"
import { errorText } from "../../src/log.ts"
import { BUDGET_REFUSAL } from "../../src/review/budget.ts"
import { parseWrittenReview, type WrittenReview } from "../../src/review/findings.ts"
import { BUDGET_REFUSAL_MARKER, resubmitPrompt } from "../../src/review/prompt.ts"
import { ReplaySpendCapError } from "../replay/budget.ts"
import { neuronsOf, type NeuronBudget } from "./budget.ts"
import type { HostOutcome, PostedReview, ReviewHost } from "./host.ts"
import type { RecallTools } from "./tools.ts"

export const MAX_TURNS = 24

export type ReviewSource = "tool" | "text" | "retry" | "retry_text"

export type UnpostedReason = "prose" | "unfit" | "incomplete" | "budget" | "turns" | "error"

export interface ReviewAnswer {
  readonly posted: PostedReview | undefined
  readonly source: ReviewSource | undefined
  readonly reason?: UnpostedReason
  readonly failure?: string
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly usd: number
  readonly neurons: number
}

type Complete = (context: Context) => Promise<AssistantMessage>

type Phase = "review" | "retry"

interface Run {
  readonly context: Context
  readonly responses: AssistantMessage[]
  readonly tools: RecallTools
  readonly host: ReviewHost
  readonly budget: NeuronBudget
  phase: Phase
}

type Ending =
  | { kind: "posted"; source: ReviewSource }
  | { kind: "unposted"; reason: UnpostedReason; failure?: string }
  | { kind: "continue" }

export async function attemptReview(
  system: string,
  prompt: string,
  tools: RecallTools,
  host: ReviewHost,
  budget: NeuronBudget,
  complete: Complete,
): Promise<ReviewAnswer> {
  try {
    return await replayReview(system, prompt, tools, host, budget, complete)
  } catch (cause) {
    if (cause instanceof ReplaySpendCapError) throw cause
    return answer([], host, { kind: "unposted", reason: "error", failure: errorText(cause) })
  }
}

export async function replayReview(
  system: string,
  prompt: string,
  tools: RecallTools,
  host: ReviewHost,
  budget: NeuronBudget,
  complete: Complete,
): Promise<ReviewAnswer> {
  const run: Run = {
    context: {
      systemPrompt: system,
      tools: tools.descriptions(),
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    responses: [],
    tools,
    host,
    budget,
    phase: "review",
  }
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const ending = await oneTurn(run, complete)
    if (ending.kind !== "continue") return answer(run.responses, host, ending)
  }
  return answer(run.responses, host, { kind: "unposted", reason: "turns" })
}

async function oneTurn(run: Run, complete: Complete): Promise<Ending> {
  if (run.budget.refuses()) run.context.messages.push(marker())
  const response = await complete(run.context)
  run.responses.push(response)
  run.budget.add(response.usage.cost.total)
  if (response.stopReason === "error" || response.stopReason === "aborted") return failed(response)
  run.context.messages.push(response)
  const calls = response.content.filter((part): part is ToolCall => part.type === "toolCall")
  return calls.length === 0 ? textEnding(run, response) : serveCalls(run, calls)
}

function failed(response: AssistantMessage): Ending {
  const failure = response.errorMessage ?? response.stopReason
  return failure === BUDGET_REFUSAL
    ? { kind: "unposted", reason: "budget" }
    : { kind: "unposted", reason: "error", failure }
}

function marker(): Message {
  return { role: "user", content: BUDGET_REFUSAL_MARKER, timestamp: Date.now() }
}

function textOf(response: AssistantMessage): string {
  return response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function textEnding(run: Run, response: AssistantMessage): Ending {
  const written = parseWrittenReview(textOf(response))
  return run.phase === "review" ? askAgain(run, written) : retryText(run, written)
}

function askAgain(run: Run, written: WrittenReview): Ending {
  let refusal: string | undefined
  if (written.kind === "submission") {
    const outcome = run.host.submit(written.submission)
    const ending = endingOf(outcome, "text")
    if (ending !== undefined) return ending
    refusal = outcome.text
  }
  const rowsNeeded = refusal === undefined ? run.host.rowsNeeded() : []
  run.context.messages.push({ role: "user", content: resubmitPrompt(refusal, rowsNeeded), timestamp: Date.now() })
  run.phase = "retry"
  return { kind: "continue" }
}

function retryText(run: Run, written: WrittenReview): Ending {
  if (written.kind !== "submission") return { kind: "unposted", reason: written.kind === "prose" ? "prose" : "unfit" }
  run.host.markRejectionsReturned()
  const outcome = run.host.submit(written.submission)
  return endingOf(outcome, "retry_text") ?? { kind: "unposted", reason: "incomplete" }
}

function endingOf(outcome: HostOutcome, source: ReviewSource): Ending | undefined {
  if (outcome.posted !== undefined) return { kind: "posted", source }
  return outcome.incomplete === true ? { kind: "unposted", reason: "incomplete" } : undefined
}

async function serveCalls(run: Run, calls: readonly ToolCall[]): Promise<Ending> {
  for (const call of calls) {
    const blocked = run.budget.blockFor(call.name)
    const served =
      blocked !== undefined
        ? { text: blocked, done: false }
        : call.argumentsError !== undefined
          ? { text: call.argumentsError, done: false }
          : await run.tools.execute(call.name, call.arguments)
    run.context.messages.push({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: served.text }],
      isError: call.argumentsError !== undefined,
      timestamp: Date.now(),
    })
    if (served.done) {
      if (run.host.posted() !== undefined) return { kind: "posted", source: run.phase === "review" ? "tool" : "retry" }
      return { kind: "unposted", reason: "incomplete" }
    }
  }
  return { kind: "continue" }
}

function answer(
  responses: readonly AssistantMessage[],
  host: ReviewHost,
  ending: Exclude<Ending, { kind: "continue" }>,
) {
  const usage = responses.reduce(
    (total, response) => ({
      calls: total.calls + 1,
      inputTokens: total.inputTokens + response.usage.input,
      outputTokens: total.outputTokens + response.usage.output,
      usd: total.usd + response.usage.cost.total,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
  )
  const base = { ...usage, neurons: neuronsOf(usage.usd) }
  if (ending.kind === "posted") return { ...base, posted: host.posted(), source: ending.source }
  const unposted: ReviewAnswer = { ...base, posted: undefined, source: undefined, reason: ending.reason }
  return ending.failure === undefined ? unposted : { ...unposted, failure: ending.failure }
}
