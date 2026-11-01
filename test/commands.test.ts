import { describe, expect, it } from "vitest"
import { helpText, parseCommand, skippedReviewText } from "../src/commands.ts"

describe("skippedReviewText", () => {
  it("names the head already reviewed and how to review it again", () => {
    const text = skippedReviewText("already_reviewed", "abc1234def5678", "andabot")
    expect(text).toContain("`abc1234`")
    expect(text).toContain("`@andabot full review`")
  })

  it("says a closed pull request has nothing to review", () => {
    expect(skippedReviewText("not_open", "abc1234def5678", "andabot")).toMatch(/closed/)
  })

  it("says nothing when a review is already running or the head moved, since that review posts, or when paused, since a pause only skips reviews nobody asked for", () => {
    expect(skippedReviewText("in_progress", "abc1234def5678", "andabot")).toBeUndefined()
    expect(skippedReviewText("superseded", "abc1234def5678", "andabot")).toBeUndefined()
    expect(skippedReviewText("paused", "abc1234def5678", "andabot")).toBeUndefined()
  })

  it("says the path filters leave out every changed file, the one setting that can skip a command", () => {
    expect(skippedReviewText("path_filters", "abc1234def5678", "andabot-staging")).toContain(
      "`.andabot-staging.yaml`'s",
    )
    expect(skippedReviewText("path_filters", "abc1234def5678", "andabot")).toBe(
      "Nothing to review: `.andabot.yaml`'s `path_filters` leave out every file this pull request changes.",
    )
  })

  it("has nothing to say for the settings a command bypasses, which skip only a push", () => {
    for (const reason of ["auto", "draft", "base_branch", "title_keyword"] as const) {
      expect(skippedReviewText(reason, "abc1234def5678", "andabot")).toBeUndefined()
    }
  })
})

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

  it("lists all seven commands, one line each", () => {
    const lines = helpText("andabot").split("\n")
    expect(lines.filter((line) => line.startsWith("- `@andabot"))).toHaveLength(7)
    for (const line of [
      "- `@andabot summary`: rewrite the summary comment for the current head, without a review.",
      "- `@andabot resolve`: resolve all my open threads, or only this one when you reply in one of my threads, then check whether I can approve.",
      "- `@andabot pause`: stop reviewing pushes until `@andabot resume`. Commands keep working.",
      "- `@andabot resume`: review pushes again, starting with the current head if it has no review yet.",
    ]) {
      expect(lines).toContain(line)
    }
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

  it("reads each new command after the mention, in any case and spacing", () => {
    expect(parseCommand("@andabot summary", "andabot")).toEqual({ kind: "summary" })
    expect(parseCommand("@AndaBot RESOLVE", "andabot")).toEqual({ kind: "resolve" })
    expect(parseCommand("@andabot  pause  ", "andabot")).toEqual({ kind: "pause" })
    expect(parseCommand("@andabot resume", "andabot")).toEqual({ kind: "resume" })
  })

  it("keeps a command with words after it as a question", () => {
    expect(parseCommand("@andabot pause please", "andabot")).toEqual({ kind: "chat", text: "pause please" })
    expect(parseCommand("@andabot resolve all", "andabot")).toEqual({ kind: "chat", text: "resolve all" })
  })

  it("ignores comments without the mention, and other logins that share a prefix", () => {
    expect(parseCommand("looks good", "andabot")).toBeUndefined()
    expect(parseCommand("@andabot-review help", "andabot")).toBeUndefined()
    expect(parseCommand("mail@andabot.dev", "andabot")).toBeUndefined()
  })
})
