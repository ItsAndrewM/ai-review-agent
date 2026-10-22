import { Minimatch } from "minimatch"
import {
  LEFT_OUT_REASONS,
  type LeftOut,
  type SnapshotFile,
  type SnapshotFiles,
  type SnapshotRecord,
} from "./snapshot.ts"

export const MAX_MATCHES = 100

export const MAX_GREP_CHARS = 12_000

export const MAX_LINE_CHARS = 300

export const MAX_PATTERN_CHARS = 500

export const MAX_TREE_ENTRIES = 500

export const DEFAULT_TREE_DEPTH = 2

export const MAX_SEARCH_CALLS = 40

export const MAX_SEARCHED_LINE_CHARS = 500

export const MAX_LONG_LINES_TESTED = 500

export interface GrepQuery {
  pattern: string
  glob?: string
  path?: string
}

interface Hit {
  path: string
  text: string
}

interface Found {
  hits: Hit[]
  overflowMatches: number
  overflowFiles: Set<string>
  searched: number
  longLines: number
  longTested: number
  stopped: boolean
  budgeted: boolean
}

interface Compiled {
  regex: RegExp
  literal: boolean
  quantified: boolean
}

type Selector = (path: string) => boolean

const GLOB_OPTIONS = { dot: true, matchBase: true }
const MAX_EXAMPLE_PATHS = 10
const NOTE_RESERVE = 400
const REGEX_SPECIALS = ".*+?^${}()|[]\\"
const LEADING_DOT_SLASH = /^(?:\.\/)+/
const LEADING_SLASHES = /^\/+/
const TRAILING_SLASHES = /\/+$/
const QUANTIFIERS = "+*{"
const REPEATERS = "+*{"
const BACKTRACKING_QUANTIFIERS = "*+?{"
const OPEN_ENDED_BRACE = /^\{\d+,\}$/
const ATOM = "a"
const CARRIAGE_RETURN = 13
const WILDCARD = "."
const WILDCARD_ESCAPES = "SWD"
const WILDCARD_REFUSAL =
  "it has more than one unbounded wildcard (such as .* twice), which can run for minutes on long lines; grep for one distinctive term and read the file instead."
const ALTERNATION_REFUSAL = String.raw`it repeats an alternation such as (.|\s)*, which can run for minutes; use a character class such as [\s\S]* instead`
const CAPPED_REASON = "cap of 50,000 files or 400 MB reached"
const TRUNCATED_REASON = "GitHub truncated the tree listing"

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

function normalisePath(path: string): string {
  const trimmed = path.trim().replace(LEADING_DOT_SLASH, "").replace(LEADING_SLASHES, "").replace(TRAILING_SLASHES, "")
  return trimmed === "." ? "" : trimmed
}

const isUnder = (path: string, root: string): boolean => root === "" || path === root || path.startsWith(`${root}/`)

function selectorFor(query: GrepQuery): Selector {
  const root = normalisePath(query.path ?? "")
  const glob = query.glob?.trim() ?? ""
  const matcher = glob === "" ? undefined : new Minimatch(glob, GLOB_OPTIONS)
  return (path) => isUnder(path, root) && (matcher === undefined || matcher.match(path))
}

const COMPLEMENTARY_ESCAPES = ["sS", "wW", "dD"]

function classEnd(pattern: string, open: number): number {
  let index = open + 1
  while (index < pattern.length && pattern.charAt(index) !== "]") {
    index += pattern.charAt(index) === "\\" ? 2 : 1
  }
  return index
}

function escapesIn(body: string): Set<string> {
  const letters = new Set<string>()
  for (let index = 0; index < body.length; index++) {
    if (body.charAt(index) === "\\") letters.add(body.charAt(++index))
  }
  return letters
}

function isWildcardClass(body: string): boolean {
  if (body.startsWith("^")) return true
  const escapes = escapesIn(body)
  return COMPLEMENTARY_ESCAPES.some((pair) => escapes.has(pair.charAt(0)) && escapes.has(pair.charAt(1)))
}

