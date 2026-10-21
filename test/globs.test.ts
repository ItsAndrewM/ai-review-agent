import { minimatch } from "minimatch"
import { describe, expect, it } from "vitest"

describe("the glob matching that repository instructions rely on", () => {
  it("matches what a directory glob contains and nothing outside it", () => {
    expect(minimatch("src/a.ts", "src/**")).toBe(true)
    expect(minimatch("test/a.ts", "src/**")).toBe(false)
  })

  it("expands braces, so one glob names several extensions at any depth", () => {
    expect(minimatch("a/b/c.tsx", "**/*.{ts,tsx}")).toBe(true)
    expect(minimatch("a/b/c.js", "**/*.{ts,tsx}")).toBe(false)
  })

  it("matches a file at the root with **, so a glob for everything covers CLAUDE.md", () => {
    expect(minimatch("CLAUDE.md", "**")).toBe(true)
  })

  it("matches a path under a dot directory only with dot: true, so the host always passes it", () => {
    expect(minimatch(".github/x.md", "**")).toBe(false)
    expect(minimatch(".github/x.md", "**", { dot: true })).toBe(true)
  })
})
