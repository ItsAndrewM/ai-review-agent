import { Type } from "@earendil-works/pi-ai"
import type { Static } from "typebox"
import { comparableText } from "../github/diff.ts"
import type { ReviewSubmissionInput } from "./findings.ts"

export const OmittedRequirement = Type.Object({
  issue: Type.Integer({ description: "The linked issue's number." }),
  requirement: Type.String({ minLength: 1, description: "The requirement, in the issue's words." }),
})

export type OmittedRequirementInput = Static<typeof OmittedRequirement>

export type ApprovalReason =
  | { kind: "omitted_requirement"; issue: number; requirement: string }
  | { kind: "not_for_merging"; quote: string }
  | { kind: "budget_cut"; budget: number }

export interface ReasonSources {
  readonly linkedIssues: readonly number[]
  readonly title: string
  readonly body: string | null | undefined
}

export interface CheckedReasons {
  accepted: ApprovalReason[]
  rejected: string[]
}

type ReasonFields = Pick<ReviewSubmissionInput, "omitted_requirements" | "not_for_merging">

export function checkReasons(submission: ReasonFields, sources: ReasonSources): CheckedReasons {
  const checked: CheckedReasons = { accepted: [], rejected: [] }
  for (const omitted of submission.omitted_requirements ?? []) {
    const problem = omittedProblem(omitted, sources.linkedIssues)
    if (problem === undefined) checked.accepted.push({ kind: "omitted_requirement", ...omitted })
    else checked.rejected.push(problem)
  }
  const quote = submission.not_for_merging
  if (quote === undefined) return checked
  if (quotedFrom(quote, sources)) checked.accepted.push({ kind: "not_for_merging", quote })
  else checked.rejected.push(notForMergingProblem(quote))
  return checked
}

function omittedProblem(omitted: OmittedRequirementInput, linkedIssues: readonly number[]): string | undefined {
  if (linkedIssues.length === 0) {
    return `omitted requirement for #${omitted.issue}: no issue is linked to this pull request, so nothing can be omitted; drop omitted_requirements`
  }
  if (linkedIssues.includes(omitted.issue)) return undefined
  const linked = linkedIssues.map((number) => `#${number}`).join(", ")
  return `omitted requirement for #${omitted.issue}: #${omitted.issue} isn't a linked issue (linked: ${linked}); name the linked issue or drop it`
}

function quotedFrom(quote: string, sources: ReasonSources): boolean {
  const needle = comparable(quote)
  return comparable(sources.title).includes(needle) || comparable(sources.body ?? "").includes(needle)
}

function comparable(text: string): string {
  return comparableText(text).toLowerCase()
}

function notForMergingProblem(quote: string): string {
  return `not_for_merging "${quote}": not found in the title or description; quote a line from them exactly, or omit it`
}

export function budgetReason(budgetBlocked: number, budget: number): ApprovalReason | undefined {
  return budgetBlocked > 0 ? { kind: "budget_cut", budget } : undefined
}

export function omittedIn(reasons: readonly ApprovalReason[]): OmittedRequirementInput[] {
  return reasons.flatMap((reason) =>
    reason.kind === "omitted_requirement" ? [{ issue: reason.issue, requirement: reason.requirement }] : [],
  )
}
