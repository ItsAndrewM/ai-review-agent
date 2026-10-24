import { describe, expect, it } from "vitest"
import { corpusProblems } from "../tools/verify-replay/coverage.ts"
import { parseSet } from "../tools/verify-replay/schema.ts"
import { labelled } from "./verify-replay-fixtures.ts"

describe("parseSet", () => {
  it("rejects duplicate ids so one comment cannot carry two labels", () => {
    expect(() =>
      parseSet(JSON.stringify({ findings: [labelled("1", "keep"), labelled("1", "drop")], excluded: [] })),
    ).toThrow("Duplicate replay finding 1")
  })
})

describe("corpusProblems", () => {
  it("refuses measurement when a required label class has no recoverable historical findings", () => {
    expect(corpusProblems({ findings: [labelled("1", "keep")], excluded: [] })).toEqual(
      expect.arrayContaining([
        expect.stringContaining("drop"),
        expect.stringContaining("demote"),
        expect.stringContaining("promote"),
      ]),
    )
  })

  it("refuses a historical nitpick because production never sends it to verify", () => {
    expect(corpusProblems({ findings: [labelled("1", "drop", { severity: "nitpick" })], excluded: [] })).toEqual(
      expect.arrayContaining([expect.stringContaining("nitpick")]),
    )
  })
})
