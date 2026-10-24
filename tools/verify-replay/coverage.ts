import type { ReplaySet } from "./schema.ts"

const REQUIRED_DROPS = ["4330021512", "4330057699", "4318503063", "4303528101"]

const EXCLUDED_NITPICKS = ["4330057723", "4318356095", "4331431933", "4341994189"]

const REQUIRED_PROMOTE = "4329887730"

export function corpusProblems(set: ReplaySet): string[] {
  const problems: string[] = []
  const byId = new Map(set.findings.map((entry) => [entry.id, entry]))
  const missingDrops = REQUIRED_DROPS.filter((id) => byId.get(id)?.label !== "drop")
  if (missingDrops.length > 0)
    problems.push(`Missing ${missingDrops.length} named drop finding(s): ${missingDrops.join(", ")}`)
  const excluded = new Set(set.excluded.map(({ commentId }) => String(commentId)))
  if (EXCLUDED_NITPICKS.some((id) => !excluded.has(id) || byId.has(id)))
    problems.push("The four historical nitpicks must stay excluded from the verify replay")
  if (set.findings.filter((entry) => entry.pr === 9 && entry.label === "demote").length < 3)
    problems.push("Fewer than three #9 await demote findings are recoverable")
  if (byId.get(REQUIRED_PROMOTE)?.label !== "promote") problems.push(`Missing promote finding ${REQUIRED_PROMOTE}`)
  if (
    set.findings.filter((entry) => entry.pr === 9 && entry.label === "keep" && entry.finding.severity === "blocking")
      .length < 4
  )
    problems.push("Fewer than four #9 true blocking findings are recoverable")
  if (set.findings.filter((entry) => entry.pr === 54 && entry.label === "keep").length < 2)
    problems.push("Fewer than two #54 true findings are recoverable")
  if (set.findings.filter((entry) => entry.pr !== 9 && entry.pr !== 54 && entry.label === "keep").length < 10)
    problems.push("Fewer than ten true real-PR keep findings are recoverable")
  if (set.findings.some((entry) => entry.finding.severity === "nitpick"))
    problems.push("A nitpick is outside production's verify candidate set")
  return problems
}
