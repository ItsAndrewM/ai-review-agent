import type { RE2JS } from "re2js"
import { Type, type Static } from "typebox"
import { Value } from "typebox/value"

type LazyDfa = RE2JS["re2Input"]["dfa"]

export interface Engine {
  regex: RE2JS
  dfa: LazyDfa
  onePass: boolean
  programSize: number
  stateWork: number
  scanWork: number
}

export interface Tested {
  matched: boolean
  cleared: boolean
  work: number
}

export interface Scans {
  cost: number
  automata: number
}

export const LINE_UNITS = 16

export const FREE_SUBSTRING_SCANS = 3

const CLEAR_MARK = -1

const Prefilter = Type.Cyclic(
  {
    Node: Type.Object({ cost: Type.Number(), allExact: Type.Boolean(), subs: Type.Array(Type.Ref("Node")) }),
  },
  "Node",
)

type PrefilterNode = Static<typeof Prefilter>

function automata(node: PrefilterNode): number {
  if (node.allExact) return 1
  return node.subs.reduce((sum, sub) => sum + automata(sub), 0)
}

export function prefilterScans(regex: RE2JS): Scans {
  const prefilter: unknown = regex.re2Input.prefilter
  if (!Value.Check(Prefilter, prefilter)) return { cost: 0, automata: 0 }
  return { cost: prefilter.cost, automata: automata(prefilter) }
}

function scanWorkOf({ cost, automata }: Scans): number {
  return Math.max(0, automata - 1) + Math.max(0, cost - automata - FREE_SUBSTRING_SCANS)
}

export function engineFor(regex: RE2JS): Engine {
  const dfa = regex.re2Input.dfa
  const programSize = regex.programSize()
  const onePass = regex.re2Input.onepass !== null
  const stateWork = programSize * (dfa.numClasses + 1)
  return { regex, dfa, onePass, programSize, stateWork, scanWork: scanWorkOf(prefilterScans(regex)) }
}

export function worstWork(engine: Engine, length: number): number {
  const steps = length + 1
  const fixed = LINE_UNITS + steps * engine.scanWork
  if (engine.onePass) return fixed + steps * engine.programSize
  return fixed + steps + engine.stateWork * (2 * steps + 1)
}

function dfaTest(engine: Engine, line: string): Tested {
  const { dfa } = engine
  const before = dfa.stateCount
  dfa.startStates.set(CLEAR_MARK, true)
  const matched = engine.regex.test(line)
  const cleared = !dfa.startStates.delete(CLEAR_MARK)
  const steps = line.length + 1
  const states = cleared ? dfa.stateCount + steps : dfa.stateCount - before
  const work = LINE_UNITS + steps * (1 + engine.scanWork) + engine.stateWork * states
  return { matched, cleared, work: Math.min(work, worstWork(engine, line.length)) }
}

export function meteredTest(engine: Engine, line: string): Tested {
  if (!engine.onePass) return dfaTest(engine, line)
  return { matched: engine.regex.test(line), cleared: false, work: worstWork(engine, line.length) }
}
