import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { EntryRecord } from "@earendil-works/pi-durable"
import type { LogFields } from "../log.ts"

export interface TranscriptSummary {
  toolCalls: Record<string, number>
  assistantTurns: number
  outputTokens: number
}

export function summarizeTranscript(entries: readonly Pick<EntryRecord, "model">[]): TranscriptSummary {
  const turns = entries.flatMap((entry) => entry.model ?? []).filter(isAssistant)
  const toolCalls: Record<string, number> = {}
  for (const part of turns.flatMap((message) => message.content)) {
    if (part.type === "toolCall") toolCalls[part.name] = (toolCalls[part.name] ?? 0) + 1
  }
  return {
    toolCalls,
    assistantTurns: turns.length,
    outputTokens: turns.reduce((total, message) => total + message.usage.output, 0),
  }
}

export function transcriptFields(summary: TranscriptSummary): LogFields {
  return {
    tools: Object.entries(summary.toolCalls)
      .map(([name, count]) => `${name}:${count}`)
      .join(" "),
    readFileCalls: summary.toolCalls["read_file"] ?? 0,
    turns: summary.assistantTurns,
    outputTokens: summary.outputTokens,
  }
}

function isAssistant(message: NonNullable<EntryRecord["model"]>[number]): message is AssistantMessage {
  return message.role === "assistant"
}
