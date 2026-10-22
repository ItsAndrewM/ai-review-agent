import { Minimatch } from "minimatch"
import { LEFT_OUT_REASONS, type LeftOut, type SnapshotFile, type SnapshotFiles } from "./snapshot.ts"

export const MAX_MATCHES = 100

export const MAX_GREP_CHARS = 12_000

export const MAX_LINE_CHARS = 300

export const MAX_PATTERN_CHARS = 500

export const MAX_TREE_ENTRIES = 500

export const DEFAULT_TREE_DEPTH = 2

export const MAX_SEARCH_CALLS = 40

export const MAX_SEARCHED_LINE_CHARS = 2_000

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
}

interface Compiled {
  regex: RegExp
  literal: boolean
}

type Selector = (path: string) => boolean

const GLOB_OPTIONS = { dot: true, matchBase: true }
const MAX_EXAMPLE_PATHS = 10
const NOTE_RESERVE = 240
const REGEX_SPECIALS = ".*+?^${}()|[]\\"
const LEADING_DOT_SLASH = /^(?:\.\/)+/
const LEADING_SLASHES = /^\/+/
const TRAILING_SLASHES = /\/+$/
const QUANTIFIERS = "+*{"
const REPEATERS = "+*{"
const ATOM = "a"

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

function structuralTokens(pattern: string): string[] {
  const tokens: string[] = []
  let inClass = false
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern.charAt(index)
    if (inClass) {
      inClass = char !== "]"
    } else if (char === "\\") {
      index++
      tokens.push(ATOM)
    } else if (char === "[") {
      inClass = true
      tokens.push(ATOM)
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

export function patternProblem(pattern: string): string | undefined {
  if (pattern === "") return "The pattern is empty."
  if (pattern.length > MAX_PATTERN_CHARS) {
    return `The pattern is ${pattern.length} characters, over the limit of ${MAX_PATTERN_CHARS}.`
  }
  if (hasNestedQuantifier(structuralTokens(pattern))) {
    return "The pattern has a nested quantifier (a repeated group that repeats inside), which can take far too long to match. Rewrite it without one."
  }
  return undefined
}

const escaped = (text: string): string =>
  [...text].map((char) => (REGEX_SPECIALS.includes(char) ? `\\${char}` : char)).join("")

function compile(pattern: string): Compiled {
  try {
    return { regex: new RegExp(pattern, "m"), literal: false }
  } catch {
    return { regex: new RegExp(escaped(pattern), "m"), literal: true }
  }
}

function* lineHits(file: SnapshotFile, regex: RegExp): Generator<Hit> {
  for (const [index, raw] of file.content.split("\n").entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (regex.test(line.slice(0, MAX_SEARCHED_LINE_CHARS))) {
      yield { path: file.path, text: `${file.path}:${index + 1}: ${line.slice(0, MAX_LINE_CHARS)}` }
    }
  }
}

function record(found: Found, file: SnapshotFile, regex: RegExp): void {
  for (const hit of lineHits(file, regex)) {
    if (found.hits.length < MAX_MATCHES) {
      found.hits.push(hit)
    } else {
      found.overflowMatches++
      found.overflowFiles.add(file.path)
    }
  }
}

function longLineCount(content: string): number {
  if (content.length <= MAX_SEARCHED_LINE_CHARS) return 0
  let count = 0
  let start = 0
  for (let end = content.indexOf("\n"); end !== -1; end = content.indexOf("\n", start)) {
    if (end - start > MAX_SEARCHED_LINE_CHARS) count++
    start = end + 1
  }
  return content.length - start > MAX_SEARCHED_LINE_CHARS ? count + 1 : count
}

function search(files: SnapshotFiles, selected: Selector, regex: RegExp): Found {
  const found: Found = { hits: [], overflowMatches: 0, overflowFiles: new Set(), searched: 0, longLines: 0 }
  for (const file of files.files()) {
    if (!selected(file.path)) continue
    found.searched++
    const longLines = longLineCount(file.content)
    found.longLines += longLines
    if (longLines > 0 || regex.test(file.content)) record(found, file, regex)
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

export function grep(files: SnapshotFiles, query: GrepQuery): string {
  const problem = patternProblem(query.pattern)
  if (problem !== undefined) return problem
  const { regex, literal } = compile(query.pattern)
  const selected = selectorFor(query)
  const opening = literal ? literalNote(query.pattern) : ""
  const closing = leftOutNote(files.leftOut(), selected)
  const room = MAX_GREP_CHARS - opening.length - closing.length - NOTE_RESERVE
  const found = search(files, selected, regex)
  const body = resultText(found, query.pattern, room)
  return [opening, body, longLineNote(found.longLines), closing].filter((part) => part !== "").join("\n")
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
