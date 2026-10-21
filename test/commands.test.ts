import { describe, expect, it } from "vitest"
import { helpText, parseCommand } from "../src/commands.ts"

describe("helpText", () => {
  it("says a full review starts over", () => {
    expect(helpText("andabot")).toContain(
      "`@andabot full review`: start over: review the whole pull request again, ignoring earlier reviews.",
    )
  })

  it("says a reply under an inline comment is answered in that thread", () => {
    expect(helpText("andabot")).toContain(
      "Reply under one of my inline comments to ask about it, and I'll answer in that thread.",
    )
  })
})

describe("parseCommand", () => {
  it("finds the mention anywhere and reads the command after it, in any case", () => {
    expect(parseCommand("@andabot review", "andabot")).toEqual({ kind: "review", full: false })
    expect(parseCommand("Please @AndaBot Full Review", "andabot")).toEqual({ kind: "review", full: true })
    expect(parseCommand("@andabot", "andabot")).toEqual({ kind: "review", full: false })
    expect(parseCommand("@andabot help", "andabot")).toEqual({ kind: "help" })
    expect(parseCommand("@andabot why is this blocking?", "andabot")).toEqual({
      kind: "chat",
      text: "why is this blocking?",
    })
  })

  it("ignores comments without the mention, and other logins that share a prefix", () => {
    expect(parseCommand("looks good", "andabot")).toBeUndefined()
    expect(parseCommand("@andabot-review help", "andabot")).toBeUndefined()
    expect(parseCommand("mail@andabot.dev", "andabot")).toBeUndefined()
  })
})
