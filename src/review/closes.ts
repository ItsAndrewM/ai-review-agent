import type { PullRequestInfo } from "../github/client.ts"
import { withoutCode } from "./code-blanking.ts"
import { codeSpan } from "./render.ts"

export interface IssueRef {
  repo: string | undefined
  number: number
}

export interface ListedRef {
  ref: IssueRef
  separator: string
  keyword: string
  first: IssueRef
}

export interface NegatedClose {
  ref: IssueRef
  phrase: string
  negation: string
}

export interface Closes {
  closes: IssueRef[]
  listed: ListedRef[]
  negated: NegatedClose[]
}

const KEYWORD = String.raw`(?<![\p{L}\p{N}_])(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?![\p{L}\p{N}_])`
const REFERENCE = String.raw`(https://github\.com/([\w.-]+/[\w.-]+)/issues/(\d+)|([\w.-]+/[\w.-]+)#(\d+)|#(\d+))(?![\p{L}\p{N}_])`
const CLOSE = new RegExp(`${KEYWORD}:?\\s+${REFERENCE}`, "giu")
const NEXT = new RegExp(`\\s*(,\\s*and|,|and|&|or)\\s*${REFERENCE}`, "iuy")
const CLAUSE_END = /[.!?;\n]/g
const WORD = /\S+/g
const NEGATIONS = new Set(["not", "never", "without"])
const NEGATION_WINDOW = 3
const NEGATION_LOOKBACK_CHARS = 200
const MOST_PHRASE_CHARS = 60
const MOST_NEGATION_CHARS = 20
const MOST_WARNINGS = 5
const MOST_CLOSES_LISTED = 10
const MOST_LATER_REFS_NAMED = 5
const MOST_SUGGESTED = 3

interface Found {
  closes: Map<string, IssueRef>
  listed: Map<string, ListedRef>
  negated: Map<string, NegatedClose>
}

export function refText(ref: IssueRef): string {
  return ref.repo === undefined ? `#${ref.number}` : `${ref.repo}#${ref.number}`
}

export function closesOf(body: string | null, repo: string): Closes {
  const readable = withoutCode((body ?? "").replace(/\r\n?/g, "\n"))
  const found: Found = { closes: new Map(), listed: new Map(), negated: new Map() }
  for (const match of readable.matchAll(CLOSE)) recordClose(found, readable, match, repo)
  const listed = [...found.listed].filter(([key]) => !found.closes.has(key)).map(([, entry]) => entry)
  return { closes: [...found.closes.values()], listed, negated: [...found.negated.values()] }
}

function recordClose(found: Found, readable: string, match: RegExpMatchArray, repo: string): void {
  const ref = refFrom(match, repo)
  const start = match.index ?? 0
  const end = start + match[0].length
  const key = refText(ref)
  if (!found.closes.has(key)) found.closes.set(key, ref)
  const negated = negationBefore(readable, start, end, ref)
  if (negated === undefined) recordListed(found, readable, end, { keyword: match[1] ?? "", first: ref }, repo)
  else if (!found.negated.has(key)) found.negated.set(key, negated)
}

function recordListed(
  found: Found,
  readable: string,
  from: number,
  close: Pick<ListedRef, "keyword" | "first">,
  repo: string,
): void {
  NEXT.lastIndex = from
  for (let next = NEXT.exec(readable); next !== null; next = NEXT.exec(readable)) {
    const ref = refFrom(next, repo)
    const separator = (next[1] ?? "").replace(/\s+/g, " ")
    const key = refText(ref)
    if (!found.listed.has(key)) found.listed.set(key, { ref, separator, ...close })
  }
}

function refFrom(match: RegExpMatchArray, repo: string): IssueRef {
  const named = match[3] ?? match[5]
  const number = Number(match[4] ?? match[6] ?? match[7])
  const other = named !== undefined && named.toLowerCase() !== repo.toLowerCase()
  return { repo: other ? named : undefined, number }
}

function negationBefore(text: string, start: number, end: number, ref: IssueRef): NegatedClose | undefined {
  const lookback = Math.max(0, start - NEGATION_LOOKBACK_CHARS)
  const clauseStart = lookback + lastClauseEnd(text.slice(lookback, start))
  const words = [...text.slice(clauseStart, start).matchAll(WORD)].slice(-NEGATION_WINDOW)
  const index = words.findIndex((word, at) => negates(word[0], words[at + 1]?.[0]))
  const word = words[index]
  if (word === undefined) return undefined
  const from = clauseStart + (word.index ?? 0)
  const phrase = clippedText(text.slice(from, end).replace(/\s+/g, " "), MOST_PHRASE_CHARS, "end")
  return { ref, phrase, negation: clippedText(plainWord(word[0]), MOST_NEGATION_CHARS, "start") }
}

