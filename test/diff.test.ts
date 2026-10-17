import { describe, expect, it } from "vitest"
import { commentableLines, isGenerated, renderPatches } from "../src/github/diff.ts"

const patch = [
  "@@ -1,4 +1,5 @@",
  " import { a } from './a';",
  "-import { b } from './b';",
  "+import { b, c } from './b';",
  "+",
  " export function f() {",
  "   return a + b;",
  "@@ -10,2 +11,3 @@ export function g() {",
  "-  return 1;",
  "+  return c;",
  "+  // added",
  " }",
  "\\ No newline at end of file",
].join("\n")

describe("commentableLines", () => {
  it("numbers added and context lines on the right, deleted on the left", () => {
    const lines = commentableLines(patch)
    expect([...lines.right].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 11, 12, 13])
    expect([...lines.left].sort((x, y) => x - y)).toEqual([2, 10])
  })

  it("has nothing for a file without a patch", () => {
    const lines = commentableLines(undefined)
    expect(lines.right.size).toBe(0)
    expect(lines.left.size).toBe(0)
  })
})

describe("renderPatches", () => {
  it("renders a header and fenced diff per file, and truncates long patches", () => {
    const text = renderPatches(
      [
        { filename: "a.ts", status: "modified", additions: 3, deletions: 2, patch },
        { filename: "big.bin", status: "added", additions: 0, deletions: 0 },
        { filename: "long.ts", status: "modified", additions: 1, deletions: 0, patch: "+".repeat(50) },
      ],
      20,
    )
    expect(text).toContain("### a.ts (modified, +3 -2)\n```diff\n@@ -1,4 +1,5 @@")
    expect(text).toContain("### big.bin (added, +0 -0)\n(no textual diff")
    expect(text).toContain("patch truncated at 20 characters")
  })

  it("lists a lock file without its patch", () => {
    const text = renderPatches([
      { filename: "pnpm-lock.yaml", status: "added", additions: 4000, deletions: 0, patch: "+lockfileVersion: 9" },
    ])
    expect(text).toContain("### pnpm-lock.yaml (added, +4000 -0)\n(patch omitted")
    expect(text).not.toContain("lockfileVersion")
  })
})

describe("isGenerated", () => {
  it("matches lock files, minified assets and build output, not source", () => {
    for (const path of [
      "pnpm-lock.yaml",
      "apps/web/package-lock.json",
      "a.min.js",
      "x.snap",
      "dist/index.js",
      "Cargo.lock",
    ])
      expect(isGenerated(path)).toBe(true)
    for (const path of ["src/index.ts", "package.json", "docs/lock.md", "distribution.ts"])
      expect(isGenerated(path)).toBe(false)
  })
})
