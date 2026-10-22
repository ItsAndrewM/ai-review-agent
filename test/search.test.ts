import { describe, expect, it } from "vitest"
import {
  DEFAULT_TREE_DEPTH,
  grep,
  MAX_GREP_CHARS,
  MAX_LINE_CHARS,
  MAX_MATCHES,
  MAX_PATTERN_CHARS,
  MAX_SEARCH_CALLS,
  MAX_SEARCHED_LINE_CHARS,
  MAX_TREE_ENTRIES,
  patternProblem,
  tree,
} from "../src/repository/search.ts"
import { MemorySnapshotFiles, type LeftOut } from "../src/repository/snapshot.ts"

function snapshotOf(contents: Record<string, string>, leftOut: readonly LeftOut[] = []): MemorySnapshotFiles {
  const files = new MemorySnapshotFiles()
  files.add(Object.entries(contents).map(([path, content]) => ({ path, content })))
  files.leaveOut(leftOut)
  return files
}

function numbered(count: number, text: string): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`f${String(index).padStart(3, "0")}.ts`, text]),
  )
}

describe("limits", () => {
  it("are the values the plan fixes", () => {
    expect([
      MAX_MATCHES,
      MAX_GREP_CHARS,
      MAX_LINE_CHARS,
      MAX_PATTERN_CHARS,
      MAX_TREE_ENTRIES,
      DEFAULT_TREE_DEPTH,
      MAX_SEARCH_CALLS,
      MAX_SEARCHED_LINE_CHARS,
    ]).toEqual([100, 12_000, 300, 500, 500, 2, 40, 2_000])
  })
})

