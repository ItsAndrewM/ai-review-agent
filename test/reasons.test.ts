import { describe, expect, it } from "vitest"
import { budgetReason, checkReasons, omittedIn, type ApprovalReason } from "../src/review/reasons.ts"

const sources = { linkedIssues: [121, 122], title: "Not for merging: spike", body: "Do not merge\nuntil #120 lands." }

describe("checkReasons", () => {
  it("accepts an omitted requirement of a linked issue", () => {
    const checked = checkReasons(
      { omitted_requirements: [{ issue: 121, requirement: "Unit tests cover the basis check" }] },
      sources,
    )
    expect(checked).toEqual({
      accepted: [{ kind: "omitted_requirement", issue: 121, requirement: "Unit tests cover the basis check" }],
      rejected: [],
    })
  })

  it("rejects an omitted requirement of an issue that isn't linked, naming the linked ones", () => {
    const checked = checkReasons({ omitted_requirements: [{ issue: 7, requirement: "r" }] }, sources)
    expect(checked.accepted).toEqual([])
    expect(checked.rejected).toEqual([
      "omitted requirement for #7: #7 isn't a linked issue (linked: #121, #122); name the linked issue or drop it",
    ])
  })

  it("rejects every omitted requirement when no issue is linked", () => {
    const checked = checkReasons(
      { omitted_requirements: [{ issue: 121, requirement: "r" }] },
      { ...sources, linkedIssues: [] },
    )
    expect(checked.rejected).toEqual([
      "omitted requirement for #121: no issue is linked to this pull request, so nothing can be omitted; drop omitted_requirements",
    ])
  })

  it("accepts a not_for_merging line found in the body or the title, whatever the whitespace or case", () => {
    expect(checkReasons({ not_for_merging: "do  not merge" }, sources).accepted).toEqual([
      { kind: "not_for_merging", quote: "do  not merge" },
    ])
    expect(checkReasons({ not_for_merging: "NOT FOR MERGING: spike" }, sources).accepted).toEqual([
      { kind: "not_for_merging", quote: "NOT FOR MERGING: spike" },
    ])
  })

  it("rejects a not_for_merging line found in neither", () => {
    const checked = checkReasons({ not_for_merging: "WIP" }, { ...sources, body: null })
    expect(checked.accepted).toEqual([])
    expect(checked.rejected).toEqual([
      'not_for_merging "WIP": not found in the title or description; quote a line from them exactly, or omit it',
    ])
  })

  it("reads an absent omitted_requirements as none", () => {
    expect(checkReasons({}, sources)).toEqual({ accepted: [], rejected: [] })
  })
})

describe("budgetReason", () => {
  it("adds a budget reason only when a tool call was blocked", () => {
    expect(budgetReason(0, 10_000)).toBeUndefined()
    expect(budgetReason(2, 10_000)).toEqual({ kind: "budget_cut", budget: 10_000 })
  })
})

describe("omittedIn", () => {
  it("keeps the omitted requirements out of a mixed list, as the submission spelled them", () => {
    const reasons: ApprovalReason[] = [
      { kind: "not_for_merging", quote: "WIP" },
      { kind: "omitted_requirement", issue: 121, requirement: "a" },
      { kind: "budget_cut", budget: 10_000 },
      { kind: "omitted_requirement", issue: 122, requirement: "b" },
    ]
    expect(omittedIn(reasons)).toEqual([
      { issue: 121, requirement: "a" },
      { issue: 122, requirement: "b" },
    ])
  })
})
