import { parseCommand, type Command } from "../commands.ts"
import type { ReviewThread } from "../github/client.ts"

export function threadOf(threads: readonly ReviewThread[], rootId: number): ReviewThread | undefined {
  return threads.find((thread) => thread.firstCommentId === rootId)
}

export function commandInThread(body: string, botLogin: string, thread: ReviewThread | undefined): Command | undefined {
  const command = parseCommand(body, botLogin)
  if (command) return command
  const text = body.trim()
  if (text === "" || !opensWithBot(thread, botLogin)) return undefined
  return { kind: "chat", text }
}

export function threadIgnoreReason(
  botLogin: string,
  thread: ReviewThread | undefined,
): "thread_unknown" | "not_andabot_thread" | "blank_reply" {
  if (thread === undefined) return "thread_unknown"
  if (!opensWithBot(thread, botLogin)) return "not_andabot_thread"
  return "blank_reply"
}

function opensWithBot(thread: ReviewThread | undefined, botLogin: string): boolean {
  return thread !== undefined && thread.authorIsBot && thread.authorLogin === botLogin
}
