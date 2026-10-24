import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  normalizeContext,
  type Message,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import type { PullRequestInfo } from "../src/github/client.ts"
import {
  outputLimitOf,
  reviewThinkingLevel,
  withBudgetRefusal,
  withForcedJson,
  withOutputLimit,
} from "../src/models.ts"
import { BUDGET_REFUSAL } from "../src/review/budget.ts"
import { ReviewSubmission, SummarySubmission } from "../src/review/findings.ts"
import { answerPrompt, BUDGET_REFUSAL_MARKER, resubmitPrompt, summaryPrompt } from "../src/review/prompt.ts"

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

function user(content: Extract<Message, { role: "user" }>["content"]) {
  return { role: "user" as const, content, timestamp: 0 }
}

async function optionsSentFor(messages: Message[]) {
  const { faux, seen } = recordingProvider(GPT_OSS)
  await withForcedJson(faux.provider).streamSimple(faux.getModel(), normalizeContext({ messages })).result()
  return seen[0]
}

const pr = {
  number: 21,
  title: "Fix totals",
  body: "Totals were NaN for an empty cart.",
  state: "open",
  user: { login: "andrew" },
  base: { ref: "main", sha: "0123456789abcdef", repo: { full_name: "o/r" } },
  head: { ref: "fix/totals.GH-7", sha: "fedcba9876543210" },
  changed_files: 0,
  additions: 0,
  deletions: 0,
  labels: [],
} satisfies PullRequestInfo

const reviewRequest = user("Review this pull request and submit the review with submit_review.")
const proseReview = fauxAssistantMessage("## Summary\nLooks risky.\n\n**Verdict:** request_changes")
const reviewAsJson = { type: "json_schema", json_schema: { name: "review_submission", schema: ReviewSubmission } }
const summaryAsJson = { type: "json_schema", json_schema: { name: "summary_submission", schema: SummarySubmission } }

describe("withForcedJson", () => {
  it.each([undefined, "Error: GitHub POST /repos/o/r/pulls/5/reviews: 502"])(
    "holds the retry after a prose review to a submit_review call or the review as JSON, since Workers AI ignores tool_choice (refusal %s)",
    async (refusal) => {
      const options = await optionsSentFor([reviewRequest, proseReview, user(resubmitPrompt(refusal, ["src/x.ts"]))])
      expect(options?.samplingParams?.["response_format"]).toEqual(reviewAsJson)
    },
  )

  it("holds the retry to JSON when it arrives as text parts", async () => {
    const retry = user([fauxText(resubmitPrompt(undefined, ["src/x.ts"]))])
    const options = await optionsSentFor([reviewRequest, proseReview, retry])
    expect(options?.samplingParams?.["response_format"]).toEqual(reviewAsJson)
  })

  it("leaves the review's own requests free to read files or answer in text", async () => {
    const readFile = fauxAssistantMessage(fauxToolCall("read_file", { path: "src/x.ts" }, { id: "c1" }))
    const fileContents = {
      role: "toolResult" as const,
      toolCallId: "c1",
      toolName: "read_file",
      content: [fauxText("export const x = 1")],
      isError: false,
      timestamp: 0,
    }
    expect((await optionsSentFor([reviewRequest]))?.samplingParams).toBeUndefined()
    expect((await optionsSentFor([reviewRequest, readFile, fileContents]))?.samplingParams).toBeUndefined()
  })

  it("holds a summary's requests to a summary as JSON", async () => {
    const options = await optionsSentFor([user(summaryPrompt(pr, [], []))])
    expect(options?.samplingParams?.["response_format"]).toEqual(summaryAsJson)
  })

  it("leaves a chat answer free to answer in text", async () => {
    const question = user(answerPrompt("andrew", "why is this a problem?", '<skill_content name="answer"/>'))
    expect((await optionsSentFor([question]))?.samplingParams).toBeUndefined()
  })

  it("lets go once the retry's submit_review call has a result, so the closing sentence can follow", async () => {
    const submitted = fauxAssistantMessage(fauxToolCall("submit_review", { summary: "s" }, { id: "c2" }))
    const posted = {
      role: "toolResult" as const,
      toolCallId: "c2",
      toolName: "submit_review",
      content: [fauxText("Posted the review.")],
      isError: false,
      timestamp: 0,
    }
    const options = await optionsSentFor([
      reviewRequest,
      proseReview,
      user(resubmitPrompt(undefined, ["src/x.ts"])),
      submitted,
      posted,
    ])
    expect(options?.samplingParams).toBeUndefined()
  })
})

describe("withBudgetRefusal", () => {
  async function answerTo(messages: Message[], options?: SimpleStreamOptions) {
    const { faux, seen } = recordingProvider(GPT_OSS)
    const message = await withBudgetRefusal(faux.provider)
      .streamSimple(faux.getModel(), normalizeContext({ messages }), options)
      .result()
    return { faux, message, seen }
  }

  it("answers a request whose latest message is the marker with an error, and never calls the model", async () => {
    const { faux, message } = await answerTo([reviewRequest, user(BUDGET_REFUSAL_MARKER)])
    expect(message).toMatchObject({ role: "assistant", content: [], stopReason: "error", errorMessage: BUDGET_REFUSAL })
    expect(faux.state.callCount).toBe(0)
  })

  it("names the model it refused for and charges it nothing", async () => {
    const { faux, message } = await answerTo([user(BUDGET_REFUSAL_MARKER)])
    const { api, provider, id } = faux.getModel()
    expect(message).toMatchObject({ api, provider, model: id, usage: { totalTokens: 0, cost: { total: 0 } } })
  })

  it("passes any other request to the model, its options untouched", async () => {
    const options = { maxTokens: 500 }
    const { faux, message, seen } = await answerTo([reviewRequest], options)
    expect(message.stopReason).toBe("stop")
    expect(faux.state.callCount).toBe(1)
    expect(seen).toEqual([options])
  })

  it.each([
    { label: "a marker that isn't the latest message", messages: [user(BUDGET_REFUSAL_MARKER), reviewRequest] },
    { label: "a prompt that only quotes the marker", messages: [user(`Say ${BUDGET_REFUSAL_MARKER}.`)] },
  ])("passes $label to the model", async ({ messages }) => {
    const { faux } = await answerTo(messages)
    expect(faux.state.callCount).toBe(1)
  })

  it("leaves the provider's other members in place", () => {
    const { faux } = recordingProvider(GPT_OSS)
    const wrapped = withBudgetRefusal(faux.provider)
    expect(wrapped.id).toBe(faux.provider.id)
    expect(wrapped.getModels()).toEqual(faux.provider.getModels())
  })
})

describe("reviewThinkingLevel", () => {
  it("takes a level pi knows from the REVIEW_THINKING_LEVEL setting", () => {
    expect(reviewThinkingLevel("medium")).toBe("medium")
  })

  it("refuses a level pi doesn't know, rather than reviewing at a level nobody chose", () => {
    expect(() => reviewThinkingLevel("mid")).toThrow('REVIEW_THINKING_LEVEL is "mid"')
  })
})

describe("outputLimitOf", () => {
  it("reads the limit from the MAX_OUTPUT_TOKENS var", () => {
    expect(outputLimitOf("32000")).toBe(32_000)
  })

  it("falls back to 16,000 when the var isn't a positive whole number", () => {
    for (const value of ["", "32k", "16,000", "0", "-1", "1.5"]) expect(outputLimitOf(value)).toBe(16_000)
  })
})
