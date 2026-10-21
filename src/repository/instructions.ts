import { Minimatch } from "minimatch"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { parse } from "yaml"
import type { TreeEntry } from "../github/client.ts"

export type StandardSource = "path_instructions" | "instructions" | "nested" | "root"

export interface Standard {
  readonly path: string
  readonly text: string
  readonly source: StandardSource
}

export interface RenderedStandards {
  text: string
  used: string[]
  cut: string[]
}

export const MAX_STANDARDS_CHARS = 12_000

const CONFIG_FILE = ".andabot.yaml"
const HEADING = "## Repository standards"
const INSTRUCTIONS_SUFFIX = ".instructions.md"
const GLOB_OPTIONS = { dot: true }
const INSTRUCTIONS_GLOB = new Minimatch(`.github/instructions/*${INSTRUCTIONS_SUFFIX}`, GLOB_OPTIONS)
const NESTED_FILES = ["CLAUDE.md", "AGENTS.md"]
const ROOT_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "REVIEW.md",
  "CODING_STANDARDS.md",
  ".github/copilot-instructions.md",
  "CONTRIBUTING.md",
]
const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n([\s\S]*))?$/
const APPLY_TO_LINE = /^applyTo:[ \t]*(.*)$/gm
const SURROUNDING_QUOTES = /^(["'])(.*)\1$/
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/

const Frontmatter = Type.Object({
  applyTo: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
})

const compareText = (a: string, b: string): number => {
  if (a < b) return -1
  return a > b ? 1 : 0
}

const depthOf = (directory: string): number => directory.split("/").length

const deepestFirst = (a: string, b: string): number => {
  const byDepth = depthOf(b) - depthOf(a)
  return byDepth === 0 ? compareText(a, b) : byDepth
}

const ancestorDirectories = (path: string): string[] => {
  const directories = path.split("/").slice(0, -1)
  return directories.map((_, index) => directories.slice(0, index + 1).join("/"))
}

const instructionPaths = (blobs: ReadonlySet<string>): string[] =>
  [...blobs].filter((path) => INSTRUCTIONS_GLOB.match(path)).sort(compareText)

const nestedPaths = (blobs: ReadonlySet<string>, changed: readonly string[]): string[] => {
  const directories = [...new Set(changed.flatMap(ancestorDirectories))].sort(deepestFirst)
  const candidates = directories.flatMap((directory) => NESTED_FILES.map((file) => `${directory}/${file}`))
  return candidates.filter((path) => blobs.has(path))
}

const rootPaths = (blobs: ReadonlySet<string>): string[] => ROOT_FILES.filter((path) => blobs.has(path))

export function instructionCandidates(entries: readonly TreeEntry[], changed: readonly string[]): string[] {
  const blobs = new Set(entries.filter(({ type }) => type === "blob").map(({ path }) => path))
  return [...instructionPaths(blobs), ...nestedPaths(blobs, changed), ...rootPaths(blobs)]
}

const isFlowList = (value: string): boolean => value.startsWith("[")

const textualApplyTo = (frontmatter: string): string | undefined => {
  const lines = [...frontmatter.matchAll(APPLY_TO_LINE)]
  const value = lines.length === 1 ? lines[0]?.[1]?.trim() : undefined
  if (value === undefined || isFlowList(value)) return undefined
  return value.replace(SURROUNDING_QUOTES, "$2")
}

const applyToOf = (frontmatter: string): string | string[] | undefined => {
  try {
    const data = parse(frontmatter)
    return Value.Check(Frontmatter, data) ? data.applyTo : undefined
  } catch {
    return textualApplyTo(frontmatter)
  }
}

const splitGlobs = (list: string): string[] => {
  const globs: string[] = []
  let braceDepth = 0
  let start = 0
  for (let index = 0; index < list.length; index++) {
    const char = list[index]
    if (char === "{") braceDepth++
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1)
    else if (char === "," && braceDepth === 0) {
      globs.push(list.slice(start, index))
      start = index + 1
    }
  }
  globs.push(list.slice(start))
  return globs.map((glob) => glob.trim()).filter((glob) => glob !== "")
}

const applyToGlobs = (text: string): string[] => {
  const block = FRONTMATTER_BLOCK.exec(text)
  const applyTo = block === null ? undefined : applyToOf(block[1] ?? "")
  if (applyTo === undefined) return []
  return (Array.isArray(applyTo) ? applyTo : [applyTo]).flatMap(splitGlobs)
}

const matchesAnyPath = (glob: string, paths: readonly string[]): boolean => {
  const matcher = new Minimatch(glob, GLOB_OPTIONS)
  return paths.some((path) => matcher.match(path))
}

export function applyToKeeps(text: string, changed: readonly string[]): boolean {
  const globs = applyToGlobs(text)
  return globs.length === 0 || globs.some((glob) => matchesAnyPath(glob, changed))
}

export function frontmatterStripped(text: string): string {
  const block = FRONTMATTER_BLOCK.exec(text)
  return block === null ? text : (block[2] ?? "")
}

const sourceOf = (path: string): StandardSource => {
  if (path.endsWith(INSTRUCTIONS_SUFFIX)) return "instructions"
  return ROOT_FILES.includes(path) ? "root" : "nested"
}

const fileStandards = (path: string, text: string, changed: readonly string[]): Standard[] => {
  const source = sourceOf(path)
  if (source !== "instructions") return [{ path, text, source }]
  return applyToKeeps(text, changed) ? [{ path, text: frontmatterStripped(text), source }] : []
}

const withTextOnce = (standards: readonly Standard[]): Standard[] => {
  const seen = new Set<string>()
  return standards.filter(({ text }) => {
    const trimmed = text.trim()
    if (trimmed === "" || seen.has(trimmed)) return false
    seen.add(trimmed)
    return true
  })
}

export function orderedStandards(
  loaded: readonly { path: string; text: string }[],
  changed: readonly string[],
  pathInstructions: readonly { path: string; instructions: string }[],
): Standard[] {
  const configured = pathInstructions
    .filter(({ path }) => matchesAnyPath(path, changed))
    .map(({ path, instructions }): Standard => ({
      path: `${CONFIG_FILE}: ${path}`,
      text: instructions,
      source: "path_instructions",
    }))
  const files = loaded.flatMap(({ path, text }) => fileStandards(path, text, changed))
  return withTextOnce([...configured, ...files])
}

const entryOf = (path: string, body: string): string => `### ${path}\n\n${body}`

const sectionOf = (entries: readonly string[], cut: readonly string[]): string => {
  const note = cut.length === 0 ? [] : [`_Cut for length: ${cut.join(", ")}._`]
  return [HEADING, ...entries, ...note].join("\n\n")
}

const wholeEntries = (standards: readonly Standard[]): RenderedStandards | undefined => {
  const entries = standards.map(({ path, text }) => entryOf(path, text.trim()))
  const paths = standards.map(({ path }) => path)
  for (let kept = standards.length; kept > 0; kept--) {
    const cut = paths.slice(kept)
    const text = sectionOf(entries.slice(0, kept), cut)
    if (text.length <= MAX_STANDARDS_CHARS) return { text, used: paths.slice(0, kept), cut }
  }
  return undefined
}

const truncatedFirst = (first: Standard, later: readonly Standard[]): RenderedStandards => {
  const cut = [`${first.path} (truncated)`, ...later.map(({ path }) => path)]
  const room = Math.max(0, MAX_STANDARDS_CHARS - sectionOf([entryOf(first.path, "")], cut).length)
  const entry = entryOf(first.path, first.text.trim().slice(0, room).replace(TRAILING_HIGH_SURROGATE, ""))
  return { text: sectionOf([entry], cut), used: [first.path], cut }
}

export function renderStandards(standards: readonly Standard[]): RenderedStandards {
  const [first, ...later] = standards
  if (first === undefined) return { text: "", used: [], cut: [] }
  return wholeEntries(standards) ?? truncatedFirst(first, later)
}
