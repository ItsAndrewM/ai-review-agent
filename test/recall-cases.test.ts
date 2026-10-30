import { describe, expect, it } from "vitest"
import { cases } from "../tools/recall/cases.ts"
import { regexOf } from "../tools/recall/schema.ts"

function pattern(id: string): RegExp {
  const expected = cases.flatMap(({ expects }) => expects).find((candidate) => candidate.id === id)
  if (expected === undefined) throw new Error(`No case ${id}`)
  return regexOf(expected.pattern)
}

describe("case patterns", () => {
  it.each([
    ["9-3", "The promise is not awaited, so a rejection is unhandled", "We await the pull request before posting"],
    [
      "54-1",
      "The elapsed ms carries the wrong sign: run.started minus now is negative",
      "A significant design change to the signal",
    ],
    [
      "57-k1",
      "The summary promises a Details link even when detailsUrl is undefined",
      "See the details of the check run record",
    ],
    ["105-1", "A donor entry without a mode carries a symlink's body", "The model reads the context in review mode"],
    ["66-k3", "The unreadable-ledger path ships without a test", "The new filter has no test"],
    [
      "143-1",
      "checkTimeoutOf returns number | undefined, not assignable to timeoutMs",
      "The caller may pass undefined paths",
    ],
    ["151-1", "A path with a `..` segment leaves the repository", "The run continues... and then stops"],
  ])("%s matches the finding and not the decoy", (id, finding, decoy) => {
    expect(pattern(id).test(finding)).toBe(true)
    expect(pattern(id).test(decoy)).toBe(false)
  })
})
