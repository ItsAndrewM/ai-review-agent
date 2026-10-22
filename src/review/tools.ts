import { Type } from "@earendil-works/pi-ai"
import {
  defineExtension,
  defineTool,
  type ConversationId,
  type Extension,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable"
import type { GitHubClient, PullRequestInfo } from "../github/client.ts"
import { filterGlobs, isFiltered, type ChangedFile } from "../github/diff.ts"
import { ReviewSubmission, type ReviewSubmissionInput } from "./findings.ts"
import { issueText } from "./linked-issues.ts"
import { systemPrompt } from "./prompt.ts"

export interface SubmitOutcome {
  readonly text: string
  readonly done: boolean
}

export interface ReviewHost {
  botLogin(): string
  github(): Promise<GitHubClient>
  pullRequest(): Promise<PullRequestInfo>
  changedFiles(): Promise<ChangedFile[]>
  pathFilters(): Promise<readonly string[]>
  submitReview(submission: ReviewSubmissionInput, conversationId: ConversationId): Promise<SubmitOutcome>
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
    async execute({ path, ref }) {
      const pr = await host.pullRequest()
      const sha = ref === "base" ? pr.base.sha : pr.head.sha
      const github = await host.github()
      const content = await github.getFileContent({ owner: owner(pr), repo: repo(pr) }, path, sha)
      if (content === undefined) return text(`${path} does not exist at ${ref ?? "head"} (${sha.slice(0, 7)}).`)
      const lines = content.split("\n")
      let out = lines.map((line, i) => `${String(i + 1).padStart(5)} | ${line}`).join("\n")
      if (out.length > MAX_FILE_CHARS)
        out = `${out.slice(0, MAX_FILE_CHARS)}\n... (truncated at ${MAX_FILE_CHARS} characters)`
      return text(out)
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

  const submitReview = defineTool({
    name: "submit_review",
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
    sections: [{ key: "preamble", render: () => systemPrompt(host.botLogin()), tag: false }],
    tools: [readFile, listChangedFiles, getIssue, submitReview],
  })
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
