import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import { Finding } from "../../src/review/findings.ts"
import { Normalization } from "./comment.ts"

export const Label = Type.Union([
  Type.Literal("drop"),
  Type.Literal("demote"),
  Type.Literal("promote"),
  Type.Literal("keep"),
])
export type Label = Static<typeof Label>

const Sha = Type.String({ pattern: "^[a-f0-9]{40}$" })

export const LabelledFinding = Type.Object({
  id: Type.String({ minLength: 1 }),
  pr: Type.Integer({ minimum: 1 }),
  head: Sha,
  base: Sha,
  commentId: Type.Integer({ minimum: 1 }),
  url: Type.String({ minLength: 1 }),
  label: Label,
  finding: Finding,
  evidence: Type.String({ minLength: 1 }),
  fixingCommit: Type.Optional(Sha),
  patch: Type.Optional(Type.String()),
  issue: Type.Optional(Type.String()),
  normalization: Type.Optional(Normalization),
})
export type LabelledFinding = Static<typeof LabelledFinding>

export const ReplaySet = Type.Object({
  findings: Type.Array(LabelledFinding),
  excluded: Type.Array(Type.Object({ commentId: Type.Integer(), reason: Type.String({ minLength: 1 }) })),
})
export type ReplaySet = Static<typeof ReplaySet>

export function parseSet(text: string): ReplaySet {
  const value = JSON.parse(text)
  if (!Value.Check(ReplaySet, value)) throw new Error("Replay set does not match its schema")
  const ids = new Set<string>()
  for (const entry of value.findings) {
    if (ids.has(entry.id)) throw new Error(`Duplicate replay finding ${entry.id}`)
    if (entry.finding.line < 1) throw new Error(`Invalid line for replay finding ${entry.id}`)
    ids.add(entry.id)
  }
  return value
}
