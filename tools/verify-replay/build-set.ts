import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import { Finding, type FindingInput } from "../../src/review/findings.ts"
import { GitFiles, patchHunks } from "../replay/git.ts"
import { cases, type Case } from "./cases.ts"
import { parseCommentBody } from "./comment.ts"
import { ReplaySet, type LabelledFinding } from "./schema.ts"

const execute = promisify(execFile)
const repository = "ItsAndrewM/ai-review-agent"

const Comment = Type.Object({
  id: Type.Integer(),
  body: Type.String(),
  html_url: Type.String(),
  pull_request_url: Type.String(),
  path: Type.String(),
  original_commit_id: Type.String(),
  original_line: Type.Union([Type.Integer(), Type.Null()]),
  original_start_line: Type.Union([Type.Integer(), Type.Null()]),
  side: Type.Union([Type.Literal("RIGHT"), Type.Literal("LEFT")]),
})

const Issue = Type.Object({
  number: Type.Integer(),
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
})
const PullCommit = Type.Object({
  sha: Type.String(),
  parents: Type.Array(Type.Object({ sha: Type.String() }), { minItems: 1 }),
})
const Exclusion = Type.String()
const bases = new Map<number, Promise<string>>()

async function command(command: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, GIT_MASTER: "1" },
    maxBuffer: 4_000_000,
  })
  return stdout.trimEnd()
}

async function comment(id: number) {
  const text = await command("gh", "api", `repos/${repository}/pulls/comments/${id}`)
  const value = JSON.parse(text)
  if (!Value.Check(Comment, value)) throw new Error(`GitHub comment ${id} has unexpected fields`)
  return value
}

async function issue(number: number): Promise<string> {
  const value = JSON.parse(await command("gh", "api", `repos/${repository}/issues/${number}`))
  if (!Value.Check(Issue, value)) throw new Error(`GitHub issue ${number} has unexpected fields`)
  return `#${value.number}: ${value.title}\n${value.body ?? ""}`
}

async function originalBase(pr: number): Promise<string> {
  const committed = bases.get(pr)
  if (committed !== undefined) return committed
  const base = (async () => {
    const value = JSON.parse(await command("gh", "api", `repos/${repository}/pulls/${pr}/commits?per_page=100`))
    if (!Value.Check(Type.Array(PullCommit, { minItems: 1 }), value))
      throw new Error(`Pull request ${pr} has no first commit`)
    const parent = value[0]?.parents[0]?.sha
    if (parent === undefined) throw new Error(`Pull request ${pr} has no original base`)
    return parent
  })()
  bases.set(pr, base)
  return base
}

function recoveredFinding(
  source: Static<typeof Comment>,
  original: NonNullable<ReturnType<typeof parseCommentBody>>,
  quote: string,
) {
  const optional: Partial<FindingInput> = {}
  if (source.original_start_line !== null) optional.start_line = source.original_start_line
  if (original.suggestion !== undefined) optional.suggestion = original.suggestion
  return {
    path: source.path,
    line: source.original_line,
    side: source.side,
    quote,
    severity: original.severity,
    title: original.title,
    body: original.body,
    basis_kind: original.basis_kind,
    basis: original.basis,
    ...optional,
  }
}

async function quotedLine(source: Static<typeof Comment>, base: string, files: GitFiles): Promise<string | undefined> {
  if (source.original_line === null) return undefined
  const sha = source.side === "LEFT" ? base : source.original_commit_id
  const content = await files.read(sha, source.path)
  return content?.split("\n")[source.original_line - 1]
}

async function recover(item: Case, files: GitFiles): Promise<LabelledFinding | string> {
  const source = await comment(item.id)
  if (source.body.startsWith("**⚪ Nitpick: ")) return "nitpick is outside the production verify candidate set"
  const original = parseCommentBody(source.body, item.inferredKind, item.basisKindReason)
  if (original === undefined) return "historical finding cannot be normalized without an explicit basis decision"
  const head = source.original_commit_id
  const pr = Number(source.pull_request_url.split("/").at(-1))
  const base = await originalBase(pr)
  const quote = await quotedLine(source, base, files)
  if (quote === undefined) return "the cited historical line is unavailable"
  const finding = recoveredFinding(source, original, quote)
  if (!Value.Check(Finding, finding)) return "recovered comment fails Finding schema"
  const entry: LabelledFinding = {
    id: String(item.id),
    pr,
    head,
    base,
    commentId: item.id,
    url: source.html_url,
    label: item.label,
    finding,
    evidence: item.evidence,
  }
  const patch = patchHunks(await files.diff(base, head, source.path))
  if (patch !== undefined) entry.patch = patch
  if (item.issue !== undefined) entry.issue = await issue(item.issue)
  if (original.normalization !== undefined) entry.normalization = original.normalization
  if (!Value.Check(ReplaySet.properties.findings.items, entry)) return "recovered entry fails replay schema"
  return entry
}

async function main(): Promise<void> {
  const files = new GitFiles(process.cwd())
  const findings: LabelledFinding[] = []
  const excluded: { commentId: number; reason: string }[] = []
  for (const item of cases) {
    const result = await recover(item, files)
    if (Value.Check(Exclusion, result)) excluded.push({ commentId: item.id, reason: result })
    else findings.push(result)
  }
  const data = { findings, excluded }
  if (!Value.Check(ReplaySet, data)) throw new Error("Generated corpus fails ReplaySet schema")
  await writeFile(new URL("./set.json", import.meta.url), `${JSON.stringify(data, null, 2)}\n`)
  console.log(`Recovered ${findings.length} findings; excluded ${excluded.length}.`)
  for (const { commentId, reason } of excluded) console.log(`${commentId}: ${reason}`)
}

await main()