function structuralTokens(pattern: string): string[] {
  const tokens: string[] = []
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern.charAt(index)
    if (char === "\\") {
      index++
      tokens.push(WILDCARD_ESCAPES.includes(pattern.charAt(index)) ? WILDCARD : ATOM)
    } else if (char === "[") {
      const end = classEnd(pattern, index)
      tokens.push(isWildcardClass(pattern.slice(index + 1, end)) ? WILDCARD : ATOM)
      index = end
    } else {
      tokens.push(char)
    }
  }
  return tokens
}

const isRepeater = (token: string | undefined): boolean => token !== undefined && REPEATERS.includes(token)

function markEnclosingGroup(groups: boolean[]): void {
  if (groups.length > 0) groups[groups.length - 1] = true
}

function hasNestedQuantifier(tokens: readonly string[]): boolean {
  const groups: boolean[] = []
  for (const [index, token] of tokens.entries()) {
    if (token === "(") {
      groups.push(false)
    } else if (token === ")") {
      const innerQuantified = groups.pop() ?? false
      if (innerQuantified && isRepeater(tokens[index + 1])) return true
      if (innerQuantified) markEnclosingGroup(groups)
    } else if (QUANTIFIERS.includes(token)) {
      markEnclosingGroup(groups)
    }
  }
  return false
}

function hasRepeatedAlternation(tokens: readonly string[]): boolean {
  const groups: boolean[] = []
  for (const [index, token] of tokens.entries()) {
    if (token === "(") {
      groups.push(false)
    } else if (token === "|") {
      markEnclosingGroup(groups)
    } else if (token === ")" && (groups.pop() ?? false)) {
      if (isRepeater(tokens[index + 1])) return true
      markEnclosingGroup(groups)
    }
  }
  return false
}

function isOpenEndedBrace(tokens: readonly string[], open: number): boolean {
  const close = tokens.indexOf("}", open)
  return close !== -1 && OPEN_ENDED_BRACE.test(tokens.slice(open, close + 1).join(""))
}

function repeatsWithoutBound(tokens: readonly string[], index: number): boolean {
  const next = tokens[index + 1]
  if (next === "+" || next === "*") return true
  return next === "{" && isOpenEndedBrace(tokens, index + 1)
}

function hasTwoUnboundedWildcards(tokens: readonly string[]): boolean {
  const wildcards = tokens.filter((token, index) => token === WILDCARD && repeatsWithoutBound(tokens, index))
  return wildcards.length >= 2
}

export function patternProblem(pattern: string): string | undefined {
  if (pattern === "") return "The pattern is empty."
  if (pattern.length > MAX_PATTERN_CHARS) {
    return `The pattern is ${pattern.length} characters, over the limit of ${MAX_PATTERN_CHARS}.`
  }
  const tokens = structuralTokens(pattern)
  if (hasNestedQuantifier(tokens)) {
    return "The pattern has a nested quantifier (a repeated group that repeats inside), which can take far too long to match. Rewrite it without one."
  }
  if (hasRepeatedAlternation(tokens)) return ALTERNATION_REFUSAL
  return hasTwoUnboundedWildcards(tokens) ? WILDCARD_REFUSAL : undefined
}

const hasQuantifier = (pattern: string): boolean =>
  structuralTokens(pattern).some((token) => BACKTRACKING_QUANTIFIERS.includes(token))

const escaped = (text: string): string =>
  [...text].map((char) => (REGEX_SPECIALS.includes(char) ? `\\${char}` : char)).join("")

function compile(pattern: string): Compiled {
  try {
    return { regex: new RegExp(pattern, "m"), literal: false, quantified: hasQuantifier(pattern) }
  } catch {
    return { regex: new RegExp(escaped(pattern), "m"), literal: true, quantified: false }
  }
}

const outOfLongLines = (found: Found): boolean => found.longTested >= MAX_LONG_LINES_TESTED

