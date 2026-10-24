import { describe, expect, it } from "vitest"
import { ReplayTools } from "../tools/verify-replay/tools.ts"
import { verdict } from "./verify-replay-fixtures.ts"

function host() {
  const reads: string[] = []
  return {
    reads,
    readFile: async ({ path }: { path: string }) => {
      reads.push(path)
      return `${path} contents`
    },
    grep: async ({ pattern }: { pattern: string }) => `match ${pattern}`,
    tree: async ({ path }: { path?: string }) => `tree ${path ?? "."}`,
  }
}

describe("ReplayTools", () => {
  it("returns the same budget refusal after ten read/search calls, without reading an eleventh file", async () => {
    const source = host()
    const tools = new ReplayTools(source)
    for (let index = 0; index < 10; index++) {
      expect(await tools.execute("read_file", { path: `src/${index}.ts` })).toBe(`src/${index}.ts contents`)
    }
    expect(await tools.execute("grep", { pattern: "x" })).toContain("tool budget of 10 calls is spent")
    expect(source.reads).toHaveLength(10)
  })

  it("accepts a structured submit_verdicts call without spending a read", async () => {
    const tools = new ReplayTools(host())
    expect(await tools.execute("submit_verdicts", { verdicts: [verdict("1", false)] })).toBe("Recorded 1 verdict.")
    expect(tools.verdicts()).toEqual([verdict("1", false)])
  })

  it("does not call a tool with malformed arguments or accept a malformed verdict", async () => {
    const source = host()
    const tools = new ReplayTools(source)
    expect(await tools.execute("read_file", { path: 3 })).toContain("Invalid arguments")
    expect(await tools.execute("submit_verdicts", { verdicts: [{ finding: "1", keep: "yes" }] })).toContain(
      "Invalid arguments",
    )
    expect(source.reads).toEqual([])
    expect(tools.verdicts()).toBeUndefined()
  })

  it("does not replace the first submission with a second one", async () => {
    const tools = new ReplayTools(host())
    await tools.execute("submit_verdicts", { verdicts: [verdict("1", true)] })
    await tools.execute("submit_verdicts", { verdicts: [verdict("1", false)] })
    expect(tools.verdicts()).toEqual([verdict("1", true)])
  })
})
