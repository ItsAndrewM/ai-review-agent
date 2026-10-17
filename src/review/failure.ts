import type { EntryRecord } from "@earendil-works/pi-durable"
import type { PiOperationResult } from "agents/harness/pi"

export type TranscriptEntry = Pick<EntryRecord, "kind" | "model">

export function lastModelError(messages: readonly TranscriptEntry[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i]
    if (entry?.kind !== "pi.assistant") continue
    for (const message of entry.model ?? []) {
      if (message.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
        return message.errorMessage.slice(0, 500)
      }
    }
  }
  return undefined
}

export function describeFailure(
  result: PiOperationResult & { messages?: readonly TranscriptEntry[] },
  storedDetail?: string,
): string {
  const reason = result.reason ?? "unknown reason"
  const detail = storedDetail ?? lastModelError(result.messages ?? [])
  return detail ? `${reason}: ${detail}` : reason
}
