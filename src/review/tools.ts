import { Type } from "@earendil-works/pi-ai"
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable"
import type { GitHubClient, PullRequestInfo } from "../github/client.ts"
import { filterGlobs, isFiltered, type ChangedFile } from "../github/diff.ts"
import { grep, MAX_SEARCH_CALLS, patternProblem, tree } from "../repository/search.ts"
import type { SnapshotFiles } from "../repository/snapshot.ts"
import { ReviewSubmission, type ReviewSubmissionInput } from "./findings.ts"
import { issueText } from "./linked-issues.ts"
import { systemPrompt } from "./prompt.ts"

export interface SubmitOutcome {
  readonly text: string
  readonly done: boolean
}

export type SearchAccess =
  | { kind: "ready"; files: SnapshotFiles }
  | { kind: "unavailable"; reason: string }
  | { kind: "spent" }

export interface ReviewHost {
  botLogin(): string
  github(): Promise<GitHubClient>
  pullRequest(): Promise<PullRequestInfo>
  changedFiles(): Promise<ChangedFile[]>
  pathFilters(): Promise<readonly string[]>
  submitReview(submission: ReviewSubmissionInput): Promise<SubmitOutcome>
  repositorySearch(tool: "grep" | "tree"): Promise<SearchAccess>
  loadedSnapshot(): SnapshotFiles | undefined
}

const MAX_FILE_CHARS = 60_000

export function createReviewExtension(host: ReviewHost): Extension {
  const readFile = defineTool({
    name: "read_file",
    description:
      "Read a file from the repository at the pull request's head (default) or base commit, with line numbers. Use it when the diff alone cannot settle a question.",
    parameters: Type.Object({
      path: Type.String({ description: "Path from the repository root." }),
      ref: Type.Optional(
        Type.Union([Type.Literal("head"), Type.Literal("base")], { description: "head (default) or base." }),
      ),
    }),
    replay: "safe",
    async execute(args) {
      return text(await readFileText(host, args))
    },
  })

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

  const grepTool = defineTool({
    name: "grep",
    description:
      "Search the files at the pull request's head by regular expression, line by line. Use it to find the callers of a changed function, an export's users, or where a name is defined.",
    parameters: Type.Object({
      pattern: Type.String({
        description: "Regular expression, matched against the first 500 characters of each line.",
      }),
      glob: Type.Optional(
        Type.String({
          description:
            "Only search files whose path matches this glob. It is matched against the path from the repository root, not from `path`, and a pattern without a slash matches at any depth, so `*.ts` finds every TypeScript file.",
        }),
      ),
      path: Type.Optional(Type.String({ description: "Only search under this directory, from the repository root." })),
    }),
    replay: "safe",
    async execute(args) {
      return text(await grepText(host, args))
    },
  })

  const treeTool = defineTool({
    name: "tree",
    description: "List the directories and files at the pull request's head under a path.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory from the repository root. Default: the root." })),
      depth: Type.Optional(Type.Integer({ description: "How many levels to list. Default 2." })),
    }),
    replay: "safe",
    async execute(args) {
      return text(await treeText(host, args))
    },
  })

  const submitReview = defineTool({
    name: "submit_review",
    description:
      "Submit the review: summary, per-file walkthrough, findings anchored to diff lines, and a verdict. The host validates every finding and posts the review to GitHub. Call it once; rejected findings and missing walkthrough rows come back once, so correct them and call it again. A second submission with walkthrough rows still missing ends the review unposted.",
    parameters: ReviewSubmission,
    callers: ["model"],
    async execute(submission) {
      return submitResult(await host.submitReview(submission))
    },
  })

  return defineExtension({
    name: "andabot",
    sections: [{ key: "preamble", render: () => systemPrompt(host.botLogin()), tag: false }],
    tools: [readFile, listChangedFiles, getIssue, grepTool, treeTool, submitReview],
  })
}

export async function readFileText(host: ReviewHost, args: { path: string; ref?: "head" | "base" }): Promise<string> {
  const { path, ref } = args
  const pr = await host.pullRequest()
  const sha = ref === "base" ? pr.base.sha : pr.head.sha
  const content =
    (ref !== "base" ? snapshotContent(host.loadedSnapshot(), sha, path) : undefined) ??
    (await fetchContent(host, pr, path, sha))
  if (content === undefined) return `${path} does not exist at ${ref ?? "head"} (${sha.slice(0, 7)}).`
  const out = content
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(5)} | ${line}`)
    .join("\n")
  return out.length > MAX_FILE_CHARS
    ? `${out.slice(0, MAX_FILE_CHARS)}\n... (truncated at ${MAX_FILE_CHARS} characters)`
    : out
}

function snapshotContent(snapshot: SnapshotFiles | undefined, sha: string, path: string): string | undefined {
  if (snapshot?.record()?.sha !== sha || !snapshot.has(path)) return undefined
  return snapshot.read(path)
}

async function fetchContent(host: ReviewHost, pr: PullRequestInfo, path: string, sha: string) {
  const github = await host.github()
  return github.getFileContent({ owner: owner(pr), repo: repo(pr) }, path, sha)
}

export async function grepText(
  host: ReviewHost,
  query: { pattern: string; glob?: string; path?: string },
): Promise<string> {
  const problem = patternProblem(query.pattern)
  if (problem !== undefined) return `Pattern refused: ${problem}`
  const access = await host.repositorySearch("grep")
  if (access.kind !== "ready") return searchRefusal(access)
  return access.files.record() === undefined ? searchRefusal(SNAPSHOT_REPLACED) : grep(access.files, query)
}

export async function treeText(host: ReviewHost, args: { path?: string; depth?: number }): Promise<string> {
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
