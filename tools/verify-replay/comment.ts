import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import { Finding, type FindingInput } from "../../src/review/findings.ts"

export const Normalization = Type.Object({
  basisSource: Type.Union([Type.Literal("legacy_basis"), Type.Literal("body")]),
  basisKindReason: Type.String({ minLength: 1 }),
})
export type Normalization = Static<typeof Normalization>

export type ParsedComment = Pick<FindingInput, "severity" | "title" | "body" | "basis_kind" | "basis"> & {
  suggestion?: string
  normalization?: Normalization
}

const HEADING = /^\*\*(🔴 Blocking|🟡 Suggestion|⚪ Nitpick): (.+)\*\*\n\n/u
const TYPED_BASIS = /^_Basis \((defect|spec|standard|test)\): ([\s\S]*?)_$/u
const LEGACY_BASIS = /^_Basis: ([\s\S]*?)_$/u
const SUGGESTION = /\n\n```suggestion\n([\s\S]*?)\n```$/u

interface CommentParts {
  title: string
  severity: FindingInput["severity"]
  claim: string
  rawBasis: string | undefined
  suggestion: string | undefined
}

function severityOf(label: string): FindingInput["severity"] {
  if (label === "🔴 Blocking") return "blocking"
  return label === "🟡 Suggestion" ? "suggestion" : "nitpick"
}

function partsOf(body: string): CommentParts | undefined {
  const heading = HEADING.exec(body)
  if (heading === null) return undefined
  const suggestion = SUGGESTION.exec(body)
  const text = suggestion === null ? body : body.slice(0, suggestion.index)
  const at = Math.max(text.lastIndexOf("\n\n_Basis ("), text.lastIndexOf("\n\n_Basis: "))
  return {
    title: heading[2] ?? "",
    severity: severityOf(heading[1] ?? ""),
    claim: text.slice(heading[0].length, at < 0 ? undefined : at).trim(),
    rawBasis: at < 0 ? undefined : text.slice(at + 2),
    suggestion: suggestion?.[1],
  }
}

function typedBasis(raw: string | undefined): Pick<ParsedComment, "basis" | "basis_kind"> | undefined {
  const typed = raw === undefined ? null : TYPED_BASIS.exec(raw)
  if (typed !== null && Value.Check(Finding.properties.basis_kind, typed[1]))
    return { basis_kind: typed[1], basis: typed[2] ?? "" }
  return undefined
}

function inferredBasis(
  raw: string | undefined,
  claim: string,
  inferredKind: FindingInput["basis_kind"] | undefined,
  reason: string | undefined,
): Pick<ParsedComment, "basis" | "basis_kind" | "normalization"> | undefined {
  const legacy = raw === undefined ? null : LEGACY_BASIS.exec(raw)
  if (raw !== undefined && legacy === null) return undefined
  if (inferredKind === undefined || !reason) return undefined
  return {
    basis_kind: inferredKind,
    basis: legacy?.[1] ?? claim,
    normalization: { basisSource: legacy === null ? "body" : "legacy_basis", basisKindReason: reason },
  }
}

function basisOf(
  raw: string | undefined,
  claim: string,
  inferredKind: FindingInput["basis_kind"] | undefined,
  reason: string | undefined,
): Pick<ParsedComment, "basis" | "basis_kind" | "normalization"> | undefined {
  return typedBasis(raw) ?? inferredBasis(raw, claim, inferredKind, reason)
}

export function parseCommentBody(
  body: string,
  inferredKind?: FindingInput["basis_kind"],
  basisKindReason?: string,
): ParsedComment | undefined {
  const parts = partsOf(body)
  if (parts === undefined) return undefined
  const basis = basisOf(parts.rawBasis, parts.claim, inferredKind, basisKindReason)
  if (basis === undefined || basis.basis.trim() === "") return undefined
  const result: ParsedComment = { severity: parts.severity, title: parts.title, body: parts.claim, ...basis }
  if (parts.suggestion !== undefined) result.suggestion = parts.suggestion
  return result
}
