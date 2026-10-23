import type { RE2JS } from "re2js"

type LazyDfa = RE2JS["re2Input"]["dfa"]

export interface Engine {
  regex: RE2JS
  dfa: LazyDfa
  onePass: boolean
  programSize: number
  stateWork: number
}

export interface Tested {
  matched: boolean
  cleared: boolean
  work: number
}

export const LINE_UNITS = 16

const CLEAR_MARK = -1

export function engineFor(regex: RE2JS): Engine {
  const dfa = regex.re2Input.dfa
  const programSize = regex.programSize()
  const onePass = regex.re2Input.onepass !== null
  return { regex, dfa, onePass, programSize, stateWork: programSize * (dfa.numClasses + 1) }
}

export function worstWork(engine: Engine, length: number): number {
  const steps = length + 1
  if (engine.onePass) return LINE_UNITS + steps * engine.programSize
  return LINE_UNITS + steps + engine.stateWork * (2 * steps + 1)
}

function dfaTest(engine: Engine, line: string): Tested {
  const { dfa } = engine
  const before = dfa.stateCount
  dfa.startStates.set(CLEAR_MARK, true)
  const matched = engine.regex.test(line)
  const cleared = !dfa.startStates.delete(CLEAR_MARK)
  const steps = line.length + 1
  const states = cleared ? dfa.stateCount + steps : dfa.stateCount - before
  const work = LINE_UNITS + steps + engine.stateWork * states
  return { matched, cleared, work: Math.min(work, worstWork(engine, line.length)) }
}

export function meteredTest(engine: Engine, line: string): Tested {
  if (!engine.onePass) return dfaTest(engine, line)
  return { matched: engine.regex.test(line), cleared: false, work: worstWork(engine, line.length) }
}
