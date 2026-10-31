import { describe, expect, it } from "vitest"
import { promptFor, reviewSkillFiles, systemFor } from "../tools/recall/prompt.ts"
import { headCase } from "./recall-fixtures.ts"

describe("systemFor", () => {
  it("puts the preamble before the tagged instructions, with the standards after the skill", () => {
    const system = systemFor(
      "andabot",
      ["read_file", "submit_review"],
      "<skill_content>review</skill_content>",
      "## Repository standards\n\nNo comments.",
    )
    expect(system.startsWith("You are andabot, a code reviewer for pull requests on GitHub.")).toBe(true)
    expect(system).toContain(
      "\n\n<instructions>\n<skill_content>review</skill_content>\n\n## Repository standards\n\nNo comments.\n</instructions>",
    )
    expect(system.indexOf("You are andabot")).toBeLessThan(system.indexOf("<instructions>"))
  })

  it("leaves an empty standards section out", () => {
    const system = systemFor("andabot", [], "skill", "")
    expect(system.endsWith("<instructions>\nskill\n</instructions>")).toBe(true)
  })
})

describe("promptFor", () => {
  it("renders the fresh review prompt for the frozen head", () => {
    const prompt = promptFor(
      headCase({ issues: [{ number: 50, title: "Elapsed time", body: "One decimal.", cut: false, state: "open" }] }),
      [{ filename: "src/example.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }],
    )
    expect(prompt.startsWith("Review this pull request in full and submit the review with submit_review.")).toBe(true)
    expect(prompt).toContain("# Pull request #9: Tidy the example")
    expect(prompt).toContain("### #50: Elapsed time\nOne decimal.")
    expect(prompt).toMatch(/R1\s+\+b/)
  })
})

describe("reviewSkillFiles", () => {
  it("reads the nine bundled skill files from disk in the bundle's order", async () => {
    const files = await reviewSkillFiles()
    expect(files.map(({ path }) => path)).toEqual([
      "answer/SKILL.md",
      "review/CREDITS.md",
      "review/SKILL.md",
      "review/references/merge-danger.md",
      "review/references/severity.md",
      "review/references/smells.md",
      "review/references/tests.md",
      "summary/SKILL.md",
      "verify/SKILL.md",
    ])
    expect(files.every(({ content }) => content.length > 0)).toBe(true)
  })
})
