import { describe, expect, it } from "vitest"
import { parseNameStatus, parseNumstat, parseTree } from "../tools/replay/git.ts"

describe("parseNameStatus", () => {
  it("reads added, removed, modified and renamed entries from -z output", () => {
    const text = "A\0src/a.ts\0D\0src/b.ts\0M\0src/c.ts\0R092\0src/old.ts\0src/new.ts\0T\0src/t.ts\0"
    expect(parseNameStatus(text)).toEqual([
      { path: "src/a.ts", status: "added" },
      { path: "src/b.ts", status: "removed" },
      { path: "src/c.ts", status: "modified" },
      { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
      { path: "src/t.ts", status: "modified" },
    ])
  })
})

describe("parseNumstat", () => {
  it("reads counts, a binary's dashes as zero, and a rename's path pair", () => {
    const text = ["2\t0\tsrc/a.ts", "-\t-\tlogo.png", "1\t0\t", "src/old.ts", "src/new.ts", ""].join("\0")
    expect([...parseNumstat(text)]).toEqual([
      ["src/a.ts", { additions: 2, deletions: 0 }],
      ["logo.png", { additions: 0, deletions: 0 }],
      ["src/new.ts", { additions: 1, deletions: 0 }],
    ])
  })
})

describe("parseTree", () => {
  it("keeps blobs with their mode, sha and size", () => {
    const text = [
      `100644 blob ${"1".repeat(40)}      12\tCLAUDE.md`,
      `040000 tree ${"2".repeat(40)}       -\tsrc`,
      `120000 blob ${"3".repeat(40)}       9\tAGENTS.md`,
      "",
    ].join("\0")
    expect(parseTree(text)).toEqual([
      { path: "CLAUDE.md", type: "blob", sha: "1".repeat(40), size: 12, mode: "100644" },
      { path: "AGENTS.md", type: "blob", sha: "3".repeat(40), size: 9, mode: "120000" },
    ])
  })
})
