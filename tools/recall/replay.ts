import { appendFile, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Message } from "@earendil-works/pi-ai"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { reviewableFiles, filterGlobs, isFiltered, type ChangedFile } from "../../src/github/diff.ts"
import { outputLimitOf, withBudgetRefusal, withForcedJson, withOutputLimit } from "../../src/models.ts"
import { reviewBudgetOf } from "../../src/review/budget.ts"
import { ReplaySpendCapError, SpendBudget } from "../replay/budget.ts"
import { GitFiles } from "../replay/git.ts"
import { openModel, thinkingLevelOf, type ReplayModel } from "../replay/model.ts"
import { checkWorkersAiAccess } from "../replay/preflight.ts"
import { snapshotSource } from "../replay/snapshot.ts"
import { NeuronBudget } from "./budget.ts"
import { attemptReview } from "./conversation.ts"
import { changedFilesAt } from "./files.ts"
import { ReviewHost } from "./host.ts"
import {
  parseJournal,
  remainingReviews,
  resumeCommand,
  runsWithin,
  stampOfJournal,
  type PendingReview,
} from "./journal.ts"
import { promptFor, reviewSkill, systemFor, type ReviewSkill } from "./prompt.ts"
import { compareTable, resultsFileName, resultsTable } from "./report.ts"
import { parseResults, rescore, rescoreRuns } from "./rescore.ts"
import { parseSet, setProblems, type HeadCase, type RecallSet } from "./schema.ts"
import { barVerdict, expectedVerdict, scoreRun, scoreSet, SetScore, type RunScore } from "./score.ts"
import { standardsAt } from "./standards.ts"
import { RecallTools, type RecallSource } from "./tools.ts"

const USAGE =
  "Usage: pnpm recall --inspect | --prompt <sha prefix> | --compare <baseline.json> <run.json> | --rescore <results.json> | --model <Workers AI model id> [--thinking low] [--runs 3] [--case <sha prefix>] [--resume <journal.jsonl>] (a run needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN)"
const ROOT = process.cwd()
const BOT_LOGIN = "andabot"
const SPEND_CAP_USD = 20
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
  rescore: string | undefined
  resume: string | undefined
}

interface Prepared {
  readonly head: HeadCase
  readonly files: ChangedFile[]
  readonly reviewable: ChangedFile[]
  readonly pathFilters: string[]
  readonly instructionFiles: string[]
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
  partial: boolean
}

const ResultsScore = Type.Object({ meta: Type.Object({ partial: Type.Boolean() }), score: SetScore })

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
    case "--resume":
      options.resume = value
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
    rescore: undefined,
    resume: undefined,
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    if (arg === "--inspect") options.inspect = true
    else if (arg === "--compare") options.compare = [args[++index] ?? "", args[++index] ?? ""]
    else if (arg === "--rescore") options.rescore = args[++index]
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
    instructionFiles: standards.used,
    system: systemFor(BOT_LOGIN, toolNames, skill.rendered, standards.text),
    prompt: promptFor(head, reviewable),
    source,
  }
}

async function reviewOnce(
  prepared: Prepared,
  run: number,
  model: ReplayModel,
  neurons: number,
  transcripts: URL,
): Promise<RunScore> {
  const host = new ReviewHost(prepared.files, prepared.pathFilters, {
    hasLinkedIssues: prepared.head.issues.length > 0,
    instructionFiles: prepared.instructionFiles,
    activatedSkills: [],
    docs: [],
  })
  const tools = new RecallTools(prepared.source, async (submission) => host.submit(submission))
  const budget = new NeuronBudget(neurons)
  const transcript: Message[] = []
  const answer = await attemptReview(
    prepared.system,
    prepared.prompt,
    tools,
    host,
    budget,
    (context) => model.complete(context),
    (messages) => transcript.push(...messages),
  )
  const line = JSON.stringify({ head: prepared.head.head, pr: prepared.head.pr, run, messages: transcript })
  await appendFile(transcripts, `${line}\n`)
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
      `- #${head.pr} ${head.head.slice(0, 7)}: ${head.expects.length} expected, verdict ${expectedVerdict(head)}${note}`,
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
  if (baseline.partial || candidate.partial)
    throw new Error("A partial run (--case, or one the spend cap stopped) can't be compared against the bar.")
  console.log(compareTable(baseline, candidate, barVerdict(baseline, candidate)))
}

