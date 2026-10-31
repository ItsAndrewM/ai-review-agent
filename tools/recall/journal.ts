import { basename } from "node:path"
import { Value } from "typebox/value"
import { ResultsRow } from "./rescore.ts"
import type { HeadCase } from "./schema.ts"

export interface PendingReview {
  head: HeadCase
  run: number
}

const JOURNAL_NAME = /^(\d{4}-\d\d-\d\dT)(\d\d)-(\d\d)-(\d\d\.\d{3}Z)\.jsonl$/

export function parseJournal(text: string): ResultsRow[] {
  return text.split("\n").flatMap((line, index) => {
    if (line.trim() === "") return []
    const value = JSON.parse(line)
    if (!Value.Check(ResultsRow, value)) throw new Error(`Line ${index + 1} of the journal is not a recorded review`)
    return [value]
  })
}

export function remainingReviews(
  heads: readonly HeadCase[],
  runs: number,
  done: readonly { head: string; run: number }[],
): PendingReview[] {
  const recorded = new Set(done.map((entry) => `${entry.head}:${entry.run}`))
  return heads.flatMap((head) =>
    Array.from({ length: runs }, (_, index) => index + 1)
      .filter((run) => !recorded.has(`${head.head}:${run}`))
      .map((run) => ({ head, run })),
  )
}

export function stampOfJournal(path: string): string {
  const match = JOURNAL_NAME.exec(basename(path))
  if (match === null) throw new Error(`${path} is not a run journal`)
  return `${match[1]}${match[2]}:${match[3]}:${match[4]}`
}
