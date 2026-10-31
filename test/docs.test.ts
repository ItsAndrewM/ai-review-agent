import { describe, expect, it } from "vitest"
import type { ChangedFile } from "../src/github/diff.ts"
import { DEFAULT_DOC_GLOBS, docMatcher, docsInChange, isHistory, mentionPatterns } from "../src/repository/docs.ts"

const changed = (filename: string, status = "modified"): ChangedFile => ({
  filename,
  status,
  additions: 1,
  deletions: 0,
})

describe("docMatcher", () => {
  const isDoc = docMatcher(DEFAULT_DOC_GLOBS)

  it("accepts the default docs: READMEs at any depth, docs markdown and the instruction files", () => {
    for (const path of [
      "README.md",
      "README",
      "packages/a/README.md",
      "docs/design.md",
      "docs/a/b.md",
      "CLAUDE.md",
      "src/CLAUDE.md",
      "AGENTS.md",
      ".github/instructions/lint.instructions.md",
      ".github/copilot-instructions.md",
      "CONTRIBUTING.md",
    ]) {
      expect([path, isDoc(path)]).toEqual([path, true])
    }
  })

  it("rejects code, non-markdown docs and dotfiles that aren't instruction files", () => {
    for (const path of ["src/a.ts", "docs/a.txt", ".github/workflows/ci.yml", "test/docs.test.ts", "package.json"]) {
      expect([path, isDoc(path)]).toEqual([path, false])
    }
  })

  it("replaces the defaults when the list has an include, and keeps the excludes", () => {
    const wiki = docMatcher(["wiki/**/*.md", "!wiki/old/**"])
    expect(wiki("wiki/a.md")).toBe(true)
    expect(wiki("wiki/old/a.md")).toBe(false)
    expect(wiki("README.md")).toBe(false)
    expect(wiki("docs/design.md")).toBe(false)
  })

  it("narrows the defaults with an excludes-only list, so the check isn't turned off by mistake", () => {
    const narrowed = docMatcher(["!docs/archive/**"])
    expect(narrowed("docs/design.md")).toBe(true)
    expect(narrowed("docs/archive/x.md")).toBe(false)
    expect(narrowed("README.md")).toBe(true)
  })
})

describe("isHistory", () => {
  it("names the plans and specs under docs/superpowers and nothing else", () => {
    expect(isHistory("docs/superpowers/specs/2026-10-24-verify-design.md")).toBe(true)
    expect(isHistory("docs/superpowers/plans/x.md")).toBe(true)
    expect(isHistory("docs/design.md")).toBe(false)
    expect(isHistory("README.md")).toBe(false)
  })
})

describe("docsInChange", () => {
  it("sorts an added plan as under review, a modified spec as history, a changed README as under, and a lock file and a source file as code", () => {
    const files = [
      changed("docs/superpowers/plans/2026-10-31-new.md", "added"),
      changed("docs/superpowers/specs/2026-10-24-verify-design.md"),
      changed("README.md"),
      changed("pnpm-lock.yaml"),
      changed("src/review/tools.ts"),
    ]
    const sorted = docsInChange(files, docMatcher(DEFAULT_DOC_GLOBS))
    expect(sorted.under.map((file) => file.filename)).toEqual(["docs/superpowers/plans/2026-10-31-new.md", "README.md"])
    expect(sorted.history.map((file) => file.filename)).toEqual(["docs/superpowers/specs/2026-10-24-verify-design.md"])
    expect(sorted.code.map((file) => file.filename)).toEqual(["pnpm-lock.yaml", "src/review/tools.ts"])
  })
})

describe("mentionPatterns", () => {
  it("searches the path and the basename as a word", () => {
    expect(mentionPatterns("src/review/tools.ts")).toEqual(["src/review/tools.ts", "\\btools\\b"])
  })

  it("skips a short or common basename", () => {
    expect(mentionPatterns("src/index.ts")).toEqual(["src/index.ts"])
    expect(mentionPatterns("cmd/main.go")).toEqual(["cmd/main.go"])
    expect(mentionPatterns("src/db.ts")).toEqual(["src/db.ts"])
    expect(mentionPatterns("lib/utils.ts")).toEqual(["lib/utils.ts"])
    expect(mentionPatterns("packages/a/README.md")).toEqual(["packages/a/README.md"])
  })

  it("takes the basename without its last extension only, and quotes it for the search", () => {
    expect(mentionPatterns("src/app.test.ts")).toEqual(["src/app.test.ts", "\\bapp\\.test\\b"])
  })
})