async function rescoreFile(set: RecallSet, path: string): Promise<void> {
  const rescored = rescore(set, parseResults(await readFile(path, "utf8")))
  await writeFile(path, `${JSON.stringify(rescored, null, 2)}\n`)
  console.log(`${resultsTable(set, rescored.score)}\n\nRescored: ${path}`)
}

interface Recorded {
  readonly stamp: string
  readonly journal: URL
  readonly runs: RunScore[]
}

interface ReviewContext {
  readonly git: GitFiles
  readonly skill: ReviewSkill
  readonly toolNames: string[]
  readonly model: ReplayModel
  readonly neurons: number
  readonly journal: URL
  readonly transcripts: URL
  readonly resume: string
}

async function recordedRuns(set: RecallSet, resume: string | undefined, runs: number): Promise<Recorded> {
  if (resume === undefined) {
    const stamp = new Date().toISOString()
    return { stamp, journal: new URL(`${stamp.replaceAll(":", "-")}.jsonl`, RUNS_DIR), runs: [] }
  }
  const rows = runsWithin(parseJournal(await readFile(resume, "utf8")), runs)
  return { stamp: stampOfJournal(resume), journal: pathToFileURL(resume), runs: rescoreRuns(set, rows) }
}

function reviewLine(head: HeadCase, run: number, scored: RunScore): string {
  const outcome = scored.answer.source ?? scored.answer.reason
  return `#${head.pr} ${head.head.slice(0, 7)} run ${run}: ${outcome} · ${scored.matches.length} matched · ${scored.unmatched.length} unmatched · $${scored.answer.usd.toFixed(4)}`
}

async function reviewPending(
  pending: readonly PendingReview[],
  context: ReviewContext,
  runs: RunScore[],
): Promise<boolean> {
  let prepared: Prepared | undefined
  try {
    for (const { head, run } of pending) {
      if (prepared?.head !== head) prepared = await prepare(head, context.git, context.skill, context.toolNames)
      const scored = await reviewOnce(prepared, run, context.model, context.neurons, context.transcripts)
      runs.push(scored)
      await appendFile(context.journal, `${JSON.stringify(scored)}\n`)
      console.error(reviewLine(head, run, scored))
    }
    return false
  } catch (error) {
    if (!(error instanceof ReplaySpendCapError)) throw error
    console.error(`${error.message} Resume once the cap allows with: ${context.resume}`)
    return true
  }
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
    wrap: (provider) => withBudgetRefusal(withForcedJson(withOutputLimit(provider, maxTokens)), BOT_LOGIN),
  })
  const skill = await reviewSkill()
  const recorded = await recordedRuns(set, options.resume, options.runs)
  const transcripts = new URL(`${recorded.stamp.replaceAll(":", "-")}-transcripts.jsonl`, RUNS_DIR)
  const pending = remainingReviews(headsMatching(set, options.onlyCase), options.runs, recorded.runs)
  const context: ReviewContext = {
    git: new GitFiles(ROOT),
    skill,
    toolNames: toolNamesOf(),
    model,
    neurons,
    journal: recorded.journal,
    transcripts,
    resume: resumeCommand(
      { model: options.model, thinking, runs: options.runs, onlyCase: options.onlyCase },
      fileURLToPath(recorded.journal),
    ),
  }
  const runs = recorded.runs
  const capped = await reviewPending(pending, context, runs)
  const score = scoreSet(set, runs, { model: options.model, thinking, skills: skill.fingerprint }, options.runs)
  const meta: RunMeta = {
    model: options.model,
    thinking,
    skills: skill.fingerprint,
    maxOutputTokens: maxTokens,
    maxReviewNeurons: neurons,
    runs: options.runs,
    at: recorded.stamp,
    partial: score.partial || capped,
  }
  const file = new URL(resultsFileName(recorded.stamp, options.model, thinking, options.onlyCase), RESULTS_DIR)
  await writeFile(file, `${JSON.stringify({ meta, score, runs }, null, 2)}\n`, {
    flag: options.resume === undefined ? "wx" : "w",
  })
  console.log(
    `${resultsTable(set, score)}\n\nResults: ${file.pathname}\nJournal: ${recorded.journal.pathname}\nTranscripts: ${transcripts.pathname}`,
  )
}

async function main(): Promise<void> {
  const options = optionsOf(process.argv.slice(2))
  const set = await loadSet()
  if (options.inspect) return inspect(set)
  if (options.prompt !== undefined) return showPrompt(set, options.prompt)
  if (options.compare !== undefined) return compare(options.compare)
  if (options.rescore !== undefined) return rescoreFile(set, options.rescore)
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
