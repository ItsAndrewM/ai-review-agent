import { describe, expect, it } from "vitest"
import {
  commentableLines,
  deltaLines,
  isGenerated,
  markedLines,
  renderPatches,
  requiresWalkthrough,
} from "../src/github/diff.ts"

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
    expect([...lines.right.keys()].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 11, 12, 13])
    expect([...lines.left.keys()].sort((x, y) => x - y)).toEqual([2, 10])
  })

  it("keeps each line's text without its diff marker, so a quote can be checked against it", () => {
    const lines = commentableLines(patch)
    expect(lines.right.get(1)).toBe("import { a } from './a';")
    expect(lines.right.get(2)).toBe("import { b, c } from './b';")
    expect(lines.right.get(3)).toBe("")
    expect(lines.right.get(5)).toBe("  return a + b;")
    expect(lines.left.get(2)).toBe("import { b } from './b';")
    expect(lines.left.get(10)).toBe("  return 1;")
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

  it("prefixes every hunk line with the anchor the review API takes, so the model copies it instead of counting", () => {
    const text = renderPatches([{ filename: "a.ts", status: "modified", additions: 3, deletions: 2, patch }])
    expect(text).toContain(
      [
        "@@ -1,4 +1,5 @@",
        "R1      import { a } from './a';",
        "L2     -import { b } from './b';",
        "R2     +import { b, c } from './b';",
        "R3     +",
        "R4      export function f() {",
        "R5        return a + b;",
        "@@ -10,2 +11,3 @@ export function g() {",
        "L10    -  return 1;",
        "R11    +  return c;",
        "R12    +  // added",
        "R13     }",
        "\\ No newline at end of file",
      ].join("\n"),
    )
  })

  it("cuts a long patch at a line boundary, so every line it shows can be quoted whole", () => {
    const added = ["@@ -0,0 +1,3 @@", "+const first = 1;", "+const second = 2;", "+const third = 3;"].join("\n")
    const text = renderPatches([{ filename: "n.ts", status: "added", additions: 3, deletions: 0, patch: added }], 50)
    expect(text).toContain("R1     +const first = 1;\n... (patch truncated at 50 characters)")
    expect(text).not.toContain("second")
  })

  it("lists a lock file without its patch", () => {
    const text = renderPatches([
      { filename: "pnpm-lock.yaml", status: "added", additions: 4000, deletions: 0, patch: "+lockfileVersion: 9" },
    ])
    expect(text).toContain("### pnpm-lock.yaml (added, +4000 -0)\n(patch omitted")
    expect(text).not.toContain("lockfileVersion")
  })
})

describe("deltaLines and markedLines", () => {
  const prPatch = [
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " export { a, b };",
  ].join("\n")

  it("deltaLines takes added lines by new number and by text, and deleted lines by text", () => {
    const delta = deltaLines(patch)
    expect([...delta.added].sort((x, y) => x - y)).toEqual([2, 3, 11, 12])
    expect([...delta.addedTexts].sort()).toEqual(["", "// added", "import { b, c } from './b';", "return c;"])
    expect([...delta.deletedTexts].sort()).toEqual(["import { b } from './b';", "return 1;"])
  })

  it("a file with no patch has no delta lines", () => {
    const delta = deltaLines(undefined)
    expect(delta.added.size).toBe(0)
    expect(delta.deletedTexts.size).toBe(0)
  })

  it("markedLines marks the PR's lines the delta added, and its deleted lines by text", () => {
    const addedSince = ["@@ -1,3 +1,4 @@", " const a = 1;", " const b = 3;", "+const c = 4;", " export { a, b };"]
    const onlyC = markedLines(prPatch, addedSince.join("\n"))
    expect([...onlyC.right]).toEqual([3])
    expect([...onlyC.left]).toEqual([])

    const changedSince = ["@@ -1,3 +1,4 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", " const c = 4;"]
    const bothSides = markedLines(prPatch, changedSince.join("\n"))
    expect([...bothSides.right]).toEqual([2])
    expect([...bothSides.left]).toEqual([2])

    const newFile = ["@@ -0,0 +1,3 @@", "+x", "+y", "+z"].join("\n")
    const lastLineOnly = markedLines(newFile, ["@@ -1,2 +1,3 @@", " x", " y", "+z"].join("\n"))
    expect([...lastLineOnly.right]).toEqual([3])
  })

  it("markedLines leaves the PR's context lines unmarked, even when the delta added them", () => {
    const fromMain = ["@@ -3,2 +3,2 @@", " const c = 4;", "-export { a };", "+export { a, b };"].join("\n")
    expect([...markedLines(prPatch, fromMain).right]).toEqual([])
  })

  it("renderPatches stars marked anchors and leaves the others alone", () => {
    const text = renderPatches(
      [{ filename: "src/x.ts", status: "modified", additions: 2, deletions: 1, patch: prPatch }],
      undefined,
      new Map([["src/x.ts", { right: new Set([2]), left: new Set<number>() }]]),
    )
    expect(text).toContain("R2*    +const b = 3;")
    expect(text).toContain("R1      const a = 1;")
    expect(text).toContain("R3     +const c = 4;")
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

describe("requiresWalkthrough", () => {
  it("asks for a row on a source file and on a binary file with no patch, not on a lock file", () => {
    const source = { filename: "src/index.ts", status: "modified", additions: 1, deletions: 0, patch }
    const binary = { filename: "logo.png", status: "added", additions: 0, deletions: 0 }
    const lock = { filename: "pnpm-lock.yaml", status: "modified", additions: 1, deletions: 0, patch: "+x" }
    expect(requiresWalkthrough(source)).toBe(true)
    expect(requiresWalkthrough(binary)).toBe(true)
    expect(requiresWalkthrough(lock)).toBe(false)
  })
})
