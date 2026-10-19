import { Type } from "@earendil-works/pi-ai"
import type { Static } from "typebox"
import { Value } from "typebox/value"
import type { ReviewComment } from "../github/client.ts"
import { comparableText, type CommentableLines, type Side } from "../github/diff.ts"
import { errorText } from "../log.ts"

export const Severity = Type.Union([Type.Literal("blocking"), Type.Literal("suggestion"), Type.Literal("nitpick")])

export const Finding = Type.Object({
  path: Type.String({ description: "Path of the changed file, exactly as listed." }),
  line: Type.Integer({
    description:
      "Line the comment is anchored to, copied from the anchor in front of that line in the diff: R12 is line 12 on side RIGHT, L10 is line 10 on side LEFT.",
  }),
  start_line: Type.Optional(
    Type.Integer({
      description:
        "First line of a multi-line range ending at `line`, copied from its anchor. Same side. Omit for one line.",
    }),
  ),
  side: Type.Optional(
    Type.Union([Type.Literal("RIGHT"), Type.Literal("LEFT")], {
      description: "RIGHT (default) when the anchor starts with R, LEFT when it starts with L.",
    }),
  ),
  quote: Type.String({
    description:
      "The text of the line at `line`, copied exactly as the diff shows it after the anchor and the +, - or space. The host checks the anchor against it.",
  }),
  severity: Severity,
  title: Type.String({ description: "One line, under 80 characters." }),
  body: Type.String({ description: "Why it is a problem and what to do instead. Markdown." }),
  suggestion: Type.Optional(
    Type.String({
      description:
        "The new text for the anchored lines, start_line (or line) through line, on the RIGHT side, verbatim, indented as in the file, no fences. GitHub removes those lines and puts this in their place, so keep any of them you still need: to add code beside a line, include that line. Only when you are sure it compiles and is complete.",
    }),
  ),
})

export const Walkthrough = Type.Object({
  path: Type.String(),
  summary: Type.String({ description: "One sentence on what changed in this file." }),
})

export const ReviewSubmission = Type.Object({
  summary: Type.String({
    description: "Two to five sentences on what the pull request does and how it does it. Markdown.",
  }),
  walkthrough: Type.Array(Walkthrough),
  findings: Type.Array(Finding),
  verdict: Type.Union([Type.Literal("approve"), Type.Literal("request_changes"), Type.Literal("comment")], {
    description:
      "approve when nothing blocking remains and the change is sound; request_changes when any finding is blocking; comment otherwise.",
  }),
})

export type FindingInput = Static<typeof Finding>
export type ReviewSubmissionInput = Static<typeof ReviewSubmission>

export type WrittenReview =
  | { kind: "submission"; submission: ReviewSubmissionInput }
  | { kind: "unfit"; problem: string }
  | { kind: "prose"; text: string }

const JSON_FENCE = /```json[^\n]*\n([\s\S]*?)\n\s*```/i
const JSON_OBJECT_START = /\{\s*"/

export function parseWrittenReview(text: string): WrittenReview {
  const json = jsonIn(text)
  if (json === undefined) return { kind: "prose", text: text.trim() }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (cause) {
    return { kind: "unfit", problem: errorText(cause) }
  }
  if (Value.Check(ReviewSubmission, value)) return { kind: "submission", submission: value }
  const [first] = Value.Errors(ReviewSubmission, value)
  return { kind: "unfit", problem: `${first?.instancePath || "/"}: ${first?.message}` }
}

function jsonIn(text: string): string | undefined {
  const fenced = JSON_FENCE.exec(text)?.[1]
  if (fenced !== undefined) return fenced
  const start = text.search(JSON_OBJECT_START)
  return start === -1 ? undefined : text.slice(start, objectEnd(text, start))
}

function objectEnd(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      i = stringEnd(text, i)
    } else if (char === "{") {
      depth++
    } else if (char === "}") {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return text.length
}

function stringEnd(text: string, quote: number): number {
  for (let i = quote + 1; i < text.length; i++) {
    if (text[i] === "\\") i++
    else if (text[i] === '"') return i
  }
  return text.length
}

export const MAX_FINDINGS = 25
export const MAX_BODY_CHARS = 4000
export const MAX_SUGGESTION_CHARS = 60_000
export const MAX_COMMENT_CHARS = 65_536

export interface Rejected {
  finding: FindingInput
  reason: string
}

export interface ValidatedReview {
  accepted: FindingInput[]
  rejected: Rejected[]
  relocated: number
  suggestionsDropped: number
}

type Anchored = { finding: FindingInput; relocated: boolean } | { reason: string }

type Checked = { finding: FindingInput; relocated: boolean; suggestionDropped: boolean } | { reason: string }

interface Fitted {
  finding: FindingInput
  suggestionDropped: boolean
}

const BRACKETS = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
] as const

