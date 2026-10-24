import type { JsonValue } from "@earendil-works/pi-ai"
import { Value } from "typebox/value"
import {
  GrepParameters,
  ReadFileParameters,
  TreeParameters,
  type GrepArgs,
  type ReadFileArgs,
  type TreeArgs,
} from "../../src/review/tools.ts"
import { createVerifyExtension, VERIFY_TOOL_BUDGET, type VerifyHost } from "../../src/review/verify-tools.ts"
import { VerdictsSubmission, type VerdictInput } from "../../src/review/verify.ts"

export interface ReplaySource {
  readFile(args: ReadFileArgs): Promise<string>
  grep(args: GrepArgs): Promise<string>
  tree(args: TreeArgs): Promise<string>
}

export class ReplayTools {
  readonly #source: ReplaySource
  #calls = 0
  #verdicts: VerdictInput[] | undefined

  constructor(source: ReplaySource) {
    this.#source = source
  }

  descriptions() {
    const host = {
      readFile: (args: ReadFileArgs) => this.#source.readFile(args),
      grep: (args: GrepArgs) => this.#source.grep(args),
      tree: (args: TreeArgs) => this.#source.tree(args),
      passOf: () => "replay",
      submitVerdicts: async () => ({ text: "Recorded verdicts.", done: true }),
    } satisfies VerifyHost
    return (
      createVerifyExtension(host).tools?.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })) ?? []
    )
  }

  verdicts(): VerdictInput[] | undefined {
    return this.#verdicts
  }

  async execute(name: string, args: JsonValue): Promise<string> {
    switch (name) {
      case "read_file":
        return this.read(args)
      case "grep":
        return this.search(args)
      case "tree":
        return this.list(args)
      case "submit_verdicts":
        return this.submit(args)
      default:
        return `Unknown verify tool: ${name}`
    }
  }

  private async read(args: JsonValue): Promise<string> {
    if (!Value.Check(ReadFileParameters, args)) return "Invalid arguments for read_file."
    return this.budgeted(() => this.#source.readFile(args))
  }

  private async search(args: JsonValue): Promise<string> {
    if (!Value.Check(GrepParameters, args)) return "Invalid arguments for grep."
    return this.budgeted(() => this.#source.grep(args))
  }

  private async list(args: JsonValue): Promise<string> {
    if (!Value.Check(TreeParameters, args)) return "Invalid arguments for tree."
    return this.budgeted(() => this.#source.tree(args))
  }

  private submit(args: JsonValue): string {
    if (!Value.Check(VerdictsSubmission, args)) return "Invalid arguments for submit_verdicts."
    this.#verdicts ??= args.verdicts
    const count = args.verdicts.length
    return `Recorded ${count} ${count === 1 ? "verdict" : "verdicts"}.`
  }

  private async budgeted(call: () => Promise<string>): Promise<string> {
    if (this.#calls >= VERIFY_TOOL_BUDGET)
      return `Verify's tool budget of ${VERIFY_TOOL_BUDGET} calls is spent; decide from what you have.`
    this.#calls++
    return call()
  }
}
