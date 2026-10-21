import { describe, expect, it } from "vitest"
import type { ReviewThread } from "../src/github/client.ts"
import { commandInThread, threadOf } from "../src/review/thread-question.ts"

const thread = (firstCommentId: number, authorLogin: string, authorIsBot: boolean) =>
  ({
    id: `T${firstCommentId}`,
    resolved: false,
    outdated: false,
    path: "src/a.ts",
    line: 12,
    side: "RIGHT",
    firstCommentId,
    firstCommentBody: "**🔴 Blocking: x**",
    authorLogin,
    authorIsBot,
  }) satisfies ReviewThread

const botThread = thread(7, "andabot", true)
const humanThread = thread(8, "andrew", false)
const otherBotThread = thread(9, "coderabbitai", true)

describe("commandInThread", () => {
  it("answers a reply in andabot's thread that doesn't mention it", () => {
    expect(commandInThread(" why is this a problem? ", "andabot", botThread)).toEqual({
      kind: "chat",
      text: "why is this a problem?",
    })
  })

  it("ignores a reply in someone else's thread that doesn't mention andabot", () => {
    expect(commandInThread("why is this a problem?", "andabot", humanThread)).toBeUndefined()
    expect(commandInThread("why is this a problem?", "andabot", otherBotThread)).toBeUndefined()
  })

  it("takes a mention as a command in any thread", () => {
    expect(commandInThread("@andabot full review", "andabot", humanThread)).toEqual({ kind: "review", full: true })
  })

  it("ignores an unmentioned reply when the thread couldn't be looked up", () => {
    expect(commandInThread("why is this a problem?", "andabot", undefined)).toBeUndefined()
  })

  it("ignores a blank reply in andabot's thread", () => {
    expect(commandInThread("  ", "andabot", botThread)).toBeUndefined()
  })
})

describe("threadOf", () => {
  it("finds a thread by its first comment", () => {
    expect(threadOf([humanThread, botThread], 7)).toBe(botThread)
    expect(threadOf([humanThread, botThread], 404)).toBeUndefined()
  })
})
