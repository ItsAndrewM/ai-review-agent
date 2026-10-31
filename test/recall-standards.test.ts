import { describe, expect, it } from "vitest"
import { standardsAt } from "../tools/recall/standards.ts"
import type { GitHistory, TreeEntryAt } from "../tools/replay/git.ts"

const BASE = "b".repeat(40)

const entry = (path: string): TreeEntryAt => ({ path, type: "blob", sha: "1".repeat(40), size: 10, mode: "100644" })

function history(files: Record<string, string>): GitHistory {
  return {
    read: async (_sha, path) => files[path],
    diff: async () => "",
    renameDiff: async () => "",
    paths: async () => Object.keys(files),
    changes: async () => [],
    tree: async () => Object.keys(files).map(entry),
  }
}

describe("standardsAt", () => {
  it("renders the base's instruction files for the changed paths and reads the config's filters", async () => {
    const git = history({
      "CLAUDE.md": "No comments.",
      ".github/instructions/tests.instructions.md": "---\napplyTo: 'test/**'\n---\nName the behaviour.",
      ".github/instructions/docs.instructions.md": "---\napplyTo: 'docs/**'\n---\nPlain words.",
      ".andabot.yaml":
        "reviews:\n  path_filters:\n    - '!**/*.snap'\n  path_instructions:\n    - path: 'src/**'\n      instructions: Split by what it decides.\n",
    })
    const standards = await standardsAt(git, BASE, ["src/a.ts", "test/a.test.ts"])
    expect(standards.text).toContain("## Repository standards")
    expect(standards.text).toContain("### CLAUDE.md\n\nNo comments.")
    expect(standards.text).toContain("Name the behaviour.")
    expect(standards.text).not.toContain("Plain words.")
    expect(standards.text).toContain("### .andabot.yaml: src/**\n\nSplit by what it decides.")
    expect(standards.pathFilters).toEqual(["!**/*.snap"])
    expect(standards.used).toEqual([".andabot.yaml: src/**", ".github/instructions/tests.instructions.md", "CLAUDE.md"])
  })

  it("renders nothing with no instruction files and no config", async () => {
    const standards = await standardsAt(history({ "src/a.ts": "export const a = 1" }), BASE, ["src/a.ts"])
    expect(standards).toEqual({ text: "", pathFilters: [], used: [] })
  })
})
