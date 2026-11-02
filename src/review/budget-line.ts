import { Type, type Static } from "typebox"
import { budgetMarkerOf } from "../names.ts"
import { shortSha } from "../sha.ts"
import { withMarkedLine, withoutMarkedLine, type MarkedLine } from "./summary-lines.ts"

const BUDGET_OPENING = "⏳ Today's review budget is spent"

export const QUESTION_BUDGET_REPLY = "Today's review budget is spent, so I can't answer until midnight UTC."

export const BudgetSkipShown = Type.Object({ head: Type.String(), day: Type.String() })

export type BudgetSkipShown = Static<typeof BudgetSkipShown>

export type BudgetResume = "sweep" | "tag"

export function budgetResumeOf(review: { requestedBy?: string }): BudgetResume {
  return review.requestedBy === undefined ? "sweep" : "tag"
}

export function budgetLine(headSha: string, botLogin: string, resume: BudgetResume): string {
  const head = `\`${shortSha(headSha)}\``
  const when =
    resume === "sweep"
      ? `${head} is reviewed after midnight UTC.`
      : `${head} isn't reviewed. Comment \`@${botLogin} review\` after midnight UTC.`
  return `${BUDGET_OPENING}: ${when} ${budgetMarkerOf(botLogin)}`
}

export function withBudgetLine(body: string, line: string, botLogin: string): string {
  return withMarkedLine(body, line, budgetKind(botLogin), botLogin)
}

export function withoutBudgetLine(body: string, botLogin: string): string {
  return withoutMarkedLine(body, budgetKind(botLogin))
}

export function budgetSkipShown(stored: BudgetSkipShown | undefined, head: string, day: string): boolean {
  return stored?.head === head && stored.day === day
}

function budgetKind(botLogin: string): MarkedLine {
  return { opening: BUDGET_OPENING, marker: budgetMarkerOf(botLogin) }
}
