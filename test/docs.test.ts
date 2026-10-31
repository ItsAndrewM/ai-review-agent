import { describe, expect, it } from "vitest"
import type { ChangedFile } from "../src/github/diff.ts"
import {
  DEFAULT_DOC_GLOBS,
  docMatcher,
  docMentions,
  docPathsAtHead,
  docsInChange,
  MAX_DOC_PATHS,
  docsStartFields,
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
    const found = docMentions(files, new GrepWork(), isDoc, [tools], new Map([["docs/setup.md", new Set([1])]]))
    expect(found.mentions).toEqual([
      { path: "README.md", line: 1, text: "The review's tools are in src/review/tools.ts." },
      { path: "docs/design.md", line: 3, text: "src/review/tools.ts is wired here." },
      { path: "docs/design.md", line: 1, text: "tools.ts holds the tools." },
    ])
    expect(found.overflow).toBe(0)
    expect(found.searched).toBe(1)
    expect(found.stopped).toBe(false)
  })

  it("keeps a hit in a doc under review when it sits outside the doc's changed lines, and drops one inside them", () => {
    const files = snapshotOf({
      "docs/setup.md": "src/review/tools.ts is listed in setup.\n\nsrc/review/tools.ts again, unchanged.\n",
    })
    const found = docMentions(files, new GrepWork(), isDoc, [tools], new Map([["docs/setup.md", new Set([1])]]))
    expect(found.mentions).toEqual([{ path: "docs/setup.md", line: 3, text: "src/review/tools.ts again, unchanged." }])
  })

  it("searches no mentions for a generated or lock file, which describes nothing", () => {
    const files = snapshotOf({ "README.md": "Run yarn install; pnpm-lock.yaml is committed; dist/app.js is built.\n" })
    const code = [changed("yarn.lock"), changed("pnpm-lock.yaml"), changed("dist/app.js"), tools]
    const found = docMentions(files, new GrepWork(), isDoc, code, new Map())
    expect(found.mentions).toEqual([])
    expect(found.searched).toBe(1)
  })

  it("ranks a hit on the path ahead of a hit on the bare word, and names a line once across changed files", () => {
    const files = snapshotOf({ "README.md": "The tools module.\nSee src/review/tools.ts and src/review/basis.ts.\n" })
    const code = [tools, changed("src/review/basis.ts")]
    const found = docMentions(files, new GrepWork(), isDoc, code, new Map())
    expect(found.mentions).toEqual([
      { path: "README.md", line: 2, text: "See src/review/tools.ts and src/review/basis.ts." },
      { path: "README.md", line: 1, text: "The tools module." },
    ])
  })

  it("shares the total cap round-robin across changed files", () => {
    const code = Array.from({ length: 8 }, (_, i) => changed(`src/area/file${i}.ts`))
    const docsByFile = Object.fromEntries(
      code.map((file, i) => [`docs/d${i}.md`, Array.from({ length: 6 }, (_, j) => `${j} ${file.filename}`).join("\n")]),
    )
    const found = docMentions(snapshotOf(docsByFile), new GrepWork(), isDoc, code, new Map())
    expect(found.mentions).toHaveLength(MAX_MENTIONS)
    expect(found.overflow).toBe(8)
    const perDoc = new Map<string, number>()
    for (const mention of found.mentions) perDoc.set(mention.path, (perDoc.get(mention.path) ?? 0) + 1)
    expect([...perDoc.values()]).toEqual(Array.from({ length: 8 }, () => 5))
  })

  it("stops when the search work is spent and says so, instead of answering that nothing mentions the change", () => {
    const work = new GrepWork()
    work.charge(Number.MAX_SAFE_INTEGER)
    const found = docMentions(snapshotOf({ "README.md": "src/review/tools.ts\n" }), work, isDoc, [tools], new Map())
    expect(found.mentions).toEqual([])
    expect(found.stopped).toBe(true)
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
      new Map(),
    )
    expect(perFile.mentions).toHaveLength(MAX_MENTIONS_PER_FILE)
    expect(perFile.overflow).toBe(2)
    const code = Array.from({ length: MAX_MENTIONS + 1 }, (_, i) => changed(`src/b/file${i}.ts`))
    const everyFile = Object.fromEntries(code.map((file, i) => [`docs/d${i}.md`, `${file.filename} is here\n`]))
    const total = docMentions(snapshotOf(everyFile), new GrepWork(), isDoc, code, new Map())
    expect(total.mentions).toHaveLength(MAX_MENTIONS)
    expect(total.overflow).toBe(1)
    expect(total.searched).toBe(MAX_MENTIONS + 1)
  })

  it("names a mention once when both the path and the basename hit the same line", () => {
    const files = snapshotOf({ "README.md": "src/review/tools.ts, the tools module\n" })
    const found = docMentions(files, new GrepWork(), isDoc, [tools], new Map())
    expect(found.mentions).toEqual([{ path: "README.md", line: 1, text: "src/review/tools.ts, the tools module" }])
  })
})

