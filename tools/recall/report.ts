import { shortSha } from "../../src/sha.ts"
import type { ExpectedFinding, HeadCase, RecallSet } from "./schema.ts"
import { expectedVerdict, type BarVerdict, type HeadScore, type SetScore } from "./score.ts"

const HEADER = [
  "| Finding | Pull request | Where | Found | Majority | Severity | Severity matched | Verdict |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
]

function yesNo(value: boolean): string {
  return value ? "yes" : "no"
}

function dollars(usd: number): string {
  return `$${usd.toFixed(4)}`
}

function verdictCell(head: HeadCase, score: HeadScore | undefined): string {
  if (score === undefined) return ""
  const notPosted = score.notPosted > 0 ? ` (${score.notPosted} not posted)` : ""
  return `${expectedVerdict(head)} ${yesNo(score.verdictMatched)}${notPosted}`
}

function expectedRow(head: HeadCase, expected: ExpectedFinding, score: HeadScore | undefined, first: boolean): string {
  const result = score?.expects.find(({ id }) => id === expected.id)
  const found = result === undefined ? "" : `${result.foundIn}/${result.runs}`
  const majority = result === undefined ? "" : yesNo(result.found)
  const severity = result === undefined ? "" : yesNo(result.severityMatched)
  const where = `\`${expected.path}\` ${expected.lines[0]}-${expected.lines[1]}`
  const verdict = first ? verdictCell(head, score) : ""
  return `| ${expected.id} | #${head.pr} \`${shortSha(head.head)}\` | ${where} | ${found} | ${majority} | ${expected.severity} | ${severity} | ${verdict} |`
}

function headRows(head: HeadCase, score: HeadScore | undefined): string[] {
  if (head.expects.length === 0) {
    return [`| — | #${head.pr} \`${shortSha(head.head)}\` | nothing expected | | | | | ${verdictCell(head, score)} |`]
  }
  return head.expects.map((expected, index) => expectedRow(head, expected, score, index === 0))
}

export function label(score: SetScore): string {
  return `${score.model} at ${score.thinking}, review@${score.skills.slice(0, 8)}`
}

export function footer(score: SetScore): string {
  const notPosted = score.heads.reduce((total, head) => total + head.notPosted, 0)
  return `Found ${score.found}/${score.expected} · false ${score.falseCount} · severity ${score.severityMatched}/${score.expected} · verdict ${score.verdictMatched}/${score.heads.length} · ${dollars(score.costPerReview)} a review · not posted ${notPosted}`
}

export function resultsTable(set: RecallSet, score: SetScore): string {
  const scored = new Map(score.heads.map((head) => [head.head, head]))
  const rows = set.heads.flatMap((head) => {
    const own = scored.get(head.head)
    return own === undefined ? [] : headRows(head, own)
  })
  const title = score.partial ? `${label(score)} (partial run)` : label(score)
  return [`## ${title}`, "", ...HEADER, ...rows, "", `**${footer(score)}**`].join("\n")
}

export function compareTable(baseline: SetScore, candidate: SetScore, verdict: BarVerdict): string {
  const notPosted = (score: SetScore) => score.heads.reduce((total, head) => total + head.notPosted, 0)
  const rows = [
    `| | ${label(baseline)} | ${label(candidate)} |`,
    "| --- | --- | --- |",
    `| Found | ${baseline.found}/${baseline.expected} | ${candidate.found}/${candidate.expected} |`,
    `| False | ${baseline.falseCount} | ${candidate.falseCount} |`,
    `| Severity matched | ${baseline.severityMatched}/${baseline.expected} | ${candidate.severityMatched}/${candidate.expected} |`,
    `| Verdict matched | ${baseline.verdictMatched}/${baseline.heads.length} | ${candidate.verdictMatched}/${candidate.heads.length} |`,
    `| Cost a review | ${dollars(baseline.costPerReview)} | ${dollars(candidate.costPerReview)} |`,
    `| Not posted | ${notPosted(baseline)} | ${notPosted(candidate)} |`,
  ]
  const outcome = verdict.adopted ? "Adopted" : "Not adopted"
  return [...rows, "", `${outcome}: ${verdict.reasons.join("; ")}`].join("\n")
}

export function resultsFileName(
  stamp: string,
  modelId: string,
  thinking: string,
  onlyCase: string | undefined,
): string {
  const time = stamp.slice(0, 19).replaceAll(":", "-")
  const tail = modelId.split("/").at(-1) ?? modelId
  const suffix = onlyCase === undefined ? "" : `-case-${onlyCase}`
  return `${time}-${tail}-${thinking}${suffix}.json`
}
