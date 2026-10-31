const RELEASE_NOTES_START = "<!-- This is an auto-generated comment: release notes by coderabbit.ai -->"
const RELEASE_NOTES_END = "<!-- end of auto-generated comment: release notes by coderabbit.ai -->"
const GENERATED_MARK = /^<!-- coderabbit-ai-generated:v\d+ -->\n?/gm

function withoutBlock(text: string): string {
  const start = text.indexOf(RELEASE_NOTES_START)
  if (start < 0) return text
  const end = text.indexOf(RELEASE_NOTES_END, start)
  const after = end < 0 ? "" : text.slice(end + RELEASE_NOTES_END.length)
  return withoutBlock(`${text.slice(0, start).trimEnd()}\n\n${after.trimStart()}`)
}

export function withoutGeneratedNotes(body: string | null): string | null {
  if (body === null) return null
  return withoutBlock(body).replace(GENERATED_MARK, "").trim()
}
