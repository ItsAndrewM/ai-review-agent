import type { JsonValue } from "@earendil-works/pi-ai"
import { Type, type TSchema } from "typebox"
import { Value } from "typebox/value"
import type { GitHubClient, PullRequestInfo } from "../../src/github/client.ts"
import type { ChangedFile } from "../../src/github/diff.ts"
import { ReviewSubmission, type ReviewSubmissionInput } from "../../src/review/findings.ts"
import { resolveOutcomeText, ResolveThreadParameters } from "../../src/review/thread-resolution.ts"
import {
  createReviewExtension,
  GrepParameters,
  ReadFileParameters,
  RunCheckParameters,
  TreeParameters,
  type ReviewHost,
  type SubmitOutcome,
} from "../../src/review/tools.ts"
import { refusalText } from "../../src/sandbox/checks.ts"
import type { ReplaySource } from "../replay/snapshot.ts"

export interface RecallSource extends ReplaySource {
  changedFilesText(): Promise<string>
  issue(number: number): string
}

export interface ToolDescription {
  name: string
  description: string
  parameters: TSchema
}

type Submit = (submission: ReviewSubmissionInput) => Promise<SubmitOutcome>

const IssueParameters = Type.Object({ number: Type.Integer() })

const BOT_LOGIN = "andabot"

const NOT_IN_REPLAY = "not available in the recall replay"

function stubHost(): ReviewHost {
  const unavailable = (): never => {
    throw new Error(NOT_IN_REPLAY)
  }
  return {
    botLogin: () => BOT_LOGIN,
    github: async (): Promise<GitHubClient> => unavailable(),
    pullRequest: async (): Promise<PullRequestInfo> => unavailable(),
    changedFiles: async (): Promise<ChangedFile[]> => unavailable(),
    pathFilters: async () => [],
    submitReview: async () => unavailable(),
    repositorySearch: async () => ({ kind: "unavailable", reason: NOT_IN_REPLAY }),
    runCheck: async () => unavailable(),
    resolveThread: async () => unavailable(),
    loadedSnapshot: () => undefined,
    budgetBlockFor: async () => undefined,
    requestBudget: async () => "allow",
  }
}

export function reviewToolDescriptions(): ToolDescription[] {
  const tools = createReviewExtension(stubHost()).tools ?? []
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
}

export class RecallTools {
  readonly #source: RecallSource
  readonly #submit: Submit

  constructor(source: RecallSource, submit: Submit) {
    this.#source = source
    this.#submit = submit
  }

  descriptions(): ToolDescription[] {
    return reviewToolDescriptions()
  }

  async execute(name: string, args: JsonValue): Promise<SubmitOutcome> {
    switch (name) {
      case "read_file":
      case "grep":
      case "tree":
      case "list_changed_files":
      case "get_issue":
        return { text: await this.read(name, args), done: false }
      case "run_check":
        return { text: checkRefusal(args), done: false }
      case "resolve_thread":
        return { text: resolveRefusal(args), done: false }
      case "submit_review":
        return this.submit(args)
      default:
        return { text: `Unknown review tool: ${name}`, done: false }
    }
  }

  private async read(name: string, args: JsonValue): Promise<string> {
    switch (name) {
      case "read_file":
        return Value.Check(ReadFileParameters, args) ? this.#source.readFile(args) : invalid(name)
      case "grep":
        return Value.Check(GrepParameters, args) ? this.#source.grep(args) : invalid(name)
      case "tree":
        return Value.Check(TreeParameters, args) ? this.#source.tree(args) : invalid(name)
      case "list_changed_files":
        return this.#source.changedFilesText()
      default:
        return Value.Check(IssueParameters, args) ? this.#source.issue(args.number) : invalid(name)
    }
  }

  private async submit(args: JsonValue): Promise<SubmitOutcome> {
    if (!Value.Check(ReviewSubmission, args)) return { text: invalid("submit_review"), done: false }
    return this.#submit(args)
  }
}

function invalid(name: string): string {
  return `Invalid arguments for ${name}.`
}

function checkRefusal(args: JsonValue): string {
  if (!Value.Check(RunCheckParameters, args)) return invalid("run_check")
  return refusalText(args.name, { kind: "off" })
}

function resolveRefusal(args: JsonValue): string {
  if (!Value.Check(ResolveThreadParameters, args)) return invalid("resolve_thread")
  return resolveOutcomeText({ kind: "refused", refusal: "not_answering" })
}
