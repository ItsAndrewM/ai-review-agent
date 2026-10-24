import { Type, type Message } from "@earendil-works/pi-ai"
import {
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ToolTask,
  type ConversationId,
  type Extension,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable"
import type { Static } from "typebox"
import type { GitHubClient, PullRequestInfo } from "../github/client.ts"
import { filterGlobs, isFiltered, type ChangedFile } from "../github/diff.ts"
import { grep, MAX_SEARCH_CALLS, patternProblem, tree, type GrepWork } from "../repository/search.ts"
import type { SnapshotFiles } from "../repository/snapshot.ts"
import { ReviewSubmission, type ReviewSubmissionInput } from "./findings.ts"
import { issueText } from "./linked-issues.ts"
import { BUDGET_REFUSAL_MARKER, numberedLine, SUBMIT_REVIEW_TOOL, systemPrompt } from "./prompt.ts"

export interface SubmitOutcome {
  readonly text: string
  readonly done: boolean
}

export type SearchAccess =
  | { kind: "ready"; files: SnapshotFiles; work: GrepWork }
  | { kind: "unavailable"; reason: string }
  | { kind: "spent" }

export type RequestBudget = "allow" | "refuse"

export interface ReviewHost {
  botLogin(): string
  github(): Promise<GitHubClient>
  pullRequest(): Promise<PullRequestInfo>
  changedFiles(): Promise<ChangedFile[]>
  pathFilters(): Promise<readonly string[]>
  submitReview(submission: ReviewSubmissionInput, conversationId: ConversationId): Promise<SubmitOutcome>
  repositorySearch(tool: "grep" | "tree"): Promise<SearchAccess>
  loadedSnapshot(): SnapshotFiles | undefined
  budgetBlockFor(toolName: string, conversationId: ConversationId): Promise<string | undefined>
  requestBudget(conversationId: ConversationId): Promise<RequestBudget>
}

const MAX_FILE_CHARS = 60_000

const ReadFileParameters = Type.Object({
  path: Type.String({ description: "Path from the repository root." }),
  ref: Type.Optional(
    Type.Union([Type.Literal("head"), Type.Literal("base")], { description: "head (default) or base." }),
  ),
})

export type ReadFileArgs = Static<typeof ReadFileParameters>

const GrepParameters = Type.Object({
  pattern: Type.String({
    description:
      "RE2 regular expression, matched against the first 500 characters of each line. JavaScript syntax mostly works, but \\s matches ASCII whitespace only, and lookaround and backreferences aren't supported: a pattern using them is searched as literal text.",
  }),
  glob: Type.Optional(
    Type.String({
      description:
        "Only search files whose path matches this glob. It is matched against the path from the repository root, not from `path`, and a pattern without a slash matches at any depth, so `*.ts` finds every TypeScript file.",
    }),
  ),
  path: Type.Optional(Type.String({ description: "Only search under this directory, from the repository root." })),
})

export type GrepArgs = Static<typeof GrepParameters>

const TreeParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory from the repository root. Default: the root." })),
  depth: Type.Optional(Type.Integer({ minimum: 1, description: "How many levels to list, at least 1. Default 2." })),
})

export type TreeArgs = Static<typeof TreeParameters>

type ToolText<Args> = (args: Args, conversationId: ConversationId) => Promise<string>

export function readFileTool(read: ToolText<ReadFileArgs>) {
  return defineTool({
    name: "read_file",
    description:
      "Read a file from the repository at the pull request's head (default) or base commit, with line numbers. Use it when the diff alone cannot settle a question.",
    parameters: ReadFileParameters,
    replay: "safe",
    async execute(args, api) {
      return text(await read(args, api.conversationId))
    },
  })
}

export function grepTool(search: ToolText<GrepArgs>) {
  return defineTool({
    name: "grep",
    description:
      "Search the files at the pull request's head by regular expression, line by line. Use it to find the callers of a changed function, an export's users, or where a name is defined.",
    parameters: GrepParameters,
    replay: "unsafe",
    async execute(args, api) {
      return text(await search(args, api.conversationId))
    },
  })
}

export function treeTool(list: ToolText<TreeArgs>) {
  return defineTool({
    name: "tree",
    description: "List the directories and files at the pull request's head under a path.",
    parameters: TreeParameters,
    replay: "unsafe",
    async execute(args, api) {
      return text(await list(args, api.conversationId))
    },
  })
}

export function createReviewExtension(host: ReviewHost): Extension {
  const readFile = readFileTool((args) => readFileText(host, args))

  const listChangedFiles = defineTool({
    name: "list_changed_files",
    description:
      "List the files the pull request changes, with status and line counts. A file marked (filtered) is left out of the review by the repository's .andabot.yaml path_filters: it needs no walkthrough row, and a finding on it is dropped.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute() {
      return text(await changedFilesText(host))
    },
  })

  const getIssue = defineTool({
    name: "get_issue",
    description:
      "Read an issue of this repository by number: its title, state and full body, which are material under review. Use it for an issue the pull request refers to beyond its linked issues, or for the rest of a linked issue whose body the prompt cut.",
    parameters: Type.Object({ number: Type.Integer() }),
    replay: "safe",
    async execute({ number }) {
      return text(await readIssue(host, number))
    },
  })

  const grepFiles = grepTool((query) => grepText(host, query))

  const listTree = treeTool((args) => treeText(host, args))

  const submitReview = defineTool({
    name: SUBMIT_REVIEW_TOOL,
    description:
      "Submit the review: summary, per-file walkthrough, findings anchored to diff lines, and a verdict. The host validates every finding and posts the review to GitHub. Call it once; rejected findings and missing walkthrough rows come back once, so correct them and call it again. A second submission with walkthrough rows still missing ends the review unposted.",
    parameters: ReviewSubmission,
    callers: ["model"],
    async execute(submission, api) {
      return submitResult(await host.submitReview(submission, api.conversationId))
    },
  })

  return defineExtension({
    name: "andabot",
    sections: [
      {
        key: "preamble",
        render: (input) =>
          systemPrompt(
            host.botLogin(),
            input.agent.tools.map((tool) => tool.name),
          ),
        tag: false,
      },
    ],
    tools: [readFile, listChangedFiles, getIssue, grepFiles, listTree, submitReview],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => blockOrNothing(await host.budgetBlockFor(call.name, api.conversationId)),
      }),
      hook(GenerationTask, {
        beforeRequest: async (request, api) =>
          markedOrNothing(request.messages, await host.requestBudget(api.conversationId)),
      }),
    ],
  })
}

