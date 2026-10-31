import { Minimatch } from "minimatch"
import { deltaLines, isGenerated, type ChangedFile } from "../github/diff.ts"
import type { LogFields } from "../log.ts"
import { grepMentions, MAX_SEARCH_WORK, type GrepWork, type MentionHit, type MentionSearch } from "./search.ts"
import type { SnapshotFiles, SnapshotRecord } from "./snapshot.ts"

export const DEFAULT_DOC_GLOBS = [
  "**/README*",
  "docs/**/*.md",
  "CLAUDE.md",
  "AGENTS.md",
  "REVIEW.md",
  "CODING_STANDARDS.md",
  ".github/copilot-instructions.md",
  "CONTRIBUTING.md",
  "**/CLAUDE.md",
  "**/AGENTS.md",
  ".github/instructions/*.instructions.md",
] as const

export const HISTORY_GLOBS = ["docs/superpowers/**"] as const

export const MAX_MENTIONS_PER_FILE = 6

export const MAX_MENTIONS = 40

export const MAX_DOC_PATHS = 200

export type DocMatcher = (path: string) => boolean

export type DocsSearch = "ready" | "unavailable" | "spent" | "stopped"

export interface DocsInChange {
  under: ChangedFile[]
  history: ChangedFile[]
  code: ChangedFile[]
}

export interface DocMention {
  path: string
  line: number
  text: string
}

export interface DocMentions {
  mentions: DocMention[]
  overflow: number
  searched: number
  stopped: boolean
}

export type ChangedLinesByDoc = ReadonlyMap<string, ReadonlySet<number>>

const GLOB_OPTIONS = { dot: true }
const EXCLUDE_GLOB_OPTIONS = { ...GLOB_OPTIONS, nonegate: true }
const EXCLUDE_MARK = "!"
const MIN_BASENAME_CHARS = 4
const COMMON_BASENAMES = new Set(["index", "main", "mod", "utils", "readme"])
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g
const WORD_CHARACTER = /\w/

const historyMatchers = HISTORY_GLOBS.map((glob) => new Minimatch(glob, GLOB_OPTIONS))

const toMatcher = (glob: string): Minimatch => new Minimatch(glob, GLOB_OPTIONS)

const toExcludeMatcher = (glob: string): Minimatch => new Minimatch(glob, EXCLUDE_GLOB_OPTIONS)

function partition(globs: readonly string[]) {
  const includes = globs.filter((glob) => !glob.startsWith(EXCLUDE_MARK))
  const excludes = globs.filter((glob) => glob.startsWith(EXCLUDE_MARK)).map((glob) => glob.slice(1))
  const effective = includes.length === 0 ? [...DEFAULT_DOC_GLOBS] : includes
  return { includes: effective.map(toMatcher), excludes: excludes.map(toExcludeMatcher) }
}

export function docMatcher(globs: readonly string[]): DocMatcher {
  const { includes, excludes } = partition(globs)
  return (path) => includes.some((glob) => glob.match(path)) && !excludes.some((glob) => glob.match(path))
}

export function isHistory(path: string): boolean {
  return historyMatchers.some((glob) => glob.match(path))
}

export function docsInChange(files: readonly ChangedFile[], isDoc: DocMatcher): DocsInChange {
  const sorted: DocsInChange = { under: [], history: [], code: [] }
  for (const file of files) sorted[bucketOf(file, isDoc)].push(file)
  return sorted
}

function bucketOf(file: ChangedFile, isDoc: DocMatcher): keyof DocsInChange {
  if (isHistory(file.filename)) return file.status === "added" ? "under" : "history"
  if (file.status === "removed") return "code"
  return isDoc(file.filename) && !isGenerated(file.filename) ? "under" : "code"
}

export function searchableCode(code: readonly ChangedFile[]): ChangedFile[] {
  return code.filter((file) => !isGenerated(file.filename))
}

export function changedLinesByDoc(under: readonly ChangedFile[]): ChangedLinesByDoc {
  return new Map(under.map((file) => [file.filename, deltaLines(file.patch).added]))
}

