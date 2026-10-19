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

function numberPatch(patch: string): string {
  return patchLines(patch)
    .map(({ text, anchor }) => (anchor ? `${`${SIDE_LETTER[anchor.side]}${anchor.line}`.padEnd(6)} ${text}` : text))
    .join("\n")
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

export function isGenerated(path: string): boolean {
  return GENERATED.some((pattern) => pattern.test(path))
}

export function requiresWalkthrough(file: ChangedFile): boolean {
  return !isGenerated(file.filename)
}

export function renderPatches(files: readonly ChangedFile[], maxCharsPerFile = 40_000): string {
  return files
    .map((file) => {
      const header = `### ${file.filename} (${file.status}, +${file.additions} -${file.deletions})`
      if (isGenerated(file.filename))
        return `${header}\n(patch omitted: generated or lock file; read_file shows it if it matters)`
      if (!file.patch) return `${header}\n(no textual diff: binary, too large, or a rename without changes)`
      return `${header}\n\`\`\`diff\n${truncateAtLine(numberPatch(file.patch), maxCharsPerFile)}\n\`\`\``
    })
    .join("\n\n")
}
