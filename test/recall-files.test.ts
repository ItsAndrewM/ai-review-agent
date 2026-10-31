import { describe, expect, it } from "vitest"
import { changedFilesAt } from "../tools/recall/files.ts"
import type { ChangeAt, GitHistory, TreeEntryAt } from "../tools/replay/git.ts"

const BASE = "b".repeat(40)
const HEAD = "a".repeat(40)

function history(changes: ChangeAt[], diffs: Record<string, string>): GitHistory {
  return {
    read: async () => undefined,
    diff: async (_base, _head, path) => diffs[path] ?? "",
    paths: async () => [],
    renameDiff: async () => "",
    changes: async () => changes,
    tree: async (): Promise<TreeEntryAt[]> => [],
  }
}

const HEADER = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n"

describe("changedFilesAt", () => {
  it("maps git's statuses and counts to GitHub's changed files with hunks only", async () => {
    const files = await changedFilesAt(
      history(
        [
          { path: "src/a.ts", status: "added", additions: 2, deletions: 0 },
          { path: "src/b.ts", status: "removed", additions: 0, deletions: 3 },
          { path: "src/c.ts", status: "modified", additions: 1, deletions: 1 },
        ],
        {
          "src/a.ts": `${HEADER}@@ -0,0 +1,2 @@\n+one\n+two\n`,
          "src/b.ts": "@@ -1,3 +0,0 @@\n-x\n-y\n-z\n",
          "src/c.ts": "@@ -1 +1 @@\n-old\n+new\n",
        },
      ),
      BASE,
      HEAD,
    )
    expect(files).toEqual([
      { filename: "src/a.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+one\n+two" },
      { filename: "src/b.ts", status: "removed", additions: 0, deletions: 3, patch: "@@ -1,3 +0,0 @@\n-x\n-y\n-z" },
      { filename: "src/c.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
    ])
  })

  it("leaves the patch out for a binary file", async () => {
    const files = await changedFilesAt(
      history([{ path: "logo.png", status: "modified", additions: 0, deletions: 0 }], {
        "logo.png": "Binary files a/logo.png and b/logo.png differ",
      }),
      BASE,
      HEAD,
    )
    expect(files).toEqual([{ filename: "logo.png", status: "modified", additions: 0, deletions: 0 }])
  })

  it("asks for a renamed file's patch by both of its paths", async () => {
    const asked: string[] = []
    const files = await changedFilesAt(
      {
        ...history(
          [{ path: "src/new.ts", status: "renamed", additions: 1, deletions: 0, previousPath: "src/old.ts" }],
          {},
        ),
        renameDiff: async (_base, _head, previous, path) => {
          asked.push(`${previous} -> ${path}`)
          return "@@ -1 +1,2 @@\n a\n+b\n"
        },
      },
      BASE,
      HEAD,
    )
    expect(asked).toEqual(["src/old.ts -> src/new.ts"])
    expect(files[0]?.filename).toBe("src/new.ts")
    expect(files[0]?.patch).toBe("@@ -1 +1,2 @@\n a\n+b")
  })
})
