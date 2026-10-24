import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { attemptReplay, replayConversation } from "../tools/verify-replay/conversation.ts"
import { ReplayTools } from "../tools/verify-replay/tools.ts"
import { verdict } from "./verify-replay-fixtures.ts"

const source = {
  readFile: async ({ path }: { path: string }) => `contents: ${path}`,
  grep: async ({ pattern }: { pattern: string }) => `match: ${pattern}`,
  tree: async () => "src/example.ts",
}

describe("replayConversation", () => {
  it("offers the production four tools and returns a verdict after a file read", async () => {
    const tools = new ReplayTools(source)
    const messages: string[][] = []
    const responses = [
      fauxAssistantMessage([fauxToolCall("read_file", { path: "src/example.ts" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("submit_verdicts", { verdicts: [verdict("F1", true)] })], {
        stopReason: "toolUse",
      }),
    ]
    const complete = async (context: {
      messages: readonly { role: string }[]
      tools?: readonly { name: string }[]
    }) => {
      messages.push(context.messages.map((message) => message.role))
      expect(context.tools?.map(({ name }) => name)).toEqual(["read_file", "grep", "tree", "submit_verdicts"])
      const response = responses.shift()
      if (response === undefined) throw new Error("Missing fixture response")
      return response
    }
    const result = await replayConversation("system", "finding F1", tools, complete)
    expect(result.verdicts).toEqual([verdict("F1", true)])
    expect(messages).toEqual([["user"], ["user", "assistant", "toolResult"]])
  })

  it("accepts the JSON text fallback", async () => {
    const text = JSON.stringify({ verdicts: [verdict("F1", false)] })
    const result = await replayConversation("system", "finding F1", new ReplayTools(source), async () =>
      fauxAssistantMessage([fauxText(text)]),
    )
    expect(result.verdicts).toEqual([verdict("F1", false)])
  })

  it("leaves findings not judged when the model gives prose", async () => {
    const result = await replayConversation("system", "finding F1", new ReplayTools(source), async () =>
      fauxAssistantMessage([fauxText("Looks fine")]),
    )
    expect(result.verdicts).toEqual([])
    expect(result.failure).toBe("no usable verdicts")
  })

  it("records a rejected model request as a failed attempt with no verdicts", async () => {
    const result = await attemptReplay("system", "finding F1", new ReplayTools(source), async () => {
      throw new Error("request failed")
    })
    expect(result.verdicts).toEqual([])
    expect(result.calls).toBe(0)
    expect(result.failure).toContain("request failed")
  })
})
