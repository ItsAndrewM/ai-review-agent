import { Type } from "typebox"
import { pausedMarkerOf, summaryMarkerOf } from "../names.ts"
import { CONFIG_FILE, type SkipReason } from "../repository/config.ts"
import { shortSha } from "../sha.ts"

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
  if (!body.startsWith(summaryMarkerOf(botLogin))) return body
  const lines = withoutPausedLine(body, botLogin).split("\n")
  const headerAt = lines.findIndex((text) => text.startsWith("## "))
  const insertAt = Math.max(headerAt, 0) + 1
  return [...lines.slice(0, insertAt), "", line, ...lines.slice(insertAt)].join("\n")
}

export function withoutPausedLine(body: string, botLogin: string): string {
  const marker = pausedMarkerOf(botLogin)
  const kept: string[] = []
  for (const text of body.split("\n")) {
    if (!isPausedLine(text, marker)) kept.push(text)
    else if (kept.at(-1) === "") kept.pop()
  }
  return kept.join("\n")
}

function isPausedLine(text: string, marker: string): boolean {
  return text.startsWith(PAUSED_OPENING) && text.trimEnd().endsWith(marker)
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

export function resumeReply(step: ResumeStep, headSha: string, botLogin: string): string {
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
      return skippedResumeReply(step, botLogin)
  }
}

function skippedResumeReply(reason: SkipReason, botLogin: string): string {
  const onRequest = `so pushes aren't reviewed; \`@${botLogin} review\` reviews on request.`
  switch (reason) {
    case "draft":
      return "Resumed. It's a draft, so I'll review it once it's ready for review."
    case "auto":
      return `Resumed. \`${CONFIG_FILE}\` turns automatic reviews off, ${onRequest}`
    case "base_branch":
      return `Resumed. \`${CONFIG_FILE}\`'s \`base_branches\` leave out this pull request's base, ${onRequest}`
    case "title_keyword":
      return `Resumed. This pull request's title holds one of \`${CONFIG_FILE}\`'s \`ignore_title_keywords\`, ${onRequest}`
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
