import { RE2JS } from "re2js"
import { describe, expect, it } from "vitest"
import { engineFor, LINE_UNITS, meteredTest } from "../src/repository/regex-work.ts"

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
})
