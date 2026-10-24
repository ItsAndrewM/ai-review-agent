import { appendFile, open, readFile, unlink, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createModels } from "@earendil-works/pi-ai/models"
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai"
import { outputLimitOf, reviewThinkingLevel } from "../../src/models.ts"
import { renderSkillWithResources, buildSkillManifest, manifestSource } from "../../src/review/skills.ts"
import { verifyPrompt, type VerdictInput } from "../../src/review/verify.ts"
import { SpendBudget } from "./budget.ts"
import { GitFiles, replayContexts, replaySource } from "./checkout.ts"
import { attemptReplay, type ReplayAnswer } from "./conversation.ts"
import { corpusProblems } from "./coverage.ts"
import { checkWorkersAiAccess } from "./preflight.ts"
import { parseSet, type LabelledFinding } from "./schema.ts"
import { fixedByMajority, scoreRuns, type RunVerdicts } from "./score.ts"
import { ReplayTools } from "./tools.ts"

const USAGE =
  "Usage: pnpm verify:replay --inspect | --model <Workers AI model id> [--runs 3] (requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN)"
const ROOT = process.cwd()

interface Options {
  model: string | undefined
  runs: number
  inspect: boolean
}

interface ReplayConfig {
  modelId: string
  repeats: number
  account: string
  token: string
  budget: SpendBudget
}

interface BatchResult {
  pr: number
  head: string
  run: number
  answer: ReplayAnswer
}

function optionsOf(args: readonly string[]): Options {
  let model: string | undefined
  let runs = 3
  let inspect = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--inspect") inspect = true
    else if (arg === "--model") model = args[++index]
    else if (arg === "--runs") runs = Number(args[++index])
    else throw new Error(`${USAGE}\nUnrecognized option: ${arg}`)
  }
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 3) throw new Error(USAGE)
  return { model, runs, inspect }
}

async function instructions(): Promise<string> {
  const [verify, review, severity] = await Promise.all([
    readFile(new URL("../../skills/verify/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../../skills/review/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../../skills/review/references/severity.md", import.meta.url), "utf8"),
  ])
  const source = manifestSource(
    buildSkillManifest(
      [
        { path: "verify/SKILL.md", content: verify },
        { path: "review/SKILL.md", content: review },
        { path: "review/references/severity.md", content: severity },
      ],
      "replay",
    ),
  )
  const skill = await source.load("verify")
  const reference = await source.readResource?.("review", "references/severity.md")
  if (skill === null || reference === null || reference === undefined)
    throw new Error("Verify skill or severity reference is missing")
  return renderSkillWithResources(skill, [reference])
}

function grouped(findings: readonly LabelledFinding[]): LabelledFinding[][] {
  const groups = new Map<string, LabelledFinding[]>()
  for (const entry of findings) {
    const key = `${entry.pr}:${entry.head}:${entry.base}`
    const batch = groups.get(key) ?? []
    batch.push(entry)
    groups.set(key, batch)
  }
  return [...groups.values()]
}

function mappedVerdicts(entries: readonly LabelledFinding[], verdicts: readonly VerdictInput[]): VerdictInput[] {
  const ids = new Map(entries.map((entry, index) => [`F${index + 1}`, entry.id]))
  return verdicts.flatMap((verdict) => {
    const id = ids.get(verdict.finding)
    return id === undefined ? [] : [{ ...verdict, finding: id }]
  })
}

function displayVerdict(entry: LabelledFinding, run: RunVerdicts | undefined): string {
  const verdict = run?.verdicts.find(({ finding }) => finding === entry.id)
  if (verdict === undefined) return "not judged"
  return verdict.keep ? `keep/${verdict.severity}` : "drop"
}

function table(entries: readonly LabelledFinding[], runs: readonly RunVerdicts[]): string {
  const rows = entries.map((entry) => {
    const cells = runs.map((run) => displayVerdict(entry, run))
    return `| ${entry.id} | ${entry.label} | ${cells.join(" | ")} | ${fixedByMajority(entry, runs) ? "yes" : "no"} |`
  })
  return [
    `| Finding | Label | ${runs.map((_, index) => `Run ${index + 1}`).join(" | ")} | Majority fixed |`,
    `| --- | --- | ${runs.map(() => "---").join(" | ")} | --- |`,
    ...rows,
  ].join("\n")
}

