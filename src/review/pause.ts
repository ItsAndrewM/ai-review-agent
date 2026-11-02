import { Type } from "typebox"
import { configFileOf, pausedMarkerOf } from "../names.ts"
import type { SkipReason } from "../repository/config.ts"
import { shortSha } from "../sha.ts"
import { withMarkedLine, withoutMarkedLine, type MarkedLine } from "./summary-lines.ts"

export const PausedBy = Type.String()

const PAUSED_OPENING = "⏸️ Paused"

export function pausesReview(review: { requestedBy?: string }, paused: boolean): boolean {
  return paused && review.requestedBy === undefined
}

export function pausedLine(by: string | undefined, botLogin: string): string {
  const who = by === undefined ? "" : ` by @${by}`
  return `${PAUSED_OPENING}${who}: pushes don't start reviews. \`@${botLogin} resume\` to resume. ${pausedMarkerOf(botLogin)}`
}

export function withPausedLine(body: string, line: string, botLogin: string): string {
  return withMarkedLine(body, line, pausedKind(botLogin), botLogin)
}

export function withoutPausedLine(body: string, botLogin: string): string {
  return withoutMarkedLine(body, pausedKind(botLogin))
}

function pausedKind(botLogin: string): MarkedLine {
  return { opening: PAUSED_OPENING, marker: pausedMarkerOf(botLogin) }
}

export function pauseReply(alreadyPaused: boolean, botLogin: string): string {
  if (alreadyPaused) return "Already paused."
  return `Paused: pushes won't start reviews until \`@${botLogin} resume\`.`
}

export function headReviewed(headSha: string, reviewedHead: string | undefined, posted: boolean): boolean {
  return posted || reviewedHead === headSha
}

export type ResumeStep = "closed" | "running" | "evaluate" | SkipReason | "review"

export function resumeStep(input: {
  open: boolean
  reviewRunning: boolean
  reviewed: boolean
  settingsSkip: SkipReason | undefined
}): ResumeStep {
  if (!input.open) return "closed"
  if (input.reviewRunning) return "running"
  if (input.reviewed) return "evaluate"
  return input.settingsSkip ?? "review"
}

export const NOT_PAUSED_REPLY = "Not paused."

export function resumeReply(step: ResumeStep, headSha: string, botLogin: string, autoReview: boolean): string {
  const head = `\`${shortSha(headSha)}\``
  switch (step) {
    case "review":
      return `Resumed: reviewing ${head}.`
    case "evaluate":
      return `Resumed: ${head} is reviewed already.`
    case "running":
      return `Resumed: a review of ${head} is already running.`
    case "closed":
      return "Resumed. The pull request is closed, so there's nothing to review."
    default:
      return skippedResumeReply(step, botLogin, autoReview)
  }
}

function skippedResumeReply(reason: SkipReason, botLogin: string, autoReview: boolean): string {
  const onRequest = `so pushes aren't reviewed; \`@${botLogin} review\` reviews on request.`
  switch (reason) {
    case "draft":
      return "Resumed. It's a draft, so I'll review it once it's ready for review."
    case "auto":
      return autoReview
        ? `Resumed. \`${configFileOf(botLogin)}\` turns automatic reviews off, ${onRequest}`
        : `Resumed. Automatic reviews are off for this deploy, ${onRequest}`
    case "base_branch":
      return `Resumed. \`${configFileOf(botLogin)}\`'s \`base_branches\` leave out this pull request's base, ${onRequest}`
    case "title_keyword":
      return `Resumed. This pull request's title holds one of \`${configFileOf(botLogin)}\`'s \`ignore_title_keywords\`, ${onRequest}`
  }
}

export function evaluatesAfterCatchUp(state: {
  headSha: string
  reviewedHead: string | undefined
  posted: boolean
  inFlight: boolean
}): boolean {
  return !state.inFlight && !state.posted && state.reviewedHead === state.headSha
}