export function docMentions(
  files: SnapshotFiles,
  work: GrepWork,
  isDoc: DocMatcher,
  code: readonly ChangedFile[],
  under: ChangedLinesByDoc,
): DocMentions {
  const selected = (path: string): boolean => isDoc(path) && !isHistory(path)
  const searchable = searchableCode(code)
  const startUnits = work.units()
  const perFile: MentionHit[][] = []
  let stopped = snapshotMissesDocs(files, selected)
  for (const file of searchable) {
    if (work.spent() || work.units() - startUnits > MAX_SEARCH_WORK) break
    const found = mentionsOf(files, work, selected, file.filename)
    stopped ||= found.stopped
    perFile.push(found.hits.filter((hit) => !under.get(hit.path)?.has(hit.line)))
  }
  const { kept, overflow } = roundRobin(perFile)
  return { mentions: kept, overflow, searched: perFile.length, stopped: stopped || perFile.length < searchable.length }
}

function snapshotMissesDocs(files: SnapshotFiles, selected: DocMatcher): boolean {
  const record = files.record()
  if (record !== undefined && isIncomplete(record)) return true
  for (const entry of files.leftOut()) if (selected(entry.path)) return true
  return false
}

const isIncomplete = (record: SnapshotRecord): boolean => record.capped || record.treeTruncated

function roundRobin(perFile: readonly MentionHit[][]) {
  const queues = perFile.map((hits) => hits.slice(0, MAX_MENTIONS_PER_FILE))
  let overflow = perFile.reduce((sum, hits) => sum + Math.max(0, hits.length - MAX_MENTIONS_PER_FILE), 0)
  const kept: MentionHit[] = []
  const seen = new Set<string>()
  for (let round = 0; round < MAX_MENTIONS_PER_FILE; round++) {
    for (const queue of queues) {
      const hit = queue[round]
      if (hit === undefined || seen.has(placeOf(hit))) continue
      if (kept.length >= MAX_MENTIONS) {
        overflow++
        continue
      }
      seen.add(placeOf(hit))
      kept.push(hit)
    }
  }
  return { kept, overflow }
}

function mentionsOf(files: SnapshotFiles, work: GrepWork, selected: DocMatcher, path: string): MentionSearch {
  const seen = new Set<string>()
  const hits: MentionHit[] = []
  let stopped = false
  for (const pattern of mentionPatterns(path)) {
    const found = grepMentions(files, selected, pattern, work)
    stopped ||= found.stopped
    for (const hit of found.hits.sort(byPlace)) {
      if (seen.has(placeOf(hit))) continue
      seen.add(placeOf(hit))
      hits.push(hit)
    }
  }
  return { hits, stopped }
}

const placeOf = (hit: MentionHit): string => `${hit.path}:${hit.line}`

const byPlace = (a: MentionHit, b: MentionHit): number => {
  if (a.path === b.path) return a.line - b.line
  return a.path < b.path ? -1 : 1
}

export function docPathsAtHead(paths: Iterable<string>, isDoc: DocMatcher, under: readonly string[]): string[] {
  const reserved = new Set(under)
  const others = new Set<string>()
  for (const path of paths) if (isDoc(path) && !isHistory(path) && !reserved.has(path)) others.add(path)
  const room = Math.max(0, MAX_DOC_PATHS - reserved.size)
  return [...reserved, ...[...others].sort().slice(0, room)].sort()
}

export function docsStartFields(sorted: DocsInChange, found: DocMentions | undefined, search: DocsSearch): LogFields {
  return {
    under: sorted.under.length,
    history: sorted.history.length,
    code: sorted.code.length,
    mentions: found?.mentions.length ?? 0,
    mentionFiles: new Set((found?.mentions ?? []).map((mention) => mention.path)).size,
    overflow: found?.overflow ?? 0,
    search,
  }
}

export function mentionPatterns(path: string): string[] {
  const basename = path.split("/").at(-1) ?? path
  const stem = basename.replace(/\.[^.]+$/, "")
  const literal = path.replace(REGEX_METACHARACTERS, "\\$&")
  if (stem.length < MIN_BASENAME_CHARS || COMMON_BASENAMES.has(stem.toLowerCase())) return [literal]
  return [literal, wordPattern(stem)]
}

function wordPattern(stem: string): string {
  const quoted = stem.replace(REGEX_METACHARACTERS, "\\$&")
  const leading = WORD_CHARACTER.test(stem[0] ?? "") ? "\\b" : ""
  const trailing = WORD_CHARACTER.test(stem.at(-1) ?? "") ? "\\b" : ""
  return `${leading}${quoted}${trailing}`
}
