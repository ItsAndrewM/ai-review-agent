import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import type { PullRequestInfo } from "../../src/github/client.ts"
import { Finding, Severity } from "../../src/review/findings.ts"

export const REPOSITORY = "ItsAndrewM/ai-review-agent"

const Sha = Type.String({ pattern: "^[a-f0-9]{40}$" })
const Text = Type.String({ minLength: 1 })

export const ExpectedFinding = Type.Object({
  id: Text,
  path: Text,
  lines: Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })]),
  side: Type.Optional(Type.Union([Type.Literal("RIGHT"), Type.Literal("LEFT")])),
  severity: Severity,
  basis_kind: Finding.properties.basis_kind,
  scenario: Text,
  pattern: Text,
  evidence: Text,
})
export type ExpectedFinding = Static<typeof ExpectedFinding>

export const KnownFinding = Type.Object({ id: Text, path: Text, pattern: Text, note: Text })
export type KnownFinding = Static<typeof KnownFinding>

export const FrozenIssue = Type.Object({
  number: Type.Integer(),
  title: Type.String(),
  body: Type.String(),
  cut: Type.Boolean(),
  state: Type.String(),
})
export type FrozenIssue = Static<typeof FrozenIssue>

export const Verdict = Type.Union([Type.Literal("approve"), Type.Literal("request_changes"), Type.Literal("comment")])
export type Verdict = Static<typeof Verdict>

export const Stats = Type.Object({ files: Type.Integer(), additions: Type.Integer(), deletions: Type.Integer() })

export const HeadCase = Type.Object({
  pr: Type.Integer({ minimum: 1 }),
  head: Sha,
  base: Sha,
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  author: Text,
  headRef: Text,
  baseRef: Text,
  labels: Type.Array(Type.String()),
  issues: Type.Array(FrozenIssue),
  expects: Type.Array(ExpectedFinding),
  summary: Type.Optional(Text),
  allowed: Type.Array(KnownFinding),
  knownFalse: Type.Array(KnownFinding),
  stats: Stats,
  note: Type.Optional(Text),
})
export type HeadCase = Static<typeof HeadCase>

export const RecallSet = Type.Object({ heads: Type.Array(HeadCase) })
export type RecallSet = Static<typeof RecallSet>

export function regexOf(pattern: string): RegExp {
  return new RegExp(pattern, "i")
}

function compiles(pattern: string): boolean {
  try {
    regexOf(pattern)
    return true
  } catch {
    return false
  }
}

function expectedProblem(expected: ExpectedFinding, ids: Set<string>): string | undefined {
  if (ids.has(expected.id)) return `Duplicate expected finding ${expected.id}`
  ids.add(expected.id)
  if (!compiles(expected.pattern)) return `Expected finding ${expected.id} has an invalid pattern`
  const [start, end] = expected.lines
  return start > end ? `Expected finding ${expected.id} has reversed lines` : undefined
}

function knownProblem(known: KnownFinding): string | undefined {
  return compiles(known.pattern) ? undefined : `Known finding ${known.id} has an invalid pattern`
}

function headProblems(head: HeadCase, heads: Set<string>, ids: Set<string>): string[] {
  const problems: string[] = []
  if (heads.has(head.head)) problems.push(`Duplicate head ${head.head}`)
  heads.add(head.head)
  for (const expected of head.expects) {
    const problem = expectedProblem(expected, ids)
    if (problem !== undefined) problems.push(problem)
  }
  for (const known of [...head.allowed, ...head.knownFalse]) {
    const problem = knownProblem(known)
    if (problem !== undefined) problems.push(problem)
  }
  return problems
}

export function setProblems(set: RecallSet): string[] {
  const heads = new Set<string>()
  const ids = new Set<string>()
  return set.heads.flatMap((head) => headProblems(head, heads, ids))
}

export function parseSet(text: string): RecallSet {
  const value = JSON.parse(text)
  if (!Value.Check(RecallSet, value)) throw new Error("Recall set does not match its schema")
  const [problem] = setProblems(value)
  if (problem !== undefined) throw new Error(problem)
  return value
}

export function pullRequestOf(head: HeadCase): PullRequestInfo {
  return {
    number: head.pr,
    title: head.title,
    body: head.body,
    state: "open",
    user: { login: head.author },
    base: { ref: head.baseRef, sha: head.base, repo: { full_name: REPOSITORY } },
    head: { ref: head.headRef, sha: head.head },
    changed_files: head.stats.files,
    additions: head.stats.additions,
    deletions: head.stats.deletions,
    labels: head.labels.map((name) => ({ name })),
  }
}
