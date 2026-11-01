import type { FindingInput } from "./findings.ts"

type Graded = Pick<FindingInput, "basis_kind" | "severity">

export interface BasisContext {
  readonly hasLinkedIssues: boolean
  readonly instructionFiles: readonly string[]
  readonly activatedSkills: readonly string[]
  readonly docs: readonly string[]
}

export const SMELLS = [
  "Mysterious Name",
  "Duplicated Code",
  "Feature Envy",
  "Data Clumps",
  "Primitive Obsession",
  "Repeated Switches",
  "Shotgun Surgery",
  "Divergent Change",
  "Speculative Generality",
  "Message Chains",
  "Middle Man",
  "Refused Bequest",
] as const

const BLOCKS = new Set<FindingInput["severity"]>(["blocking", "major"])
const SAYS_THE_CODE_FAILS = new Set<FindingInput["basis_kind"]>(["defect", "spec"])
const SKILL_FILE = "skill.md"
const SMELL_NAMES = SMELLS.map((smell) => smell.toLowerCase())

const STANDARD_OR_TEST_TOO_HIGH =
  "a standard, test or docs finding cannot be blocking or major; grade it suggestion or nitpick, or give it the defect or spec basis it rests on"
const DEFECT_OR_SPEC_TOO_LOW =
  "a defect or spec finding is blocking or major, since its basis says the code fails; if the code works as it stands, give it the standard or test basis it rests on"

export function pairingProblem(finding: Graded): string | undefined {
  const blocks = BLOCKS.has(finding.severity)
  const saysTheCodeFails = SAYS_THE_CODE_FAILS.has(finding.basis_kind)
  if (saysTheCodeFails && !blocks) return DEFECT_OR_SPEC_TOO_LOW
  if (!saysTheCodeFails && blocks) return STANDARD_OR_TEST_TOO_HIGH
  return undefined
}

export function standardBasisProblem(basis: string, context: BasisContext): string | undefined {
  const text = basis.toLowerCase()
  if (namesStandardsFile(text, context.instructionFiles) || namesSmell(text)) return undefined
  if (namesSkill(text, context.activatedSkills)) return undefined
  return `a standard finding must name a repository standards file (${listed(context.instructionFiles, "none is listed")}), a smell from references/smells.md, or a repository skill this review activated (${listed(context.activatedSkills, "none was")}); if the code is wrong on its own terms, make it a defect with its failure scenario`
}

const MOST_DOCS_LISTED = 10
const CONFIG_FILE_LABEL = /^(\.[^/:\s]+\.yaml): /
const PATH_EDGE = "[\\s`'\"()\\[\\],;:]"

export function docsBasisProblem(basis: string, context: BasisContext): string | undefined {
  const text = basis.toLowerCase()
  if (context.docs.flatMap(namesOf).some((name) => namesPathAtBoundary(text, name))) return undefined
  return `a docs finding must name one of the pull request's docs (${listedUpTo(context.docs, MOST_DOCS_LISTED, "none is known")}); if the code is wrong on its own terms, make it a defect with its failure scenario`
}

function namesPathAtBoundary(text: string, name: string): boolean {
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|${PATH_EDGE}|/)${quoted}(?:$|${PATH_EDGE}|/)`).test(text)
}

function listedUpTo(names: readonly string[], most: number, none: string): string {
  if (names.length === 0) return none
  if (names.length <= most) return names.join(", ")
  return `${names.slice(0, most).join(", ")}, and ${names.length - most} more`
}

function namesStandardsFile(text: string, instructionFiles: readonly string[]): boolean {
  return instructionFiles.flatMap(namesOf).some((name) => text.includes(name))
}

function namesOf(instructionFile: string): string[] {
  const lower = instructionFile.toLowerCase()
  const configFile = CONFIG_FILE_LABEL.exec(lower)?.[1]
  if (configFile !== undefined) return [configFile]
  const basename = lower.split("/").at(-1)
  return basename === undefined || basename === lower ? [lower] : [lower, basename]
}

function namesSmell(text: string): boolean {
  return SMELL_NAMES.some((smell) => text.includes(smell))
}

function namesSkill(text: string, activatedSkills: readonly string[]): boolean {
  if (activatedSkills.length === 0) return false
  return text.includes(SKILL_FILE) || activatedSkills.some((skill) => text.includes(skill.toLowerCase()))
}

function listed(names: readonly string[], none: string): string {
  return names.length === 0 ? none : names.join(", ")
}
