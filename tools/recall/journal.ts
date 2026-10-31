import { basename } from "node:path"
import { Value } from "typebox/value"
import { ResultsRow } from "./rescore.ts"
import type { HeadCase } from "./schema.ts"

export interface PendingReview {
  head: HeadCase
  run: number
}

const JOURNAL_NAME = /^(\d{4}-\d\d-\d\dT)(\d\d)-(\d\d)-(\d\d\.\d{3}Z)\.jsonl$/

export interface ResumeOptions {
  model: string
  thinking: string
  runs: number
  onlyCase: string | undefined
}

function keyOf(row: { head: string; run: number }): string {
  return `${row.head}:${row.run}`
}

export function parseJournal(text: string): ResultsRow[] {
  const seen = new Set<string>()
  return text.split("\n").flatMap((line, index) => {
    if (line.trim() === "") return []
    const value = JSON.parse(line)
    if (!Value.Check(ResultsRow, value)) throw new Error(`Line ${index + 1} of the journal is not a recorded review`)
    if (seen.has(keyOf(value))) {
      throw new Error(`Line ${index + 1} of the journal repeats ${value.head.slice(0, 7)} run ${value.run}`)
    }
    seen.add(keyOf(value))
    return [value]
  })
}

export function runsWithin(rows: readonly ResultsRow[], runs: number): readonly ResultsRow[] {
  const above = rows.find((row) => row.run > runs)
  if (above !== undefined) {
    throw new Error(`The journal records run ${above.run} of ${above.head.slice(0, 7)} but --runs is ${runs}`)
  }
  return rows
}

export function resumeCommand(options: ResumeOptions, journal: string): string {
  const scope = options.onlyCase === undefined ? "" : ` --case ${options.onlyCase}`
  return `pnpm recall --model ${options.model} --thinking ${options.thinking} --runs ${options.runs}${scope} --resume ${journal}`
}

export function remainingReviews(
  heads: readonly HeadCase[],
  runs: number,
  done: readonly { head: string; run: number }[],
): PendingReview[] {
  const recorded = new Set(done.map(keyOf))
  return heads.flatMap((head) =>
    Array.from({ length: runs }, (_, index) => index + 1)
      .filter((run) => !recorded.has(keyOf({ head: head.head, run })))
      .map((run) => ({ head, run })),
  )
}

export function stampOfJournal(path: string): string {
  const match = JOURNAL_NAME.exec(basename(path))
  if (match === null) throw new Error(`${path} is not a run journal`)
  return `${match[1]}${match[2]}:${match[3]}:${match[4]}`
}
