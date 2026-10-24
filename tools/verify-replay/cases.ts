import type { FindingInput } from "../../src/review/findings.ts"
import type { Label } from "./schema.ts"

export interface Case {
  id: number
  label: Label
  evidence: string
  issue?: number
  inferredKind?: FindingInput["basis_kind"]
  basisKindReason?: string
}

export const cases: readonly Case[] = [
  {
    id: 4330021512,
    label: "drop",
    evidence: "#31 audit: answerPrompt already protects this path",
    inferredKind: "defect",
    basisKindReason: "Alleges a wrong chat response on a concrete input",
  },
  {
    id: 4330057699,
    label: "drop",
    evidence: "#31 audit: answerPrompt already protects this path",
    inferredKind: "defect",
    basisKindReason: "Alleges a wrong chat response on a concrete input",
  },
  { id: 4330057723, label: "drop", evidence: "#31 audit: the test assertion is not a defect" },
  { id: 4318356095, label: "drop", evidence: "#31 audit: the test assertion is not a defect" },
  {
    id: 4318503063,
    label: "drop",
    evidence: "#31 audit: object spreading undefined does not throw",
    inferredKind: "defect",
    basisKindReason: "Alleges a runtime exception from spreading undefined",
  },
  { id: 4331431933, label: "drop", evidence: "#31 audit: praise is not a finding" },
  { id: 4341994189, label: "drop", evidence: "#31 audit: the priced-name criticism is false" },
  {
    id: 4303528101,
    label: "drop",
    evidence: "#31 audit: the HMAC suggestion self-verifies",
    inferredKind: "defect",
    basisKindReason: "Alleges a timing vulnerability in the existing comparison",
  },
  {
    id: 4307774415,
    label: "demote",
    evidence: "#31 audit: the unawaited storage.put is safe",
    inferredKind: "defect",
    basisKindReason: "Alleges lost persisted review metadata",
  },
  {
    id: 4318909797,
    label: "demote",
    evidence: "#31 audit: the unawaited storage.put is safe",
    inferredKind: "defect",
    basisKindReason: "Alleges a lost review record after an unawaited write",
  },
  {
    id: 4321702794,
    label: "demote",
    evidence: "#31 audit: the unawaited storage.put is safe",
    inferredKind: "defect",
    basisKindReason: "Alleges a posted-check race and false review failure",
  },
  {
    id: 4329887730,
    label: "promote",
    evidence: "#31 audit: the retry refusal is a defect, not a suggestion",
    inferredKind: "defect",
    basisKindReason: "Names a failed retry path that drops valid review findings",
  },
  {
    id: 4321702779,
    label: "keep",
    evidence: "#2 answer key: planted off-by-one at src/github/diff.ts:32",
    inferredKind: "defect",
    basisKindReason: "Shows misnumbered changed lines on a concrete diff",
  },
  {
    id: 4321702785,
    label: "keep",
    evidence: "#2 answer key: planted inverted version comparison at src/version.ts:14",
    inferredKind: "defect",
    basisKindReason: "Shows inverted stale-build result on a concrete version order",
  },
  {
    id: 4321702791,
    label: "keep",
    evidence: "#2 answer key: planted swallowed error at src/github/client.ts:86",
    inferredKind: "defect",
    basisKindReason: "Shows a non-404 API failure silently treated as a missing file",
  },
  {
    id: 4324307483,
    label: "keep",
    evidence: "#2 answer key: planted missing superseded-head guard at src/pull-request.ts:203",
    inferredKind: "defect",
    basisKindReason: "Shows stale review events starting a review on a superseded head",
  },
  { id: 4332660637, label: "keep", evidence: "#50 answer key: negative elapsed time is a planted defect", issue: 50 },
  { id: 4332660645, label: "keep", evidence: "#50 answer key: whole seconds depart from requirement 1", issue: 50 },
  {
    id: 4331547228,
    label: "keep",
    evidence: "#25 asks for a decision test through a commented approve record",
    inferredKind: "test",
    basisKindReason: "Identifies an untested decision branch",
  },
  { id: 4332938752, label: "keep", evidence: "#26 explicitly requires no-write-access and reply tests" },
  { id: 4332938761, label: "keep", evidence: "#63 code reports a false outdated-thread state for file comments" },
  { id: 4338905683, label: "keep", evidence: "#66 code treats a clamped zero cost as an unpriced model" },
  {
    id: 4338905689,
    label: "keep",
    evidence: "#66 cites the price-table departure agreed in its description",
    issue: 32,
  },
  { id: 4338905701, label: "keep", evidence: "#66 identifies an unreadable-ledger test gap" },
  { id: 4349909331, label: "keep", evidence: "#74 root-conversation refusal has no direct regression test" },
  { id: 4356321578, label: "keep", evidence: "#82 callers still use the old answerPrompt signature" },
  { id: 4361057856, label: "keep", evidence: "#88 differs from its linked issue's replay:safe requirement" },
  { id: 4361057868, label: "keep", evidence: "#88 charges failed repository searches to the review budget" },
]
