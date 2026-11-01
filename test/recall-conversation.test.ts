import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import type { ChangedFile } from "../src/github/diff.ts"
import { budgetRefusalMarkerOf } from "../src/names.ts"
import { BUDGET_REFUSAL } from "../src/review/budget.ts"
import type { ReviewSubmissionInput } from "../src/review/findings.ts"
import { isResubmitPrompt } from "../src/review/prompt.ts"
import { NeuronBudget } from "../tools/recall/budget.ts"
import { attemptReview, replayReview } from "../tools/recall/conversation.ts"
import { NO_BASIS, ReviewHost } from "../tools/recall/host.ts"
import { RecallTools, type RecallSource } from "../tools/recall/tools.ts"

const files: ChangedFile[] = [
  { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
  { filename: "test/a.snap", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" },
]

const source: RecallSource = {
  readFile: async ({ path }) => `read ${path}`,
  grep: async () => "",
  tree: async () => "",
  changedFilesText: async () => "src/a.ts",
  issue: () => "",
}

function finding(path: string, line: number, quote: string, title: string) {
  return {
    path,
    line,
    quote,
    severity: "major" as const,
    basis_kind: "defect" as const,
    basis: "input x gives y",
    title,
    body: "body",
  }
}

function submission(
  findings: ReviewSubmissionInput["findings"],
  walkthrough = [{ path: "src/a.ts", summary: "changed" }],
) {
  return {
    summary: "summary",
    walkthrough,
    findings,
    merge_danger: { door: "two-way", blast_radius: "none" },
  } satisfies ReviewSubmissionInput
}

const priced = (message: AssistantMessage, usd: number): AssistantMessage => ({
  ...message,
  usage: { ...message.usage, input: 100, output: 10, cost: { ...message.usage.cost, total: usd } },
})

function scripted(responses: AssistantMessage[]) {
  const prompts: string[] = []
  const complete = async (context: Context) => {
    const latest = context.messages.at(-1)
    if (latest?.role === "user" && !Array.isArray(latest.content)) prompts.push(latest.content)
    const response = responses.shift()
    if (response === undefined) throw new Error("Missing fixture response")
    return response
  }
  return { complete, prompts }
}

function setup(responses: AssistantMessage[], pathFilters: string[] = []) {
  const host = new ReviewHost(files, pathFilters, NO_BASIS)
  const tools = new RecallTools(source, async (given) => host.submit(given))
  const budget = new NeuronBudget(10_000)
  return { host, tools, budget, ...scripted(responses) }
}

describe("replayReview", () => {
  it("posts a tool submission as source tool", async () => {
    const { tools, host, budget, complete } = setup([
      fauxAssistantMessage([fauxToolCall("read_file", { path: "src/a.ts" })], { stopReason: "toolUse" }),
      priced(
        fauxAssistantMessage([fauxToolCall("submit_review", submission([finding("src/a.ts", 1, "new", "Wrong")]))], {
          stopReason: "toolUse",
        }),
        0.01,
      ),
    ])
    const answer = await replayReview("system", "review", tools, host, budget, complete)
    expect(answer.source).toBe("tool")
    expect(answer.posted?.accepted.map(({ title }) => title)).toEqual(["Wrong"])
    expect([answer.calls, answer.inputTokens, answer.outputTokens, answer.usd]).toEqual([2, 100, 10, 0.01])
    expect(answer.neurons).toBeCloseTo(909.09, 1)
  })

  it("posts a prose answer's retry text with its rejected finding dropped, as retry_text", async () => {
    const rejected = finding("src/a.ts", 7, "nowhere", "Lost")
    const kept = finding("src/a.ts", 1, "new", "Kept")
    const { tools, host, budget, complete, prompts } = setup([
      fauxAssistantMessage([fauxText("Looks fine to me.")]),
      fauxAssistantMessage([fauxText(JSON.stringify(submission([kept, rejected])))]),
    ])
    const answer = await replayReview("system", "review", tools, host, budget, complete)
    expect(answer.source).toBe("retry_text")
    expect(answer.posted?.accepted.map(({ title }) => title)).toEqual(["Kept"])
    expect(answer.posted?.rejected.map(({ finding: { title } }) => title)).toEqual(["Lost"])
    expect(prompts.filter(isResubmitPrompt)).toHaveLength(1)
  })

  it("rejects a finding on a filtered path as unfounded and never accepts it", async () => {
    const filtered = finding("test/a.snap", 2, "b", "Snapshot")
    const { tools, host, budget, complete } = setup(
      [
        fauxAssistantMessage([fauxToolCall("submit_review", submission([filtered]))], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("submit_review", submission([]))], { stopReason: "toolUse" }),
      ],
      ["!**/*.snap"],
    )
    const answer = await replayReview("system", "review", tools, host, budget, complete)
    expect(answer.source).toBe("tool")
    expect(answer.posted?.accepted).toEqual([])
    expect(host.rejectionsReturned()).toBe(true)
  })

  it("blocks tools past the budget and ends with reason budget after three more requests", async () => {
    const read = () =>
      fauxAssistantMessage([fauxToolCall("read_file", { path: "src/a.ts" })], { stopReason: "toolUse" })
    const refused = fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: BUDGET_REFUSAL })
    const { tools, host, budget, complete, prompts } = setup([priced(read(), 0.2), read(), read(), read(), refused])
    const seen: string[] = []
    const observing = async (context: Context) => {
      const latest = context.messages.at(-1)
      if (latest?.role === "toolResult")
        seen.push(latest.content.map((part) => (part.type === "text" ? part.text : "")).join(""))
      return complete(context)
    }
    const answer = await replayReview("system", "review", tools, host, budget, observing)
    expect(answer.reason).toBe("budget")
    expect(answer.posted).toBeUndefined()
    expect(seen.slice(1).every((text) => text.startsWith("Budget spent: this review has used"))).toBe(true)
    expect(prompts.at(-1)).toBe(budgetRefusalMarkerOf("andabot"))
    expect([answer.calls, answer.usd]).toEqual([5, 0.2])
  })

  it("ends incomplete when rows are still missing after the retry", async () => {
    const { tools, host, budget, complete } = setup([
      fauxAssistantMessage([fauxToolCall("submit_review", submission([], [{ path: "nothing.ts", summary: "x" }]))], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("submit_review", submission([], [{ path: "nothing.ts", summary: "x" }]))], {
        stopReason: "toolUse",
      }),
    ])
    const answer = await replayReview("system", "review", tools, host, budget, complete)
    expect(answer.reason).toBe("incomplete")
    expect(answer.posted).toBeUndefined()
  })

  it("ends with reason prose when the retry is prose too", async () => {
    const { tools, host, budget, complete } = setup([
      fauxAssistantMessage([fauxText("Looks fine.")]),
      fauxAssistantMessage([fauxText("Still fine.")]),
    ])
    const answer = await replayReview("system", "review", tools, host, budget, complete)
    expect(answer.reason).toBe("prose")
    expect(answer.source).toBeUndefined()
  })
})

describe("attemptReview", () => {
  it("turns a thrown error into a failed answer", async () => {
    const { tools, host, budget } = setup([])
    const answer = await attemptReview("system", "review", tools, host, budget, async () => {
      throw new Error("upstream down")
    })
    expect(answer.reason).toBe("error")
    expect(answer.failure).toBe("Error: upstream down")
  })
})

describe("replayReview's transcript", () => {
  it("hands the observer the whole conversation at the end", async () => {
    const { tools, host, budget, complete } = setup([
      fauxAssistantMessage([fauxToolCall("read_file", { path: "src/a.ts" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("submit_review", submission([]))], { stopReason: "toolUse" }),
    ])
    const roles: string[][] = []
    await replayReview("system", "review", tools, host, budget, complete, (messages) => {
      roles.push(messages.map(({ role }) => role))
    })
    expect(roles).toEqual([["user", "assistant", "toolResult", "assistant", "toolResult"]])
  })
})
