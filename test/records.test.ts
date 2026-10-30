import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { PostedReview, PullRequestKey, StoredSessionId, SummaryCommentId } from "../src/records.ts"

describe("PullRequestKey", () => {
  it("accepts the key the object stores on its first event", () => {
    expect(
      Value.Check(PullRequestKey, { installationId: 99, owner: "ItsAndrewM", repo: "ai-review-agent", number: 44 }),
    ).toBe(true)
  })

  it("rejects a key without the installation its token is minted for", () => {
    expect(Value.Check(PullRequestKey, { owner: "ItsAndrewM", repo: "ai-review-agent", number: 44 })).toBe(false)
  })
})

describe("StoredSessionId", () => {
  it("reads a stored Pi session's id, the summary's or verify's, as a string", () => {
    expect(Value.Check(StoredSessionId, "2")).toBe(true)
    expect(Value.Check(StoredSessionId, 2)).toBe(false)
  })
})

describe("SummaryCommentId", () => {
  it("is a comment id, not a link or a node id", () => {
    expect(Value.Check(SummaryCommentId, 6298894241)).toBe(true)
    expect(Value.Check(SummaryCommentId, "IC_kwDOP")).toBe(false)
  })
})

describe("PostedReview", () => {
  const posted = { reviewId: 5590176461, event: "APPROVE", at: 1792522915699 }

  it("accepts a record from before reviews stored their finding counts, which still marks the head as posted", () => {
    expect(Value.Check(PostedReview, posted)).toBe(true)
    expect(Value.Check(PostedReview, { ...posted, model: "@cf/zai-org/glm-5.3-flash", fingerprint: "5584572c" })).toBe(
      true,
    )
  })

  it("accepts the finding counts the run's title is built from", () => {
    expect(Value.Check(PostedReview, { ...posted, counts: { blocking: 1, suggestion: 2, nitpick: 0 } })).toBe(true)
  })

  it("accepts the verdict the review showed, and refuses one a summary can't show", () => {
    expect(Value.Check(PostedReview, { ...posted, shown: "WITHHELD" })).toBe(true)
    expect(Value.Check(PostedReview, { ...posted, shown: "AWAITING_CHECKS" })).toBe(true)
    expect(Value.Check(PostedReview, { ...posted, shown: "approve" })).toBe(false)
  })

  it("accepts the counts with the major grade, and without it from before the grade existed", () => {
    expect(Value.Check(PostedReview, { ...posted, counts: { blocking: 1, major: 1, suggestion: 2, nitpick: 0 } })).toBe(
      true,
    )
    expect(Value.Check(PostedReview, { ...posted, counts: { blocking: 1, suggestion: 2, nitpick: 0 } })).toBe(true)
  })

  it("accepts the spend the summary's cost line was rendered from", () => {
    const spend = [
      {
        model: "cloudflare/@cf/zai-org/glm-5.3-flash",
        calls: 3,
        inputTokens: 61_204,
        cachedTokens: 40_000,
        outputTokens: 4_811,
        usd: 0.0067,
        priced: true,
      },
    ]
    expect(Value.Check(PostedReview, { ...posted, spend })).toBe(true)
    expect(Value.Check(PostedReview, { ...posted, spend: [{ ...spend[0], usd: "0.0067" }] })).toBe(false)
  })

  it("accepts whether the review posted unverified, which a later run of the head repeats in its title", () => {
    expect(Value.Check(PostedReview, { ...posted, unverified: true })).toBe(true)
    expect(Value.Check(PostedReview, { ...posted, unverified: false })).toBe(true)
    expect(Value.Check(PostedReview, { ...posted, unverified: "yes" })).toBe(false)
  })

  it("rejects a record whose event isn't one GitHub posts", () => {
    expect(Value.Check(PostedReview, { ...posted, event: "approve" })).toBe(false)
    expect(Value.Check(PostedReview, { event: "APPROVE", at: 1 })).toBe(false)
  })
})
