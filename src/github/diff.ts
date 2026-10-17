import { Type, type Static } from "typebox"

export type Side = "LEFT" | "RIGHT"

export interface CommentableLines {
  right: Set<number>
  left: Set<number>
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const NO_NEWLINE_AT_END_OF_FILE = "\\"

export function commentableLines(patch: string | undefined): CommentableLines {
  const right = new Set<number>()
  const left = new Set<number>()
  if (!patch) return { right, left }
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[3])
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith(NO_NEWLINE_AT_END_OF_FILE)) continue
    const marker = line[0]
    if (marker === "+") {
      right.add(newLine++)
    } else if (marker === "-") {
      left.add(oldLine++)
    } else {
      right.add(newLine++)
      oldLine++
    }
  }
  return { right, left }
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

export function renderPatches(files: readonly ChangedFile[], maxCharsPerFile = 40_000): string {
  return files
    .map((file) => {
      const header = `### ${file.filename} (${file.status}, +${file.additions} -${file.deletions})`
      if (isGenerated(file.filename))
        return `${header}\n(patch omitted: generated or lock file; read_file shows it if it matters)`
      if (!file.patch) return `${header}\n(no textual diff: binary, too large, or a rename without changes)`
      const patch =
        file.patch.length > maxCharsPerFile
          ? `${file.patch.slice(0, maxCharsPerFile)}\n... (patch truncated at ${maxCharsPerFile} characters)`
          : file.patch
      return `${header}\n\`\`\`diff\n${patch}\n\`\`\``
    })
    .join("\n\n")
}
