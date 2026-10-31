import { describe, expect, it } from "vitest"
import type { ChangedFile } from "../src/github/diff.ts"
import {
  DEFAULT_DOC_GLOBS,
  docMatcher,
  docMentions,
  docsInChange,
  isHistory,
  MAX_MENTIONS,
  MAX_MENTIONS_PER_FILE,
  mentionPatterns,
} from "../src/repository/docs.ts"
import { GrepWork } from "../src/repository/search.ts"
import { MemorySnapshotFiles } from "../src/repository/snapshot.ts"

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

function snapshotOf(contents: Record<string, string>): MemorySnapshotFiles {
  const files = new MemorySnapshotFiles()
  files.add(Object.entries(contents).map(([path, content]) => ({ path, content })))
  return files
}

describe("docMentions", () => {
  const isDoc = docMatcher(DEFAULT_DOC_GLOBS)
  const tools = changed("src/review/tools.ts")

  it("lists the docs that name a changed file, in path order, and skips history and the docs under review", () => {
    const files = snapshotOf({
      "docs/design.md": "tools.ts holds the tools.\n\nsrc/review/tools.ts is wired here.\n",
      "README.md": "The review's tools are in src/review/tools.ts.\n",
      "docs/superpowers/plans/2026-10-17-tools.md": "src/review/tools.ts will hold the tools.\n",
      "docs/setup.md": "src/review/tools.ts is listed in setup.\n",
      "src/review/tools.ts": "export const tools = 1\n",
    })
    const found = docMentions(files, new GrepWork(), isDoc, [tools], new Set(["docs/setup.md"]))
    expect(found.mentions).toEqual([
      { path: "README.md", line: 1, text: "The review's tools are in src/review/tools.ts." },
      { path: "docs/design.md", line: 1, text: "tools.ts holds the tools." },
      { path: "docs/design.md", line: 3, text: "src/review/tools.ts is wired here." },
    ])
    expect(found.overflow).toBe(0)
    expect(found.searched).toBe(1)
  })

  it("caps the mentions per changed file and in all, and counts what it dropped", () => {
    const manyLines = Array.from({ length: MAX_MENTIONS_PER_FILE + 2 }, (_, i) => `line ${i} names src/a/one.ts`).join(
      "\n",
    )
    const perFile = docMentions(
      snapshotOf({ "docs/design.md": manyLines }),
      new GrepWork(),
      isDoc,
      [changed("src/a/one.ts")],
      new Set(),
    )
    expect(perFile.mentions).toHaveLength(MAX_MENTIONS_PER_FILE)
    expect(perFile.overflow).toBe(2)
    const code = Array.from({ length: MAX_MENTIONS + 1 }, (_, i) => changed(`src/b/file${i}.ts`))
    const everyFile = Object.fromEntries(code.map((file, i) => [`docs/d${i}.md`, `${file.filename} is here\n`]))
    const total = docMentions(snapshotOf(everyFile), new GrepWork(), isDoc, code, new Set())
    expect(total.mentions).toHaveLength(MAX_MENTIONS)
    expect(total.overflow).toBe(1)
    expect(total.searched).toBe(MAX_MENTIONS + 1)
  })

  it("names a mention once when both the path and the basename hit the same line", () => {
    const files = snapshotOf({ "README.md": "src/review/tools.ts, the tools module\n" })
    const found = docMentions(files, new GrepWork(), isDoc, [tools], new Set())
    expect(found.mentions).toEqual([{ path: "README.md", line: 1, text: "src/review/tools.ts, the tools module" }])
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
