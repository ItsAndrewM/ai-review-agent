import { Type, type Static } from "typebox"
import { ReviewSpend } from "./review/cost.ts"

export const PullRequestKey = Type.Object({
  installationId: Type.Integer(),
  owner: Type.String(),
  repo: Type.String(),
  number: Type.Integer(),
})

export type PullRequestKey = Static<typeof PullRequestKey>

export const SummaryCommentId = Type.Integer()

export const SeverityCounts = Type.Object({
  blocking: Type.Integer(),
  suggestion: Type.Integer(),
  nitpick: Type.Integer(),
})

export type SeverityCounts = Static<typeof SeverityCounts>

export const PostedReview = Type.Object({
  reviewId: Type.Integer(),
  event: Type.Union([Type.Literal("APPROVE"), Type.Literal("REQUEST_CHANGES"), Type.Literal("COMMENT")]),
  at: Type.Integer(),
  fingerprint: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  counts: Type.Optional(SeverityCounts),
  spend: Type.Optional(ReviewSpend),
  unverified: Type.Optional(Type.Boolean()),
})

export type PostedReview = Static<typeof PostedReview>