export function validateFindings(
  findings: readonly FindingInput[],
  commentable: ReadonlyMap<string, CommentableLines>,
): ValidatedReview {
  const accepted: FindingInput[] = []
  const rejected: Rejected[] = []
  const seen = new Set<string>()
  let relocated = 0
  let suggestionsDropped = 0
  for (const finding of findings) {
    const checked = checkFinding(finding, commentable)
    if ("reason" in checked) {
      rejected.push({ finding, reason: checked.reason })
      continue
    }
    const key = `${checked.finding.path}:${checked.finding.side ?? "RIGHT"}:${checked.finding.line}`
    if (seen.has(key)) {
      rejected.push({ finding, reason: "duplicate anchor: one comment per line, merge them" })
      continue
    }
    seen.add(key)
    if (accepted.length >= MAX_FINDINGS) {
      rejected.push({ finding, reason: `more than ${MAX_FINDINGS} findings; keep the most important` })
      continue
    }
    accepted.push(checked.finding)
    if (checked.relocated) relocated++
    if (checked.suggestionDropped) suggestionsDropped++
  }
  return { accepted, rejected, relocated, suggestionsDropped }
}

function checkFinding(finding: FindingInput, commentable: ReadonlyMap<string, CommentableLines>): Checked {
  const lines = commentable.get(finding.path)
  if (!lines) return { reason: `path "${finding.path}" is not a changed file` }
  const side = finding.side ?? "RIGHT"
  const sideLines = side === "RIGHT" ? lines.right : lines.left
  const anchored = anchorByQuote(finding, side, sideLines)
  if ("reason" in anchored) return anchored
  const rangeIssue = rangeProblem(anchored.finding, side, sideLines)
  if (rangeIssue !== undefined) return { reason: rangeIssue }
  const fitted = fitSuggestion(anchored.finding, sideLines)
  const problem = contentProblem(fitted.finding)
  return problem === undefined ? { ...fitted, relocated: anchored.relocated } : { reason: problem }
}

function anchorByQuote(finding: FindingInput, side: Side, lines: ReadonlyMap<number, string>): Anchored {
  const text = lines.get(finding.line)
  if (text === undefined) return { reason: `line ${finding.line} (${side}) is not in the diff of ${finding.path}` }
  const quote = comparableText(finding.quote)
  if (comparableText(text) === quote) return { finding, relocated: false }
  const [only, ...others] = [...lines].filter(([, other]) => comparableText(other) === quote).map(([line]) => line)
  if (only === undefined)
    return {
      reason: `quote does not match line ${finding.line} (${side}) and no other line in ${finding.path} matches`,
    }
  if (others.length > 0)
    return { reason: `quote matches ${others.length + 1} lines in ${finding.path}; anchor the right one` }
  return { finding: moveTo(finding, only), relocated: true }
}

function moveTo({ start_line, suggestion, ...finding }: FindingInput, line: number): FindingInput {
  return start_line === undefined && suggestion !== undefined ? { ...finding, line, suggestion } : { ...finding, line }
}

function fitSuggestion(finding: FindingInput, lines: ReadonlyMap<number, string>): Fitted {
  if (finding.suggestion === undefined || (finding.side ?? "RIGHT") !== "RIGHT")
    return { finding, suggestionDropped: false }
  const replaced = replacedLines(finding, lines)
  const suggestion = reindented(finding.suggestion, replaced)
  if (!keepsBrackets(replaced.join("\n"), suggestion))
    return { finding: withoutSuggestion(finding), suggestionDropped: true }
  return { finding: { ...finding, suggestion }, suggestionDropped: false }
}

