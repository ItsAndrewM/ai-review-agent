import { describe, expect, it } from "vitest"
import { plural, were } from "../src/review/copy.ts"

describe("plural", () => {
  it("adds an s for every count but one, or the plural it is given", () => {
    expect(plural(1, "thread")).toBe("1 thread")
    expect(plural(0, "thread")).toBe("0 threads")
    expect(plural(2, "finding")).toBe("2 findings")
    expect(plural(3, "inline comment")).toBe("3 inline comments")
  })

  it("picks the verb for the count", () => {
    expect(were(1)).toBe("was")
    expect(were(3)).toBe("were")
    expect(were(0)).toBe("were")
  })
})
