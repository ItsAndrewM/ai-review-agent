import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { summarizeTranscript, transcriptFields } from "../src/review/transcript.ts"

function turn(content: Parameters<typeof fauxAssistantMessage>[0], output: number): AssistantMessage {
  const message = fauxAssistantMessage(content)
  return { ...message, usage: { ...message.usage, output } }
}

function result(toolCallId: string, toolName: string) {
  const content = [fauxText("ok")]
  return { role: "toolResult" as const, toolCallId, toolName, content, isError: false, timestamp: 0 }
}

const prompt = { role: "user" as const, content: "Review this pull request.", timestamp: 0 }

describe("summarizeTranscript", () => {
  it("counts the review's tool calls by name, so a log shows whether it read past the diff", () => {
    const summary = summarizeTranscript([
      { model: [prompt] },
      { model: [turn([fauxToolCall("read_file", { path: "a.ts" }), fauxToolCall("read_file", { path: "b.ts" })], 40)] },
      { model: [result("c1", "read_file"), result("c2", "read_file")] },
      { model: [turn(fauxToolCall("list_changed_files", {}), 10)] },
      { model: [result("c3", "list_changed_files")] },
      { model: [turn(fauxToolCall("submit_review", { summary: "s" }), 300)] },
    ])
    expect(summary.toolCalls).toEqual({ read_file: 2, list_changed_files: 1, submit_review: 1 })
  })

  it("counts the model's turns and adds up their output tokens, reasoning included", () => {
    const summary = summarizeTranscript([
      { model: [prompt] },
      { model: [turn(fauxToolCall("read_file", { path: "a.ts" }), 40)] },
      { model: [result("c1", "read_file")] },
      { model: [turn("Done.", 5)] },
    ])
    expect(summary.assistantTurns).toBe(2)
    expect(summary.outputTokens).toBe(45)
  })

  it("skips bookkeeping entries that put nothing in the model's context", () => {
    expect(summarizeTranscript([{}, { model: [prompt] }])).toEqual({
      toolCalls: {},
      assistantTurns: 0,
      outputTokens: 0,
    })
  })
})

describe("transcriptFields", () => {
  it("flattens the summary into log fields, with read_file calls on their own to query by", () => {
    const fields = transcriptFields({
      toolCalls: { read_file: 3, submit_review: 1 },
      assistantTurns: 4,
      outputTokens: 900,
    })
    expect(fields).toEqual({ tools: "read_file:3 submit_review:1", readFileCalls: 3, turns: 4, outputTokens: 900 })
  })

  it("logs no tools and no reads for a review that called none", () => {
    expect(transcriptFields({ toolCalls: {}, assistantTurns: 1, outputTokens: 20 })).toMatchObject({
      tools: "",
      readFileCalls: 0,
    })
  })
})
