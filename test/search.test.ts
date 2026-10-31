import { RE2JS } from "re2js"
import { describe, expect, it } from "vitest"
import { engineFor, LINE_UNITS, worstWork, type Engine } from "../src/repository/regex-work.ts"
import {
  DEFAULT_TREE_DEPTH,
  grep,
  GrepWork,
  grepMentions,
  MAX_GREP_CHARS,
  MAX_LINE_CHARS,
  MAX_MATCHES,
  MAX_PATTERN_CHARS,
  MAX_RUN_SEARCH_WORK,
  MAX_SEARCH_CALLS,
  MAX_SEARCH_WORK,
  MAX_SEARCHED_LINE_CHARS,
  MAX_TREE_ENTRIES,
  patternProblem,
  tree,
  type GrepQuery,
} from "../src/repository/search.ts"
import { MemorySnapshotFiles, type LeftOut, type SnapshotFile, type SnapshotFiles } from "../src/repository/snapshot.ts"

const grepOnce = (files: SnapshotFiles, query: GrepQuery): string => grep(files, query, new GrepWork())

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

const LETTERS = "acegikmoqsu"

const SPRAWLING = `${Array.from(LETTERS, (letter) => `.{0,999}[${letter}${letter.toUpperCase()}]`).join("")}zzz`

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
      MAX_RUN_SEARCH_WORK,
    ]).toEqual([100, 12_000, 300, 500, 500, 2, 40, 500, 750_000_000, 3_000_000_000])
  })
})

class CountedFiles extends MemorySnapshotFiles {
  scans = 0

  override files(): Iterable<SnapshotFile> {
    this.scans += 1
    return super.files()
  }
}

describe("grep's run budget", () => {
  const counted = (): CountedFiles => {
    const files = new CountedFiles()
    files.add([{ path: "a.ts", content: "hit\nmiss\n" }])
    return files
  }

  it("charges every call's work to the run's total", () => {
    const work = new GrepWork()
    const files = counted()
    grep(files, { pattern: "hit" }, work)
    const once = work.units()
    grep(files, { pattern: "hit" }, work)
    expect(once).toBeGreaterThan(0)
    expect(work.units()).toBe(2 * once)
  })

  it("still searches while the total is a unit short of the run budget", () => {
    const work = new GrepWork()
    work.charge(MAX_RUN_SEARCH_WORK - 1)
    expect(grep(counted(), { pattern: "hit" }, work)).toBe("a.ts:1: hit")
    expect(work.spent()).toBe(true)
  })

  it("answers that grep's budget is spent, pointing at tree and read_file, and scans nothing once the total reaches the run budget", () => {
    const work = new GrepWork()
    work.charge(MAX_RUN_SEARCH_WORK)
    const files = counted()
    expect(grep(files, { pattern: "hit" }, work)).toBe(
      "Grep budget spent: this review's grep calls have searched as much as one review allows. Use tree or read_file.",
    )
    expect(files.scans).toBe(0)
    expect(work.units()).toBe(MAX_RUN_SEARCH_WORK)
  })

  it("refuses a bad pattern before checking the total, so the model learns what was wrong with it", () => {
    const work = new GrepWork()
    work.charge(MAX_RUN_SEARCH_WORK)
    expect(grep(counted(), { pattern: "" }, work)).toBe("The pattern is empty.")
  })
})

