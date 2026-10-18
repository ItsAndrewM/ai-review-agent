import { describe, expect, it } from "vitest"
import { answerPrompt, rejectionsText, resubmitPrompt, systemPrompt } from "../src/review/prompt.ts"

describe("systemPrompt", () => {
  it("names the bot and the tools and leaves the procedure to the skills", () => {
    const text = systemPrompt("andabot")
    expect(text.startsWith("You are andabot")).toBe(true)
    expect(text).toContain("read_skill_resource")
    expect(text).not.toContain("blocking")
    expect(text).not.toContain("nitpick")
    expect(text.length).toBeLessThan(900)
  })
})

describe("rejectionsText", () => {
  it("returns every rejected finding with its anchor, title and reason, not only the first few", () => {
    const rejected = [1, 2, 3, 4].map((line) => ({
      finding: { path: "src/x.ts", line, quote: "q", severity: "blocking" as const, title: `t${line}`, body: "b" },
      reason: `reason ${line}`,
    }))
    const text = rejectionsText(rejected)
    expect(text).toContain('- src/x.ts:1 "t1": reason 1\n- src/x.ts:2 "t2": reason 2\n')
    expect(text).toContain('- src/x.ts:3 "t3": reason 3\n- src/x.ts:4 "t4": reason 4\n')
  })
})

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

describe("answerPrompt", () => {
  it("puts the answer skill before the question", () => {
    const text = answerPrompt(
      "andrew",
      "why is this a problem?",
      '<skill_content name="answer" version="1">\nx\n</skill_content>',
    )
    expect(text.startsWith('<skill_content name="answer"')).toBe(true)
    expect(text).toContain("andrew asks, in a comment on the pull request:\n\nwhy is this a problem?")
  })
})
