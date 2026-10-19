import { Type } from "@earendil-works/pi-ai"
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable"
import type { GitHubClient, PullRequestInfo } from "../github/client.ts"
import type { ChangedFile } from "../github/diff.ts"
import { ReviewSubmission, type ReviewSubmissionInput } from "./findings.ts"
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
  submitReview(submission: ReviewSubmissionInput): Promise<SubmitOutcome>
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
    description: "List the files the pull request changes, with status and line counts.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute() {
      const files = await host.changedFiles()
      return text(
        files.map((f) => `${f.status.padEnd(9)} +${f.additions} -${f.deletions}  ${f.filename}`).join("\n") ||
          "(no files)",
      )
    },
  })

  const submitReview = defineTool({
    name: "submit_review",
    description:
      "Submit the review: summary, per-file walkthrough, findings anchored to diff lines, and a verdict. The host validates every finding and posts the review to GitHub. Call it once; if it reports rejected findings, correct them and call it again.",
    parameters: ReviewSubmission,
    callers: ["model"],
    async execute(submission) {
      const outcome = await host.submitReview(submission)
      if (!outcome.done) return text(outcome.text)
      return { ...text(outcome.text), control: { terminate: true as const } }
    },
  })

  return defineExtension({
    name: "andabot",
    sections: [{ key: "preamble", render: () => systemPrompt(host.botLogin()), tag: false }],
    tools: [readFile, listChangedFiles, submitReview],
  })
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
