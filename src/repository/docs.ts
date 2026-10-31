import { Minimatch } from "minimatch"
import { isGenerated, type ChangedFile } from "../github/diff.ts"

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

export type DocMatcher = (path: string) => boolean

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

const GLOB_OPTIONS = { dot: true }
const EXCLUDE_MARK = "!"
const MIN_BASENAME_CHARS = 4
const COMMON_BASENAMES = new Set(["index", "main", "mod", "utils", "readme"])
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g

const historyMatchers = HISTORY_GLOBS.map((glob) => new Minimatch(glob, GLOB_OPTIONS))

const toMatcher = (glob: string): Minimatch => new Minimatch(glob, GLOB_OPTIONS)

function partition(globs: readonly string[]) {
  const includes = globs.filter((glob) => !glob.startsWith(EXCLUDE_MARK))
  const excludes = globs.filter((glob) => glob.startsWith(EXCLUDE_MARK)).map((glob) => glob.slice(1))
  const effective = includes.length === 0 ? [...DEFAULT_DOC_GLOBS] : includes
  return { includes: effective.map(toMatcher), excludes: excludes.map(toMatcher) }
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
  return isDoc(file.filename) && !isGenerated(file.filename) ? "under" : "code"
}

export function mentionPatterns(path: string): string[] {
  const basename = path.split("/").at(-1) ?? path
  const stem = basename.replace(/\.[^.]+$/, "")
  if (stem.length < MIN_BASENAME_CHARS || COMMON_BASENAMES.has(stem.toLowerCase())) return [path]
  return [path, `\\b${stem.replace(REGEX_METACHARACTERS, "\\$&")}\\b`]
}