describe("docPathsAtHead", () => {
  it("keeps the head's docs minus history, plus the docs under review, sorted and de-duplicated", () => {
    const paths = ["src/a.ts", "docs/design.md", "docs/superpowers/plans/old.md", "README.md", "docs/design.md"]
    expect(
      docPathsAtHead(paths, docMatcher(DEFAULT_DOC_GLOBS), ["docs/superpowers/plans/new.md", "README.md"]),
    ).toEqual(["README.md", "docs/design.md", "docs/superpowers/plans/new.md"])
  })

  it("keeps at most the first MAX_DOC_PATHS docs in path order, so the record stays small in a monorepo", () => {
    const many = Array.from(
      { length: MAX_DOC_PATHS + 5 },
      (_, i) => `packages/p${String(i).padStart(4, "0")}/README.md`,
    )
    expect(docPathsAtHead(many, docMatcher(DEFAULT_DOC_GLOBS), [])).toHaveLength(MAX_DOC_PATHS)
  })
})

describe("docsStartFields", () => {
  const sorted = {
    under: [changed("README.md"), changed("docs/superpowers/plans/new.md", "added")],
    history: [changed("docs/superpowers/specs/old.md")],
    code: [changed("src/a.ts"), changed("src/b.ts")],
  }

  it("counts the sorted files and the mentions found", () => {
    const found = {
      mentions: [
        { path: "docs/design.md", line: 1, text: "a" },
        { path: "docs/design.md", line: 9, text: "b" },
        { path: "docs/setup.md", line: 2, text: "c" },
      ],
      overflow: 4,
      searched: 2,
      stopped: false,
    }
    expect(docsStartFields(sorted, found, "ready")).toEqual({
      under: 2,
      history: 1,
      code: 2,
      mentions: 3,
      mentionFiles: 2,
      overflow: 4,
      search: "ready",
    })
  })

  it("reports zero mentions and the search state when the search wasn't available", () => {
    expect(docsStartFields(sorted, undefined, "unavailable")).toEqual({
      under: 2,
      history: 1,
      code: 2,
      mentions: 0,
      mentionFiles: 0,
      overflow: 0,
      search: "unavailable",
    })
  })
})

describe("mentionPatterns", () => {
  it("searches the path and the basename as a word", () => {
    expect(mentionPatterns("src/review/tools.ts")).toEqual(["src/review/tools\\.ts", "\\btools\\b"])
  })

  it("skips a short or common basename", () => {
    expect(mentionPatterns("src/index.ts")).toEqual(["src/index\\.ts"])
    expect(mentionPatterns("cmd/main.go")).toEqual(["cmd/main\\.go"])
    expect(mentionPatterns("src/db.ts")).toEqual(["src/db\\.ts"])
    expect(mentionPatterns("lib/utils.ts")).toEqual(["lib/utils\\.ts"])
    expect(mentionPatterns("packages/a/README.md")).toEqual(["packages/a/README\\.md"])
  })

  it("takes the basename without its last extension only, and quotes it for the search", () => {
    expect(mentionPatterns("src/app.test.ts")).toEqual(["src/app\\.test\\.ts", "\\bapp\\.test\\b"])
  })

  it("quotes a path with regex syntax, and drops the word boundary beside a stem's non-word edge", () => {
    expect(mentionPatterns("src/routes/+page.svelte")).toEqual(["src/routes/\\+page\\.svelte", "\\+page\\b"])
    expect(mentionPatterns("app/[id]/page.tsx")).toEqual(["app/\\[id\\]/page\\.tsx", "\\bpage\\b"])
    expect(mentionPatterns("routes/$id.tsx")).toEqual(["routes/\\$id\\.tsx"])
  })
})
