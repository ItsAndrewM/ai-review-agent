import type { FindingInput } from "../src/review/findings.ts"
import type { VerdictInput } from "../src/review/verify.ts"
import type { Label, LabelledFinding } from "../tools/verify-replay/score.ts"

export const finding = {
  path: "src/example.ts",
  line: 1,
  quote: "return total",
  severity: "blocking",
  basis_kind: "defect",
  basis: "An empty input returns the wrong total.",
  title: "Wrong total",
  body: "An empty input should return zero.",
} satisfies FindingInput

export function labelled(id: string, label: Label, changes: Partial<FindingInput> = {}): LabelledFinding {
  return {
    id,
    label,
    pr: 9,
    head: "a".repeat(40),
    base: "b".repeat(40),
    commentId: Number(id),
    url: `https://github.com/ItsAndrewM/ai-review-agent/pull/9#discussion_r${id}`,
    finding: { ...finding, ...changes },
    evidence: "Hand-checked fixture",
  }
}

export function verdict(id: string, keep: boolean, severity: VerdictInput["severity"] = "blocking"): VerdictInput {
  return { finding: id, keep, severity, reason: "Checked the cited code" }
}
