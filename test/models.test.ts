import { fauxAssistantMessage, fauxProvider, normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { withOutputLimit } from "../src/models.ts"

function recordingProvider() {
  const faux = fauxProvider({ models: [{ id: "@cf/openai/gpt-oss-120b", contextWindow: 128_000, maxTokens: 16_000 }] })
  const seen: (SimpleStreamOptions | undefined)[] = []
  faux.setResponses([
    (_context, options) => {
      seen.push(options)
      return fauxAssistantMessage("ok")
    },
  ])
  return { faux, seen }
}

const context = normalizeContext({ messages: [] })

describe("withOutputLimit", () => {
  it("adds the model's output cap when the caller passed none, which Workers AI would hold to 256 tokens", async () => {
    const { faux, seen } = recordingProvider()
    await withOutputLimit(faux.provider).streamSimple(faux.getModel(), context).result()
    expect(seen[0]?.maxTokens).toBe(16_000)
  })

  it("keeps an explicit output cap the caller passed", async () => {
    const { faux, seen } = recordingProvider()
    await withOutputLimit(faux.provider).streamSimple(faux.getModel(), context, { maxTokens: 500 }).result()
    expect(seen[0]?.maxTokens).toBe(500)
  })

  it("leaves the provider's other members in place", () => {
    const { faux } = recordingProvider()
    const wrapped = withOutputLimit(faux.provider)
    expect(wrapped.id).toBe(faux.provider.id)
    expect(wrapped.name).toBe(faux.provider.name)
    expect(wrapped.getModels()).toEqual(faux.provider.getModels())
  })
})
