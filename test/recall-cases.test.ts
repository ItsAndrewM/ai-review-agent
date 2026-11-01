import { readFileSync } from "node:fs"
import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { cases } from "../tools/recall/cases.ts"
import { RecallSet, regexOf } from "../tools/recall/schema.ts"

function pattern(id: string): RegExp {
  const expected = cases.flatMap(({ expects }) => expects).find((candidate) => candidate.id === id)
  if (expected === undefined) throw new Error(`No case ${id}`)
  return regexOf(expected.pattern)
}

describe("case labels", () => {
  const all = cases.flatMap(({ expects }) => expects)
  const label = (expected: { id: string; severity: string }): string => `${expected.id}:${expected.severity}`

  it("pairs every expected finding's severity with its basis kind as the review's rule does", () => {
    const offending = all.filter((expected) =>
      expected.basis_kind === "defect" || expected.basis_kind === "spec"
        ? expected.severity !== "blocking" && expected.severity !== "major"
        : expected.severity === "blocking" || expected.severity === "major",
    )
    expect(offending.map(({ id }) => id)).toEqual([])
  })

  it("labels #112's two docs-against-code cases with the docs basis", () => {
    expect(all.filter(({ id }) => id.startsWith("112-")).map(({ basis_kind }) => basis_kind)).toEqual(["docs", "docs"])
  })

  it("freezes the set without a hand-written verdict and with the cases' labels, so the expected event is derived", () => {
    const parsed: unknown = JSON.parse(readFileSync(new URL("../tools/recall/set.json", import.meta.url), "utf8"))
    if (!Value.Check(RecallSet, parsed)) throw new Error("set.json is not a recall set")
    expect(parsed.heads.filter((head) => "verdict" in head)).toEqual([])
    expect(parsed.heads.flatMap((head) => head.expects).map(label)).toEqual(all.map(label))
  })
})

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
    [
      "38-1",
      "postedRetryText answers a boolean, so the host's refusal is only logged and reportUnpostedReview never says why",
      "test/models.test.ts covers the wrapper, prompts and the empty-walkthrough refusal, but nothing covers the new behaviour in src/pull-request.ts that parses the retry's JSON and posts it as retry_text; a regression there (e.g. a swapped argument or a dropped isPosted check) would ship silently",
    ],
    [
      "57-k1",
      "The run's summary says Details opens the summary comment even when detailsUrl is undefined",
      "The run's summary is one sentence pointing at Details; the Markdown the issue asks for never reaches the run, even when `detailsUrl` exists and the comment is one call away",
    ],
    [
      "152-1",
      "GitHub shows seven characters and the tests pin seven, so every rendered sha is now a character short",
      "The PR changes the observable behaviour of shortSha (7→6 characters), but no test in test/ references shortSha, so no test fails if this change breaks or is reverted. Add a small unit test asserting the expected six-character literal, so a future edit to the length fails loudly.",
    ],
  ])("%s matches the finding and not the decoy", (id, finding, decoy) => {
    expect(pattern(id).test(finding)).toBe(true)
    expect(pattern(id).test(decoy)).toBe(false)
  })
})
