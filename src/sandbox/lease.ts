import { Type, type Static } from "typebox"

export const MAX_SANDBOXES = 3

export const LeaseState = Type.Record(Type.String(), Type.Integer())

export type LeaseState = Static<typeof LeaseState>

export function liveLeases(state: LeaseState, now: number): LeaseState {
  return Object.fromEntries(Object.entries(state).filter(([, expiresAt]) => expiresAt > now))
}

export interface LeaseGrant {
  readonly state: LeaseState
  readonly granted: boolean
}

export function acquire(state: LeaseState, holder: string, now: number, ttlMs: number): LeaseGrant {
  const live = liveLeases(state, now)
  const held = holder in live
  if (!held && Object.keys(live).length >= MAX_SANDBOXES) return { state: live, granted: false }
  return { state: { ...live, [holder]: now + ttlMs }, granted: true }
}

export function release(state: LeaseState, holder: string): LeaseState {
  const { [holder]: _released, ...rest } = state
  return rest
}
