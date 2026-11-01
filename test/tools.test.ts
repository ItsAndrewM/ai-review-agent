import { fauxProvider, normalizeContext, type Message } from "@earendil-works/pi-ai"
import {
  GenerationTask,
  ROOT_CONVERSATION_ID,
  ToolTask,
  type ConversationId,
  type Extension,
} from "@earendil-works/pi-durable"
import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { GitHubClient, type PullRequestInfo } from "../src/github/client.ts"
import { withBudgetRefusal } from "../src/models.ts"
import { budgetRefusalMarkerOf } from "../src/names.ts"
import { GrepWork, MAX_RUN_SEARCH_WORK } from "../src/repository/search.ts"
import { SnapshotRuns } from "../src/repository/snapshot-host.ts"
import { MemorySnapshotFiles, type SnapshotFiles } from "../src/repository/snapshot.ts"
import { BUDGET_REFUSAL, budgetBlock } from "../src/review/budget.ts"
import { SUBMIT_REVIEW_TOOL } from "../src/review/prompt.ts"
import type { ResolveThreadArgs } from "../src/review/thread-resolution.ts"
import {
  changedFilesText,
  createReviewExtension,
  grepText,
  readFileText,
  readIssue,
  submitResult,
  treeText,
  type RequestBudget,
  type ReviewHost,
  type RunCheckArgs,
  type SearchAccess,
} from "../src/review/tools.ts"

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

const answers = new Map([
  [
    "https://api.example/repos/o/r/issues/7",
    { status: 200, body: JSON.stringify({ number: 7, title: "Fix totals", body: "Totals are NaN.", state: "open" }) },
  ],
  ["https://api.example/repos/o/r/issues/8", { status: 404, body: "{}" }],
  [
    "https://api.example/repos/o/r/issues/9",
    {
      status: 200,
      body: JSON.stringify({ number: 9, title: "Add totals", body: "", state: "open", pull_request: {} }),
    },
  ],
])

const fakeFetch = async (input: RequestInfo | URL) => {
  const answer = answers.get(String(input))
  if (answer === undefined) return new Response(`no answer for ${String(input)}`, { status: 500 })
  return new Response(answer.body, { status: answer.status })
}

const host = {
  botLogin: () => "andabot",
  github: async () => new GitHubClient("token", "https://api.example", fakeFetch),
  pullRequest: async () => pr,
  changedFiles: async () => [],
  pathFilters: async () => [],
  submitReview: async () => ({ text: "Nothing to post.", done: false }),
  repositorySearch: async (): Promise<SearchAccess> => ({ kind: "unavailable", reason: "no snapshot" }),
  runCheck: async (args: RunCheckArgs) => `ran ${args.name} on ${(args.paths ?? []).join(" ") || "nothing"}`,
  resolveThread: async (args: ResolveThreadArgs) => `resolved as ${args.reason} on ${args.evidence}`,
  loadedSnapshot: (): SnapshotFiles | undefined => undefined,
  budgetBlockFor: async (): Promise<string | undefined> => undefined,
  requestBudget: async (): Promise<RequestBudget> => "allow",
} satisfies ReviewHost

const headSha = pr.head.sha
const baseSha = pr.base.sha

function snapshotOf(sha: string, files: Record<string, string>): MemorySnapshotFiles {
  const snapshot = new MemorySnapshotFiles()
  snapshot.begin(sha)
  snapshot.add(Object.entries(files).map(([path, content]) => ({ path, content })))
  snapshot.finish({
    sha,
    files: Object.keys(files).length,
    bytes: 0,
    gapFilled: 0,
    leftOut: {},
    capped: false,
    treeTruncated: false,
  })
  return snapshot
}

function hostWith(options: { snapshot?: SnapshotFiles; search?: SearchAccess }) {
  const requested: string[] = []
  const contents = new Map([
    [`https://api.example/repos/o/r/contents/src/a.ts?ref=${headSha}`, "from the head api"],
    [`https://api.example/repos/o/r/contents/src/a.ts?ref=${baseSha}`, "from the base api"],
  ])
  const recordingFetch = async (input: RequestInfo | URL) => {
    requested.push(String(input))
    const body = contents.get(String(input))
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(body, { status: 200 })
  }
  const searched: string[] = []
  const wired = {
    ...host,
    github: async () => new GitHubClient("token", "https://api.example", recordingFetch),
    loadedSnapshot: () => options.snapshot,
    repositorySearch: async (tool: "grep" | "tree"): Promise<SearchAccess> => {
      searched.push(tool)
      return options.search ?? { kind: "unavailable", reason: "no snapshot" }
    },
  } satisfies ReviewHost
  return { host: wired, requested, searched }
}

