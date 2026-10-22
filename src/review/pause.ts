import { Type } from "typebox"
import { shortSha } from "../sha.ts"
import { SUMMARY_MARKER } from "./render.ts"

export const PausedBy = Type.String()

export const PAUSED_MARKER = "<!-- andabot:paused -->"

const PAUSED_OPENING = "⏸️ Paused"

export function pausesReview(review: { requestedBy?: string }, paused: boolean): boolean {
  return paused && review.requestedBy === undefined
}

export function pausedLine(by: string | undefined, botLogin: string): string {
  const who = by === undefined ? "" : ` by @${by}`
  return `${PAUSED_OPENING}${who}: pushes don't start reviews. \`@${botLogin} resume\` to resume. ${PAUSED_MARKER}`
}

export function withPausedLine(body: string, line: string): string {
  if (!body.startsWith(SUMMARY_MARKER)) return body
  const lines = withoutPausedLine(body).split("\n")
  const headerAt = lines.findIndex((text) => text.startsWith("## "))
  const insertAt = Math.max(headerAt, 0) + 1
  return [...lines.slice(0, insertAt), "", line, ...lines.slice(insertAt)].join("\n")
}

export function withoutPausedLine(body: string): string {
  const kept: string[] = []
  for (const text of body.split("\n")) {
    if (!isPausedLine(text)) kept.push(text)
    else if (kept.at(-1) === "") kept.pop()
  }
  return kept.join("\n")
}

function isPausedLine(text: string): boolean {
  return text.startsWith(PAUSED_OPENING) && text.trimEnd().endsWith(PAUSED_MARKER)
}

export function pauseReply(alreadyPaused: boolean, botLogin: string): string {
  if (alreadyPaused) return "Already paused."
  return `Paused: pushes won't start reviews until \`@${botLogin} resume\`.`
}

export function headReviewed(headSha: string, reviewedHead: string | undefined, posted: boolean): boolean {
  return posted || reviewedHead === headSha
}

export type ResumeStep = "closed" | "draft" | "running" | "evaluate" | "review"

export function resumeStep(input: {
  open: boolean
  draft: boolean
  reviewRunning: boolean
  reviewed: boolean
}): ResumeStep {
  if (!input.open) return "closed"
  if (input.draft) return "draft"
  if (input.reviewRunning) return "running"
  if (input.reviewed) return "evaluate"
  return "review"
}

export const NOT_PAUSED_REPLY = "Not paused."

export function resumeReply(step: ResumeStep, headSha: string): string {
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
    case "draft":
      return "Resumed. It's a draft, so I'll review it once it's ready for review."
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