async function measure(
  config: ReplayConfig,
  entries: readonly LabelledFinding[],
  record: (batch: BatchResult) => Promise<void>,
) {
  const models = createModels()
  models.setProvider(cloudflareWorkersAIProvider())
  const model = models.getModel("cloudflare-workers-ai", config.modelId)
  if (model === undefined) throw new Error(`Workers AI model not in the pinned pi-ai catalog: ${config.modelId}`)
  const files = new GitFiles(ROOT)
  const system = await instructions()
  const runs: RunVerdicts[] = []
  const batches: BatchResult[] = []
  for (let run = 1; run <= config.repeats; run++) {
    const verdicts: VerdictInput[] = []
    for (const group of grouped(entries)) {
      const first = group[0]
      if (first === undefined) continue
      const contexts = await replayContexts(group, files)
      const source = await replaySource(first.head, first.base, files)
      const tools = new ReplayTools(source)
      const answer = await attemptReplay(system, verifyPrompt(contexts), tools, (context) => {
        const maxTokens = outputLimitOf(process.env.MAX_OUTPUT_TOKENS ?? "16000")
        const settings = {
          apiKey: config.token,
          env: { CLOUDFLARE_ACCOUNT_ID: config.account },
          maxTokens,
          signal: AbortSignal.timeout(900_000),
        }
        const level = reviewThinkingLevel(process.env.REVIEW_THINKING_LEVEL ?? "low")
        return config.budget.complete(config.modelId, context, model.cost, maxTokens, () =>
          level === "off"
            ? models.completeSimple(model, context, settings)
            : models.completeSimple(model, context, { ...settings, reasoning: level }),
        )
      })
      verdicts.push(...mappedVerdicts(group, answer.verdicts))
      const batch = { pr: first.pr, head: first.head, run, answer }
      batches.push(batch)
      await record(batch)
    }
    runs.push({ verdicts })
  }
  return {
    model: config.modelId,
    score: scoreRuns(runs, new Map(entries.map((entry) => [entry.id, entry]))),
    runs,
    batches,
  }
}

async function main(): Promise<void> {
  const options = optionsOf(process.argv.slice(2))
  const set = parseSet(await readFile(new URL("./set.json", import.meta.url), "utf8"))
  const problems = corpusProblems(set)
  if (options.inspect) {
    console.log(`Corpus: ${set.findings.length} findings, ${set.excluded.length} exclusions`)
    for (const problem of problems) console.log(`- ${problem}`)
    for (const excluded of set.excluded) console.log(`- Excluded ${excluded.commentId}: ${excluded.reason}`)
    return
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (options.model === undefined || !account || !token) throw new Error(USAGE)
  if (problems.length > 0) throw new Error(`Corpus is incomplete; no model call made:\n${problems.join("\n")}`)
  await checkWorkersAiAccess(account, token, fetch)
  const lockPath = new URL("../../.superpowers/sdd/2026-10-24-verify/replay-costs.lock", import.meta.url)
  const lock = await open(lockPath, "wx")
  try {
    await runMeasured(options.model, options.runs, account, token, set.findings)
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

async function runMeasured(
  modelId: string,
  repeats: number,
  account: string,
  token: string,
  findings: readonly LabelledFinding[],
) {
  const spendJournal = new URL("../../.superpowers/sdd/2026-10-24-verify/replay-costs.jsonl", import.meta.url)
  const budget = await SpendBudget.open(fileURLToPath(spendJournal), 2)
  const config = { modelId, repeats, account, token, budget }
  const path = `../../.superpowers/sdd/2026-10-24-verify/replay-${Date.now()}`
  const journal = new URL(`${path}.jsonl`, import.meta.url)
  const result = await measure(config, findings, async (batch) => {
    await appendFile(journal, `${JSON.stringify(batch)}\n`)
  })
  const file = new URL(`${path}.json`, import.meta.url)
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`)
  const usd = result.batches.reduce((total, batch) => total + batch.answer.usd, 0)
  const calls = result.batches.reduce((total, batch) => total + batch.answer.calls, 0)
  console.log(
    `## ${modelId}\n\n${table(findings, result.runs)}\n\nScore: ${JSON.stringify(result.score)}\nCalls: ${calls} · measured spend: $${usd.toFixed(4)}\nRaw results: ${file.pathname}\nBatch journal: ${journal.pathname}`,
  )
}

await main()
