import { DurableObject } from "cloudflare:workers"
import { Value } from "typebox/value"
import { DayAccount, type ReserveAnswer, type RoomAnswer } from "./day-account.ts"
import { DayLedger, EMPTY_DAY } from "./ledger.ts"

const DAY_KEY = "day"

const KEPT_MS = 8 * 86_400_000

export class DailySpend extends DurableObject<Env> {
  reserve(holder: string, neurons: number, cap: number): Promise<ReserveAnswer> {
    return this.#account().reserve(holder, neurons, cap)
  }

  settle(holder: string, neurons: number, sandboxSeconds: number): Promise<void> {
    return this.#account().settle(holder, neurons, sandboxSeconds)
  }

  room(cap: number): Promise<RoomAnswer> {
    return this.#account().room(cap)
  }

  add(neurons: number): Promise<void> {
    return this.#account().add(neurons)
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }

  #account(): DayAccount {
    const storage = this.ctx.storage
    const record = {
      read: async () => {
        const stored = await storage.get(DAY_KEY)
        return Value.Check(DayLedger, stored) ? stored : EMPTY_DAY
      },
      write: async (day: DayLedger) => {
        await storage.put(DAY_KEY, day)
        if ((await storage.getAlarm()) === null) await storage.setAlarm(Date.now() + KEPT_MS)
      },
    }
    return new DayAccount(record, this.ctx.id.name ?? "unnamed")
  }
}