function* lineHits(file: SnapshotFile, regex: RegExp, found: Found): Generator<Hit> {
  const lines = file.content.split("\n")
  for (const [index, raw] of lines.entries()) {
    const trailingNewline = index === lines.length - 1 && raw === ""
    if (outOfLongLines(found) && !trailingNewline) {
      found.stopped = true
      return
    }
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (found.budgeted && line.length > MAX_LINE_CHARS) found.longTested++
    if (regex.test(line.slice(0, MAX_SEARCHED_LINE_CHARS))) {
      yield { path: file.path, text: `${file.path}:${index + 1}: ${line.slice(0, MAX_LINE_CHARS)}` }
    }
  }
}

function record(found: Found, file: SnapshotFile, regex: RegExp): void {
  for (const hit of lineHits(file, regex, found)) {
    if (found.hits.length < MAX_MATCHES) {
      found.hits.push(hit)
    } else {
      found.overflowMatches++
      found.overflowFiles.add(file.path)
    }
  }
}

function lineLength(content: string, start: number, end: number): number {
  return end > start && content.charCodeAt(end - 1) === CARRIAGE_RETURN ? end - start - 1 : end - start
}

function longLineCount(content: string): number {
  if (content.length <= MAX_SEARCHED_LINE_CHARS) return 0
  let count = 0
  let start = 0
  for (let end = content.indexOf("\n"); end !== -1; end = content.indexOf("\n", start)) {
    if (lineLength(content, start, end) > MAX_SEARCHED_LINE_CHARS) count++
    start = end + 1
  }
  return lineLength(content, start, content.length) > MAX_SEARCHED_LINE_CHARS ? count + 1 : count
}

function search(files: SnapshotFiles, selected: Selector, { regex, quantified }: Compiled): Found {
  const found: Found = {
    hits: [],
    overflowMatches: 0,
    overflowFiles: new Set(),
    searched: 0,
    longLines: 0,
    longTested: 0,
    stopped: false,
    budgeted: quantified,
  }
  for (const file of files.files()) {
    if (!selected(file.path)) continue
    if (outOfLongLines(found)) {
      found.stopped = true
      break
    }
    found.searched++
    found.longLines += longLineCount(file.content)
    record(found, file, regex)
  }
  return found
}

function fitting(hits: readonly Hit[], room: number): Hit[] {
  let used = 0
  const kept: Hit[] = []
  for (const hit of hits) {
    used += hit.text.length + 1
    if (used > room) break
    kept.push(hit)
  }
  return kept
}

function hiddenNote(hidden: readonly Hit[], found: Found): string {
  const matches = hidden.length + found.overflowMatches
  const fileCount = new Set([...hidden.map(({ path }) => path), ...found.overflowFiles]).size
  return `… ${plural(matches, "more match", "more matches")} in ${plural(fileCount, "file", "files")} not shown.`
}

function resultText(found: Found, pattern: string, room: number): string {
  if (found.hits.length === 0) return `No match for /${pattern}/ in ${plural(found.searched, "file", "files")}.`
  const shown = fitting(found.hits, room)
  const hidden = found.hits.slice(shown.length)
  const lines = shown.map(({ text }) => text)
  const anyHidden = hidden.length + found.overflowMatches > 0
  return (anyHidden ? [...lines, hiddenNote(hidden, found)] : lines).join("\n")
}

interface Examples {
  groups: string[]
  shown: number
}

function longLineNote(count: number): string {
  if (count === 0) return ""
  const [subject, pronoun] = count === 1 ? ["long line", "its"] : ["long lines", "their"]
  return `${count} ${subject} searched only in ${pronoun} first ${MAX_SEARCHED_LINE_CHARS.toLocaleString("en-US")} characters.`
}

function stoppedNote(found: Found): string {
  if (!found.stopped) return ""
  return `Stopped early after ${plural(found.searched, "file", "files")}: too many long lines. Narrow the path or glob.`
}

function exampleGroups(chosen: readonly LeftOut[]): Examples {
  let room = MAX_EXAMPLE_PATHS
  const groups: string[] = []
  for (const reason of LEFT_OUT_REASONS) {
    const paths = chosen
      .filter((entry) => entry.reason === reason)
      .slice(0, room)
      .map((entry) => entry.path)
    if (paths.length > 0) groups.push(`${reason}: ${paths.join(", ")}`)
    room -= paths.length
  }
  return { groups, shown: MAX_EXAMPLE_PATHS - room }
}

