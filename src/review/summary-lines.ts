import { summaryMarkerOf } from "../names.ts"

export interface MarkedLine {
  readonly opening: string
  readonly marker: string
}

export function withMarkedLine(body: string, line: string, kind: MarkedLine, botLogin: string): string {
  if (!body.startsWith(summaryMarkerOf(botLogin))) return body
  const lines = withoutMarkedLine(body, kind).split("\n")
  const headerAt = lines.findIndex((text) => text.startsWith("## "))
  const insertAt = Math.max(headerAt, 0) + 1
  return [...lines.slice(0, insertAt), "", line, ...lines.slice(insertAt)].join("\n")
}

export function withoutMarkedLine(body: string, kind: MarkedLine): string {
  const kept: string[] = []
  for (const text of body.split("\n")) {
    if (!isMarkedLine(text, kind)) kept.push(text)
    else if (kept.at(-1) === "") kept.pop()
  }
  return kept.join("\n")
}

function isMarkedLine(text: string, { opening, marker }: MarkedLine): boolean {
  return text.startsWith(opening) && text.trimEnd().endsWith(marker)
}
