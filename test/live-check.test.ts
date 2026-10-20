import { expect, it } from "vitest"
import { lastItem } from "../src/live-check.ts"

it("returns the last item of a list", () => {
  expect(lastItem([1, 2, 3])).toBe(3)
})
