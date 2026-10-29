import { describe, expect, it } from "vitest"
import { acquire, liveLeases, MAX_SANDBOXES, release } from "../src/sandbox/lease.ts"

const NOW = 1_000_000
const TTL = 60_000

describe("acquire", () => {
  it("grants three distinct holders and refuses a fourth", () => {
    let state = {}
    for (const holder of ["a", "b", "c"]) {
      const next = acquire(state, holder, NOW, TTL)
      expect(next.granted).toBe(true)
      state = next.state
    }
    expect(Object.keys(state)).toHaveLength(MAX_SANDBOXES)
    const fourth = acquire(state, "d", NOW, TTL)
    expect(fourth.granted).toBe(false)
    expect(fourth.state).toEqual(state)
  })

  it("renews a holder it already holds without counting it twice", () => {
    const state = { a: NOW + 10, b: NOW + 10, c: NOW + 10 }
    const again = acquire(state, "a", NOW + 5, TTL)
    expect(again.granted).toBe(true)
    expect(again.state).toEqual({ a: NOW + 5 + TTL, b: NOW + 10, c: NOW + 10 })
  })

  it("drops an expired lease so a fourth holder gets its slot", () => {
    const state = { a: NOW - 1, b: NOW + 10, c: NOW + 10 }
    const fourth = acquire(state, "d", NOW, TTL)
    expect(fourth.granted).toBe(true)
    expect(fourth.state).toEqual({ b: NOW + 10, c: NOW + 10, d: NOW + TTL })
  })
})

describe("release", () => {
  it("frees the slot, and is a no-op for an unknown holder", () => {
    const state = { a: NOW + 10, b: NOW + 10 }
    expect(release(state, "a")).toEqual({ b: NOW + 10 })
    expect(release(state, "zz")).toEqual(state)
  })
})

describe("liveLeases", () => {
  it("keeps only leases that expire after now", () => {
    expect(liveLeases({ a: NOW, b: NOW + 1 }, NOW)).toEqual({ b: NOW + 1 })
  })
})
