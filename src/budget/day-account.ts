import { log } from "../log.ts"
import { addIn, crossings, reservedOf, reserveIn, roomIn, settleIn, type DayLedger } from "./ledger.ts"

export interface DayRecord {
  read(): Promise<DayLedger>
  write(day: DayLedger): Promise<void>
}

export interface ReserveAnswer {
  granted: boolean
  spent: number
  reserved: number
}

export interface RoomAnswer {
  open: boolean
  spent: number
  reserved: number
}

export class DayAccount {
  readonly #record: DayRecord
  readonly #name: string

  constructor(record: DayRecord, name: string) {
    this.#record = record
    this.#name = name
  }

  async reserve(holder: string, neurons: number, cap: number): Promise<ReserveAnswer> {
    const before = await this.#record.read()
    const next = reserveIn(before, holder, neurons, cap)
    const day = await this.#noteCrossings(before, next.day, cap, !next.granted)
    return { granted: next.granted, spent: day.spent, reserved: reservedOf(day) }
  }

  async settle(holder: string, neurons: number, sandboxSeconds: number): Promise<void> {
    const day = settleIn(await this.#record.read(), holder, neurons, sandboxSeconds)
    await this.#record.write(day)
    log("budget.settled", { day: this.#name, holder, neurons, sandboxSeconds, spent: day.spent })
  }

  async room(cap: number): Promise<RoomAnswer> {
    const before = await this.#record.read()
    const open = roomIn(before, cap)
    const day = await this.#noteCrossings(before, before, cap, !open)
    return { open, spent: day.spent, reserved: reservedOf(day) }
  }

  async add(neurons: number): Promise<void> {
    await this.#record.write(addIn(await this.#record.read(), neurons))
  }

  async #noteCrossings(before: DayLedger, after: DayLedger, cap: number, refused: boolean): Promise<DayLedger> {
    const crossed = crossings(before, after, cap, refused)
    const fields = { day: this.#name, spent: crossed.day.spent, reserved: reservedOf(crossed.day), cap }
    if (crossed.warn) log("budget.daily_warning", fields)
    if (crossed.refuse) log("budget.daily_spent", fields)
    await this.#record.write(crossed.day)
    return crossed.day
  }
}
