import { Minimatch } from "minimatch"
import { RE2JS } from "re2js"
import { engineFor, meteredTest, worstWork, type Engine } from "./regex-work.ts"
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

export const MAX_SEARCH_WORK = 750_000_000

export const MAX_RUN_SEARCH_WORK = 4 * MAX_SEARCH_WORK

export class GrepWork {
  #units = 0

  units(): number {
    return this.#units
  }

  spent(): boolean {
    return this.#units >= MAX_RUN_SEARCH_WORK
  }

  charge(units: number): void {
    this.#units += units
  }
}

export interface GrepQuery {
  pattern: string
  glob?: string
  path?: string
}

interface Hit {
  path: string
  line: number
  content: string
  text: string
}

export interface MentionHit {
  path: string
  line: number
  text: string
}

interface Found {
  hits: Hit[]
  overflowMatches: number
  overflowFiles: Set<string>
  searched: number
  longLines: number
  work: number
  stopped: boolean
}

interface Compiled {
  regex: RE2JS
  literal: boolean
}

type Selector = (path: string) => boolean

const GLOB_OPTIONS = { dot: true, matchBase: true }
const MAX_EXAMPLE_PATHS = 10
const MAX_EXAMPLE_PATH_CHARS = 200
const NOTE_RESERVE = 400
const LEADING_DOT_SLASH = /^(?:\.\/)+/
const LEADING_SLASHES = /^\/+/
const TRAILING_SLASHES = /\/+$/
const COSTLY_REASON =
  "this pattern costs too much to search everything. Narrow the path or glob, or use a simpler pattern (wide bounded repeats such as .{0,400} are the costly kind)."
const WORK_SPENT =
  "Grep budget spent: this review's grep calls have searched as much as one review allows. Use tree or read_file."
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

export function patternProblem(pattern: string): string | undefined {
  if (pattern === "") return "The pattern is empty."
  if (pattern.length > MAX_PATTERN_CHARS) {
    return `The pattern is ${pattern.length} characters, over the limit of ${MAX_PATTERN_CHARS}.`
  }
  return undefined
}

function compile(pattern: string): Compiled {
  try {
    return { regex: RE2JS.compile(RE2JS.translateRegExp(pattern)), literal: false }
  } catch {
    return { regex: RE2JS.compile(RE2JS.quote(pattern)), literal: true }
  }
}

function linesOf(content: string): string[] {
  const lines = content.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

function* lineHits(file: SnapshotFile, engine: Engine, found: Found): Generator<Hit> {
  const lines = linesOf(file.content)
  if (lines.length === 0) found.searched++
  for (const [index, raw] of lines.entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    const searched = line.slice(0, MAX_SEARCHED_LINE_CHARS)
    if (found.work + worstWork(engine, searched.length) > MAX_SEARCH_WORK) {
      found.stopped = true
      return
    }
    if (index === 0) found.searched++
    if (line.length > MAX_SEARCHED_LINE_CHARS) found.longLines++
    const { matched, work } = meteredTest(engine, searched)
    found.work += work
    if (matched) {
      const content = line.slice(0, MAX_LINE_CHARS)
      yield { path: file.path, line: index + 1, content, text: `${file.path}:${index + 1}: ${content}` }
    }
  }
}

function record(found: Found, file: SnapshotFile, engine: Engine): void {
  for (const hit of lineHits(file, engine, found)) {
    if (found.hits.length < MAX_MATCHES) {
      found.hits.push(hit)
    } else {
      found.overflowMatches++
      found.overflowFiles.add(file.path)
    }
  }
}

function search(files: SnapshotFiles, selected: Selector, engine: Engine): Found {
  const found: Found = {
    hits: [],
    overflowMatches: 0,
    overflowFiles: new Set(),
    searched: 0,
    longLines: 0,
    work: 0,
    stopped: false,
  }
  for (const file of files.files()) {
    if (!selected(file.path)) continue
    record(found, file, engine)
    if (found.stopped) break
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
  return `${count} ${subject} searched only in ${pronoun} first ${MAX_SEARCHED_LINE_CHARS.toLocaleString("en-US")} characters, so \`$\` and \`\\b\` can match at the cut.`
}

function stoppedNote(found: Found): string {
  if (!found.stopped) return ""
  return `Stopped early after ${plural(found.searched, "file", "files")}: ${COSTLY_REASON}`
}

const shortPath = (path: string): string =>
  path.length <= MAX_EXAMPLE_PATH_CHARS ? path : `…${path.slice(1 - MAX_EXAMPLE_PATH_CHARS)}`

function exampleGroups(chosen: readonly LeftOut[]): Examples {
  let room = MAX_EXAMPLE_PATHS
  const groups: string[] = []
  for (const reason of LEFT_OUT_REASONS) {
    const paths = chosen
      .filter((entry) => entry.reason === reason)
      .slice(0, room)
      .map((entry) => shortPath(entry.path))
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
  `Searched for the literal text \`${pattern}\` (not a pattern this search supports).`

function incompleteNote(record: SnapshotRecord | undefined): string {
  const reasons = [record?.capped ? CAPPED_REASON : "", record?.treeTruncated ? TRUNCATED_REASON : ""].filter(present)
  if (reasons.length === 0) return ""
  return `The snapshot is incomplete (${reasons.join("; ")}); a missing match may be in a file it didn't load.`
}

const present = (part: string): boolean => part !== ""

const joined = (parts: readonly string[]): string => parts.filter(present).join("\n")

export function grepMentions(files: SnapshotFiles, selected: Selector, pattern: string, work: GrepWork): MentionHit[] {
  if (work.spent() || patternProblem(pattern) !== undefined) return []
  const found = search(files, selected, engineFor(compile(pattern).regex))
  work.charge(found.work)
  return found.hits.map(({ path, line, content }) => ({ path, line, text: content }))
}

export function grep(files: SnapshotFiles, query: GrepQuery, work: GrepWork): string {
  const problem = patternProblem(query.pattern)
  if (problem !== undefined) return problem
  if (work.spent()) return WORK_SPENT
  const compiled = compile(query.pattern)
  const selected = selectorFor(query)
  const opening = compiled.literal ? literalNote(query.pattern) : ""
  const closing = joined([leftOutNote(files.leftOut(), selected), incompleteNote(files.record())])
  const room = MAX_GREP_CHARS - opening.length - closing.length - NOTE_RESERVE
  const found = search(files, selected, engineFor(compiled.regex))
  work.charge(found.work)
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
