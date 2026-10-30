import { appendFile, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { reviewableFiles, filterGlobs, isFiltered, type ChangedFile } from "../../src/github/diff.ts"
import { outputLimitOf, withBudgetRefusal, withForcedJson, withOutputLimit } from "../../src/models.ts"
import { reviewBudgetOf } from "../../src/review/budget.ts"
import { SpendBudget } from "../replay/budget.ts"
import { GitFiles } from "../replay/git.ts"
import { openModel, thinkingLevelOf, type ReplayModel } from "../replay/model.ts"
import { checkWorkersAiAccess } from "../replay/preflight.ts"
import { snapshotSource } from "../replay/snapshot.ts"
import { NeuronBudget } from "./budget.ts"
import { attemptReview } from "./conversation.ts"
import { changedFilesAt } from "./files.ts"
import { ReviewHost } from "./host.ts"
import { promptFor, reviewSkill, systemFor, type ReviewSkill } from "./prompt.ts"
import { compareTable, resultsTable } from "./report.ts"
import { parseSet, setProblems, type HeadCase, type RecallSet } from "./schema.ts"
import { barVerdict, scoreRun, scoreSet, SetScore, type RunScore } from "./score.ts"
import { standardsAt } from "./standards.ts"
import { RecallTools, type RecallSource } from "./tools.ts"

const USAGE =
  "Usage: pnpm recall --inspect | --prompt <sha prefix> | --compare <baseline.json> <run.json> | --model <Workers AI model id> [--thinking low] [--runs 3] [--case <sha prefix>] (a run needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN)"
const ROOT = process.cwd()
const BOT_LOGIN = "andabot"
const SPEND_CAP_USD = 15
const RUNS_DIR = new URL("./runs/", import.meta.url)
const RESULTS_DIR = new URL("./results/", import.meta.url)

interface Options {
  model: string | undefined
  thinking: string | undefined
  runs: number
  onlyCase: string | undefined
  inspect: boolean
  prompt: string | undefined
  compare: [string, string] | undefined
}

interface Prepared {
  readonly head: HeadCase
  readonly files: ChangedFile[]
  readonly reviewable: ChangedFile[]
  readonly pathFilters: string[]
  readonly system: string
  readonly prompt: string
  readonly source: RecallSource
}

interface RunMeta {
  model: string
  thinking: string
  skills: string
  maxOutputTokens: number
  maxReviewNeurons: number
  runs: number
  at: string
}

const ResultsScore = Type.Object({ score: SetScore })

function valuedOption(options: Options, name: string, value: string | undefined): boolean {
  switch (name) {
    case "--model":
      options.model = value
      return true
    case "--thinking":
      options.thinking = value
      return true
    case "--runs":
      options.runs = Number(value)
      return true
    case "--case":
      options.onlyCase = value
      return true
    case "--prompt":
      options.prompt = value
      return true
    default:
      return false
  }
}

function optionsOf(args: readonly string[]): Options {
  const options: Options = {
    model: undefined,
    thinking: undefined,
    runs: 3,
    onlyCase: undefined,
    inspect: false,
    prompt: undefined,
    compare: undefined,
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    if (arg === "--inspect") options.inspect = true
    else if (arg === "--compare") options.compare = [args[++index] ?? "", args[++index] ?? ""]
    else if (valuedOption(options, arg, args[index + 1])) index++
    else throw new Error(`${USAGE}\nUnrecognized option: ${arg}`)
  }
  return withValidRuns(options)
}

function withValidRuns(options: Options): Options {
  if (!Number.isSafeInteger(options.runs) || options.runs < 1 || options.runs > 3) throw new Error(USAGE)
  return options
}

async function loadSet(): Promise<RecallSet> {
  return parseSet(await readFile(new URL("./set.json", import.meta.url), "utf8"))
}

function headsMatching(set: RecallSet, prefix: string | undefined): HeadCase[] {
  const heads = prefix === undefined ? set.heads : set.heads.filter((head) => head.head.startsWith(prefix))
  if (heads.length === 0) throw new Error(`No head in the set starts with ${prefix}`)
  return heads
}

function changedFilesLine(file: ChangedFile, globs: ReturnType<typeof filterGlobs>): string {
  const mark = isFiltered(file.filename, globs) ? " (filtered)" : ""
  return `${file.status.padEnd(9)} +${file.additions} -${file.deletions}  ${file.filename}${mark}`
}

function issueText(head: HeadCase, number: number): string {
  const issue = head.issues.find((candidate) => candidate.number === number)
  if (issue === undefined) return `Issue #${number} does not exist.`
  return `#${number}: ${issue.title} (${issue.state})\n\n${issue.body}`
}

async function prepare(
  head: HeadCase,
  git: GitFiles,
  skill: ReviewSkill,
  toolNames: readonly string[],
): Promise<Prepared> {
  const files = await changedFilesAt(git, head.base, head.head)
  const standards = await standardsAt(
    git,
    head.base,
    files.map(({ filename }) => filename),
  )
  const reviewable = reviewableFiles(files, standards.pathFilters)
  const snapshot = await snapshotSource(head.head, head.base, git)
  const globs = filterGlobs(standards.pathFilters)
  const source: RecallSource = {
    ...snapshot,
    changedFilesText: async () => files.map((file) => changedFilesLine(file, globs)).join("\n") || "(no files)",
    issue: (number) => issueText(head, number),
  }
  return {
    head,
    files,
    reviewable,
    pathFilters: standards.pathFilters,
    system: systemFor(BOT_LOGIN, toolNames, skill.rendered, standards.text),
    prompt: promptFor(head, reviewable),
    source,
  }
}

async function reviewOnce(prepared: Prepared, run: number, model: ReplayModel, neurons: number): Promise<RunScore> {
  const host = new ReviewHost(prepared.files, prepared.pathFilters, prepared.head.issues.length > 0)
  const tools = new RecallTools(prepared.source, async (submission) => host.submit(submission))
  const budget = new NeuronBudget(neurons)
  const answer = await attemptReview(prepared.system, prepared.prompt, tools, host, budget, (context) =>
    model.complete(context),
  )
  return scoreRun(prepared.head, run, answer)
}

function toolNamesOf(): string[] {
  return new RecallTools(
    {
      readFile: async () => "",
      grep: async () => "",
      tree: async () => "",
      changedFilesText: async () => "",
      issue: () => "",
    },
    async () => ({ text: "", done: false }),
  )
    .descriptions()
    .map(({ name }) => name)
}

async function inspect(set: RecallSet): Promise<void> {
  const problems = setProblems(set)
  const expected = set.heads.reduce((total, head) => total + head.expects.length, 0)
  console.log(`Set: ${set.heads.length} heads, ${expected} expected findings, ${problems.length} problems`)
  for (const problem of problems) console.log(`- ${problem}`)
  for (const head of set.heads) {
    const note = head.note === undefined ? "" : ` (${head.note})`
    console.log(
      `- #${head.pr} ${head.head.slice(0, 7)}: ${head.expects.length} expected, verdict ${head.verdict}${note}`,
    )
  }
}

async function showPrompt(set: RecallSet, prefix: string): Promise<void> {
  const [head] = headsMatching(set, prefix)
  if (head === undefined) throw new Error(USAGE)
  const prepared = await prepare(head, new GitFiles(ROOT), await reviewSkill(), toolNamesOf())
  console.log(
    `=== system (${prepared.system.length} chars)\n${prepared.system}\n\n=== prompt (${prepared.prompt.length} chars)\n${prepared.prompt}`,
  )
}

async function readScore(path: string): Promise<SetScore> {
  const value = JSON.parse(await readFile(path, "utf8"))
  if (!Value.Check(ResultsScore, value)) throw new Error(`${path} is not a recall results file`)
  return value.score
}

async function compare(paths: [string, string]): Promise<void> {
  const [baseline, candidate] = await Promise.all(paths.map(readScore))
  if (baseline === undefined || candidate === undefined) throw new Error(USAGE)
  console.log(compareTable(baseline, candidate, barVerdict(baseline, candidate)))
}

function modelTail(modelId: string): string {
  return modelId.split("/").at(-1) ?? modelId
}

async function measure(set: RecallSet, options: Options, account: string, token: string): Promise<void> {
  if (options.model === undefined) throw new Error(USAGE)
  const thinking = thinkingLevelOf(options.thinking)
  const maxTokens = outputLimitOf(process.env.MAX_OUTPUT_TOKENS ?? "16000")
  const neurons = reviewBudgetOf(process.env.MAX_REVIEW_NEURONS)
  await mkdir(RUNS_DIR, { recursive: true })
  const budget = await SpendBudget.open(fileURLToPath(new URL("spend.jsonl", RUNS_DIR)), SPEND_CAP_USD)
  const model = openModel({
    modelId: options.model,
    thinking,
    account,
    token,
    budget,
    maxTokens,
    wrap: (provider) => withBudgetRefusal(withForcedJson(withOutputLimit(provider, maxTokens))),
  })
  const skill = await reviewSkill()
  const git = new GitFiles(ROOT)
  const toolNames = toolNamesOf()
  const stamp = new Date().toISOString()
  const journal = new URL(`${stamp.replaceAll(":", "-")}.jsonl`, RUNS_DIR)
  const runs: RunScore[] = []
  for (const head of headsMatching(set, options.onlyCase)) {
    const prepared = await prepare(head, git, skill, toolNames)
    for (let run = 1; run <= options.runs; run++) {
      const scored = await reviewOnce(prepared, run, model, neurons)
      runs.push(scored)
      await appendFile(journal, `${JSON.stringify(scored)}\n`)
      console.error(
        `#${head.pr} ${head.head.slice(0, 7)} run ${run}: ${scored.answer.source ?? scored.answer.reason} · ${scored.matches.length} matched · ${scored.unmatched.length} unmatched · $${scored.answer.usd.toFixed(4)}`,
      )
    }
  }
  const meta: RunMeta = {
    model: options.model,
    thinking,
    skills: skill.fingerprint,
    maxOutputTokens: maxTokens,
    maxReviewNeurons: neurons,
    runs: options.runs,
    at: stamp,
  }
  const score = scoreSet(set, runs, { model: options.model, thinking, skills: skill.fingerprint })
  const file = new URL(`${stamp.slice(0, 10)}-${modelTail(options.model)}-${thinking}.json`, RESULTS_DIR)
  await writeFile(file, `${JSON.stringify({ meta, score, runs }, null, 2)}\n`)
  console.log(`${resultsTable(set, score)}\n\nResults: ${file.pathname}\nJournal: ${journal.pathname}`)
}

async function main(): Promise<void> {
  const options = optionsOf(process.argv.slice(2))
  const set = await loadSet()
  if (options.inspect) return inspect(set)
  if (options.prompt !== undefined) return showPrompt(set, options.prompt)
  if (options.compare !== undefined) return compare(options.compare)
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (options.model === undefined || !account || !token) throw new Error(USAGE)
  const problems = setProblems(set)
  if (problems.length > 0) throw new Error(`The set has problems; no model call made:\n${problems.join("\n")}`)
  await checkWorkersAiAccess(account, token, fetch)
  await mkdir(RUNS_DIR, { recursive: true })
  const lockPath = new URL("recall.lock", RUNS_DIR)
  const lock = await open(lockPath, "wx")
  try {
    await measure(set, options, account, token)
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

await main()
