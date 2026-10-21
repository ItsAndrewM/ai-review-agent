export type Command =
  | { kind: "review"; full: boolean }
  | { kind: "help" }
  | { kind: "summary" }
  | { kind: "resolve" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "chat"; text: string }

const COMMAND_BY_TEXT = new Map<string, Command>([
  ["", { kind: "review", full: false }],
  ["review", { kind: "review", full: false }],
  ["full review", { kind: "review", full: true }],
  ["help", { kind: "help" }],
  ["summary", { kind: "summary" }],
  ["resolve", { kind: "resolve" }],
  ["pause", { kind: "pause" }],
  ["resume", { kind: "resume" }],
])

export function parseCommand(body: string, botLogin: string): Command | undefined {
  const mention = new RegExp(`(?:^|\\s)@${escapeRegExp(botLogin)}(?![\\w-])\\s*([\\s\\S]*)`, "i")
  const match = mention.exec(body)
  if (!match) return undefined
  const text = (match[1] ?? "").trim()
  return COMMAND_BY_TEXT.get(text.toLowerCase()) ?? { kind: "chat", text }
}

export function helpText(botLogin: string): string {
  return [
    `**@${botLogin} commands**`,
    "",
    `- \`@${botLogin} review\`: review what changed since the last review, or the whole pull request if there was none.`,
    `- \`@${botLogin} full review\`: start over: review the whole pull request again, ignoring earlier reviews.`,
    `- \`@${botLogin} summary\`: rewrite the summary comment for the current head, without a review.`,
    `- \`@${botLogin} resolve\`: resolve all my open threads, or only this one when you reply in one of my threads, then check whether I can approve.`,
    `- \`@${botLogin} pause\`: stop reviewing pushes until \`@${botLogin} resume\`. Commands keep working.`,
    `- \`@${botLogin} resume\`: review pushes again, starting with the current head if it has no review yet.`,
    `- \`@${botLogin} help\`: this message.`,
    "",
    `Anything else after \`@${botLogin}\` is a question for the reviewer about this pull request.`,
    "Reply under one of my inline comments to ask about it, and I'll answer in that thread.",
  ].join("\n")
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
