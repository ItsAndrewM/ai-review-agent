import { describe, expect, it } from "vitest"
import { chunked, firstItem, lastItem } from "../src/live-check.ts"

describe("lastItem", () => {
  it("returns the last item, or undefined for an empty list", () => {
    expect(lastItem([1, 2, 3])).toBe(3)
    expect(lastItem([])).toBeUndefined()
  })
})

describe("firstItem", () => {
  it("returns the first item, or undefined for an empty list", () => {
    expect(firstItem(["a", "b"])).toBe("a")
    expect(firstItem([])).toBeUndefined()
  })
})

describe("chunked", () => {
  it("splits a list into chunks of the given size, the last one shorter", () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunked([], 3)).toEqual([])
  })

  it("refuses a size that isn't a positive whole number", () => {
    expect(() => chunked([1], 0)).toThrow(RangeError)
    expect(() => chunked([1], 1.5)).toThrow(RangeError)
  })
})
