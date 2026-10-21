import { shortSha } from "./sha.ts"

export type Command = { kind: "review"; full: boolean } | { kind: "help" } | { kind: "chat"; text: string }

export type ReviewSkip = "not_open" | "superseded" | "already_reviewed" | "in_progress"

export function parseCommand(body: string, botLogin: string): Command | undefined {
  const mention = new RegExp(`(?:^|\\s)@${escapeRegExp(botLogin)}(?![\\w-])\\s*([\\s\\S]*)`, "i")
  const match = mention.exec(body)
  if (!match) return undefined
  const text = (match[1] ?? "").trim()
  const lower = text.toLowerCase()
  if (lower === "" || lower === "review") return { kind: "review", full: false }
  if (lower === "full review") return { kind: "review", full: true }
  if (lower === "help") return { kind: "help" }
  return { kind: "chat", text }
}

export function helpText(botLogin: string): string {
  return [
    `**@${botLogin} commands**`,
    "",
    `- \`@${botLogin} review\`: review what changed since the last review, or the whole pull request if there was none.`,
    `- \`@${botLogin} full review\`: start over: review the whole pull request again, ignoring earlier reviews.`,
    `- \`@${botLogin} help\`: this message.`,
    "",
    `Anything else after \`@${botLogin}\` is a question for the reviewer about this pull request.`,
    "Reply under one of my inline comments to ask about it, and I'll answer in that thread.",
  ].join("\n")
}

export function skippedReviewText(reason: ReviewSkip, headSha: string, botLogin: string): string | undefined {
  if (reason === "already_reviewed") {
    return `Nothing new to review: I already reviewed \`${shortSha(headSha)}\`. \`@${botLogin} full review\` reviews it again from the start.`
  }
  if (reason === "not_open") return "This pull request is closed, so there's nothing to review."
  return undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
