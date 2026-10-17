import { Type } from "@earendil-works/pi-ai"
import type { Static } from "typebox"
import type { ReviewComment } from "../github/client.ts"
import type { CommentableLines } from "../github/diff.ts"

export const Severity = Type.Union([Type.Literal("blocking"), Type.Literal("suggestion"), Type.Literal("nitpick")])

export const Finding = Type.Object({
  path: Type.String({ description: "Path of the changed file, exactly as listed." }),
  line: Type.Integer({
    description:
      "Line the comment is anchored to. For side RIGHT, the line number in the new file; for LEFT, in the old file. Must be a line that appears in the diff.",
  }),
  start_line: Type.Optional(
    Type.Integer({ description: "First line of a multi-line range ending at `line`. Same side. Omit for one line." }),
  ),
  side: Type.Optional(
    Type.Union([Type.Literal("RIGHT"), Type.Literal("LEFT")], {
      description: "RIGHT (default) for added or unchanged lines, LEFT for deleted lines.",
    }),
  ),
  severity: Severity,
  title: Type.String({ description: "One line, under 80 characters." }),
  body: Type.String({ description: "Why it is a problem and what to do instead. Markdown." }),
  suggestion: Type.Optional(
    Type.String({
      description:
        "Replacement for the anchored line(s) on the RIGHT side, verbatim, no fences. Only when you are sure it compiles and is complete.",
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

export const MAX_FINDINGS = 25
export const MAX_BODY_CHARS = 4000

export interface Rejected {
  finding: FindingInput
  reason: string
}

export interface ValidatedReview {
  accepted: FindingInput[]
  rejected: Rejected[]
}

export function validateFindings(
  findings: readonly FindingInput[],
  commentable: ReadonlyMap<string, CommentableLines>,
): ValidatedReview {
  const accepted: FindingInput[] = []
  const rejected: Rejected[] = []
  const seen = new Set<string>()
  for (const finding of findings) {
    const reason = anchorProblem(finding, commentable) ?? contentProblem(finding)
    if (reason) {
      rejected.push({ finding, reason })
      continue
    }
    const key = `${finding.path}:${finding.side ?? "RIGHT"}:${finding.line}`
    if (seen.has(key)) {
      rejected.push({ finding, reason: "duplicate anchor: one comment per line, merge them" })
      continue
    }
    seen.add(key)
    if (accepted.length >= MAX_FINDINGS) {
      rejected.push({ finding, reason: `more than ${MAX_FINDINGS} findings; keep the most important` })
      continue
    }
    accepted.push(finding)
  }
  return { accepted, rejected }
}

function anchorProblem(finding: FindingInput, commentable: ReadonlyMap<string, CommentableLines>): string | undefined {
  const lines = commentable.get(finding.path)
  if (!lines) return `path "${finding.path}" is not a changed file`
  const side = finding.side ?? "RIGHT"
  const set = side === "RIGHT" ? lines.right : lines.left
  if (!set.has(finding.line)) return `line ${finding.line} (${side}) is not in the diff of ${finding.path}`
  if (finding.start_line === undefined) return undefined
  if (finding.start_line > finding.line) return "start_line must be before line"
  if (!set.has(finding.start_line)) return `start_line ${finding.start_line} (${side}) is not in the diff`
  return undefined
}

function contentProblem(finding: FindingInput): string | undefined {
  if (finding.suggestion !== undefined && (finding.side ?? "RIGHT") !== "RIGHT")
    return "a suggestion needs the RIGHT side"
  if (finding.title.trim() === "" || finding.body.trim() === "") return "title and body are required"
  if (finding.body.length > MAX_BODY_CHARS) return `body longer than ${MAX_BODY_CHARS} characters`
  return undefined
}

const SEVERITY_LABEL = {
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
