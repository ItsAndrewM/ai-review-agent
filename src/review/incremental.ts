import { Type, type Static } from "typebox"
import type { CompareStatus, ReviewThread } from "../github/client.ts"
import {
  commentableLines,
  comparableText,
  deltaLines,
  markedLines,
  type ChangedFile,
  type MarkedLines,
} from "../github/diff.ts"
import {
  SEVERITY_LABEL,
  Severity,
  Walkthrough,
  type FindingInput,
  type Rejected,
  type ValidatedReview,
} from "./findings.ts"

export type ReviewMode = "fresh" | "full" | "incremental"

export const MOST_LISTED_THREADS = 30

const Mode = Type.Union([Type.Literal("fresh"), Type.Literal("full"), Type.Literal("incremental")])

export const SinceSection = Type.Object({
  from: Type.String(),
  to: Type.String(),
  summary: Type.String(),
  files: Type.Array(Type.String()),
  resolved: Type.Integer(),
})

export type SinceSection = Static<typeof SinceSection>

export const ReviewedRecord = Type.Object({
  headSha: Type.String(),
  baseRef: Type.String(),
  at: Type.Integer(),
  mode: Mode,
  summary: Type.String(),
  walkthrough: Type.Array(Walkthrough),
  since: Type.Optional(SinceSection),
})

export type ReviewedRecord = Static<typeof ReviewedRecord>

export const StoredFinding = Type.Object({
  severity: Severity,
  title: Type.String(),
  quote: Type.String(),
  path: Type.String(),
})

export type StoredFinding = Static<typeof StoredFinding>

export const OpenThread = Type.Object({
  handle: Type.String(),
  threadId: Type.String(),
  firstCommentId: Type.Integer(),
  path: Type.String(),
  line: Type.Union([Type.Integer(), Type.Null()]),
  side: Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]),
  outdated: Type.Boolean(),
  title: Type.String(),
  quote: Type.Optional(Type.String()),
  blocking: Type.Boolean(),
})

export type OpenThread = Static<typeof OpenThread>

export interface ListedThreads {
  open: OpenThread[]
  leftOut: number
}

export interface DeltaScope {
  mode: ReviewMode
  covered: ReadonlyMap<string, MarkedLines>
  open: readonly OpenThread[]
}

export interface ScopedReview {
  accepted: FindingInput[]
  rejected: Rejected[]
  duplicates: Rejected[]
}

export interface AddressedThreads {
  resolve: OpenThread[]
  unknown: string[]
}

const COMMENT_LABEL = /^\*\*(.+?): (.+?)\*\*/

export function chooseMode(input: {
  full: boolean
  reviewed: ReviewedRecord | undefined
  baseRef: string
  compareStatus: CompareStatus | undefined
}): ReviewMode {
  if (input.full) return "fresh"
  if (input.reviewed === undefined || input.reviewed.baseRef !== input.baseRef) return "full"
  return input.compareStatus === "ahead" ? "incremental" : "full"
}

export function coveredFiles(prFiles: readonly ChangedFile[], delta: readonly ChangedFile[]): Map<string, MarkedLines> {
  const deltaByPath = new Map(delta.map((file) => [file.filename, file]))
  const covered = new Map<string, MarkedLines>()
  for (const file of prFiles) {
    const since = deltaByPath.get(file.filename)
    if (!since) continue
    const marked = markedLines(commentableLines(file.patch), deltaLines(since.patch))
    if (marked.right.size + marked.left.size > 0) covered.set(file.filename, marked)
  }
  return covered
}

export function openBotThreads(
  threads: readonly ReviewThread[],
  findings: ReadonlyMap<number, StoredFinding>,
  botLogin: string,
): ListedThreads {
  const mine = threads.filter((thread) => !thread.resolved && thread.authorIsBot && thread.authorLogin === botLogin)
  const listed = mine.slice(0, MOST_LISTED_THREADS)
  return {
    open: listed.map((thread, i) => openThread(thread, `T${i + 1}`, findings.get(thread.firstCommentId))),
    leftOut: mine.length - listed.length,
  }
}

