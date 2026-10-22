import { Minimatch } from "minimatch"
import { Type, type Static } from "typebox"

export type Side = "LEFT" | "RIGHT"

export interface CommentableLines {
  right: Map<number, string>
  left: Map<number, string>
}

interface Anchor {
  side: Side
  line: number
}

interface PatchLine {
  text: string
  anchor?: Anchor
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const NO_NEWLINE_AT_END_OF_FILE = "\\"
const SIDE_LETTER = { RIGHT: "R", LEFT: "L" } satisfies Record<Side, string>

function patchLines(patch: string): PatchLine[] {
  const lines: PatchLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const text of patch.split("\n")) {
    const header = HUNK_HEADER.exec(text)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[3])
      inHunk = true
      lines.push({ text })
    } else if (!inHunk || text.startsWith(NO_NEWLINE_AT_END_OF_FILE)) {
      lines.push({ text })
    } else if (text.startsWith("-")) {
      lines.push({ text, anchor: { side: "LEFT", line: oldLine++ } })
    } else if (text.startsWith("+")) {
      lines.push({ text, anchor: { side: "RIGHT", line: newLine++ } })
    } else {
      oldLine++
      lines.push({ text, anchor: { side: "RIGHT", line: newLine++ } })
    }
  }
  return lines
}

export function commentableLines(patch: string | undefined): CommentableLines {
  const right = new Map<number, string>()
  const left = new Map<number, string>()
  for (const { text, anchor } of patchLines(patch ?? "")) {
    if (anchor) (anchor.side === "RIGHT" ? right : left).set(anchor.line, text.slice(1))
  }
  return { right, left }
}

export interface DeltaLines {
  added: Set<number>
  addedTexts: Set<string>
  deletedTexts: Set<string>
}

export interface MarkedLines {
  right: Set<number>
  left: Set<number>
}

export function comparableText(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

export function deltaLines(patch: string | undefined): DeltaLines {
  const added = new Set<number>()
  const addedTexts = new Set<string>()
  const deletedTexts = new Set<string>()
  for (const { text, anchor } of patchLines(patch ?? "")) {
    if (anchor?.side === "RIGHT" && text.startsWith("+")) {
      added.add(anchor.line)
      addedTexts.add(comparableText(text.slice(1)))
    }
    if (anchor?.side === "LEFT") deletedTexts.add(comparableText(text.slice(1)))
  }
  return { added, addedTexts, deletedTexts }
}

export function markedLines(prPatch: string | undefined, sincePatch: string | undefined): MarkedLines {
  const since = deltaLines(sincePatch)
  const right = new Set([...deltaLines(prPatch).added].filter((line) => since.added.has(line)))
  const left = new Set(
    [...commentableLines(prPatch).left]
      .filter(([, text]) => since.deletedTexts.has(comparableText(text)))
      .map(([line]) => line),
  )
  return { right, left }
}

function numberPatch(patch: string, marked: MarkedLines | undefined): string {
  return patchLines(patch)
    .map((line) => numberedLine(line, marked))
    .join("\n")
}

function numberedLine({ text, anchor }: PatchLine, marked: MarkedLines | undefined): string {
  if (!anchor) return text
  const star = isMarked(anchor, marked) ? "*" : ""
  return `${`${SIDE_LETTER[anchor.side]}${anchor.line}${star}`.padEnd(6)} ${text}`
}

function isMarked(anchor: Anchor, marked: MarkedLines | undefined): boolean {
  if (!marked) return false
  return (anchor.side === "RIGHT" ? marked.right : marked.left).has(anchor.line)
}

function truncateAtLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.lastIndexOf("\n", maxChars)
  return `${cut === -1 ? "" : text.slice(0, cut)}\n... (patch truncated at ${maxChars} characters)`
}

export const ChangedFile = Type.Object({
  filename: Type.String(),
  status: Type.String(),
  additions: Type.Integer(),
  deletions: Type.Integer(),
  patch: Type.Optional(Type.String()),
})

export type ChangedFile = Static<typeof ChangedFile>

export function indexCommentableLines(files: readonly ChangedFile[]): Map<string, CommentableLines> {
  const index = new Map<string, CommentableLines>()
  for (const file of files) index.set(file.filename, commentableLines(file.patch))
  return index
}

const GENERATED = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
  /\.(min\.js|min\.css|map|snap)$/,
  /(^|\/)(dist|build|\.wrangler)\//,
]

const FILTER_MARK = /^!/
const FILTER_OPTIONS = { dot: true, nonegate: true }

export function isGenerated(path: string): boolean {
  return GENERATED.some((pattern) => pattern.test(path))
}

export const filterGlobs = (patterns: readonly string[]): Minimatch[] =>
  patterns.map((pattern) => new Minimatch(pattern.replace(FILTER_MARK, ""), FILTER_OPTIONS))

export const isFiltered = (path: string, globs: readonly Minimatch[]): boolean => globs.some((glob) => glob.match(path))

export function requiresWalkthrough(file: ChangedFile): boolean {
  return !isGenerated(file.filename)
}

export function reviewableFiles(files: readonly ChangedFile[], patterns: readonly string[]): ChangedFile[] {
  const globs = filterGlobs(patterns)
  return files.filter((file) => !isFiltered(file.filename, globs))
}

export const everyFileFiltered = (files: readonly ChangedFile[], patterns: readonly string[]): boolean =>
  files.length > 0 && reviewableFiles(files, patterns).length === 0

export function renderPatches(
  files: readonly ChangedFile[],
  maxCharsPerFile = 40_000,
  marked?: ReadonlyMap<string, MarkedLines>,
): string {
  return files
    .map((file) => renderFile(file, maxCharsPerFile, (patch) => numberPatch(patch, marked?.get(file.filename))))
    .join("\n\n")
}

export function renderChanges(files: readonly ChangedFile[], maxCharsPerFile = 40_000): string {
  return files.map((file) => renderFile(file, maxCharsPerFile, (patch) => patch)).join("\n\n")
}

function renderFile(file: ChangedFile, maxChars: number, render: (patch: string) => string): string {
  const header = `### ${file.filename} (${file.status}, +${file.additions} -${file.deletions})`
  if (isGenerated(file.filename))
    return `${header}\n(patch omitted: generated or lock file; read_file shows it if it matters)`
  if (!file.patch) return `${header}\n(no textual diff: binary, too large, or a rename without changes)`
  return `${header}\n\`\`\`diff\n${truncateAtLine(render(file.patch), maxChars)}\n\`\`\``
}
