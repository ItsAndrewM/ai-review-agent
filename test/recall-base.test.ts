import { describe, expect, it } from "vitest"
import { diffBase } from "../tools/recall/base.ts"

describe("diffBase", () => {
  it("uses the merge-base of the merge commit's first parent and the head for a merged pull request", async () => {
    const asked: string[][] = []
    const mergeBase = async (left: string, right: string) => {
      asked.push([left, right])
      return "67b3e14"
    }
    const base = await diffBase(
      { mergedAt: "2026-10-23T17:09:00Z", mergeCommitSha: "0e4c23c" },
      "64d6ba6",
      "14fcf76",
      mergeBase,
    )
    expect(base).toBe("67b3e14")
    expect(asked).toEqual([["0e4c23c^1", "64d6ba6"]])
  })

  it("keeps the first commit's parent for a pull request that never merged", async () => {
    const mergeBase = async () => {
      throw new Error("not asked")
    }
    await expect(diffBase({ mergedAt: null, mergeCommitSha: null }, "eccf31d", "b45d534", mergeBase)).resolves.toBe(
      "b45d534",
    )
  })
})
