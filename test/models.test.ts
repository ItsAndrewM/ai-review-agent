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
import { reviewThinkingLevel, withForcedResubmission, withOutputLimit } from "../src/models.ts"
import { ReviewSubmission } from "../src/review/findings.ts"
import { answerPrompt, resubmitPrompt } from "../src/review/prompt.ts"

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

function user(content: Extract<Message, { role: "user" }>["content"]) {
  return { role: "user" as const, content, timestamp: 0 }
}

async function optionsSentFor(messages: Message[]) {
  const { faux, seen } = recordingProvider()
  await withForcedResubmission(faux.provider).streamSimple(faux.getModel(), normalizeContext({ messages })).result()
  return seen[0]
}

const reviewRequest = user("Review this pull request and submit the review with submit_review.")
const proseReview = fauxAssistantMessage("## Summary\nLooks risky.\n\n**Verdict:** request_changes")
const reviewAsJson = { type: "json_schema", json_schema: { name: "review_submission", schema: ReviewSubmission } }

describe("withForcedResubmission", () => {
  it.each([undefined, "Error: GitHub POST /repos/o/r/pulls/5/reviews: 502"])(
    "holds the retry after a prose review to a submit_review call or the review as JSON, since Workers AI ignores tool_choice (refusal %s)",
    async (refusal) => {
      const options = await optionsSentFor([reviewRequest, proseReview, user(resubmitPrompt(refusal))])
      expect(options?.samplingParams?.["response_format"]).toEqual(reviewAsJson)
    },
  )

  it("holds the retry to JSON when it arrives as text parts", async () => {
    const options = await optionsSentFor([reviewRequest, proseReview, user([fauxText(resubmitPrompt(undefined))])])
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
      user(resubmitPrompt(undefined)),
      submitted,
      posted,
    ])
    expect(options?.samplingParams).toBeUndefined()
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
