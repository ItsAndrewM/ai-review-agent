import type { ReviewThread } from "../github/client.ts"
import { configFileOf } from "../names.ts"
import { shortSha } from "../sha.ts"
import type { ApprovalOutcome, LastReview, WaitReason } from "./approval.ts"
import { openBotThreads, type OpenThread } from "./incremental.ts"
import { opensWithBot } from "./thread-question.ts"

export type ResolveScope =
  | { where: "conversation"; threads: readonly ReviewThread[] }
  | { where: "thread"; thread: ReviewThread | undefined }

export type ResolveTargets =
  | { kind: "resolve"; threads: OpenThread[] }
  | { kind: "not_mine" }
  | { kind: "resolved_already" }
  | { kind: "unknown" }

export type ResolveRefusal = Exclude<ResolveTargets["kind"], "resolve"> | "unreadable"

type PlainWait = Exclude<WaitReason, "workflow_off" | "paused" | "review_stands" | "workflow_unknown">

const REFUSALS = {
  not_mine: "I only resolve my own threads, and this one isn't mine.",
  resolved_already: "Already resolved.",
  unknown: "I couldn't find this thread.",
  unreadable: "I couldn't read the threads, so I resolved none.",
} satisfies Record<ResolveRefusal, string>

const PLAIN_WAITS = {
  not_open: "Approval waits: the pull request is closed or a draft.",
  review_in_flight: "Approval waits for the review that's running.",
  not_reviewed: "Approval waits for my review of the current head.",
  no_record: "Approval waits for my next review.",
  approved: "I approved this pull request already.",
  threads_unknown: "Approval waits: I couldn't read the threads.",
  blocking_threads: "Approval waits: one of my blocking threads is still open.",
  checks_unknown: "Approval waits: I couldn't read the checks.",
  checks_failing: "Approval waits: a check is failing.",
  checks_pending: "Approval waits for the checks to finish.",
  head_moved: "Approval waits: the head moved, so my review of the new head decides.",
  approving: "An approval of this head is already on its way.",
} satisfies Record<PlainWait, string>

export function resolveTargets(scope: ResolveScope, botLogin: string): ResolveTargets {
  if (scope.where === "conversation") {
    return { kind: "resolve", threads: openBotThreads(scope.threads, new Map(), botLogin) }
  }
  return targetsInThread(scope.thread, botLogin)
}

function targetsInThread(thread: ReviewThread | undefined, botLogin: string): ResolveTargets {
  if (thread === undefined) return { kind: "unknown" }
  if (!opensWithBot(thread, botLogin)) return { kind: "not_mine" }
  if (thread.resolved) return { kind: "resolved_already" }
  return { kind: "resolve", threads: openBotThreads([thread], new Map(), botLogin) }
}

export function resolveRefusal(kind: ResolveRefusal): string {
  return REFUSALS[kind]
}

type Standing = Pick<LastReview, "heldBack" | "withheld"> | undefined

export function approvalNote(outcome: ApprovalOutcome, last: Standing, botLogin: string): string | undefined {
  if (outcome.kind === "approved") return `Approved \`${shortSha(outcome.head)}\`.`
  if (outcome.kind === "failed") return "I couldn't check approval this time."
  return waitNote(outcome.reason, last, botLogin)
}

function waitNote(reason: WaitReason, last: Standing, botLogin: string): string | undefined {
  if (reason === "workflow_off") return undefined
  if (reason === "paused") return `Approval waits until \`@${botLogin} resume\`.`
  if (reason === "workflow_unknown") return `Approval waits: I couldn't read \`${configFileOf(botLogin)}\`.`
  if (reason === "review_stands") return reviewStandsNote(last)
  return PLAIN_WAITS[reason]
}

function reviewStandsNote(last: Standing): string {
  const heldBack = last?.heldBack ?? 0
  if (heldBack > 0) return heldBackNote(heldBack)
  if ((last?.withheld ?? 0) > 0)
    return "Approval waits for my next review, since my last one withheld it; its body says why."
  return "Approval waits for my next review, since my last one only commented."
}

function heldBackNote(heldBack: number): string {
  const findings = heldBack === 1 ? "1 blocking finding that isn't" : `${heldBack} blocking findings that aren't`
  return `Approval still waits: my last review holds back ${findings} in a thread; push a fix or ask for a \`full review\`.`
}

export function resolveReply(input: { resolved: number; failed: number; note: string | undefined }): string {
  const { resolved, failed, note } = input
  const nothingOpen = resolved + failed === 0
  const sentences = [nothingOpen ? "None of my threads is open." : `Resolved ${resolved} of my threads.`]
  if (failed > 0) sentences.push(`${failed} couldn't be resolved.`)
  if (note !== undefined) sentences.push(note)
  return sentences.join(" ")
}
