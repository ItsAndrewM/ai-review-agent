/**
 * Why a Pi run ended without an answer, in words a person can act on.
 */

import type { EntryRecord } from "@earendil-works/pi-durable";
import type { PiOperationResult } from "agents/harness/pi";

/** The provider's message from the newest assistant entry that stopped with an error. */
export function lastModelError(messages: readonly EntryRecord[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (entry?.kind !== "pi.assistant") continue;
    for (const message of entry.model ?? []) {
      if (message.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
        return message.errorMessage.slice(0, 500);
      }
    }
  }
  return undefined;
}

export function describeFailure(result: PiOperationResult & { messages?: readonly EntryRecord[] }): string {
  const reason = result.reason ?? "unknown reason";
  const detail = lastModelError(result.messages ?? []);
  return detail ? `${reason}: ${detail}` : reason;
}
