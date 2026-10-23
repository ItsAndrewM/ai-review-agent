import { RE2JS } from "re2js"
import { describe, expect, it } from "vitest"
import { engineFor, LINE_UNITS, worstWork, type Engine } from "../src/repository/regex-work.ts"
import {
  DEFAULT_TREE_DEPTH,
  grep,
  MAX_GREP_CHARS,
  MAX_LINE_CHARS,
  MAX_MATCHES,
  MAX_PATTERN_CHARS,
  MAX_SEARCH_CALLS,
  MAX_SEARCH_WORK,
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

function finished(files: MemorySnapshotFiles, flags: { capped: boolean; treeTruncated: boolean }): MemorySnapshotFiles {
  files.finish({ sha: "abc", files: 0, bytes: 0, gapFilled: 0, leftOut: {}, ...flags })
  return files
}

const CAPPED =
  "The snapshot is incomplete (cap of 50,000 files or 400 MB reached); a missing match may be in a file it didn't load."

const TRUNCATED =
  "The snapshot is incomplete (GitHub truncated the tree listing); a missing match may be in a file it didn't load."

const LETTERS = "abcdefghijklmnopqrst"

const SPRAWLING = `${Array.from(LETTERS, (letter) => `.{0,999}${letter}`).join("")}zzz`

const engineOf = (pattern: string): Engine => engineFor(RE2JS.compile(pattern))

function fillerLines(units: number, length: number): string[] {
  const widest = length + 1 + LINE_UNITS
  const lines: string[] = []
  for (let left = units; left > 0;) {
    const size = left <= widest ? left : Math.min(widest, left - 1 - LINE_UNITS)
    lines.push("x".repeat(size - 1 - LINE_UNITS))
    left -= size
  }
  return lines
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
      MAX_SEARCH_WORK,
    ]).toEqual([100, 12_000, 300, 500, 500, 2, 40, 500, 750_000_000])
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
        "Searched for the literal text `answerPrompt(` (not a pattern this search supports).",
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

  it("says a capped snapshot is incomplete under the matches", () => {
    const files = finished(snapshotOf({ "a.ts": "hit\n" }), { capped: true, treeTruncated: false })
    expect(grep(files, { pattern: "hit" })).toBe(["a.ts:1: hit", CAPPED].join("\n"))
  })

  it("says a snapshot of a truncated tree is incomplete when nothing matches", () => {
    const files = finished(snapshotOf({ "a.ts": "nothing\n" }), { capped: false, treeTruncated: true })
    expect(grep(files, { pattern: "hit" })).toBe(["No match for /hit/ in 1 file.", TRUNCATED].join("\n"))
  })

  it("gives both reasons when the snapshot is capped and the tree truncated", () => {
    const files = finished(snapshotOf({ "a.ts": "nothing\n" }), { capped: true, treeTruncated: true })
    expect(grep(files, { pattern: "hit" }).split("\n").at(-1)).toBe(
      "The snapshot is incomplete (cap of 50,000 files or 400 MB reached; GitHub truncated the tree listing); a missing match may be in a file it didn't load.",
    )
  })

  it("says nothing of completeness for a complete snapshot", () => {
    const files = finished(snapshotOf({ "a.ts": "hit\n" }), { capped: false, treeTruncated: false })
    expect(grep(files, { pattern: "hit" })).toBe("a.ts:1: hit")
  })

  it("keeps the incomplete-snapshot note inside the 12,000-character budget", () => {
    const files = finished(
      snapshotOf({ "a.ts": `${"x".repeat(250)}\n`.repeat(90) }, [{ path: "dist/app.js", reason: "too_large" }]),
      { capped: true, treeTruncated: true },
    )
    const answer = grep(files, { pattern: "x" })
    expect(answer.length).toBeLessThanOrEqual(MAX_GREP_CHARS)
    expect(answer).toContain("The snapshot is incomplete (")
  })

  it("finds a match within the first 500 characters of a very long line", () => {
    const files = snapshotOf({ "min.js": `foo${"x".repeat(50_000)}\n` })
    const answer = grep(files, { pattern: "foo" })
    expect(answer).toContain("min.js:1: foo")
    expect(answer).toContain("1 long line searched only in its first 500 characters.")
  })

  it("does not find a match that starts after character 500 of a line and says one long line was cut", () => {
    const files = snapshotOf({ "min.js": `${"x".repeat(600)}foo\n` })
    expect(grep(files, { pattern: "foo" })).toBe(
      ["No match for /foo/ in 1 file.", "1 long line searched only in its first 500 characters."].join("\n"),
    )
  })

  it("counts the long lines across the files searched", () => {
    const long = `${"x".repeat(501)}\n`
    const files = snapshotOf({ "a.js": long.repeat(2), "b.js": long, "c.js": "short\n" })
    expect(grep(files, { pattern: "short" })).toBe(
      ["c.js:1: short", "3 long lines searched only in their first 500 characters."].join("\n"),
    )
  })

  it("does not count a line of exactly 500 characters as long", () => {
    const files = snapshotOf({ "a.js": `${"x".repeat(500)}\n` })
    expect(grep(files, { pattern: "x{500}" })).not.toContain("long line")
  })

  it("does not count a CRLF line of exactly 500 characters as long", () => {
    const files = snapshotOf({ "a.js": `${"x".repeat(500)}\r\n` })
    expect(grep(files, { pattern: "x{500}" })).not.toContain("long line")
  })

  it("searches every file however many long lines a quantified pattern tests", () => {
    const longLine = `${"x".repeat(399)}\n`
    const contents = { ...numbered(600, longLine.repeat(2)), "f599.ts": `needle${"x".repeat(394)}\n` }
    expect(grep(snapshotOf(contents), { pattern: "needle+" })).toBe(
      `f599.ts:1: needle${"x".repeat(MAX_LINE_CHARS - 6)}`,
    )
  })

  it("keeps the long-line note inside the 12,000-character budget", () => {
    const files = snapshotOf({ "a.ts": `${"x".repeat(250)}\n`.repeat(90), "b.js": `${"y".repeat(600)}\n` })
    const answer = grep(files, { pattern: "x" })
    expect(answer.length).toBeLessThanOrEqual(MAX_GREP_CHARS)
    expect(answer).toContain("1 long line searched only")
  })

  it("answers a backtracking-prone pattern over one very long line in under a second", () => {
    const files = snapshotOf({ "min.js": `${"x".repeat(200_000)}\n` })
    const started = performance.now()
    grep(files, { pattern: String.raw`[\s\S]*foo` })
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it("answers an accepted alternation over 300 lines of 400 characters in under a second", () => {
    const line = "  .set(getValue(key), setValue(value)) ; ".repeat(10).slice(0, 400)
    const files = snapshotOf({ "a.ts": `${line}\n`.repeat(300) })
    const started = performance.now()
    const answer = grep(files, { pattern: String.raw`(get|set)Value\s*\(\s*(key|val)ue?zzz` })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(answer).toContain("No match")
  })

  it("answers a pattern that spans lines over 20,000 short lines in under a second with no match", () => {
    const files = snapshotOf({ "big.txt": "foo line\n".repeat(20_000) })
    const started = performance.now()
    const answer = grep(files, { pattern: String.raw`[\s\S]*bar` })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(answer).toBe("No match for /[\\s\\S]*bar/ in 1 file.")
  })

  it.each([
    "zzzz_no_match",
    "foo.*bar",
    String.raw`\bcreateElement\(`,
    String.raw`[\s\S]*zzz`,
    String.raw`(.\w?)*zzz`,
    String.raw`(.|\s)*zzz`,
    String.raw`[\w ,.]*[\w ,.]*[\w ,.]*;;`,
    ".{0,400}e.{0,400}t.{0,400}zzz",
    "(a+)+zzz",
    ".*a.*b.*zzz",
    ".{1,}e.{1,}zzz",
  ])("searches %s over 300 lines of 400 characters in well under a second", (pattern) => {
    const line = "  .set(getValue(key), setValue(value)) ; ".repeat(10).slice(0, 400)
    const files = snapshotOf({ "a.ts": `${line}\n`.repeat(300) })
    const started = performance.now()
    const answer = grep(files, { pattern })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(answer).toBe(`No match for /${pattern}/ in 1 file.`)
  })

  it("searches a lookbehind, which the engine does not support, as literal text", () => {
    const files = snapshotOf({ "a.ts": "ab\nx (?<=a)b\n" })
    expect(grep(files, { pattern: "(?<=a)b" })).toBe(
      ["Searched for the literal text `(?<=a)b` (not a pattern this search supports).", "a.ts:2: x (?<=a)b"].join("\n"),
    )
  })

  it("stops before a line whose worst case would pass the work budget, and says how many files it searched", () => {
    expect(worstWork(engineOf(SPRAWLING), MAX_SEARCHED_LINE_CHARS)).toBeGreaterThan(MAX_SEARCH_WORK)
    const contents = {
      "a.ts": "short line\n",
      "b.ts": `${"x".repeat(MAX_SEARCHED_LINE_CHARS)}\n`,
      "c.ts": `${LETTERS}zzz\n`,
    }
    expect(grep(snapshotOf(contents), { pattern: SPRAWLING })).toBe(
      [
        `No match for /${SPRAWLING}/ in 1 file.`,
        "Stopped early after 1 file: this pattern costs too much to search everything. Narrow the path or glob, or use a simpler pattern (wide bounded repeats such as .{0,400} are the costly kind).",
      ].join("\n"),
    )
  })

  it("leaves an ordinary pattern the budget for a vscode-size repository, at seven times react's characters and lines", () => {
    const pattern = String.raw`\bcreateElement\(`
    const reactUnits = 36_092_141 + (1 + LINE_UNITS) * 1_179_032
    expect(7 * reactUnits + 100 * engineOf(pattern).stateWork).toBeLessThan(MAX_SEARCH_WORK)
    const files = snapshotOf(numbered(10, `${"  const element = render(props) ;".repeat(15)}\n`.repeat(500)))
    expect(grep(files, { pattern })).toBe(`No match for /${pattern}/ in 10 files.`)
  })

  it("searches a line whose worst case lands exactly on the budget and stops at one unit over", () => {
    const engine = engineOf(SPRAWLING)
    let length = MAX_SEARCHED_LINE_CHARS
    while (worstWork(engine, length) > MAX_SEARCH_WORK) length--
    expect(length).toBeGreaterThan(LETTERS.length + 3)
    const filler = fillerLines(MAX_SEARCH_WORK - worstWork(engine, length) - 1 - LINE_UNITS, length)
    const last = `${LETTERS}zzz`.padEnd(length, "x")
    const atBudget = grep(snapshotOf({ "a.ts": ["", ...filler, last].join("\n") }), { pattern: SPRAWLING })
    expect(atBudget).toBe(`a.ts:${filler.length + 2}: ${last.slice(0, MAX_LINE_CHARS)}`)
    const overBudget = grep(snapshotOf({ "a.ts": ["x", ...filler, last].join("\n") }), { pattern: SPRAWLING })
    expect(overBudget).toContain("Stopped early after 1 file: this pattern costs too much")
    expect(overBudget).not.toContain("a.ts:")
  })

  it("stops a one-pass pattern, which re2js runs without its DFA, once its work passes the budget", () => {
    const pattern = `^(?:${"()".repeat(240)}a)*$`
    const line = "  const element = render(props.item, index) + offset; return element;"
    const linesWithinBudget = Math.floor(MAX_SEARCH_WORK / worstWork(engineOf(pattern), line.length))
    const linesPerFile = Math.ceil((linesWithinBudget + 1) / 5)
    const lines = Array.from({ length: linesPerFile }, () => line).join("\n")
    const contents = { ...numbered(10, lines), "f009.ts": `${lines}\naaa` }
    const charged = Math.ceil(linesWithinBudget / linesPerFile)
    expect(grep(snapshotOf(contents), { pattern })).toBe(
      [
        `No match for /${pattern}/ in ${charged} files.`,
        `Stopped early after ${charged} files: this pattern costs too much to search everything. Narrow the path or glob, or use a simpler pattern (wide bounded repeats such as .{0,400} are the costly kind).`,
      ].join("\n"),
    )
  })

  it.each([String.raw`(a)\1`, "(.{0,99}e){0,999}"])(
    "searches %s, which re2js cannot compile, as literal text",
    (pattern) => {
      const files = snapshotOf({ "a.ts": `aa\nx ${pattern}\n` })
      expect(grep(files, { pattern })).toBe(
        [
          `Searched for the literal text \`${pattern}\` (not a pattern this search supports).`,
          `a.ts:2: x ${pattern}`,
        ].join("\n"),
      )
    },
  )

  it("reads JavaScript escapes such as \\u0041 the way a JavaScript regular expression does", () => {
    const files = snapshotOf({ "a.ts": "Apple\nbanana\n" })
    expect(grep(files, { pattern: "^\\u0041" })).toBe("a.ts:1: Apple")
  })
})

describe("patternProblem", () => {
  it("refuses a pattern over 500 characters", () => {
    expect(patternProblem("a".repeat(501))).toContain("500")
    expect(patternProblem("a".repeat(500))).toBeUndefined()
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

  it("says a capped snapshot is incomplete", () => {
    const files = finished(snapshotOf({ "a.ts": "" }), { capped: true, treeTruncated: false })
    expect(tree(files)).toBe(["a.ts", CAPPED].join("\n"))
  })

  it("says a snapshot of a truncated tree is incomplete, even when nothing is under the path", () => {
    const files = finished(snapshotOf({ "a.ts": "" }), { capped: false, treeTruncated: true })
    expect(tree(files, "nowhere")).toBe(["No files under `nowhere` in the snapshot.", TRUNCATED].join("\n"))
  })
})
