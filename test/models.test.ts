import { fauxAssistantMessage, fauxProvider, normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { withOutputLimit } from "../src/models.ts"

const LIMIT = 16_000
const GPT_OSS = { id: "@cf/openai/gpt-oss-120b", contextWindow: 128_000, maxTokens: 16_384 }
const GLM_5_3_FLASH = { id: "@cf/zai-org/glm-5.3-flash", contextWindow: 1_048_576, maxTokens: 1_048_576 }
const SHORT_OUTPUT = { id: "@cf/example/short-output", contextWindow: 128_000, maxTokens: 8_192 }

function recordingProvider(model: typeof GPT_OSS) {
  const faux = fauxProvider({ models: [model] })
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
  it("adds the output limit when the caller passed none, which Workers AI would hold to 256 tokens", async () => {
    const { faux, seen } = recordingProvider(GPT_OSS)
    await withOutputLimit(faux.provider, LIMIT).streamSimple(faux.getModel(), context).result()
    expect(seen[0]?.maxTokens).toBe(16_000)
  })

  it("holds a model whose catalog maximum is its whole context window, as GLM-5.3 Flash's is, to the limit", async () => {
    const { faux, seen } = recordingProvider(GLM_5_3_FLASH)
    await withOutputLimit(faux.provider, LIMIT).streamSimple(faux.getModel(), context).result()
    expect(seen[0]?.maxTokens).toBe(16_000)
  })

  it("keeps a model's own maximum when it is below the limit", async () => {
    const { faux, seen } = recordingProvider(SHORT_OUTPUT)
    await withOutputLimit(faux.provider, LIMIT).streamSimple(faux.getModel(), context).result()
    expect(seen[0]?.maxTokens).toBe(8_192)
  })

  it("keeps an explicit output cap the caller passed", async () => {
    const { faux, seen } = recordingProvider(GPT_OSS)
    await withOutputLimit(faux.provider, LIMIT).streamSimple(faux.getModel(), context, { maxTokens: 500 }).result()
    expect(seen[0]?.maxTokens).toBe(500)
  })

  it("leaves the provider's other members in place", () => {
    const { faux } = recordingProvider(GPT_OSS)
    const wrapped = withOutputLimit(faux.provider, LIMIT)
    expect(wrapped.id).toBe(faux.provider.id)
    expect(wrapped.name).toBe(faux.provider.name)
    expect(wrapped.getModels()).toEqual(faux.provider.getModels())
  })
})
