import type { FindingInput } from "./findings.ts"

type Graded = Pick<FindingInput, "basis_kind" | "severity">

const BLOCKS = new Set<FindingInput["severity"]>(["blocking", "major"])
const SAYS_THE_CODE_FAILS = new Set<FindingInput["basis_kind"]>(["defect", "spec"])

const STANDARD_OR_TEST_TOO_HIGH =
  "a standard or test finding cannot be blocking or major; grade it suggestion or nitpick, or give it the defect or spec basis it rests on"
const DEFECT_OR_SPEC_TOO_LOW =
  "a defect or spec finding is blocking or major, since its basis says the code fails; if the code works as it stands, give it the standard or test basis it rests on"

export function pairingProblem(finding: Graded): string | undefined {
  const blocks = BLOCKS.has(finding.severity)
  const saysTheCodeFails = SAYS_THE_CODE_FAILS.has(finding.basis_kind)
  if (saysTheCodeFails && !blocks) return DEFECT_OR_SPEC_TOO_LOW
  if (!saysTheCodeFails && blocks) return STANDARD_OR_TEST_TOO_HIGH
  return undefined
}
