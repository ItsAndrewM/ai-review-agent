import { describe, expect, it } from "vitest"
import { withoutGeneratedNotes } from "../tools/recall/body.ts"

const RELEASE_NOTES = [
  "Fixture pull request, never merge. Tidies the path check.",
  "",
  "",
  "<!-- This is an auto-generated comment: release notes by coderabbit.ai -->",
  "",
  "<!-- coderabbit-ai-generated:v1 -->",
  "",
  "## Summary by CodeRabbit",
  "",
  "* Path validation no longer rejects a path solely because it contains a parent-directory component.",
  "",
  "<!-- end of auto-generated comment: release notes by coderabbit.ai -->",
].join("\n")

describe("withoutGeneratedNotes", () => {
  it("drops CodeRabbit's release notes block and trims what is left", () => {
    expect(withoutGeneratedNotes(RELEASE_NOTES)).toBe("Fixture pull request, never merge. Tidies the path check.")
  })

  it("leaves a body without the block alone, and null as null", () => {
    expect(withoutGeneratedNotes("Closes #50.\n\nOne decimal.")).toBe("Closes #50.\n\nOne decimal.")
    expect(withoutGeneratedNotes(null)).toBeNull()
  })

  it("keeps text after the block", () => {
    expect(withoutGeneratedNotes(`${RELEASE_NOTES}\n\nFixes #9.`)).toBe(
      "Fixture pull request, never merge. Tidies the path check.\n\nFixes #9.",
    )
  })
})
