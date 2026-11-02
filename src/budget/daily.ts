import { Type, type Static } from "typebox"
import { errorText, logError } from "../log.ts"
import type { PullRequestKey } from "../records.ts"
import type { ReserveAnswer, RoomAnswer } from "./day-account.ts"
import { utcDay } from "./ledger.ts"

export interface DayStore {
  reserve(holder: string, neurons: number, cap: number): Promise<ReserveAnswer>
  settle(holder: string, neurons: number, sandboxSeconds: number, cap: number): Promise<void>
  room(cap: number): Promise<RoomAnswer>
  add(neurons: number, cap: number): Promise<void>
}

export type DayStores = (day: string) => DayStore

export const LedgerRef = Type.Object({
  day: Type.String(),
  holder: Type.String(),
  reserved: Type.Number(),
})

export type LedgerRef = Static<typeof LedgerRef>

export function ledgerHolder(key: Pick<PullRequestKey, "owner" | "repo" | "number">, deliveryId: string): string {
  return `${key.owner}/${key.repo}#${key.number}:${deliveryId}`
}

export type ReviewReservation =
  | { kind: "granted"; ledger: LedgerRef }
  | { kind: "refused"; day: string; spent: number; reserved: number }
  | { kind: "uncounted" }

export async function reserveReview(
  stores: DayStores,
  holder: string,
  neurons: number,
  cap: number,
  now: number,
): Promise<ReviewReservation> {
  const day = utcDay(now)
  try {
    const answer = await stores(day).reserve(holder, neurons, cap)
    if (answer.granted) return { kind: "granted", ledger: { day, holder, reserved: neurons } }
    return { kind: "refused", day, spent: answer.spent, reserved: answer.reserved }
  } catch (cause) {
    unreadable("reserve", cause)
    return { kind: "uncounted" }
  }
}

export async function settleReview(
  stores: DayStores,
  ledger: LedgerRef | undefined,
  neurons: number,
  sandboxSeconds: number,
  cap: number,
): Promise<void> {
  if (ledger === undefined) return
  try {
    await stores(ledger.day).settle(ledger.holder, neurons, sandboxSeconds, cap)
  } catch (cause) {
    unreadable("settle", cause)
  }
}

export async function questionRoom(stores: DayStores, cap: number, now: number): Promise<boolean> {
  try {
    return (await stores(utcDay(now)).room(cap)).open
  } catch (cause) {
    unreadable("room", cause)
    return true
  }
}

export async function addQuestion(stores: DayStores, neurons: number, cap: number, now: number): Promise<void> {
  try {
    await stores(utcDay(now)).add(neurons, cap)
  } catch (cause) {
    unreadable("add", cause)
  }
}

function unreadable(when: string, cause: unknown): void {
  logError("budget.ledger_unreadable", { when, error: errorText(cause) })
}