describe("changedFilesText", () => {
  const files = [
    { filename: "src/x.ts", status: "modified", additions: 3, deletions: 1 },
    { filename: "test/__snapshots__/x.test.ts.snap", status: "added", additions: 40, deletions: 0 },
  ]

  it("lists each changed file with its status and counts, and marks the ones path_filters leave out", async () => {
    const filtering = { ...host, changedFiles: async () => files, pathFilters: async () => ["!**/*.snap"] }
    expect(await changedFilesText(filtering)).toBe(
      "modified  +3 -1  src/x.ts\nadded     +40 -0  test/__snapshots__/x.test.ts.snap (filtered)",
    )
  })

  it("marks nothing when no filter applies, and says so when nothing changed", async () => {
    expect(await changedFilesText({ ...host, changedFiles: async () => files })).toBe(
      "modified  +3 -1  src/x.ts\nadded     +40 -0  test/__snapshots__/x.test.ts.snap",
    )
    expect(await changedFilesText(host)).toBe("(no files)")
  })
})

describe("createReviewExtension", () => {
  it("offers the model eight tools, with submit_review last", () => {
    expect(createReviewExtension(host).tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_changed_files",
      "get_issue",
      "grep",
      "tree",
      "run_check",
      "resolve_thread",
      "submit_review",
    ])
  })

  it("tells the model that an incremental review also says what the new commits do in changes_since", () => {
    const submit = createReviewExtension(host).tools?.find((tool) => tool.name === "submit_review")
    expect(submit?.description).toContain("`changes_since`")
    expect(submit?.description).toContain("a missing `changes_since` come back once")
  })

  it("offers resolve_thread with a reason and evidence, replayed unsafe, and hands the call to the host", async () => {
    const resolveThread = createReviewExtension(host).tools?.find((tool) => tool.name === "resolve_thread")
    const parameters = JSON.stringify(resolveThread?.parameters)
    expect(parameters).toContain('"withdrawn"')
    expect(parameters).toContain('"evidence"')
    expect(resolveThread?.replay).toBe("unsafe")
    expect(resolveThread?.description).toContain("path:line")
  })

  it("offers run_check with the three check names and optional paths, replayed unsafe like grep", () => {
    const runCheck = createReviewExtension(host).tools?.find((tool) => tool.name === "run_check")
    const parameters = JSON.stringify(runCheck?.parameters)
    expect(parameters).toContain('"lint"')
    expect(parameters).toContain('"typecheck"')
    expect(parameters).toContain('"test"')
    expect(parameters).toContain('"paths"')
    expect(runCheck?.replay).toBe("unsafe")
    expect(runCheck?.description).toContain("whole suite is CI's job")
  })

  it("runs submit_review's round one call at a time, so two calls in one round can't post or verify at once", () => {
    const submit = createReviewExtension(host).tools?.find((tool) => tool.name === SUBMIT_REVIEW_TOOL)
    expect(submit?.executionMode).toBe("sequential")
  })

  it("never reruns grep or tree after a reset, so a scan that reset the object cannot loop", () => {
    const tools = createReviewExtension(host).tools ?? []
    const replays = tools.filter((tool) => tool.name === "grep" || tool.name === "tree").map((tool) => tool.replay)
    expect(replays).toEqual(["unsafe", "unsafe"])
  })

  it("still reruns the API reads after a reset", () => {
    const tools = createReviewExtension(host).tools ?? []
    const reads = ["read_file", "list_changed_files", "get_issue"]
    const replays = tools.filter((tool) => reads.includes(tool.name)).map((tool) => tool.replay)
    expect(replays).toEqual(["safe", "safe", "safe"])
  })

  it("declares every argument grepText and treeText read, each with its type, so none is dropped on the way", () => {
    const tools = createReviewExtension(host).tools ?? []
    const accepts = (name: string, args: Record<string, string | number>) => {
      const parameters = tools.find((tool) => tool.name === name)?.parameters
      return parameters !== undefined && Value.Check(parameters, args)
    }
    expect(accepts("grep", { pattern: "total", glob: "*.ts", path: "src" })).toBe(true)
    expect(
      [{ pattern: 1 }, { pattern: "total", glob: 1 }, { pattern: "total", path: 1 }].map((args) =>
        accepts("grep", args),
      ),
    ).toEqual([false, false, false])
    expect(accepts("tree", { path: "src", depth: 3 })).toBe(true)
    expect([{ path: 1 }, { depth: "3" }, { depth: 0 }, { depth: -1 }].map((args) => accepts("tree", args))).toEqual([
      false,
      false,
      false,
      false,
    ])
  })

  it("tells the model that a grep glob matches the repository-relative path at any depth", () => {
    const grepTool = createReviewExtension(host).tools?.find((tool) => tool.name === "grep")
    const glob = JSON.stringify(grepTool?.parameters)
    expect(glob).toContain("repository root")
    expect(glob).toContain("*.ts")
  })
})