describe("grep", () => {
  const repository = snapshotOf({
    "src/b.ts": "const b = 1\nconst target = 2\n",
    "src/a.ts": "const target = 1\nline\nlet target = 3\n",
    "src/deep/c.ts": "target()\n",
    "test/a.ts": "target\n",
    "README.md": "no hit\n",
  })

  it("returns path:line: text lines in path order", () => {
    expect(grep(repository, { pattern: "target" })).toBe(
      [
        "src/a.ts:1: const target = 1",
        "src/a.ts:3: let target = 3",
        "src/b.ts:2: const target = 2",
        "src/deep/c.ts:1: target()",
        "test/a.ts:1: target",
      ].join("\n"),
    )
  })

  it("keeps ^ and $ at line boundaries", () => {
    expect(grep(repository, { pattern: "^line$" })).toBe("src/a.ts:2: line")
  })

  it("filters by path", () => {
    const answer = grep(repository, { pattern: "target", path: "src/deep" })
    expect(answer).toBe("src/deep/c.ts:1: target()")
  })

  it("does not take a sibling directory with the same prefix for the path", () => {
    const files = snapshotOf({ "src/a.ts": "x\n", "src-old/a.ts": "x\n" })
    expect(grep(files, { pattern: "x", path: "src" })).toBe("src/a.ts:1: x")
  })

  it("gives the same answer for ./src/ and src", () => {
    expect(grep(repository, { pattern: "target", path: "./src/" })).toBe(
      grep(repository, { pattern: "target", path: "src" }),
    )
  })

  it("searches the whole repository for . and an empty path", () => {
    const whole = grep(repository, { pattern: "target" })
    expect(grep(repository, { pattern: "target", path: "." })).toBe(whole)
    expect(grep(repository, { pattern: "target", path: "" })).toBe(whole)
  })

  it("matches *.ts against files in any directory", () => {
    const answer = grep(repository, { pattern: "target", glob: "*.ts" })
    expect(answer).toContain("src/deep/c.ts:1")
    expect(answer).toContain("test/a.ts:1")
  })

  it("keeps src/**/*.ts away from test/a.ts", () => {
    const answer = grep(repository, { pattern: "target", glob: "src/**/*.ts" })
    expect(answer).toContain("src/deep/c.ts:1")
    expect(answer).not.toContain("test/a.ts")
  })

  it("combines path and glob", () => {
    const answer = grep(repository, { pattern: "target", path: "src", glob: "a.ts" })
    expect(answer).toBe("src/a.ts:1: const target = 1\nsrc/a.ts:3: let target = 3")
  })

  it("stops at 100 matches and counts what it did not show", () => {
    const files = snapshotOf(numbered(4, "hit\n".repeat(40)))
    const lines = grep(files, { pattern: "hit" }).split("\n")
    expect(lines).toHaveLength(MAX_MATCHES + 1)
    expect(lines.at(-1)).toBe("… 60 more matches in 2 files not shown.")
  })

  it("counts a file once however many of its matches are hidden", () => {
    const files = snapshotOf({ "a.ts": "hit\n".repeat(105) })
    expect(grep(files, { pattern: "hit" }).split("\n").at(-1)).toBe("… 5 more matches in 1 file not shown.")
  })

  it("cuts the answer at 12,000 characters with a note", () => {
    const files = snapshotOf({ "a.ts": `${"x".repeat(250)}\n`.repeat(90) })
    const answer = grep(files, { pattern: "x" })
    expect(answer.length).toBeLessThanOrEqual(MAX_GREP_CHARS)
    expect(answer).toMatch(/\n… \d+ more matches in 1 file not shown\.$/)
  })

  it("keeps the answer under 12,000 characters with the left-out note", () => {
    const files = snapshotOf({ "a.ts": `${"x".repeat(250)}\n`.repeat(90) }, [
      { path: "dist/app.js", reason: "too_large" },
    ])
    const answer = grep(files, { pattern: "x" })
    expect(answer.length).toBeLessThanOrEqual(MAX_GREP_CHARS)
    expect(answer).toContain("Not searched: 1 file left out of the snapshot (too_large: dist/app.js).")
  })

  it("cuts a line at 300 characters and drops a trailing carriage return", () => {
    const files = snapshotOf({ "a.ts": `${"y".repeat(400)}\r\nshort\r\n` })
    const lines = grep(files, { pattern: "y|short" }).split("\n")
    expect(lines[0]).toBe(`a.ts:1: ${"y".repeat(MAX_LINE_CHARS)}`)
    expect(lines[1]).toBe("a.ts:2: short")
  })

  it("searches a pattern that does not compile as literal text", () => {
    const files = snapshotOf({ "a.ts": "answerPrompt(x)\nanswerPrompt\n" })
    expect(grep(files, { pattern: "answerPrompt(" })).toBe(
      [
        "Searched for the literal text `answerPrompt(` (not a valid regular expression).",
        "a.ts:1: answerPrompt(x)",
      ].join("\n"),
    )
  })

  it("lists left-out paths under the searched path", () => {
    const files = snapshotOf({ "src/a.ts": "hit\n" }, [
      { path: "dist/app.js", reason: "too_large" },
      { path: "logo.png", reason: "binary" },
    ])
    expect(grep(files, { pattern: "hit" })).toBe(
      [
        "src/a.ts:1: hit",
        "Not searched: 2 files left out of the snapshot (too_large: dist/app.js; binary: logo.png).",
      ].join("\n"),
    )
  })

  it("lists at most ten example paths and counts the rest", () => {
    const leftOut = Array.from({ length: 12 }, (_, index): LeftOut => ({
      path: `big/${String(index).padStart(2, "0")}.js`,
      reason: "too_large",
    }))
    const files = snapshotOf({ "a.ts": "hit\n" }, [...leftOut, { path: "logo.png", reason: "binary" }])
    const examples = Array.from({ length: 10 }, (_, index) => `big/${String(index).padStart(2, "0")}.js`).join(", ")
    expect(grep(files, { pattern: "hit" }).split("\n").at(-1)).toBe(
      `Not searched: 13 files left out of the snapshot (too_large: ${examples}; and 3 more).`,
    )
  })

  it("only lists left-out paths the path and glob select", () => {
    const files = snapshotOf({ "src/a.ts": "hit\n" }, [
      { path: "dist/app.js", reason: "too_large" },
      { path: "src/logo.png", reason: "binary" },
    ])
    const answer = grep(files, { pattern: "hit", path: "src" })
    expect(answer).toContain("(binary: src/logo.png)")
    expect(answer).not.toContain("dist/app.js")
    expect(grep(files, { pattern: "hit", glob: "*.ts" })).not.toContain("Not searched")
  })

  it("says no match with the file count", () => {
    const files = snapshotOf(numbered(12, "nothing\n"))
    expect(grep(files, { pattern: "x" })).toBe("No match for /x/ in 12 files.")
  })

  it("says no match for one file in the singular", () => {
    expect(grep(snapshotOf({ "a.ts": "nothing\n" }), { pattern: "x" })).toBe("No match for /x/ in 1 file.")
  })

  it("adds the left-out note to a search with no match", () => {
    const files = snapshotOf(numbered(12, "nothing\n"), [
      { path: "dist/app.js", reason: "too_large" },
      { path: "logo.png", reason: "binary" },
    ])
    expect(grep(files, { pattern: "x" })).toBe(
      [
        "No match for /x/ in 12 files.",
        "Not searched: 2 files left out of the snapshot (too_large: dist/app.js; binary: logo.png).",
      ].join("\n"),
    )
  })

  it("finds a match within the first 2,000 characters of a very long line", () => {
    const files = snapshotOf({ "min.js": `foo${"x".repeat(50_000)}\n` })
    const answer = grep(files, { pattern: "foo" })
    expect(answer).toContain("min.js:1: foo")
    expect(answer).toContain("1 long line searched only in its first 2,000 characters.")
  })

  it("does not find a match that starts after character 2,000 of a line and says one long line was cut", () => {
    const files = snapshotOf({ "min.js": `${"x".repeat(2_500)}foo\n` })
    expect(grep(files, { pattern: "foo" })).toBe(
      ["No match for /foo/ in 1 file.", "1 long line searched only in its first 2,000 characters."].join("\n"),
    )
  })

  it("counts the long lines across the files searched", () => {
    const long = `${"x".repeat(2_001)}\n`
    const files = snapshotOf({ "a.js": long.repeat(2), "b.js": long, "c.js": "short\n" })
    expect(grep(files, { pattern: "short" })).toBe(
      ["c.js:1: short", "3 long lines searched only in their first 2,000 characters."].join("\n"),
    )
  })

  it("does not count a line of exactly 2,000 characters as long", () => {
    const files = snapshotOf({ "a.js": `${"x".repeat(2_000)}\n` })
    expect(grep(files, { pattern: "x{2000}" })).not.toContain("long line")
  })

  it("keeps the long-line note inside the 12,000-character budget", () => {
    const files = snapshotOf({ "a.ts": `${"x".repeat(250)}\n`.repeat(90), "b.js": `${"y".repeat(2_500)}\n` })
    const answer = grep(files, { pattern: "x" })
    expect(answer.length).toBeLessThanOrEqual(MAX_GREP_CHARS)
    expect(answer).toContain("1 long line searched only")
  })

  it("answers a backtracking-prone pattern over one very long line in under a second", () => {
    const files = snapshotOf({ "min.js": `xx foo ${"x".repeat(199_990)}\n` })
    const started = performance.now()
    grep(files, { pattern: ".*foo.*bar" })
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it("answers a pattern that spans lines over 20,000 short lines in under a second with no match", () => {
    const files = snapshotOf({ "big.txt": "foo line\n".repeat(20_000) })
    const started = performance.now()
    const answer = grep(files, { pattern: String.raw`[\s\S]*foo[\s\S]*bar` })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(answer).toBe("No match for /[\\s\\S]*foo[\\s\\S]*bar/ in 1 file.")
  })

  it("refuses a pattern with a nested quantifier without searching", () => {
    const answer = grep(snapshotOf({ "a.ts": "aaaa\n" }), { pattern: "(a+)+" })
    expect(answer).toBe(patternProblem("(a+)+"))
    expect(answer).toContain("nested quantifier")
  })
})

describe("patternProblem", () => {
  it("refuses a pattern over 500 characters", () => {
    expect(patternProblem("a".repeat(501))).toContain("500")
    expect(patternProblem("a".repeat(500))).toBeUndefined()
  })

  it.each([
    "(a+)+",
    "(a*)*",
    String.raw`(\w+\s?)+`,
    "((a+)b)+",
    "(a+){2,}",
    "(?:a+)*",
    "(a{2,})+",
    String.raw`(\d{1,3}\.?)+`,
  ])("refuses the nested quantifier in %s", (pattern) => {
    expect(patternProblem(pattern)).toContain("nested quantifier")
  })

  it.each([
    "foo(bar)+",
    "a+b+",
    String.raw`(\++)`,
    String.raw`(a\+)+`,
    "([+*])+",
    "(a|b)+",
    "(a)(b+)",
    String.raw`\(a+\)+`,
  ])("accepts %s", (pattern) => {
    expect(patternProblem(pattern)).toBeUndefined()
  })

  it("refuses an empty pattern", () => {
    expect(patternProblem("")).toContain("empty")
  })
})

describe("tree", () => {
  const repository = snapshotOf(
    {
      "README.md": "",
      "src/a.ts": "",
      "src/deep/b.ts": "",
      "src/deep/more/c.ts": "",
      "test/a.test.ts": "",
    },
    [
      { path: "logo.png", reason: "binary" },
      { path: "src/deep/huge.js", reason: "too_large" },
    ],
  )

  it("lists to depth 2 by default with directories ending in a slash", () => {
    expect(tree(repository)).toBe(
      ["README.md", "logo.png (left out: binary)", "src/", "src/a.ts", "src/deep/", "test/", "test/a.test.ts"].join(
        "\n",
      ),
    )
  })

  it("lists deeper when asked, marking left-out paths with their reason", () => {
    expect(tree(repository, "src", 3)).toBe(
      [
        "src/a.ts",
        "src/deep/",
        "src/deep/b.ts",
        "src/deep/huge.js (left out: too_large)",
        "src/deep/more/",
        "src/deep/more/c.ts",
      ].join("\n"),
    )
  })

  it("counts depth below the path and normalises it", () => {
    expect(tree(repository, "./src/")).toBe(
      ["src/a.ts", "src/deep/", "src/deep/b.ts", "src/deep/huge.js (left out: too_large)", "src/deep/more/"].join("\n"),
    )
    expect(tree(repository, "src", 1)).toBe(["src/a.ts", "src/deep/"].join("\n"))
  })

  it("lists a directory once however many files it holds", () => {
    const entries = tree(repository, "", 1).split("\n")
    expect(entries.filter((entry) => entry === "src/")).toHaveLength(1)
    expect(entries).not.toContain("src/a.ts")
  })

  it("stops at 500 entries with a note", () => {
    const lines = tree(snapshotOf(numbered(520, ""))).split("\n")
    expect(lines).toHaveLength(MAX_TREE_ENTRIES + 1)
    expect(lines.at(-1)).toBe("… 20 more entries not shown.")
  })

  it("says so when nothing is under the path", () => {
    expect(tree(repository, "nowhere")).toBe("No files under `nowhere` in the snapshot.")
    expect(tree(snapshotOf({}))).toBe("The snapshot has no files.")
  })
})