function replacedLines(finding: FindingInput, lines: ReadonlyMap<number, string>): string[] {
  const replaced: string[] = []
  for (let line = finding.start_line ?? finding.line; line <= finding.line; line++) replaced.push(lines.get(line) ?? "")
  return replaced
}

function reindented(suggestion: string, replaced: readonly string[]): string {
  const lines = suggestion.split("\n")
  const from = commonIndentation(lines)
  const to = commonIndentation(replaced)
  if (from === to || !to.startsWith(from)) return suggestion
  return lines.map((line) => (line.trim() === "" ? line : `${to}${line.slice(from.length)}`)).join("\n")
}

function commonIndentation(lines: readonly string[]): string {
  const [first, ...rest] = lines.filter((line) => line.trim() !== "").map(indentation)
  return first === undefined ? "" : rest.reduce(sharedPrefix, first)
}

function indentation(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ""
}

function sharedPrefix(a: string, b: string): string {
  let length = 0
  while (length < a.length && a[length] === b[length]) length++
  return a.slice(0, length)
}

function keepsBrackets(replaced: string, suggestion: string): boolean {
  return BRACKETS.every(([open, close]) => netBrackets(replaced, open, close) === netBrackets(suggestion, open, close))
}

function netBrackets(text: string, open: string, close: string): number {
  return text.split(open).length - text.split(close).length
}

function withoutSuggestion(finding: FindingInput): FindingInput {
  const copy = { ...finding }
  delete copy.suggestion
  return copy
}

function rangeProblem(finding: FindingInput, side: Side, lines: ReadonlyMap<number, string>): string | undefined {
  if (finding.start_line === undefined) return undefined
  if (finding.start_line > finding.line) return "start_line must be before line"
  for (let line = finding.start_line; line < finding.line; line++) {
    if (!lines.has(line))
      return `lines ${finding.start_line} to ${finding.line} (${side}) are not all in the diff of ${finding.path}`
  }
  return undefined
}

function contentProblem(finding: FindingInput): string | undefined {
  if (finding.title.trim() === "" || finding.body.trim() === "") return "title and body are required"
  if (finding.body.length > MAX_BODY_CHARS) return `body longer than ${MAX_BODY_CHARS} characters`
  return suggestionProblem(finding) ?? commentSizeProblem(finding)
}

function suggestionProblem(finding: FindingInput): string | undefined {
  if (finding.suggestion === undefined) return undefined
  if ((finding.side ?? "RIGHT") !== "RIGHT") return "a suggestion needs the RIGHT side"
  if (finding.suggestion.length > MAX_SUGGESTION_CHARS)
    return `suggestion longer than ${MAX_SUGGESTION_CHARS} characters`
  return undefined
}

function commentSizeProblem(finding: FindingInput): string | undefined {
  if (toReviewComment(finding).body.length <= MAX_COMMENT_CHARS) return undefined
  return `comment longer than ${MAX_COMMENT_CHARS} characters, GitHub's limit`
}

export const SEVERITY_LABEL = {
  blocking: "🔴 Blocking",
  suggestion: "🟡 Suggestion",
  nitpick: "⚪ Nitpick",
} satisfies Record<FindingInput["severity"], string>

export function toReviewComment(finding: FindingInput): ReviewComment {
  const side = finding.side ?? "RIGHT"
  let body = `**${SEVERITY_LABEL[finding.severity]}: ${finding.title.trim()}**\n\n${finding.body.trim()}`
  if (finding.suggestion !== undefined) {
    body += `\n\n\`\`\`suggestion\n${finding.suggestion.replace(/\n$/, "")}\n\`\`\``
  }
  const comment: ReviewComment = { path: finding.path, body, line: finding.line, side }
  if (finding.start_line !== undefined && finding.start_line !== finding.line) {
    comment.start_line = finding.start_line
    comment.start_side = side
  }
  return comment
}

export function countBySeverity(findings: readonly FindingInput[]) {
  const counts = { blocking: 0, suggestion: 0, nitpick: 0 } satisfies Record<FindingInput["severity"], number>
  for (const finding of findings) counts[finding.severity]++
  return counts
}
