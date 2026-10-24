import { describe, expect, it } from "vitest"
import { parseCommentBody } from "../tools/verify-replay/comment.ts"

describe("parseCommentBody", () => {
  it("preserves an old basis while marking only its kind as inferred", () => {
    const body =
      "**🔴 Blocking: Bad call**\n\nThe retry drops an error.\n\n_Basis: postReview returns rejectionsText without showing it._"
    expect(parseCommentBody(body, "defect", "The claim names a concrete failed retry path")).toEqual({
      severity: "blocking",
      title: "Bad call",
      body: "The retry drops an error.",
      basis_kind: "defect",
      basis: "postReview returns rejectionsText without showing it.",
      normalization: {
        basisSource: "legacy_basis",
        basisKindReason: "The claim names a concrete failed retry path",
      },
    })
  })

  it("uses the original body as the basis when no basis was recorded, preserving the suggestion", () => {
    const body =
      "**🟡 Suggestion: Bad write**\n\nA missing await can lose the write.\n\n```suggestion\nawait write()\n```"
    expect(parseCommentBody(body, "defect", "The claim alleges a lost write")).toEqual({
      severity: "suggestion",
      title: "Bad write",
      body: "A missing await can lose the write.",
      basis_kind: "defect",
      basis: "A missing await can lose the write.",
      suggestion: "await write()",
      normalization: { basisSource: "body", basisKindReason: "The claim alleges a lost write" },
    })
  })

  it("does not infer a basis kind for a historical comment without an explicit normalization decision", () => {
    expect(parseCommentBody("**🟡 Suggestion: Old**\n\nAn unsupported claim.")).toBeUndefined()
  })
})
