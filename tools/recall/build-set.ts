import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { linkedIssueNumbers, linkedIssuesFrom } from "../../src/review/linked-issues.ts"
import { withoutGeneratedNotes } from "./body.ts"
import { cases, type Case } from "./cases.ts"
import { parseSet, REPOSITORY, type FrozenIssue, type HeadCase } from "./schema.ts"

const execute = promisify(execFile)

const PullRequest = Type.Object({
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  user: Type.Object({ login: Type.String() }),
  head: Type.Object({ ref: Type.String() }),
  base: Type.Object({ ref: Type.String() }),
  labels: Type.Array(Type.Object({ name: Type.String() })),
})

const Issue = Type.Object({
  number: Type.Integer(),
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  state: Type.String(),
  pull_request: Type.Optional(Type.Object({})),
})

const PullCommits = Type.Array(Type.Object({ parents: Type.Array(Type.Object({ sha: Type.String() })) }), {
  minItems: 1,
})

const SHORTSTAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/

async function command(name: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute(name, args, { cwd: process.cwd(), maxBuffer: 16_000_000 })
  return stdout.trimEnd()
}

async function api(path: string): Promise<string> {
  return command("gh", "api", `repos/${REPOSITORY}/${path}`)
}

async function pullRequest(pr: number) {
  const value = JSON.parse(await api(`pulls/${pr}`))
  if (!Value.Check(PullRequest, value)) throw new Error(`Pull request ${pr} has unexpected fields`)
  return value
}

async function originalBase(pr: number): Promise<string> {
  const value = JSON.parse(await api(`pulls/${pr}/commits?per_page=100`))
  if (!Value.Check(PullCommits, value)) throw new Error(`Pull request ${pr} has no commits`)
  const parent = value[0]?.parents[0]?.sha
  if (parent === undefined) throw new Error(`Pull request ${pr} has no original base`)
  return parent
}

async function frozenIssue(number: number): Promise<FrozenIssue | undefined> {
  const value = JSON.parse(await api(`issues/${number}`))
  if (!Value.Check(Issue, value)) throw new Error(`Issue ${number} has unexpected fields`)
  const [linked] = linkedIssuesFrom([{ number, issue: value }])
  return linked === undefined ? undefined : { ...linked, state: value.state }
}

async function frozenIssues(body: string | null, headRef: string): Promise<FrozenIssue[]> {
  const issues = await Promise.all(linkedIssueNumbers(body, headRef).map(frozenIssue))
  return issues.filter((issue) => issue !== undefined)
}

async function stats(base: string, head: string): Promise<HeadCase["stats"]> {
  const match = SHORTSTAT.exec(await command("git", "diff", "--shortstat", base, head))
  if (match === null) throw new Error(`No diff between ${base.slice(0, 7)} and ${head.slice(0, 7)}`)
  return { files: Number(match[1]), additions: Number(match[2] ?? 0), deletions: Number(match[3] ?? 0) }
}

async function checkExpectedPaths(item: Case, base: string): Promise<void> {
  const changed = new Set((await command("git", "diff", "--name-only", base, item.head)).split("\n"))
  for (const expected of item.expects) {
    if (!changed.has(expected.path))
      throw new Error(
        `Expected finding ${expected.id} names ${expected.path}, which ${item.head.slice(0, 7)} does not change`,
      )
  }
}

async function freeze(item: Case): Promise<HeadCase> {
  const pr = await pullRequest(item.pr)
  const body = withoutGeneratedNotes(pr.body)
  const base = item.base ?? (await originalBase(item.pr))
  await checkExpectedPaths(item, base)
  const head: HeadCase = {
    pr: item.pr,
    head: item.head,
    base,
    title: pr.title,
    body,
    author: pr.user.login,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    labels: pr.labels.map(({ name }) => name),
    issues: await frozenIssues(body, pr.head.ref),
    expects: item.expects,
    verdict: item.verdict,
    allowed: item.allowed,
    knownFalse: item.knownFalse,
    stats: await stats(base, item.head),
  }
  if (item.summary !== undefined) head.summary = item.summary
  if (item.note !== undefined) head.note = item.note
  return head
}

async function main(): Promise<void> {
  const heads: HeadCase[] = []
  for (const item of cases) heads.push(await freeze(item))
  const text = `${JSON.stringify({ heads }, null, 2)}\n`
  const set = parseSet(text)
  await writeFile(new URL("./set.json", import.meta.url), text)
  const expected = set.heads.reduce((total, head) => total + head.expects.length, 0)
  console.log(`Froze ${set.heads.length} heads, ${expected} expected findings.`)
}

await main()
