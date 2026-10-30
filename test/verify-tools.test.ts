import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context"
import { fauxProvider, Type } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  type Conversation,
  type ConversationId,
  type Extension,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable"
import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { GitHubClient, type PullRequestInfo } from "../src/github/client.ts"
import { MemorySnapshotFiles, type SnapshotFiles } from "../src/repository/snapshot.ts"
import {
  createReviewExtension,
  type GrepArgs,
  type ReadFileArgs,
  type RequestBudget,
  type ReviewHost,
  type SearchAccess,
  type TreeArgs,
} from "../src/review/tools.ts"
import {
  createVerifyExtension,
  verifyHostOf,
  VerifyPasses,
  withoutVerifyByDefault,
  type VerifyHost,
} from "../src/review/verify-tools.ts"
import type { VerdictInput } from "../src/review/verify.ts"

const BUDGET_SPENT = "Verify's tool budget of 10 calls is spent; decide from what you have."
const NO_PASS = "No verify pass is running in this conversation; stop here."

const verdicts = [
  { finding: "F1", keep: true, severity: "blocking", reason: "the caller awaits it" },
  { finding: "F2", keep: false, severity: "suggestion", reason: "the guard on line 9 covers it" },
] satisfies VerdictInput[]

function fakeHost(pass: { current: string | undefined } = { current: "review:d-1:verify:1" }) {
  const asked: string[] = []
  const submitted: { verdicts: VerdictInput[]; conversation: ConversationId }[] = []
  const host = {
    readFile: async ({ path }: ReadFileArgs) => {
      asked.push(`read_file ${path}`)
      return `contents of ${path}`
    },
    grep: async ({ pattern }: GrepArgs) => {
      asked.push(`grep ${pattern}`)
      return `matches for ${pattern}`
    },
    tree: async ({ path }: TreeArgs) => {
      asked.push(`tree ${path ?? "."}`)
      return "src/a.ts"
    },
    passOf: () => pass.current,
    submitVerdicts: async (given: VerdictInput[], conversation: ConversationId) => {
      submitted.push({ verdicts: given, conversation })
      return { text: "Recorded 2 verdicts.", done: true }
    },
  } satisfies VerifyHost
  return { host, asked, submitted, pass }
}

type ToolArgs = ReadFileArgs | GrepArgs | TreeArgs | { verdicts: VerdictInput[] }

interface CalledWithoutHarness {
  execute(
    args?: ToolArgs,
    api?: Pick<ToolExecutionApi, "conversationId">,
    context?: Context,
  ): Promise<ToolExecutionResult>
}

function toolOf(extension: Extension, name: string) {
  const tool = extension.tools?.find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`verify should offer ${name}`)
  return tool
}

function calledWithoutHarness(extension: Extension, name: string): CalledWithoutHarness {
  return toolOf(extension, name)
}

const inVerify = { conversationId: ROOT_CONVERSATION_ID }

async function outputOf(extension: Extension, name: string, args: ToolArgs) {
  return (await calledWithoutHarness(extension, name).execute(args, inVerify)).output
}

function said(text: string) {
  return [{ type: "text" as const, text }]
}

const fileCalls: [string, ToolArgs][] = [
  ["read_file", { path: "src/a.ts" }],
  ["grep", { pattern: "total" }],
  ["tree", { path: "src" }],
]