interface HooksCalledWithoutHarness {
  beforeTool?(call: { name: string }, api: { conversationId: ConversationId }): Promise<{ block: string } | undefined>
  beforeRequest?(
    request: { messages: readonly Message[] },
    api: { conversationId: ConversationId },
  ): Promise<{ messages: readonly Message[] } | undefined>
}

function hooksOf(extension: Extension, task: string): HooksCalledWithoutHarness {
  const registration = extension.hooks?.find((candidate) => candidate.task === task)
  if (registration === undefined) throw new Error(`the extension should hook ${task}`)
  return registration.handlers
}

describe("the budget hooks", () => {
  const toolTask = ToolTask.definition.name
  const generationTask = GenerationTask.definition.name
  const transcript: Message[] = [{ role: "user", content: "Review this pull request.", timestamp: 1 }]
  const marker = { role: "user", content: budgetRefusalMarkerOf("andabot"), timestamp: 0 }

  it("hooks the tool task's beforeTool and the generation task's beforeRequest", () => {
    const extension = createReviewExtension(host)
    expect(extension.hooks?.map((registration) => registration.task)).toEqual([toolTask, generationTask])
    expect(hooksOf(extension, toolTask).beforeTool).toBeDefined()
    expect(hooksOf(extension, generationTask).beforeRequest).toBeDefined()
  })

  it("blocks a tool call with the message the host gives for that tool and conversation", async () => {
    const asked: { tool: string; conversation: ConversationId }[] = []
    const spent = {
      ...host,
      budgetBlockFor: async (tool: string, conversation: ConversationId) => {
        asked.push({ tool, conversation })
        return "Budget spent."
      },
    }
    const { beforeTool } = hooksOf(createReviewExtension(spent), toolTask)
    expect(await beforeTool?.({ name: "grep" }, { conversationId: ROOT_CONVERSATION_ID })).toEqual({
      block: "Budget spent.",
    })
    expect(asked).toEqual([{ tool: "grep", conversation: ROOT_CONVERSATION_ID }])
  })

  it("registers the review tool under the one name the budget lets through, so it blocks every other tool", () => {
    const registered = createReviewExtension(host).tools?.map((tool) => tool.name) ?? []
    const spent = { kind: "spent", neurons: 20, budget: 10 } as const
    expect(registered.filter((name) => budgetBlock(spent, name) === undefined)).toEqual([SUBMIT_REVIEW_TOOL])
  })

  it("leaves a tool call alone when the host has no message for it", async () => {
    const { beforeTool } = hooksOf(createReviewExtension(host), toolTask)
    expect(await beforeTool?.({ name: "submit_review" }, { conversationId: ROOT_CONVERSATION_ID })).toBeUndefined()
  })

  it("ends the transcript's request with the marker when the host refuses the request, asking for its conversation", async () => {
    const asked: ConversationId[] = []
    const refusing = {
      ...host,
      requestBudget: async (conversation: ConversationId): Promise<RequestBudget> => {
        asked.push(conversation)
        return "refuse"
      },
    }
    const { beforeRequest } = hooksOf(createReviewExtension(refusing), generationTask)
    expect(await beforeRequest?.({ messages: transcript }, { conversationId: ROOT_CONVERSATION_ID })).toEqual({
      messages: [...transcript, marker],
    })
    expect(asked).toEqual([ROOT_CONVERSATION_ID])
  })

  it("leaves the request's messages alone when the host allows it", async () => {
    const { beforeRequest } = hooksOf(createReviewExtension(host), generationTask)
    expect(await beforeRequest?.({ messages: transcript }, { conversationId: ROOT_CONVERSATION_ID })).toBeUndefined()
  })

  it("lets a failure of the host's budget read reach Pi Durable rather than hiding it", async () => {
    const failing = {
      ...host,
      budgetBlockFor: async (): Promise<string | undefined> => {
        throw new Error("storage closed")
      },
      requestBudget: async (): Promise<RequestBudget> => {
        throw new Error("storage closed")
      },
    }
    const extension = createReviewExtension(failing)
    const { beforeTool } = hooksOf(extension, toolTask)
    const { beforeRequest } = hooksOf(extension, generationTask)
    await expect(beforeTool?.({ name: "grep" }, { conversationId: ROOT_CONVERSATION_ID })).rejects.toThrow(
      "storage closed",
    )
    await expect(beforeRequest?.({ messages: transcript }, { conversationId: ROOT_CONVERSATION_ID })).rejects.toThrow(
      "storage closed",
    )
  })

  it("marks a request in the way the provider wrapper refuses, so the model is never called", async () => {
    const refusing = { ...host, requestBudget: async (): Promise<RequestBudget> => "refuse" }
    const { beforeRequest } = hooksOf(createReviewExtension(refusing), generationTask)
    const marked = await beforeRequest?.({ messages: transcript }, { conversationId: ROOT_CONVERSATION_ID })
    const faux = fauxProvider()
    const answer = await withBudgetRefusal(faux.provider, "andabot")
      .streamSimple(faux.getModel(), normalizeContext({ messages: [...(marked?.messages ?? [])] }))
      .result()
    expect(answer).toMatchObject({ stopReason: "error", errorMessage: BUDGET_REFUSAL })
    expect(faux.state.callCount).toBe(0)
  })
})

