import type { RE2JS } from "re2js"

type LazyDfa = RE2JS["re2Input"]["dfa"]

export interface Engine {
  regex: RE2JS
  dfa: LazyDfa
  stateWork: number
}

export interface Tested {
  matched: boolean
  cleared: boolean
  work: number
}

const CLEAR_MARK = -1

export function engineFor(regex: RE2JS): Engine {
  const dfa = regex.re2Input.dfa
  return { regex, dfa, stateWork: regex.programSize() * (dfa.numClasses + 1) }
}

export function worstWork(engine: Engine, length: number): number {
  const steps = length + 1
  return steps + engine.stateWork * (2 * steps + 1)
}

export function meteredTest(engine: Engine, line: string): Tested {
  const { dfa } = engine
  const before = dfa.stateCount
  dfa.startStates.set(CLEAR_MARK, true)
  const matched = engine.regex.test(line)
  const cleared = !dfa.startStates.delete(CLEAR_MARK)
  const steps = line.length + 1
  const states = cleared ? dfa.stateCount + steps : dfa.stateCount - before
  return { matched, cleared, work: Math.min(steps + engine.stateWork * states, worstWork(engine, line.length)) }
}