describe("createVerifyExtension", () => {
  it("offers read_file, grep, tree and submit_verdicts, and nothing else", () => {
    expect(createVerifyExtension(fakeHost().host).tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "grep",
      "tree",
      "submit_verdicts",
    ])
  })

  it("answers the 11th read_file, grep or tree call of a pass with the budget message, without asking the host", async () => {
    const { host, asked } = fakeHost()
    const verify = createVerifyExtension(host)
    const answers = []
    for (let call = 0; call < 10; call++) {
      const [name, args] = fileCalls[call % fileCalls.length] ?? ["read_file", { path: "src/a.ts" }]
      answers.push(await outputOf(verify, name, args))
    }
    expect(asked).toHaveLength(10)
    expect(answers.at(-1)).toEqual(said("contents of src/a.ts"))
    for (const [name, args] of fileCalls) expect(await outputOf(verify, name, args)).toEqual(said(BUDGET_SPENT))
    expect(asked).toHaveLength(10)
  })

  it("gives each pass its own 10 calls, so the retry starts with a whole budget", async () => {
    const { host, asked, pass } = fakeHost()
    const verify = createVerifyExtension(host)
    for (let call = 0; call < 10; call++) await outputOf(verify, "grep", { pattern: "total" })
    expect(await outputOf(verify, "grep", { pattern: "total" })).toEqual(said(BUDGET_SPENT))
    pass.current = "review:d-1:verify:2"
    expect(await outputOf(verify, "grep", { pattern: "price" })).toEqual(said("matches for price"))
    expect(asked).toHaveLength(11)
  })

  it("refuses read_file, grep and tree outside a verify pass, without asking the host", async () => {
    const { host, asked } = fakeHost({ current: undefined })
    const verify = createVerifyExtension(host)
    for (const [name, args] of fileCalls) expect(await outputOf(verify, name, args)).toEqual(said(NO_PASS))
    expect(asked).toEqual([])
  })

  it("refuses submit_verdicts arguments that fail VerdictsSubmission", () => {
    const { parameters } = toolOf(createVerifyExtension(fakeHost().host), "submit_verdicts")
    const good = verdicts[0]
    expect(Value.Check(parameters, { verdicts })).toBe(true)
    expect(
      [
        {},
        { verdicts: good },
        { verdicts: [{ ...good, keep: "yes" }] },
        { verdicts: [{ ...good, reason: "" }] },
        { verdicts: [{ ...good, severity: "critical" }] },
        { verdicts: [{ keep: true, severity: "blocking", reason: "no id" }] },
      ].map((args) => Value.Check(parameters, args)),
    ).toEqual([false, false, false, false, false, false])
  })

  it("hands the submitted verdicts and the calling conversation to the host, and ends the run when the host is done", async () => {
    const { host, submitted } = fakeHost()
    const result = await calledWithoutHarness(createVerifyExtension(host), "submit_verdicts").execute(
      { verdicts },
      inVerify,
    )
    expect(submitted).toEqual([{ verdicts, conversation: ROOT_CONVERSATION_ID }])
    expect(result).toEqual({ output: said("Recorded 2 verdicts."), control: { terminate: true } })
  })
})

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

const notFetched = async (input: RequestInfo | URL) => new Response(`no answer for ${String(input)}`, { status: 500 })

const reviewHost = {
  botLogin: () => "andabot",
  github: async () => new GitHubClient("token", "https://api.example", notFetched),
  pullRequest: async () => pr,
  changedFiles: async () => [],
  pathFilters: async () => [],
  submitReview: async () => ({ text: "Nothing to post.", done: false }),
  repositorySearch: async (): Promise<SearchAccess> => ({ kind: "unavailable", reason: "no snapshot" }),
  runCheck: async () => "The sandbox is off for this repository, so test did not run.",
  resolveThread: async () => "Not resolved: resolve_thread acts only while answering a reply in one of my threads.",
  loadedSnapshot: (): SnapshotFiles | undefined => undefined,
  budgetBlockFor: async (): Promise<string | undefined> => undefined,
  requestBudget: async (): Promise<RequestBudget> => "allow",
} satisfies ReviewHost

