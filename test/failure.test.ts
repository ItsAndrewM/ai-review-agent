import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { describeFailure, lastModelError } from "../src/review/failure.ts"

const assistantError = (errorMessage: string) => ({
  kind: "pi.assistant",
  model: [fauxAssistantMessage([], { stopReason: "error", errorMessage })],
})

describe("lastModelError", () => {
  it("finds the newest assistant entry that stopped with an error", () => {
    const messages = [
      assistantError("older"),
      { kind: "pi.user" },
      assistantError("Model is not available on the Workers Free plan"),
    ]
    expect(lastModelError(messages)).toBe("Model is not available on the Workers Free plan")
    expect(lastModelError([{ kind: "pi.assistant", model: [fauxAssistantMessage("done")] }])).toBeUndefined()
    expect(lastModelError([])).toBeUndefined()
  })

  it("describes a failure with its reason and the provider's message when there is one", () => {
    const base = { operationId: "o", session: "1", status: "unanswered" as const }
    expect(describeFailure({ ...base, reason: "model_error", messages: [assistantError("quota")] })).toBe(
      "model_error: quota",
    )
    expect(describeFailure({ ...base, reason: "model_error", messages: [] })).toBe("model_error")
    expect(describeFailure({ ...base })).toBe("unknown reason")
  })
})
