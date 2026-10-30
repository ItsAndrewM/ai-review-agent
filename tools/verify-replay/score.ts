import { pairingProblem } from "../../src/review/basis.ts"
import type { VerdictInput } from "../../src/review/verify.ts"
import type { LabelledFinding } from "./schema.ts"

export type { Label, LabelledFinding } from "./schema.ts"

export interface RunVerdicts {
  readonly verdicts: readonly VerdictInput[]
}

export interface ModelScore {
  readonly passes: boolean
  readonly hardRuleBroken: boolean
  readonly demoteFixed: boolean
  readonly promoteFixed: boolean
  readonly dropped: number
  readonly droppable: number
}

export function effectiveVerdict(entry: LabelledFinding, run: RunVerdicts): VerdictInput | undefined {
  const verdict = run.verdicts.find(({ finding }) => finding === entry.id)
  if (verdict === undefined || !verdict.keep) return verdict
  const revised = { ...entry.finding, severity: verdict.severity }
  return pairingProblem(revised) === undefined ? verdict : { ...verdict, severity: entry.finding.severity }
}

export function fixesFinding(entry: LabelledFinding, run: RunVerdicts): boolean {
  const verdict = effectiveVerdict(entry, run)
  if (verdict === undefined) return false
  switch (entry.label) {
    case "drop":
      return !verdict.keep
    case "demote":
      return !verdict.keep || verdict.severity !== "blocking"
    case "promote":
      return verdict.keep && verdict.severity === "blocking"
    case "keep":
      return verdict.keep && (entry.finding.severity !== "blocking" || verdict.severity === "blocking")
  }
}

export function fixedByMajority(entry: LabelledFinding, runs: readonly RunVerdicts[]): boolean {
  return runs.filter((run) => fixesFinding(entry, run)).length > runs.length / 2
}

function breaksHardRule(entry: LabelledFinding, runs: readonly RunVerdicts[]): boolean {
  if (entry.label !== "keep" || entry.finding.severity !== "blocking") return false
  return runs.some((run) => {
    const verdict = effectiveVerdict(entry, run)
    return verdict !== undefined && (!verdict.keep || verdict.severity !== "blocking")
  })
}

export function scoreRuns(runs: readonly RunVerdicts[], labels: ReadonlyMap<string, LabelledFinding>): ModelScore {
  const entries = [...labels.values()]
  const demotes = entries.filter(({ label }) => label === "demote")
  const promotes = entries.filter(({ label }) => label === "promote")
  const drops = entries.filter(({ label }) => label === "drop")
  const hardRuleBroken = entries.some((entry) => breaksHardRule(entry, runs))
  const demoteFixed = demotes.length > 0 && demotes.every((entry) => fixedByMajority(entry, runs))
  const promoteFixed = promotes.length > 0 && promotes.every((entry) => fixedByMajority(entry, runs))
  const dropped = drops.filter((entry) => fixedByMajority(entry, runs)).length
  const targetsMet = demoteFixed && promoteFixed && drops.length > 0 && dropped * 2 >= drops.length
  const hasBlocker = entries.some(({ label, finding }) => label === "keep" && finding.severity === "blocking")
  return {
    passes: runs.length === 3 && hasBlocker && !hardRuleBroken && targetsMet,
    hardRuleBroken,
    demoteFixed,
    promoteFixed,
    dropped,
    droppable: drops.length,
  }
}
