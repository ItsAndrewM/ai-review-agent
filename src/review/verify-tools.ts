import {
  defineExtension,
  defineTool,
  type ConversationId,
  type Extension,
  type HarnessSettings,
  type RegistryReader,
} from "@earendil-works/pi-durable"
import {
  grepText,
  grepTool,
  readFileText,
  readFileTool,
  submitResult,
  treeText,
  treeTool,
  type GrepArgs,
  type ReadFileArgs,
  type ReviewHost,
  type SubmitOutcome,
  type TreeArgs,
} from "./tools.ts"
import { VerdictsSubmission, type VerdictInput } from "./verify.ts"

export const VERIFY_EXTENSION = "andabot.verify"

export const SUBMIT_VERDICTS_TOOL = "submit_verdicts"

export const VERIFY_TOOL_BUDGET = 10

const BUDGET_SPENT = `Verify's tool budget of ${VERIFY_TOOL_BUDGET} calls is spent; decide from what you have.`

const NO_VERIFY_PASS = "No verify pass is running in this conversation; stop here."

export interface VerifyHost {
  readFile(args: ReadFileArgs): Promise<string>
  grep(query: GrepArgs): Promise<string>
  tree(args: TreeArgs): Promise<string>
  passOf(conversationId: ConversationId): string | undefined
  submitVerdicts(verdicts: VerdictInput[], conversationId: ConversationId): Promise<SubmitOutcome>
}

export function createVerifyExtension(host: VerifyHost): Extension {
  const withinBudget = passBudget(host)
  const submitVerdicts = defineTool({
    name: SUBMIT_VERDICTS_TOOL,
    description:
      "Submit your verdicts: one for every finding id, each keeping or dropping the finding, with its severity and a one-line reason. Call it once, when you have judged every finding.",
    parameters: VerdictsSubmission,
    callers: ["model"],
    async execute({ verdicts }, api) {
      return submitResult(await host.submitVerdicts(verdicts, api.conversationId))
    },
  })
  return defineExtension({
    name: VERIFY_EXTENSION,
    tools: [
      readFileTool((args, conversationId) => withinBudget(conversationId, () => host.readFile(args))),
      grepTool((query, conversationId) => withinBudget(conversationId, () => host.grep(query))),
      treeTool((args, conversationId) => withinBudget(conversationId, () => host.tree(args))),
      submitVerdicts,
    ],
  })
}

function passBudget(host: Pick<VerifyHost, "passOf">) {
  const calls = new Map<string, number>()
  return async (conversationId: ConversationId, call: () => Promise<string>): Promise<string> => {
    const pass = host.passOf(conversationId)
    if (pass === undefined) return NO_VERIFY_PASS
    const made = calls.get(pass) ?? 0
    if (made >= VERIFY_TOOL_BUDGET) return BUDGET_SPENT
    calls.set(pass, made + 1)
    return call()
  }
}

export function verifyHostOf(review: ReviewHost, passes: Pick<VerifyHost, "passOf" | "submitVerdicts">): VerifyHost {
  return {
    readFile: (args) => readFileText(review, args),
    grep: (query) => grepText(review, query),
    tree: (args) => treeText(review, args),
    passOf: (conversationId) => passes.passOf(conversationId),
    submitVerdicts: (verdicts, conversationId) => passes.submitVerdicts(verdicts, conversationId),
  }
}

interface OpenPass<Conversation> {
  readonly conversation: Conversation
  readonly run: string
  readonly operationId: string
  verdicts: VerdictInput[] | undefined
}

export class VerifyPasses<Conversation> {
  #open: OpenPass<Conversation> | undefined

  open(conversation: Conversation, run: string, operationId: string): () => VerdictInput[] | undefined {
    const open = this.#open
    if (open !== undefined && open.run !== run) {
      throw new Error(`verify run ${open.run} is still open, so run ${run} can't open a pass`)
    }
    const pass: OpenPass<Conversation> = { conversation, run, operationId, verdicts: undefined }
    this.#open = pass
    return () => pass.verdicts
  }

  close(run: string): void {
    if (this.#open?.run === run) this.#open = undefined
  }

  passOf(conversation: Conversation): string | undefined {
    return this.#open?.conversation === conversation ? this.#open.operationId : undefined
  }

  async submitVerdicts(verdicts: VerdictInput[], conversation: Conversation): Promise<SubmitOutcome> {
    const pass = this.#open
    if (pass?.conversation !== conversation) return { text: NO_VERIFY_PASS, done: true }
    pass.verdicts ??= verdicts
    return { text: `Recorded ${verdicts.length} ${verdicts.length === 1 ? "verdict" : "verdicts"}.`, done: true }
  }
}

export function withoutVerifyByDefault(registry: RegistryReader, settings: HarnessSettings): HarnessSettings {
  return {
    ...settings,
    get extensions() {
      return registry
        .snapshot()
        .installed()
        .filter(({ name }) => name !== VERIFY_EXTENSION)
    },
  }
}
