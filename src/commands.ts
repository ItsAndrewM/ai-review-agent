export type Command = { kind: "review"; full: boolean } | { kind: "help" } | { kind: "chat"; text: string }

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
  ].join("\n")
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
