import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import {
  addQuestion,
  ledgerHolder,
  questionRoom,
  reserveReview,
  settleReview,
  type DayStore,
} from "../src/budget/daily.ts"
import { DayAccount, type DayRecord } from "../src/budget/day-account.ts"
import { EMPTY_DAY, type DayLedger } from "../src/budget/ledger.ts"

const LAST_MS_OF_NOV_1 = Date.UTC(2026, 10, 1, 23, 59, 59, 999)

class MemoryRecord implements DayRecord {
  day: DayLedger = EMPTY_DAY
  async read(): Promise<DayLedger> {
    return this.day
  }
  async write(day: DayLedger): Promise<void> {
    this.day = day
  }
}

function memoryDays() {
  const records = new Map<string, MemoryRecord>()
  const recordOf = (day: string) => {
    const record = records.get(day) ?? new MemoryRecord()
    records.set(day, record)
    return record
  }
  return { stores: (day: string): DayStore => new DayAccount(recordOf(day), day), recordOf }
}

const BROKEN: DayStore = {
  reserve: () => Promise.reject(new Error("overloaded")),
  settle: () => Promise.reject(new Error("overloaded")),
  room: () => Promise.reject(new Error("overloaded")),
  add: () => Promise.reject(new Error("overloaded")),
}

let logged: MockInstance<typeof console.log>
let errors: MockInstance<typeof console.error>

beforeEach(() => {
  logged = vi.spyOn(console, "log").mockImplementation(() => undefined)
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  logged.mockRestore()
  errors.mockRestore()
})

const events = (spy: MockInstance<typeof console.log>) => spy.mock.calls.map(([line]) => JSON.parse(String(line)))

describe("reserveReview and settleReview", () => {
  it("charges a review that crosses midnight UTC to the day it started", async () => {
    const days = memoryDays()
    const reserved = await reserveReview(days.stores, "o/r#1:d", 10_000, 200_000, LAST_MS_OF_NOV_1)
    expect(reserved).toEqual({ kind: "granted", ledger: { day: "2026-11-01", holder: "o/r#1:d", reserved: 10_000 } })
    if (reserved.kind !== "granted") return
    await settleReview(days.stores, reserved.ledger, 2_014, 30)
    expect(days.recordOf("2026-11-01").day).toMatchObject({ spent: 2_014, sandboxSeconds: 30, reservations: {} })
    expect(days.recordOf("2026-11-02").day).toEqual(EMPTY_DAY)
    expect(events(logged)).toContainEqual(
      expect.objectContaining({ event: "budget.settled", holder: "o/r#1:d", neurons: 2_014, spent: 2_014 }),
    )
  })

  it("refuses past the cap with the day's spend, and logs the day's first refusal once", async () => {
    const days = memoryDays()
    await reserveReview(days.stores, "a", 10_000, 15_000, LAST_MS_OF_NOV_1)
    const refused = await reserveReview(days.stores, "b", 10_000, 15_000, LAST_MS_OF_NOV_1)
    await reserveReview(days.stores, "c", 10_000, 15_000, LAST_MS_OF_NOV_1)
    expect(refused).toEqual({ kind: "refused", day: "2026-11-01", spent: 0, reserved: 10_000 })
    const spentEvents = events(logged).filter((line) => line.event === "budget.daily_spent")
    expect(spentEvents).toEqual([
      { event: "budget.daily_spent", day: "2026-11-01", spent: 0, reserved: 10_000, cap: 15_000 },
    ])
  })

  it("logs the 80% warning once", async () => {
    const days = memoryDays()
    await reserveReview(days.stores, "a", 8_000, 10_000, LAST_MS_OF_NOV_1)
    await reserveReview(days.stores, "b", 1_000, 10_000, LAST_MS_OF_NOV_1)
    expect(events(logged).filter((line) => line.event === "budget.daily_warning")).toHaveLength(1)
  })

  it("settles nothing for a review that started uncounted", async () => {
    const days = memoryDays()
    await settleReview(days.stores, undefined, 2_014, 30)
    expect(days.recordOf("2026-11-01").day).toEqual(EMPTY_DAY)
  })
})

describe("questions", () => {
  it("has room until the day's spend reaches the cap, and adds a question's spend", async () => {
    const days = memoryDays()
    expect(await questionRoom(days.stores, 1_000, LAST_MS_OF_NOV_1)).toBe(true)
    await addQuestion(days.stores, 1_000, LAST_MS_OF_NOV_1)
    expect(days.recordOf("2026-11-01").day.spent).toBe(1_000)
    expect(await questionRoom(days.stores, 1_000, LAST_MS_OF_NOV_1)).toBe(false)
  })
})

describe("a ledger that can't be reached", () => {
  it("lets reviews and questions run uncounted and logs each failure", async () => {
    const stores = () => BROKEN
    expect(await reserveReview(stores, "a", 10_000, 200_000, LAST_MS_OF_NOV_1)).toEqual({ kind: "uncounted" })
    expect(await questionRoom(stores, 200_000, LAST_MS_OF_NOV_1)).toBe(true)
    await settleReview(stores, { day: "2026-11-01", holder: "a", reserved: 10_000 }, 1, 0)
    await addQuestion(stores, 1, LAST_MS_OF_NOV_1)
    expect(events(errors).map((line) => [line.event, line.when])).toEqual([
      ["budget.ledger_unreadable", "reserve"],
      ["budget.ledger_unreadable", "room"],
      ["budget.ledger_unreadable", "settle"],
      ["budget.ledger_unreadable", "add"],
    ])
  })
})

describe("ledgerHolder", () => {
  it("names the repository, pull request and delivery, so two deliveries hold two reservations", () => {
    expect(ledgerHolder({ owner: "o", repo: "r", number: 7 }, "abc")).toBe("o/r#7:abc")
  })
})