describe("grepText", () => {
  const snapshot = snapshotOf(headSha, { "src/a.ts": "export const total = 1\n", "src/b.ts": "const x = total + 1\n" })

  it("answers from the snapshot", async () => {
    const { host: wired } = hostWith({ search: { kind: "ready", files: snapshot, work: new GrepWork() } })
    const answer = await grepText(wired, { pattern: "total", glob: "*.ts" })
    expect(answer).toContain("src/a.ts")
    expect(answer).toContain("export const total = 1")
    expect(answer).toContain("src/b.ts")
  })

  it("says search is unavailable", async () => {
    const { host: wired } = hostWith({ search: { kind: "unavailable", reason: "the tarball failed: 502" } })
    expect(await grepText(wired, { pattern: "total" })).toBe(
      "Repository search is unavailable for this review: the tarball failed: 502. Use read_file.",
    )
  })

  it("says the budget is spent", async () => {
    const { host: wired } = hostWith({ search: { kind: "spent" } })
    expect(await grepText(wired, { pattern: "total" })).toBe(
      "Search budget spent: 40 grep and tree calls this review. Use read_file.",
    )
  })

  it("says search again when the snapshot was dropped between the access check and the scan", async () => {
    const unfinished = new MemorySnapshotFiles()
    unfinished.begin(headSha)
    unfinished.add([{ path: "src/a.ts", content: "export const total = 1\n" }])
    const { host: wired } = hostWith({ search: { kind: "ready", files: unfinished, work: new GrepWork() } })
    const replaced =
      "Repository search is unavailable for this review: the snapshot was replaced while searching; search again. Use read_file."
    expect(await grepText(wired, { pattern: "total" })).toBe(replaced)
    expect(await treeText(wired, {})).toBe(replaced)
  })

  it("lets one grep of a parallel round past a run budget a unit short of spent, and answers the other that it is spent", async () => {
    const runs = new SnapshotRuns(
      () => snapshot,
      async () => {
        throw new Error("the snapshot is already loaded")
      },
    )
    const head = async () => ({ number: pr.number, sha: headSha })
    runs.start()
    const opened = await runs.access("tree", head)
    if (opened.kind !== "ready") throw new Error(`expected a ready access, got ${opened.kind}`)
    opened.work.charge(MAX_RUN_SEARCH_WORK - 1)
    const wired = { ...host, repositorySearch: async (tool: "grep" | "tree") => runs.access(tool, head) }
    const answers = await Promise.all([grepText(wired, { pattern: "total" }), grepText(wired, { pattern: "total" })])
    expect(answers[0]).toContain("src/a.ts:1: export const total = 1")
    expect(answers[1]).toBe(
      "Grep budget spent: this review's grep calls have searched as much as one review allows. Use tree or read_file.",
    )
    expect(await treeText(wired, { path: "src" })).toBe("src/a.ts\nsrc/b.ts")
  })

  it("refuses a bad pattern without asking for search access, so the refusal uses no budget", async () => {
    const { host: wired, searched } = hostWith({ search: { kind: "ready", files: snapshot, work: new GrepWork() } })
    expect(await grepText(wired, { pattern: "" })).toBe("Pattern refused: The pattern is empty.")
    expect(searched).toEqual([])
  })

  it("searches a pattern with two wildcards and a repeated alternation instead of refusing it", async () => {
    const { host: wired, searched } = hostWith({ search: { kind: "ready", files: snapshot, work: new GrepWork() } })
    expect(await grepText(wired, { pattern: String.raw`.*a.*b(.|\s)*zzz` })).toMatch(/^No match for /)
    expect(searched).toEqual(["grep"])
  })
})

