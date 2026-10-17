import { describe, expect, it } from "vitest"
import { resubmitPrompt } from "../src/review/prompt.ts"

describe("resubmitPrompt", () => {
  it("passes on why the host refused the review the model wrote out, as submit_review would have", () => {
    const refusal =
      "Rejected findings:\n- src/x.ts:40: line 40 (RIGHT) is not in the diff of src/x.ts\nFix the anchors or drop these, then call submit_review again."
    expect(resubmitPrompt(refusal)).toContain(refusal)
  })

  it("still asks for submit_review when the refusal doesn't, as after a GitHub error", () => {
    expect(resubmitPrompt("Error: GitHub POST /repos/o/r/pulls/5/reviews: 502")).toContain("Call submit_review")
  })
})