describe("verifyHostOf", () => {
  it("serves verify's grep and tree through the review's repository search, so they count toward the review's 40 calls", async () => {
    const searched: string[] = []
    const spent = {
      ...reviewHost,
      repositorySearch: async (tool: "grep" | "tree"): Promise<SearchAccess> => {
        searched.push(tool)
        return { kind: "spent" }
      },
    }
    const host = verifyHostOf(spent, new VerifyPasses<ConversationId>())
    const refusal = "Search budget spent: 40 grep and tree calls this review. Use read_file."
    expect([await host.grep({ pattern: "total" }), await host.tree({ path: "src" })]).toEqual([refusal, refusal])
    expect(searched).toEqual(["grep", "tree"])
  })

  it("reads a file at the head from the review's snapshot, numbered as the review's read_file numbers it", async () => {
    const snapshot = new MemorySnapshotFiles()
    snapshot.begin(pr.head.sha)
    snapshot.add([{ path: "src/a.ts", content: "export const total = 1" }])
    snapshot.finish({
      sha: pr.head.sha,
      files: 1,
      bytes: 0,
      gapFilled: 0,
      leftOut: {},
      capped: false,
      treeTruncated: false,
    })
    const host = verifyHostOf({ ...reviewHost, loadedSnapshot: () => snapshot }, new VerifyPasses<ConversationId>())
    expect(await host.readFile({ path: "src/a.ts" })).toBe("    1 | export const total = 1")
  })

  it("asks the passes it is given which pass a conversation runs, and hands them the verdicts", async () => {
    const passes = new VerifyPasses<ConversationId>()
    const host = verifyHostOf(reviewHost, passes)
    const submittedOf = passes.open(ROOT_CONVERSATION_ID, "a1b2c3d4", "review:d-1:verify:a1b2c3d4:1")
    expect(host.passOf(ROOT_CONVERSATION_ID)).toBe("review:d-1:verify:a1b2c3d4:1")
    await host.submitVerdicts(verdicts, ROOT_CONVERSATION_ID)
    expect(submittedOf()).toEqual(verdicts)
  })
})

describe("VerifyPasses", () => {
  const firstAttempt = "review:d-1:verify:a1b2c3d4:1"
  const retry = "review:d-1:verify:a1b2c3d4:2"

  it("names the pass open in a conversation, and none in another", () => {
    const passes = new VerifyPasses<string>()
    expect(passes.passOf("verify")).toBeUndefined()
    passes.open("verify", "a1b2c3d4", firstAttempt)
    expect(passes.passOf("verify")).toBe(firstAttempt)
    expect(passes.passOf("root")).toBeUndefined()
  })

  it("hands a pass the verdicts its conversation submits, and ends that run", async () => {
    const passes = new VerifyPasses<string>()
    const submittedOf = passes.open("verify", "a1b2c3d4", firstAttempt)
    expect(submittedOf()).toBeUndefined()
    expect(await passes.submitVerdicts(verdicts, "verify")).toEqual({ text: "Recorded 2 verdicts.", done: true })
    expect(submittedOf()).toEqual(verdicts)
  })

  it("counts one verdict in the singular, and records an empty submission for the runner to judge", async () => {
    const passes = new VerifyPasses<string>()
    const submittedOf = passes.open("verify", "a1b2c3d4", firstAttempt)
    expect(await passes.submitVerdicts([], "verify")).toEqual({ text: "Recorded 0 verdicts.", done: true })
    expect(submittedOf()).toEqual([])
    const single = passes.open("verify", "a1b2c3d4", retry)
    expect(await passes.submitVerdicts(verdicts.slice(0, 1), "verify")).toEqual({
      text: "Recorded 1 verdict.",
      done: true,
    })
    expect(single()).toEqual(verdicts.slice(0, 1))
  })

  it("keeps a pass's first submission", async () => {
    const passes = new VerifyPasses<string>()
    const submittedOf = passes.open("verify", "a1b2c3d4", firstAttempt)
    await passes.submitVerdicts(verdicts, "verify")
    await passes.submitVerdicts(verdicts.slice(1), "verify")
    expect(submittedOf()).toEqual(verdicts)
  })

  it("refuses verdicts from a conversation with no pass open, ends that run and records nothing", async () => {
    const passes = new VerifyPasses<string>()
    expect(await passes.submitVerdicts(verdicts, "verify")).toEqual({ text: NO_PASS, done: true })
    const submittedOf = passes.open("verify", "a1b2c3d4", firstAttempt)
    expect(await passes.submitVerdicts(verdicts, "root")).toEqual({ text: NO_PASS, done: true })
    expect(submittedOf()).toBeUndefined()
  })

  it("lets a run open its retry's pass over its first attempt's, which gets none of the retry's verdicts", async () => {
    const passes = new VerifyPasses<string>()
    const first = passes.open("verify", "a1b2c3d4", firstAttempt)
    await passes.submitVerdicts(verdicts, "verify")
    const second = passes.open("verify", "a1b2c3d4", retry)
    expect(passes.passOf("verify")).toBe(retry)
    expect(second()).toBeUndefined()
    expect(first()).toEqual(verdicts)
  })

  it("refuses a pass for another verify run while one is open, so two runs can't cross their verdicts", async () => {
    const passes = new VerifyPasses<string>()
    const open = passes.open("verify", "a1b2c3d4", firstAttempt)
    expect(() => passes.open("verify", "e5f6a7b8", "review:d-1:verify:e5f6a7b8:1")).toThrow(
      "verify run a1b2c3d4 is still open, so run e5f6a7b8 can't open a pass",
    )
    expect(passes.passOf("verify")).toBe(firstAttempt)
    await passes.submitVerdicts(verdicts, "verify")
    expect(open()).toEqual(verdicts)
  })

  it("opens a pass for another run once the open run has closed, and a close for another run changes nothing", async () => {
    const passes = new VerifyPasses<string>()
    passes.open("verify", "a1b2c3d4", firstAttempt)
    passes.close("e5f6a7b8")
    expect(passes.passOf("verify")).toBe(firstAttempt)
    passes.close("a1b2c3d4")
    expect(passes.passOf("verify")).toBeUndefined()
    expect(await passes.submitVerdicts(verdicts, "verify")).toEqual({ text: NO_PASS, done: true })
    passes.open("verify", "e5f6a7b8", "review:d-1:verify:e5f6a7b8:1")
    expect(passes.passOf("verify")).toBe("review:d-1:verify:e5f6a7b8:1")
  })
})

