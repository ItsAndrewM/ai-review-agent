import type { Issue } from "../github/client.ts"
import { errorText } from "../log.ts"

export const MOST_LINKED_ISSUES = 3
export const MAX_ISSUE_BODY_CHARS = 4_000

export interface LinkedIssue {
  number: number
  title: string
  body: string
  cut: boolean
}

export interface IssueRead {
  number: number
  issue: Issue | undefined
}

type ReadIssue = (number: number) => Promise<Issue | undefined>
type ReportUnreadable = (number: number, error: string) => void

const CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi
const BARE_REFERENCE = /(?<!\w)#(\d+)\b/g
const BRANCH_ISSUE_KEY = /\bGH-(\d+)/g
const BRANCH_TRAILING_KEY = /\.(\d+)$/g

export function linkedIssueNumbers(body: string | null, branch: string): number[] {
  const text = body ?? ""
  const keyed = [
    ...numbersIn(text, CLOSING_REFERENCE),
    ...numbersIn(branch, BRANCH_ISSUE_KEY),
    ...numbersIn(branch, BRANCH_TRAILING_KEY),
  ]
  const candidates = keyed.length > 0 ? keyed : numbersIn(text, BARE_REFERENCE)
  return [...new Set(candidates)].slice(0, MOST_LINKED_ISSUES)
}

function numbersIn(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((match) => Number(match[1]))
}

export function readLinkedIssues(
  numbers: readonly number[],
  read: ReadIssue,
  unreadable: ReportUnreadable,
): Promise<IssueRead[]> {
  return Promise.all(numbers.map(async (number) => ({ number, issue: await readOrMissing(number, read, unreadable) })))
}

async function readOrMissing(
  number: number,
  read: ReadIssue,
  unreadable: ReportUnreadable,
): Promise<Issue | undefined> {
  try {
    return await read(number)
  } catch (cause) {
    unreadable(number, errorText(cause))
    return undefined
  }
}

export function linkedIssuesFrom(reads: readonly IssueRead[]): LinkedIssue[] {
  return reads.flatMap(({ number, issue }) =>
    issue === undefined || issue.pull_request !== undefined ? [] : [linked(number, issue)],
  )
}

function linked(number: number, { title, body }: Issue): LinkedIssue {
  const text = body ?? ""
  return { number, title, body: text.slice(0, MAX_ISSUE_BODY_CHARS), cut: text.length > MAX_ISSUE_BODY_CHARS }
}

export function issueText({ number, issue }: IssueRead): string {
  if (issue === undefined) return `Issue #${number} does not exist.`
  if (issue.pull_request !== undefined) return `#${number} is a pull request, not an issue.`
  return `#${number}: ${issue.title} (${issue.state})\n\n${issue.body ?? ""}`
}
