import type { EntryRecord } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { describeFailure, lastModelError } from "../src/review/failure.ts"

const assistant = (overrides: object): EntryRecord =>
  ({
    id: "e1",
    conversationId: "1",
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [],
        api: "x",
        provider: "cloudflare",
        model: "m",
        usage: {},
        stopReason: "stop",
        timestamp: 0,
        ...overrides,
      },
    ],
  }) as unknown as EntryRecord

describe("lastModelError", () => {
  it("finds the newest assistant entry that stopped with an error", () => {
    const messages = [
      assistant({ stopReason: "error", errorMessage: "older" }),
      { id: 2, conversationId: 1, kind: "pi.user" } as unknown as EntryRecord,
      assistant({ stopReason: "error", errorMessage: "Model is not available on the Workers Free plan" }),
    ]
    expect(lastModelError(messages)).toBe("Model is not available on the Workers Free plan")
    expect(lastModelError([assistant({ stopReason: "stop" })])).toBeUndefined()
    expect(lastModelError([])).toBeUndefined()
  })

  it("describes a failure with its reason and the provider's message when there is one", () => {
    const base = { operationId: "o", session: "1", status: "unanswered" as const }
    expect(
      describeFailure({
        ...base,
        reason: "model_error",
        messages: [assistant({ stopReason: "error", errorMessage: "quota" })],
      }),
    ).toBe("model_error: quota")
    expect(describeFailure({ ...base, reason: "model_error", messages: [] })).toBe("model_error")
    expect(describeFailure({ ...base })).toBe("unknown reason")
  })
})
