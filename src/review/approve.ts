import { configFileOf } from "../names.ts"
import { shortSha } from "../sha.ts"
import type { ApprovalOutcome, LastReview, WorkflowState } from "./approval.ts"

export type ApproveStep =
  | "thread"
  | "disabled"
  | "author"
  | "workflow_off"
  | "not_open"
  | "paused"
  | "review_running"
  | "not_reviewed"
  | "approved"
  | "override"

export interface ApproveFacts {
  inThread: boolean
  enabled: boolean
  allowAuthor: boolean
  commenter: string
  author: string
  workflow: WorkflowState
  open: boolean
  paused: boolean
  reviewRunning: boolean
  reviewedHead: string | undefined
  lastReview: LastReview | undefined
  head: string
}

export function approveStep(facts: ApproveFacts): ApproveStep {
  return askerStep(facts) ?? pullRequestStep(facts) ?? reviewStep(facts)
}

function askerStep(facts: ApproveFacts): ApproveStep | undefined {
  if (facts.inThread) return "thread"
  if (!facts.enabled) return "disabled"
  if (!facts.allowAuthor && sameLogin(facts.commenter, facts.author)) return "author"
  return undefined
}

function pullRequestStep(facts: ApproveFacts): ApproveStep | undefined {
  if (facts.workflow !== true) return "workflow_off"
  if (!facts.open) return "not_open"
  if (facts.paused) return "paused"
  if (facts.reviewRunning) return "review_running"
  return undefined
}

function reviewStep({ reviewedHead, lastReview, head }: ApproveFacts): ApproveStep {
  if (reviewedHead !== head || lastReview?.headSha !== head) return "not_reviewed"
  return lastReview.event === "APPROVE" ? "approved" : "override"
}

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function approveReply(step: Exclude<ApproveStep, "override">, head: string, botLogin: string): string {
  const sha = `\`${shortSha(head)}\``
  switch (step) {
    case "thread":
      return `Type \`@${botLogin} approve\` as a comment on the pull request, not in a thread.`
    case "disabled":
      return `\`${configFileOf(botLogin)}\` turns \`approve\` off for this repository.`
    case "author":
      return `You opened this pull request, so \`approve\` needs someone else; \`${configFileOf(botLogin)}\` can allow authors with \`reviews.approve.allow_author: true\`.`
    case "workflow_off":
      return "I never approve here: the request-changes workflow is off."
    case "not_open":
      return "This pull request is closed or a draft, so there's nothing to approve."
    case "paused":
      return `I'm paused here; \`@${botLogin} resume\` first.`
    case "review_running":
      return `My review of ${sha} is still running; type approve once it posts.`
    case "not_reviewed":
      return `I haven't reviewed ${sha} yet; type approve once my review posts.`
    case "approved":
      return `${sha} is approved already.`
  }
}

export function overrideReply(outcome: ApprovalOutcome, head: string, botLogin: string): string {
  const sha = `\`${shortSha(head)}\``
  if (outcome.kind === "approved") {
    return `Approved ${sha} on your request. My open threads stay open; \`@${botLogin} resolve\` closes them.`
  }
  if (outcome.kind === "failed") {
    return `I couldn't approve ${sha}: GitHub didn't answer. Try \`@${botLogin} approve\` again.`
  }
  if (outcome.reason === "checks_pending") return `I'll approve ${sha} once the other checks pass.`
  if (outcome.reason === "checks_failing") return `I'll approve ${sha} once the failing checks pass.`
  return `I couldn't approve ${sha} yet: ${outcome.reason}.`
}