describe("withoutVerifyByDefault", () => {
  async function openedWithVerify() {
    const registry = createRegistry()
    registry.install(createReviewExtension(reviewHost))
    const verify = createVerifyExtension(fakeHost().host)
    registry.install(verify)
    const models = createModels()
    models.setProvider(fauxProvider().provider)
    const pi = await Harness.open(
      new MemoryStorage(),
      { models, registry, settings: withoutVerifyByDefault(registry, {}) },
      BACKGROUND_CONTEXT,
    )
    return { pi, registry, verify }
  }

  const toolsOf = async (conversation: Conversation) =>
    (await conversation.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name)

  const reviewTools = [
    "read_file",
    "list_changed_files",
    "get_issue",
    "grep",
    "tree",
    "run_check",
    "resolve_thread",
    "submit_review",
  ]

  it("keeps verify's tools out of the root, and out of any conversation that leaves its extensions to the host", async () => {
    const { pi } = await openedWithVerify()
    try {
      expect(await toolsOf(await pi.root(BACKGROUND_CONTEXT))).toEqual(reviewTools)
      const fresh = await pi.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT)
      expect(await toolsOf(fresh)).toEqual(reviewTools)
    } finally {
      await pi.close(BACKGROUND_CONTEXT)
    }
  })

  it("gives a conversation that selects verify's extension exactly verify's four tools", async () => {
    const { pi, verify } = await openedWithVerify()
    try {
      const conversation = await pi.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT)
      await conversation.configure({ extensions: [verify] }, BACKGROUND_CONTEXT)
      expect(await toolsOf(conversation)).toEqual(["read_file", "grep", "tree", "submit_verdicts"])
    } finally {
      await pi.close(BACKGROUND_CONTEXT)
    }
  })

  it("offers the root an extension installed after the harness opened, as the repository's skill catalog is", async () => {
    const { pi, registry } = await openedWithVerify()
    try {
      const activate = defineTool({
        name: "activate_skill",
        description: "Activate a skill by name.",
        parameters: Type.Object({ name: Type.String() }),
        async execute() {
          return { output: said("Activated.") }
        },
      })
      registry.install(defineExtension({ name: "agents.skills", tools: [activate] }))
      expect(await toolsOf(await pi.root(BACKGROUND_CONTEXT))).toEqual([...reviewTools, "activate_skill"])
    } finally {
      await pi.close(BACKGROUND_CONTEXT)
    }
  })

  it("keeps the other settings it is given", () => {
    const retry = { enabled: true, maxRetries: 4, baseDelayMs: 1000 }
    expect(withoutVerifyByDefault(createRegistry(), { retry }).retry).toEqual(retry)
  })
})