function openThread(thread: ReviewThread, handle: string, stored: StoredFinding | undefined): OpenThread {
  const severity = stored?.severity ?? severityOfComment(thread.firstCommentBody)
  const listed = {
    handle,
    threadId: thread.id,
    firstCommentId: thread.firstCommentId,
    path: thread.path,
    line: thread.line,
    side: thread.side,
    outdated: thread.outdated,
    title: stored?.title ?? titleOfComment(thread.firstCommentBody),
    blocking: severity === "blocking",
  }
  return stored === undefined ? listed : { ...listed, quote: stored.quote }
}

function severityOfComment(body: string): FindingInput["severity"] {
  const label = COMMENT_LABEL.exec(body)?.[1]
  if (label === SEVERITY_LABEL.blocking) return "blocking"
  if (label === SEVERITY_LABEL.nitpick) return "nitpick"
  return "suggestion"
}

function titleOfComment(body: string): string {
  const title = COMMENT_LABEL.exec(body)?.[2] ?? body.split("\n")[0] ?? ""
  return title.trim().slice(0, 100)
}

export function threadsToRecheck(
  open: readonly OpenThread[],
  mode: ReviewMode,
  covered: ReadonlyMap<string, MarkedLines>,
): OpenThread[] {
  if (mode === "fresh") return []
  if (mode === "full") return open.filter((thread) => thread.outdated)
  return open.filter((thread) => thread.outdated || onMarkedLine(thread, covered))
}

function onMarkedLine(thread: OpenThread, covered: ReadonlyMap<string, MarkedLines>): boolean {
  const marked = covered.get(thread.path)
  if (!marked || thread.line === null) return false
  return (thread.side === "RIGHT" ? marked.right : marked.left).has(thread.line)
}

export function applyDeltaPolicy(validated: ValidatedReview, scope: DeltaScope): ScopedReview {
  if (scope.mode === "fresh") return { accepted: validated.accepted, rejected: validated.rejected, duplicates: [] }
  const accepted: FindingInput[] = []
  const rejected: Rejected[] = [...validated.rejected]
  const duplicates: Rejected[] = []
  for (const finding of validated.accepted) {
    const duplicate = duplicatedThread(finding, scope.open)
    if (duplicate) duplicates.push({ finding, reason: `duplicates open thread ${duplicate.handle}` })
    else if (scope.mode === "incremental" && outsideTheDelta(finding, scope.covered)) {
      rejected.push({
        finding,
        reason: `line ${finding.line} was not changed since the last review; only a blocking finding may go elsewhere`,
      })
    } else accepted.push(finding)
  }
  return { accepted, rejected, duplicates }
}

function duplicatedThread(finding: FindingInput, open: readonly OpenThread[]): OpenThread | undefined {
  const side = finding.side ?? "RIGHT"
  const quote = comparableText(finding.quote)
  return open.find(
    (thread) =>
      thread.path === finding.path &&
      ((thread.side === side && thread.line === finding.line) ||
        (thread.quote !== undefined && comparableText(thread.quote) === quote)),
  )
}

function outsideTheDelta(finding: FindingInput, covered: ReadonlyMap<string, MarkedLines>): boolean {
  if (finding.severity === "blocking") return false
  const marked = covered.get(finding.path)
  if (!marked) return true
  return !((finding.side ?? "RIGHT") === "RIGHT" ? marked.right : marked.left).has(finding.line)
}

export function addressedThreads(
  handles: readonly string[] | undefined,
  recheck: readonly OpenThread[],
): AddressedThreads {
  const byHandle = new Map(recheck.map((thread) => [thread.handle, thread]))
  const resolve: OpenThread[] = []
  const unknown: string[] = []
  for (const handle of new Set(handles ?? [])) {
    const thread = byHandle.get(handle)
    if (thread) resolve.push(thread)
    else unknown.push(handle)
  }
  return { resolve, unknown }
}
