import type { Issue } from "../github/client.ts"

export const MOST_LINKED_ISSUES = 3
export const MAX_ISSUE_BODY_CHARS = 4_000

export interface LinkedIssue {
  number: number
  title: string
  body: string
}

const CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi
const BARE_REFERENCE = /(?<!\w)#(\d+)\b/g
const BRANCH_ISSUE_KEY = /\bGH-(\d+)/g
const BRANCH_TRAILING_REFERENCE = /#(\d+)$/g

export function linkedIssueNumbers(body: string | null, branch: string): number[] {
  const text = body ?? ""
  const candidates = [
    ...numbersIn(text, CLOSING_REFERENCE),
    ...numbersIn(text, BARE_REFERENCE),
    ...numbersIn(branch, BRANCH_ISSUE_KEY),
    ...numbersIn(branch, BRANCH_TRAILING_REFERENCE),
  ]
  return [...new Set(candidates)].slice(0, MOST_LINKED_ISSUES)
}

function numbersIn(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((match) => Number(match[1]))
}

export function linkedIssuesFrom(found: readonly (Issue | undefined)[]): LinkedIssue[] {
  return found.flatMap((issue) => (issue === undefined || issue.pull_request !== undefined ? [] : [linked(issue)]))
}

function linked({ number, title, body }: Issue): LinkedIssue {
  return { number, title, body: (body ?? "").slice(0, MAX_ISSUE_BODY_CHARS) }
}

export function issueText(number: number, issue: Issue | undefined): string {
  if (issue === undefined) return `Issue #${number} does not exist.`
  if (issue.pull_request !== undefined) return `#${number} is a pull request, not an issue.`
  return `#${issue.number}: ${issue.title} (${issue.state})\n\n${issue.body ?? ""}`
}