describe("treeText", () => {
  const snapshot = snapshotOf(headSha, { "src/a.ts": "a", "src/deep/b.ts": "b", "README.md": "r" })

  it("lists the snapshot under a path", async () => {
    const { host: wired, searched } = hostWith({ search: { kind: "ready", files: snapshot, work: new GrepWork() } })
    expect(await treeText(wired, { path: "src", depth: 1 })).toBe("src/a.ts\nsrc/deep/")
    expect(searched).toEqual(["tree"])
  })

  it("says search is unavailable", async () => {
    const { host: wired } = hostWith({ search: { kind: "unavailable", reason: "no snapshot" } })
    expect(await treeText(wired, {})).toBe(
      "Repository search is unavailable for this review: no snapshot. Use read_file.",
    )
  })

  it("says the budget is spent", async () => {
    const { host: wired } = hostWith({ search: { kind: "spent" } })
    expect(await treeText(wired, {})).toBe("Search budget spent: 40 grep and tree calls this review. Use read_file.")
  })
})

describe("readFileText", () => {
  it("reads the head from a loaded snapshot without calling the API", async () => {
    const snapshot = snapshotOf(headSha, { "src/a.ts": "from the snapshot" })
    const { host: wired, requested } = hostWith({ snapshot })
    expect(await readFileText(wired, { path: "src/a.ts" })).toBe("    1 | from the snapshot")
    expect(requested).toEqual([])
  })

  it("reads the head from the API when the snapshot is for another sha", async () => {
    const snapshot = snapshotOf(baseSha, { "src/a.ts": "from the snapshot" })
    const { host: wired, requested } = hostWith({ snapshot })
    expect(await readFileText(wired, { path: "src/a.ts" })).toBe("    1 | from the head api")
    expect(requested).toHaveLength(1)
  })

  it("reads the head from the API when the snapshot left that path out", async () => {
    const snapshot = snapshotOf(headSha, { "src/other.ts": "x" })
    const { host: wired, requested } = hostWith({ snapshot })
    expect(await readFileText(wired, { path: "src/a.ts" })).toBe("    1 | from the head api")
    expect(requested).toHaveLength(1)
  })

  it("reads the head from the API when the snapshot has no record, as when a load was interrupted", async () => {
    const snapshot = new MemorySnapshotFiles()
    snapshot.begin(headSha)
    snapshot.add([{ path: "src/a.ts", content: "partial" }])
    const { host: wired } = hostWith({ snapshot })
    expect(await readFileText(wired, { path: "src/a.ts" })).toBe("    1 | from the head api")
  })

  it("reads the base from the API and ignores the snapshot", async () => {
    const snapshot = snapshotOf(headSha, { "src/a.ts": "from the snapshot" })
    const { host: wired, requested } = hostWith({ snapshot })
    expect(await readFileText(wired, { path: "src/a.ts", ref: "base" })).toBe("    1 | from the base api")
    expect(requested).toHaveLength(1)
  })

  it("says so when the file does not exist at the head", async () => {
    const { host: wired } = hostWith({})
    expect(await readFileText(wired, { path: "src/none.ts" })).toBe("src/none.ts does not exist at head (fedcba9).")
  })
})

describe("readIssue", () => {
  it("gives an issue's number, title, state and body", async () => {
    expect(await readIssue(host, 7)).toBe("#7: Fix totals (open)\n\nTotals are NaN.")
  })

  it("says so when the issue does not exist", async () => {
    expect(await readIssue(host, 8)).toBe("Issue #8 does not exist.")
  })

  it("says so when the number is a pull request, which GitHub's issue endpoint also serves", async () => {
    expect(await readIssue(host, 9)).toBe("#9 is a pull request, not an issue.")
  })
})

describe("submitResult", () => {
  it("ends the run when the host says the review is done", () => {
    expect(submitResult({ text: "Posted review 1.", done: true })).toEqual({
      output: [{ type: "text", text: "Posted review 1." }],
      control: { terminate: true },
    })
  })

  it("leaves the run going when the host says there is more to do, so the model can correct and submit again", () => {
    const result = submitResult({ text: "Nothing to post.", done: false })
    expect(result.output).toEqual([{ type: "text", text: "Nothing to post." }])
    expect(result).not.toHaveProperty("control")
  })
})