function clippedText(text: string, most: number, keep: "start" | "end"): string {
  if (text.length <= most) return text
  return keep === "end" ? `…${text.slice(-most)}` : `${text.slice(0, most)}…`
}

function lastClauseEnd(before: string): number {
  const ends = [...before.matchAll(CLAUSE_END)]
  const last = ends.at(-1)
  return last === undefined ? 0 : (last.index ?? 0) + 1
}

function negates(word: string, next: string | undefined): boolean {
  const plain = plainWord(word)
  if (NEGATIONS.has(plain) || plain.endsWith("n't") || plain.endsWith("n’t")) return true
  return plain === "no" && next !== undefined && plainWord(next) === "longer"
}

function plainWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}'’]/gu, "")
}

export const CLOSES_START = "<!-- andabot:closes -->"
export const CLOSES_END = "<!-- andabot:closes-end -->"

export function closesBlockOf(pr: PullRequestInfo): string[] {
  return closesBlockFor(pr, closesOf(pr.body, pr.base.repo.full_name))
}

export function closesBlockFor(pr: PullRequestInfo, closes: Closes): string[] {
  return closesBlock(closes, pr.base.ref, pr.base.repo.default_branch)
}

export function closesBlock(closes: Closes, base: string, defaultBranch: string | undefined): string[] {
  return [CLOSES_START, ...closesLines(closes, base, defaultBranch), CLOSES_END]
}

function closesLines(closes: Closes, base: string, defaultBranch: string | undefined): string[] {
  if (closes.closes.length === 0) return []
  if (defaultBranch !== undefined && base !== defaultBranch) {
    return [
      `<sub>Merging into ${codeSpan(base)} closes no issue: GitHub closes them only on a merge into ${codeSpan(defaultBranch)}.</sub>`,
    ]
  }
  const warnings = [...runsOf(closes.listed).map(runWarning), ...closes.negated.map(negatedWarning)]
  return [
    ...cappedWarnings(warnings),
    `<sub>Merging closes ${countedList(closes.closes.map(refText), MOST_CLOSES_LISTED)} (from the description).</sub>`,
  ]
}

function cappedWarnings(warnings: readonly string[]): string[] {
  const shown = warnings.slice(0, MOST_WARNINGS)
  const hidden = warnings.length - shown.length
  return hidden > 0 ? [...shown, `⚠️ ${hidden} more wording problems aren't listed.`] : shown
}

function runsOf(listed: readonly ListedRef[]): ListedRef[][] {
  const runs = new Map<string, ListedRef[]>()
  for (const entry of listed) runs.set(runKey(entry), [...(runs.get(runKey(entry)) ?? []), entry])
  return [...runs.values()]
}

function runKey(entry: ListedRef): string {
  return `${entry.keyword.toLowerCase()} ${refText(entry.first)}`
}

function runWarning(run: readonly ListedRef[]): string {
  const [head] = run
  if (head === undefined) return ""
  const refs = [head.first, ...run.map((entry) => entry.ref)]
  const suggested = refs
    .slice(0, MOST_SUGGESTED)
    .map((ref, index) => `${index === 0 ? head.keyword : head.keyword.toLowerCase()} ${refText(ref)}`)
  const suggestion = `${suggested.join(", ")}${refs.length > MOST_SUGGESTED ? ", …" : ""}`
  if (run.length === 1) {
    return `⚠️ ${refText(head.ref)} follows "${head.separator}" after a keyword, so merging won't close it. Repeat the keyword for each issue: "${suggestion}".`
  }
  const later = countedList(
    run.map((entry) => refText(entry.ref)),
    MOST_LATER_REFS_NAMED,
  )
  return `⚠️ ${later} follow "${head.keyword} ${refText(head.first)}" without a keyword of their own, so merging won't close them. Repeat the keyword for each issue: "${suggestion}".`
}

function negatedWarning(entry: NegatedClose): string {
  const ref = refText(entry.ref)
  return `⚠️ ${codeSpan(entry.phrase)} still closes ${ref} on merge: GitHub ignores the "${entry.negation}". Name it without a keyword to leave it open, such as "Part of ${ref}".`
}

function countedList(items: readonly string[], most: number): string {
  if (items.length > most) return `${items.slice(0, most).join(", ")} and ${items.length - most} more`
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`
}

export function withClosesBlock(body: string, block: readonly string[]): string | undefined {
  const start = body.lastIndexOf(CLOSES_START)
  const end = body.indexOf(CLOSES_END, start)
  if (start < 0 || end < 0) return undefined
  const rewritten = `${body.slice(0, start)}${block.join("\n")}${body.slice(end + CLOSES_END.length)}`
  return rewritten === body ? undefined : rewritten
}

export function closesFields(closes: Closes) {
  return { closes: closes.closes.length, listed: closes.listed.length, negated: closes.negated.length }
}