function leftOutNote(leftOut: Iterable<LeftOut>, selected: Selector): string {
  const chosen = [...leftOut].filter((entry) => selected(entry.path))
  if (chosen.length === 0) return ""
  const { groups, shown } = exampleGroups(chosen)
  const rest = chosen.length - shown
  const examples = rest > 0 ? [...groups, `and ${rest} more`] : groups
  return `Not searched: ${plural(chosen.length, "file", "files")} left out of the snapshot (${examples.join("; ")}).`
}

const literalNote = (pattern: string): string =>
  `Searched for the literal text \`${pattern}\` (not a valid regular expression).`

function incompleteNote(record: SnapshotRecord | undefined): string {
  const reasons = [record?.capped ? CAPPED_REASON : "", record?.treeTruncated ? TRUNCATED_REASON : ""].filter(present)
  if (reasons.length === 0) return ""
  return `The snapshot is incomplete (${reasons.join("; ")}); a missing match may be in a file it didn't load.`
}

const present = (part: string): boolean => part !== ""

const joined = (parts: readonly string[]): string => parts.filter(present).join("\n")

export function grep(files: SnapshotFiles, query: GrepQuery): string {
  const problem = patternProblem(query.pattern)
  if (problem !== undefined) return problem
  const compiled = compile(query.pattern)
  const selected = selectorFor(query)
  const opening = compiled.literal ? literalNote(query.pattern) : ""
  const closing = joined([leftOutNote(files.leftOut(), selected), incompleteNote(files.record())])
  const room = MAX_GREP_CHARS - opening.length - closing.length - NOTE_RESERVE
  const found = search(files, selected, compiled)
  const body = resultText(found, query.pattern, room)
  return joined([opening, body, stoppedNote(found), longLineNote(found.longLines), closing])
}

interface Listed {
  path: string
  note: string
}

function* listed(files: SnapshotFiles): Generator<Listed> {
  for (const path of files.paths()) yield { path, note: "" }
  for (const entry of files.leftOut()) yield { path: entry.path, note: ` (left out: ${entry.reason})` }
}

function addEntries(entries: Map<string, string>, item: Listed, root: string, levels: number): void {
  if (!isUnder(item.path, root) || item.path === root) return
  const segments = (root === "" ? item.path : item.path.slice(root.length + 1)).split("/")
  const prefix = root === "" ? "" : `${root}/`
  for (let count = 1; count <= Math.min(levels, segments.length); count++) {
    const isDirectory = count < segments.length
    const entry = `${prefix}${segments.slice(0, count).join("/")}${isDirectory ? "/" : ""}`
    entries.set(entry, isDirectory ? "" : item.note)
  }
}

const byText = (a: string, b: string): number => {
  if (a < b) return -1
  return a > b ? 1 : 0
}

function emptyTreeText(root: string): string {
  return root === "" ? "The snapshot has no files." : `No files under \`${root}\` in the snapshot.`
}

export function tree(files: SnapshotFiles, path = "", depth = DEFAULT_TREE_DEPTH): string {
  return joined([listing(files, path, depth), incompleteNote(files.record())])
}

function listing(files: SnapshotFiles, path: string, depth: number): string {
  const root = normalisePath(path)
  const levels = Number.isInteger(depth) ? Math.max(1, depth) : DEFAULT_TREE_DEPTH
  const entries = new Map<string, string>()
  for (const item of listed(files)) addEntries(entries, item, root, levels)
  if (entries.size === 0) return emptyTreeText(root)
  const lines = [...entries.keys()].sort(byText).map((entry) => `${entry}${entries.get(entry) ?? ""}`)
  if (lines.length <= MAX_TREE_ENTRIES) return lines.join("\n")
  const hidden = lines.length - MAX_TREE_ENTRIES
  return [...lines.slice(0, MAX_TREE_ENTRIES), `… ${plural(hidden, "more entry", "more entries")} not shown.`].join(
    "\n",
  )
}
