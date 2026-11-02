import { Type, type Static } from "typebox"

export const DEFAULT_DAILY_NEURONS = 200_000

const WARNING_SHARE = 0.8

export const DayLedger = Type.Object({
  spent: Type.Number(),
  sandboxSeconds: Type.Number(),
  reservations: Type.Record(Type.String(), Type.Number()),
  warned: Type.Boolean(),
  refused: Type.Boolean(),
})

export type DayLedger = Static<typeof DayLedger>

export interface Reservation {
  granted: boolean
  day: DayLedger
}

export interface Crossings {
  warn: boolean
  refuse: boolean
  day: DayLedger
}

export const EMPTY_DAY: DayLedger = { spent: 0, sandboxSeconds: 0, reservations: {}, warned: false, refused: false }

export function dailyBudgetOf(value: string | undefined): number {
  const budget = Number(value)
  return Number.isSafeInteger(budget) && budget > 0 ? budget : DEFAULT_DAILY_NEURONS
}

export function reservationOf(reviewBudget: number, dailyBudget: number): number {
  return Math.min(reviewBudget, dailyBudget)
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function reservedOf(day: DayLedger): number {
  return Object.values(day.reservations).reduce((total, neurons) => total + neurons, 0)
}

function committedOf(day: DayLedger): number {
  return day.spent + reservedOf(day)
}

export function reserveIn(day: DayLedger, holder: string, neurons: number, cap: number): Reservation {
  if (day.reservations[holder] !== undefined) return { granted: true, day }
  if (committedOf(day) + neurons > cap) return { granted: false, day }
  return { granted: true, day: { ...day, reservations: { ...day.reservations, [holder]: neurons } } }
}

export function settleIn(day: DayLedger, holder: string, neurons: number, sandboxSeconds: number): DayLedger {
  const { [holder]: _settled, ...reservations } = day.reservations
  return {
    ...day,
    reservations,
    spent: day.spent + neurons,
    sandboxSeconds: day.sandboxSeconds + sandboxSeconds,
  }
}

export function roomIn(day: DayLedger, cap: number): boolean {
  return committedOf(day) < cap
}

export function addIn(day: DayLedger, neurons: number): DayLedger {
  return { ...day, spent: day.spent + neurons }
}

export function crossings(before: DayLedger, after: DayLedger, cap: number, refusedNow: boolean): Crossings {
  const warn = !before.warned && committedOf(after) >= WARNING_SHARE * cap
  const refuse = !before.refused && refusedNow
  return {
    warn,
    refuse,
    day: { ...after, warned: before.warned || warn, refused: before.refused || refuse },
  }
}