function blockOrNothing(message: string | undefined) {
  return message === undefined ? undefined : { block: message }
}

function markedOrNothing(messages: readonly Message[], decision: RequestBudget) {
  if (decision === "allow") return undefined
  const marker = { role: "user", content: BUDGET_REFUSAL_MARKER, timestamp: 0 } satisfies Message
  return { messages: [...messages, marker] }
}

export async function readFileText(host: ReviewHost, args: ReadFileArgs): Promise<string> {
  const { path, ref } = args
  const { sha, content } = await fileAt(host, path, ref)
  if (content === undefined) return `${path} does not exist at ${ref ?? "head"} (${sha.slice(0, 7)}).`
  const out = content
    .split("\n")
    .map((line, i) => numberedLine(i + 1, line))
    .join("\n")
  return out.length > MAX_FILE_CHARS
    ? `${out.slice(0, MAX_FILE_CHARS)}\n... (truncated at ${MAX_FILE_CHARS} characters)`
    : out
}

export async function fileAt(
  host: ReviewHost,
  path: string,
  ref: ReadFileArgs["ref"],
): Promise<{ sha: string; content: string | undefined }> {
  const pr = await host.pullRequest()
  const sha = ref === "base" ? pr.base.sha : pr.head.sha
  const content =
    (ref !== "base" ? snapshotContent(host.loadedSnapshot(), sha, path) : undefined) ??
    (await fetchContent(host, pr, path, sha))
  return { sha, content }
}

function snapshotContent(snapshot: SnapshotFiles | undefined, sha: string, path: string): string | undefined {
  if (snapshot?.record()?.sha !== sha || !snapshot.has(path)) return undefined
  return snapshot.read(path)
}

async function fetchContent(host: ReviewHost, pr: PullRequestInfo, path: string, sha: string) {
  const github = await host.github()
  return github.getFileContent({ owner: owner(pr), repo: repo(pr) }, path, sha)
}

export async function grepText(host: ReviewHost, query: GrepArgs): Promise<string> {
  const problem = patternProblem(query.pattern)
  if (problem !== undefined) return `Pattern refused: ${problem}`
  const access = await host.repositorySearch("grep")
  if (access.kind !== "ready") return searchRefusal(access)
  return access.files.record() === undefined ? searchRefusal(SNAPSHOT_REPLACED) : grep(access.files, query, access.work)
}

export async function treeText(host: ReviewHost, args: TreeArgs): Promise<string> {
  const access = await host.repositorySearch("tree")
  if (access.kind !== "ready") return searchRefusal(access)
  return access.files.record() === undefined
    ? searchRefusal(SNAPSHOT_REPLACED)
    : tree(access.files, args.path, args.depth)
}

const SNAPSHOT_REPLACED = {
  kind: "unavailable",
  reason: "the snapshot was replaced while searching; search again",
} as const

function searchRefusal(access: Exclude<SearchAccess, { kind: "ready" }>): string {
  if (access.kind === "spent") {
    return `Search budget spent: ${MAX_SEARCH_CALLS} grep and tree calls this review. Use read_file.`
  }
  return `Repository search is unavailable for this review: ${access.reason}. Use read_file.`
}

export async function changedFilesText(host: ReviewHost): Promise<string> {
  const globs = filterGlobs(await host.pathFilters())
  const line = (file: ChangedFile): string => {
    const mark = isFiltered(file.filename, globs) ? " (filtered)" : ""
    return `${file.status.padEnd(9)} +${file.additions} -${file.deletions}  ${file.filename}${mark}`
  }
  return (await host.changedFiles()).map(line).join("\n") || "(no files)"
}

export async function readIssue(host: ReviewHost, number: number): Promise<string> {
  const pr = await host.pullRequest()
  const github = await host.github()
  const issue = await github.getIssue({ owner: owner(pr), repo: repo(pr) }, number)
  return issueText({ number, issue })
}

export function submitResult(outcome: SubmitOutcome): ToolExecutionResult {
  const result = text(outcome.text)
  return outcome.done ? { ...result, control: { terminate: true } } : result
}

function text(value: string) {
  return { output: [{ type: "text" as const, text: value }] }
}

function owner(pr: PullRequestInfo): string {
  return pr.base.repo.full_name.split("/")[0] ?? ""
}

function repo(pr: PullRequestInfo): string {
  return pr.base.repo.full_name.split("/")[1] ?? ""
}
