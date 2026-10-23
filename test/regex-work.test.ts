import { RE2JS } from "re2js"
import { describe, expect, it } from "vitest"
import { engineFor, LINE_UNITS, meteredTest, prefilterScans } from "../src/repository/regex-work.ts"

const ALTERNATIONS = Array.from({ length: 32 }, (_, index) => `(?:P${index}a|Q${index}b)`).join("")

function alternationLine(): string {
  const words = Array.from({ length: 32 }, (_, index) => `P${index}a`).join(" ")
  return words.padStart(500, "-")
}

function slowLines(count: number, alphabet: string): string[] {
  let seed = 7
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  return Array.from({ length: count }, () =>
    Array.from({ length: 500 }, () => alphabet.charAt(Math.floor(next() * alphabet.length))).join(""),
  )
}

describe("meteredTest", () => {
  it("charges an ordinary pattern about one unit per character plus the line's fixed cost", () => {
    const engine = engineFor(RE2JS.compile(String.raw`\bcreateElement\(`))
    const lines = Array.from({ length: 2_000 }, (_, index) => `  const element${index} = render(props, ${index});`)
    const base = lines.reduce((sum, line) => sum + line.length + 1 + LINE_UNITS, 0)
    const work = lines.reduce((sum, line) => sum + meteredTest(engine, line).work, 0)
    expect(work).toBeGreaterThanOrEqual(base)
    expect(work - base).toBeLessThan(100 * engine.stateWork)
  })

  it("charges the states a pattern builds, so a thrashing pattern costs far more than its characters", () => {
    const engine = engineFor(RE2JS.compile(".{0,50}e.{0,50}[#@]{3}"))
    const [line = ""] = slowLines(1, "eeeeeeeeex")
    const tested = meteredTest(engine, line)
    expect(tested.cleared).toBe(false)
    expect(tested.work).toBeGreaterThan(100 * (line.length + 1))
  })

  it("sees the lazy DFA clear its cache and charges that line the fallback's worst case", () => {
    const engine = engineFor(RE2JS.compile(".{0,400}e.{0,400}t.{0,400}[#@]{3}"))
    const lines = slowLines(12, "eeeeeeeeext")
    const cleared = lines.map((line) => meteredTest(engine, line)).find((tested) => tested.cleared)
    expect(cleared?.work).toBeGreaterThanOrEqual(engine.stateWork * 501)
  })

  it("charges a literal, which the DFA never runs, one unit per character plus the line's fixed cost", () => {
    const engine = engineFor(RE2JS.compile("TODO"))
    expect(meteredTest(engine, "x".repeat(499)).work).toBe(500 + LINE_UNITS)
  })

  it("charges every line a fixed cost, so a file of empty lines isn't free", () => {
    const engine = engineFor(RE2JS.compile("TODO"))
    const work = Array.from({ length: 1_000 }, () => meteredTest(engine, "").work).reduce((sum, each) => sum + each, 0)
    expect(work).toBeGreaterThanOrEqual(1_000 * LINE_UNITS)
  })

  it("charges a program OnePass runs, which skips the DFA, its program size per character", () => {
    const regex = RE2JS.compile("^(?:()()()()()a)*$")
    const tested = meteredTest(engineFor(regex), "a".repeat(499))
    expect(tested.matched).toBe(true)
    expect(tested.work).toBeGreaterThanOrEqual(500 * regex.programSize())
  })

  it("charges a line under 32 all-exact alternation groups for each of the prefilter's automaton scans, even once the DFA is warm", () => {
    const line = alternationLine()
    const engine = engineFor(RE2JS.compile(ALTERNATIONS))
    meteredTest(engine, line)
    expect(meteredTest(engine, line).work).toBeGreaterThanOrEqual(LINE_UNITS + 32 * (line.length + 1))
  })

  it("charges each of 31 short substring scans past the third one unit per character, on a line built against indexOf", () => {
    const needles = Array.from({ length: 31 }, (_, index) => `aaaaa${"bcdefghijklmnopqrstuvwxyz01234".charAt(index)}`)
    const line = needles.join("").padStart(500, "a")
    const engine = engineFor(RE2JS.compile(needles.join(".*")))
    meteredTest(engine, line)
    expect(meteredTest(engine, line).work).toBeGreaterThanOrEqual(LINE_UNITS + 29 * (line.length + 1))
  })

  it("leaves a pattern with three substrings at one unit per character", () => {
    const line = "foo bar baz".padStart(500, "x")
    const engine = engineFor(RE2JS.compile("foo.*bar.*baz"))
    meteredTest(engine, line)
    expect(meteredTest(engine, line).work).toBe(LINE_UNITS + line.length + 1)
  })
})

describe("prefilterScans", () => {
  it.each([
    [ALTERNATIONS, 32, 32],
    ["foo.*bar", 2, 0],
    ["TODO", 1, 0],
    ["use(State|Effect|Memo)", 2, 1],
    [".*", 0, 0],
  ])("reads re2js's prefilter for %s as %i scans, %i of them automata", (pattern, cost, automata) => {
    expect(prefilterScans(RE2JS.compile(pattern))).toEqual({ cost, automata })
  })
})
