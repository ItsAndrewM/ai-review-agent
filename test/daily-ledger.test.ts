import { describe, expect, it } from "vitest"
import {
  addIn,
  crossings,
  dailyBudgetOf,
  DEFAULT_DAILY_NEURONS,
  EMPTY_DAY,
  reservationOf,
  reservedOf,
  reserveIn,
  roomIn,
  settleIn,
  utcDay,
} from "../src/budget/ledger.ts"

describe("dailyBudgetOf", () => {
  it.each([undefined, "", "0", "-5", "1.5", "abc"])("falls back to the default for %s", (value) => {
    expect(dailyBudgetOf(value)).toBe(DEFAULT_DAILY_NEURONS)
    expect(DEFAULT_DAILY_NEURONS).toBe(200_000)
  })

  it("reads a positive whole number", () => {
    expect(dailyBudgetOf("5000")).toBe(5000)
  })
})

describe("reservationOf", () => {
  it("reserves the review's own budget when the day's cap is larger", () => {
    expect(reservationOf(10_000, 200_000)).toBe(10_000)
  })

  it("reserves the whole cap when it is smaller than one review's budget, so one review can still start", () => {
    expect(reservationOf(10_000, 4_000)).toBe(4_000)
  })
})

describe("utcDay", () => {
  it("changes at midnight UTC", () => {
    const lastMs = Date.UTC(2026, 10, 1, 23, 59, 59, 999)
    expect(utcDay(lastMs)).toBe("2026-11-01")
    expect(utcDay(lastMs + 1)).toBe("2026-11-02")
  })
})

describe("reserveIn", () => {
  it("grants reservations up to the cap and refuses the one that would pass it, leaving the day as it was", () => {
    const first = reserveIn(EMPTY_DAY, "a", 10_000, 25_000)
    const second = reserveIn(first.day, "b", 10_000, 25_000)
    const third = reserveIn(second.day, "c", 10_000, 25_000)
    expect([first.granted, second.granted, third.granted]).toEqual([true, true, false])
    expect(third.day).toEqual(second.day)
    expect(reservedOf(second.day)).toBe(20_000)
  })

  it("grants a reservation that reaches the cap exactly", () => {
    const day = { ...EMPTY_DAY, spent: 15_000 }
    expect(reserveIn(day, "a", 10_000, 25_000).granted).toBe(true)
  })

  it("grants a holder it already holds without counting it twice", () => {
    const once = reserveIn(EMPTY_DAY, "a", 10_000, 25_000).day
    const twice = reserveIn(once, "a", 10_000, 25_000)
    expect(twice.granted).toBe(true)
    expect(reservedOf(twice.day)).toBe(10_000)
  })
})

describe("settleIn", () => {
  it("swaps a held reservation for the review's real spend", () => {
    const held = reserveIn(EMPTY_DAY, "a", 10_000, 25_000).day
    const settled = settleIn(held, "a", 2_014, 120)
    expect(reservedOf(settled)).toBe(0)
    expect(settled.spent).toBe(2_014)
    expect(settled.sandboxSeconds).toBe(120)
  })

  it("adds the spend of a holder it never reserved, as a review started during a ledger outage", () => {
    const settled = settleIn(EMPTY_DAY, "unknown", 500, 0)
    expect(settled.spent).toBe(500)
  })
})

describe("roomIn and addIn", () => {
  it("leaves room for a question until spent and reserved reach the cap", () => {
    const held = reserveIn(EMPTY_DAY, "a", 10_000, 25_000).day
    expect(roomIn(addIn(held, 14_999), 25_000)).toBe(true)
    expect(roomIn(addIn(held, 15_000), 25_000)).toBe(false)
  })
})

describe("crossings", () => {
  it("warns once, the first time spent and reserved reach 80% of the cap", () => {
    const before = { ...EMPTY_DAY, spent: 7_000 }
    const after = { ...EMPTY_DAY, spent: 8_000 }
    const first = crossings(before, after, 10_000, false)
    expect(first.warn).toBe(true)
    expect(first.day.warned).toBe(true)
    const again = crossings(first.day, { ...first.day, spent: 9_000 }, 10_000, false)
    expect(again.warn).toBe(false)
  })

  it("doesn't warn below 80%", () => {
    expect(crossings(EMPTY_DAY, { ...EMPTY_DAY, spent: 7_999 }, 10_000, false).warn).toBe(false)
  })

  it("logs the day's first refusal once", () => {
    const first = crossings(EMPTY_DAY, EMPTY_DAY, 10_000, true)
    expect(first.refuse).toBe(true)
    expect(first.day.refused).toBe(true)
    expect(crossings(first.day, first.day, 10_000, true).refuse).toBe(false)
  })
})