describe("grepMentions", () => {
  const docs = snapshotOf({
    "docs/design.md": "The tools live in src/review/tools.ts.\nAnother line.\nsrc/review/tools.ts again\n",
    "README.md": "See src/review/tools.ts for the tools.\n",
    "src/review/tools.ts": "export const tools = 1 // src/review/tools.ts\n",
  })

  it("answers structured hits, path then line, for the files the selector accepts", () => {
    const work = new GrepWork()
    const hits = grepMentions(docs, (path) => path.endsWith(".md"), "src/review/tools.ts", work)
    expect(hits).toEqual([
      { path: "README.md", line: 1, text: "See src/review/tools.ts for the tools." },
      { path: "docs/design.md", line: 1, text: "The tools live in src/review/tools.ts." },
      { path: "docs/design.md", line: 3, text: "src/review/tools.ts again" },
    ])
    expect(work.units()).toBeGreaterThan(0)
  })

  it("answers nothing once the review's search work is spent", () => {
    const work = new GrepWork()
    work.charge(Number.MAX_SAFE_INTEGER)
    expect(grepMentions(docs, () => true, "tools", work)).toEqual([])
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
    expect(grepOnce(repository, { pattern: "target" })).toBe(
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
    expect(grepOnce(repository, { pattern: "^line$" })).toBe("src/a.ts:2: line")
  })

  it("filters by path", () => {
    const answer = grepOnce(repository, { pattern: "target", path: "src/deep" })
    expect(answer).toBe("src/deep/c.ts:1: target()")
  })

  it("does not take a sibling directory with the same prefix for the path", () => {
    const files = snapshotOf({ "src/a.ts": "x\n", "src-old/a.ts": "x\n" })
    expect(grepOnce(files, { pattern: "x", path: "src" })).toBe("src/a.ts:1: x")
  })

  it("gives the same answer for ./src/ and src", () => {
    expect(grepOnce(repository, { pattern: "target", path: "./src/" })).toBe(
      grepOnce(repository, { pattern: "target", path: "src" }),
    )
  })

  it("searches the whole repository for . and an empty path", () => {
    const whole = grepOnce(repository, { pattern: "target" })
    expect(grepOnce(repository, { pattern: "target", path: "." })).toBe(whole)
    expect(grepOnce(repository, { pattern: "target", path: "" })).toBe(whole)
  })

  it("matches *.ts against files in any directory", () => {
    const answer = grepOnce(repository, { pattern: "target", glob: "*.ts" })
    expect(answer).toContain("src/deep/c.ts:1")
    expect(answer).toContain("test/a.ts:1")
  })

  it("keeps src/**/*.ts away from test/a.ts", () => {
    const answer = grepOnce(repository, { pattern: "target", glob: "src/**/*.ts" })
    expect(answer).toContain("src/deep/c.ts:1")
    expect(answer).not.toContain("test/a.ts")
  })

  it("combines path and glob", () => {
    const answer = grepOnce(repository, { pattern: "target", path: "src", glob: "a.ts" })
    expect(answer).toBe("src/a.ts:1: const target = 1\nsrc/a.ts:3: let target = 3")
  })

  it("stops at 100 matches and counts what it did not show", () => {
    const files = snapshotOf(numbered(4, "hit\n".repeat(40)))
    const lines = grepOnce(files, { pattern: "hit" }).split("\n")
    expect(lines).toHaveLength(MAX_MATCHES + 1)
    expect(lines.at(-1)).toBe("… 60 more matches in 2 files not shown.")
  })

  it("counts a file once however many of its matches are hidden", () => {
    const files = snapshotOf({ "a.ts": "hit\n".repeat(105) })
    expect(grepOnce(files, { pattern: "hit" }).split("\n").at(-1)).toBe("… 5 more matches in 1 file not shown.")
  })

  it("cuts the answer at 12,000 characters with a note", () => {
    const files = snapshotOf({ "a.ts": `${"x".repeat(250)}\n`.repeat(90) })
    const answer = grepOnce(files, { pattern: "x" })
    expect(answer.length).toBeLessThanOrEqual(MAX_GREP_CHARS)
    expect(answer).toMatch(/\n… \d+ more matches in 1 file not shown\.$/)
  })

  it("keeps the answer under 12,000 characters with the left-out note", () => {
    const files = snapshotOf({ "a.ts": `${"x".repeat(250)}\n`.repeat(90) }, [
      { path: "dist/app.js", reason: "too_large" },
    ])
    const answer = grepOnce(files, { pattern: "x" })
    expect(answer.length).toBeLessThanOrEqual(MAX_GREP_CHARS)
    expect(answer).toContain("Not searched: 1 file left out of the snapshot (too_large: dist/app.js).")
  })

  it("cuts a line at 300 characters and drops a trailing carriage return", () => {
    const files = snapshotOf({ "a.ts": `${"y".repeat(400)}\r\nshort\r\n` })
    const lines = grepOnce(files, { pattern: "y|short" }).split("\n")
    expect(lines[0]).toBe(`a.ts:1: ${"y".repeat(MAX_LINE_CHARS)}`)
    expect(lines[1]).toBe("a.ts:2: short")
  })

  it("searches a pattern that does not compile as literal text", () => {
    const files = snapshotOf({ "a.ts": "answerPrompt(x)\nanswerPrompt\n" })
    expect(grepOnce(files, { pattern: "answerPrompt(" })).toBe(
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
    expect(grepOnce(files, { pattern: "hit" })).toBe(
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
    expect(grepOnce(files, { pattern: "hit" }).split("\n").at(-1)).toBe(
      `Not searched: 13 files left out of the snapshot (too_large: ${examples}; and 3 more).`,
    )
  })

  it("shortens a long left-out path to its last 200 characters, so the note can't crowd out the matches", () => {
    const leftOut = Array.from({ length: 10 }, (_, index): LeftOut => ({
      path: `${"deep/".repeat(600)}${index}.js`,
      reason: "too_large",
    }))
    const hits = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`f${index}.ts`, `hit ${"y".repeat(90)}\n`]),
    )
    const answer = grepOnce(snapshotOf(hits, leftOut), { pattern: "hit" })
    const note = answer.split("\n").at(-1) ?? ""
    expect(note).toContain(`too_large: …${"deep/".repeat(40).slice(-195)}0.js, …`)
    expect(note.length).toBeLessThan(2_200)
    expect(answer.length).toBeLessThanOrEqual(MAX_GREP_CHARS)
    expect(answer.split("\n").filter((line) => line.startsWith("f")).length).toBeGreaterThan(80)
  })

  it("only lists left-out paths the path and glob select", () => {
    const files = snapshotOf({ "src/a.ts": "hit\n" }, [
      { path: "dist/app.js", reason: "too_large" },
      { path: "src/logo.png", reason: "binary" },
    ])
    const answer = grepOnce(files, { pattern: "hit", path: "src" })
    expect(answer).toContain("(binary: src/logo.png)")
    expect(answer).not.toContain("dist/app.js")
    expect(grepOnce(files, { pattern: "hit", glob: "*.ts" })).not.toContain("Not searched")
  })

  it("says no match with the file count", () => {
    const files = snapshotOf(numbered(12, "nothing\n"))
    expect(grepOnce(files, { pattern: "x" })).toBe("No match for /x/ in 12 files.")
  })

  it("says no match for one file in the singular", () => {
    expect(grepOnce(snapshotOf({ "a.ts": "nothing\n" }), { pattern: "x" })).toBe("No match for /x/ in 1 file.")
  })

  it("adds the left-out note to a search with no match", () => {
    const files = snapshotOf(numbered(12, "nothing\n"), [
      { path: "dist/app.js", reason: "too_large" },
      { path: "logo.png", reason: "binary" },
    ])
    expect(grepOnce(files, { pattern: "x" })).toBe(
      [
        "No match for /x/ in 12 files.",
        "Not searched: 2 files left out of the snapshot (too_large: dist/app.js; binary: logo.png).",
      ].join("\n"),
    )
  })

  it("says a capped snapshot is incomplete under the matches", () => {
    const files = finished(snapshotOf({ "a.ts": "hit\n" }), { capped: true, treeTruncated: false })
    expect(grepOnce(files, { pattern: "hit" })).toBe(["a.ts:1: hit", CAPPED].join("\n"))
  })

  it("says a snapshot of a truncated tree is incomplete when nothing matches", () => {
    const files = finished(snapshotOf({ "a.ts": "nothing\n" }), { capped: false, treeTruncated: true })
    expect(grepOnce(files, { pattern: "hit" })).toBe(["No match for /hit/ in 1 file.", TRUNCATED].join("\n"))
  })

  it("gives both reasons when the snapshot is capped and the tree truncated", () => {
    const files = finished(snapshotOf({ "a.ts": "nothing\n" }), { capped: true, treeTruncated: true })
    expect(grepOnce(files, { pattern: "hit" }).split("\n").at(-1)).toBe(
      "The snapshot is incomplete (cap of 50,000 files or 400 MB reached; GitHub truncated the tree listing); a missing match may be in a file it didn't load.",
    )
  })

  it("says nothing of completeness for a complete snapshot", () => {
    const files = finished(snapshotOf({ "a.ts": "hit\n" }), { capped: false, treeTruncated: false })
    expect(grepOnce(files, { pattern: "hit" })).toBe("a.ts:1: hit")
  })

  it("keeps the incomplete-snapshot note inside the 12,000-character budget", () => {
    const files = finished(
      snapshotOf({ "a.ts": `${"x".repeat(250)}\n`.repeat(90) }, [{ path: "dist/app.js", reason: "too_large" }]),
      { capped: true, treeTruncated: true },
    )
    const answer = grepOnce(files, { pattern: "x" })
    expect(answer.length).toBeLessThanOrEqual(MAX_GREP_CHARS)
    expect(answer).toContain("The snapshot is incomplete (")
  })

  it("warns that $ can match where a long line was cut", () => {
    const files = snapshotOf({ "min.js": `${"a".repeat(600)}\n` })
    expect(grepOnce(files, { pattern: "a$" })).toBe(
      [
        `min.js:1: ${"a".repeat(300)}`,
        "1 long line searched only in its first 500 characters, so `$` and `\\b` can match at the cut.",
      ].join("\n"),
    )
  })

  it("doesn't search the empty line after a file's final newline", () => {
    expect(grepOnce(snapshotOf({ "a.ts": "a\nb\n" }), { pattern: "^$" })).toBe("No match for /^$/ in 1 file.")
    expect(grepOnce(snapshotOf({ "a.ts": "a\r\n" }), { pattern: "^$" })).toBe("No match for /^$/ in 1 file.")
    expect(grepOnce(snapshotOf({ "a.ts": "a\n\nb\n" }), { pattern: "^$" })).toBe("a.ts:2: ")
    expect(grepOnce(snapshotOf({ "a.ts": "a\nb" }), { pattern: "^b$" })).toBe("a.ts:2: b")
  })

  it("counts an empty file as searched without finding a line in it", () => {
    expect(grepOnce(snapshotOf({ "empty.ts": "", "a.ts": "a\n" }), { pattern: "^$" })).toBe(
      "No match for /^$/ in 2 files.",
    )
  })

  it("finds a match within the first 500 characters of a very long line", () => {
    const files = snapshotOf({ "min.js": `foo${"x".repeat(50_000)}\n` })
    const answer = grepOnce(files, { pattern: "foo" })
    expect(answer).toContain("min.js:1: foo")
    expect(answer).toContain(
      "1 long line searched only in its first 500 characters, so `$` and `\\b` can match at the cut.",
    )
  })

  it("does not find a match that starts after character 500 of a line and says one long line was cut", () => {
    const files = snapshotOf({ "min.js": `${"x".repeat(600)}foo\n` })
    expect(grepOnce(files, { pattern: "foo" })).toBe(
      [
        "No match for /foo/ in 1 file.",
        "1 long line searched only in its first 500 characters, so `$` and `\\b` can match at the cut.",
      ].join("\n"),
    )
  })

  it("counts the long lines across the files searched", () => {
    const long = `${"x".repeat(501)}\n`
    const files = snapshotOf({ "a.js": long.repeat(2), "b.js": long, "c.js": "short\n" })
    expect(grepOnce(files, { pattern: "short" })).toBe(
      [
        "c.js:1: short",
        "3 long lines searched only in their first 500 characters, so `$` and `\\b` can match at the cut.",
      ].join("\n"),
    )
  })

  it("does not count a line of exactly 500 characters as long", () => {
    const files = snapshotOf({ "a.js": `${"x".repeat(500)}\n` })
    expect(grepOnce(files, { pattern: "x{500}" })).not.toContain("long line")
  })

  it("does not count a CRLF line of exactly 500 characters as long", () => {
    const files = snapshotOf({ "a.js": `${"x".repeat(500)}\r\n` })
    expect(grepOnce(files, { pattern: "x{500}" })).not.toContain("long line")
  })

  it("searches every file however many long lines a quantified pattern tests", () => {
    const longLine = `${"x".repeat(399)}\n`
    const contents = { ...numbered(600, longLine.repeat(2)), "f599.ts": `needle${"x".repeat(394)}\n` }
    expect(grepOnce(snapshotOf(contents), { pattern: "needle+" })).toBe(
      `f599.ts:1: needle${"x".repeat(MAX_LINE_CHARS - 6)}`,
    )
  })

  it("keeps the long-line note inside the 12,000-character budget", () => {
    const files = snapshotOf({ "a.ts": `${"x".repeat(250)}\n`.repeat(90), "b.js": `${"y".repeat(600)}\n` })
    const answer = grepOnce(files, { pattern: "x" })
    expect(answer.length).toBeLessThanOrEqual(MAX_GREP_CHARS)
    expect(answer).toContain("1 long line searched only")
  })

  it("answers a backtracking-prone pattern over one very long line, searching only its first 500 characters", () => {
    const files = snapshotOf({ "min.js": `${"x".repeat(200_000)}\n` })
    expect(grepOnce(files, { pattern: String.raw`[\s\S]*foo` })).toBe(
      "No match for /[\\s\\S]*foo/ in 1 file.\n1 long line searched only in its first 500 characters, so `$` and `\\b` can match at the cut.",
    )
  })

  it("answers an accepted alternation over 300 lines of 400 characters", () => {
    const line = "  .set(getValue(key), setValue(value)) ; ".repeat(10).slice(0, 400)
    const files = snapshotOf({ "a.ts": `${line}\n`.repeat(300) })
    const answer = grepOnce(files, { pattern: String.raw`(get|set)Value\s*\(\s*(key|val)ue?zzz` })
    expect(answer).toContain("No match")
  })

  it("answers a pattern that spans lines over 20,000 short lines with no match", () => {
    const files = snapshotOf({ "big.txt": "foo line\n".repeat(20_000) })
    const answer = grepOnce(files, { pattern: String.raw`[\s\S]*bar` })
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
    const answer = grepOnce(files, { pattern })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(answer).toBe(`No match for /${pattern}/ in 1 file.`)
  })

  it("searches a lookbehind, which the engine does not support, as literal text", () => {
    const files = snapshotOf({ "a.ts": "ab\nx (?<=a)b\n" })
    expect(grepOnce(files, { pattern: "(?<=a)b" })).toBe(
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
    expect(grepOnce(snapshotOf(contents), { pattern: SPRAWLING })).toBe(
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
    expect(grepOnce(files, { pattern })).toBe(`No match for /${pattern}/ in 10 files.`)
  })

  it("searches a line whose worst case lands exactly on the budget and stops at one unit over", () => {
    const engine = engineOf(SPRAWLING)
    let length = MAX_SEARCHED_LINE_CHARS
    while (worstWork(engine, length) > MAX_SEARCH_WORK) length--
    expect(length).toBeGreaterThan(LETTERS.length + 3)
    const filler = fillerLines(MAX_SEARCH_WORK - worstWork(engine, length) - 1 - LINE_UNITS, length)
    const last = `${LETTERS}zzz`.padEnd(length, "x")
    const atBudget = grepOnce(snapshotOf({ "a.ts": ["", ...filler, last].join("\n") }), { pattern: SPRAWLING })
    expect(atBudget).toBe(`a.ts:${filler.length + 2}: ${last.slice(0, MAX_LINE_CHARS)}`)
    const overBudget = grepOnce(snapshotOf({ "a.ts": ["x", ...filler, last].join("\n") }), { pattern: SPRAWLING })
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
    expect(grepOnce(snapshotOf(contents), { pattern })).toBe(
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
      expect(grepOnce(files, { pattern })).toBe(
        [
          `Searched for the literal text \`${pattern}\` (not a pattern this search supports).`,
          `a.ts:2: x ${pattern}`,
        ].join("\n"),
      )
    },
  )

  it("reads JavaScript escapes such as \\u0041 the way a JavaScript regular expression does", () => {
    const files = snapshotOf({ "a.ts": "Apple\nbanana\n" })
    expect(grepOnce(files, { pattern: "^\\u0041" })).toBe("a.ts:1: Apple")
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
