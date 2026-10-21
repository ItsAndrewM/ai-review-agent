import { describe, expect, it } from "vitest"
import {
  evaluatesAfterCatchUp,
  headReviewed,
  pauseReply,
  pausedLine,
  pausesReview,
  resumeReply,
  resumeStep,
  withoutPausedLine,
  withPausedLine,
} from "../src/review/pause.ts"
import { SUMMARY_MARKER } from "../src/review/render.ts"

const summary = [SUMMARY_MARKER, "## andabot review", "", "**Head:** `abc1234`", "", "_Not reviewed yet._"].join("\n")

const line = pausedLine("andrew", "andabot")

describe("pausesReview", () => {
  it("skips only a review nobody asked for, and only while paused", () => {
    expect(pausesReview({}, true)).toBe(true)
    expect(pausesReview({ requestedBy: "andrew" }, true)).toBe(false)
    expect(pausesReview({}, false)).toBe(false)
  })
})

describe("pausedLine", () => {
  it("names who paused and how to resume", () => {
    expect(pausedLine("andrew", "andabot")).toBe(
      "⏸️ Paused by @andrew: pushes don't start reviews. `@andabot resume` to resume. <!-- andabot:paused -->",
    )
    expect(pausedLine(undefined, "andabot")).toBe(
      "⏸️ Paused: pushes don't start reviews. `@andabot resume` to resume. <!-- andabot:paused -->",
    )
  })
})

describe("withPausedLine", () => {
  it("puts the paused line under the summary's header", () => {
    expect(withPausedLine(summary, line)).toBe(
      [SUMMARY_MARKER, "## andabot review", "", line, "", "**Head:** `abc1234`", "", "_Not reviewed yet._"].join("\n"),
    )
  })

  it("replaces an earlier paused line instead of adding a second", () => {
    const bea = pausedLine("bea", "andabot")
    const body = withPausedLine(withPausedLine(summary, line), bea)
    expect(body.match(/@bea/g)).toHaveLength(1)
    expect(body).not.toContain("@andrew")
    expect(body).toBe(withPausedLine(summary, bea))
  })

  it("leaves a comment that isn't the summary alone", () => {
    expect(withPausedLine("hello", line)).toBe("hello")
  })

  it("puts the paused line under the marker when the summary has no header", () => {
    expect(withPausedLine(SUMMARY_MARKER, line)).toBe([SUMMARY_MARKER, "", line].join("\n"))
  })
})

describe("withoutPausedLine", () => {
  it("takes the paused line out and gives the summary back as it was", () => {
    expect(withoutPausedLine(withPausedLine(summary, line))).toBe(summary)
    expect(withoutPausedLine(summary)).toBe(summary)
  })

  it("takes out every paused line it finds, each with the blank line before it", () => {
    const twice = [
      SUMMARY_MARKER,
      "## andabot review",
      "",
      line,
      "",
      pausedLine("bea", "andabot"),
      "",
      "**Head:** `abc1234`",
      "",
      "_Not reviewed yet._",
    ].join("\n")
    expect(withoutPausedLine(twice)).toBe(summary)
  })

  const quotingLines = [
    "The pause adds `<!-- andabot:paused -->` under the header.",
    "",
    "| File | Change |",
    "| --- | --- |",
    "| `src/review/pause.ts` | adds `<!-- andabot:paused -->` |",
  ]
  const quoting = [SUMMARY_MARKER, "## andabot review", "", "**Head:** `abc1234`", "", ...quotingLines].join("\n")

  it("keeps a summary line that quotes the paused marker", () => {
    expect(withoutPausedLine(quoting)).toBe(quoting)
    expect(withPausedLine(quoting, line)).toBe(
      [SUMMARY_MARKER, "## andabot review", "", line, "", "**Head:** `abc1234`", "", ...quotingLines].join("\n"),
    )
    expect(withoutPausedLine(withPausedLine(quoting, line))).toBe(quoting)
  })

  it("takes out only a line that opens like the paused line and ends with its marker", () => {
    const body = [
      SUMMARY_MARKER,
      "## andabot review",
      "",
      `${line} Pushes stay paused.`,
      "",
      "Pushes are skipped <!-- andabot:paused -->",
    ].join("\n")
    expect(withoutPausedLine(body)).toBe(body)
    expect(withoutPausedLine(withPausedLine(body, line))).toBe(body)
  })

  it("finds its paused line through whitespace after the marker", () => {
    const padded = withPausedLine(summary, `${line}  `)
    expect(withoutPausedLine(padded)).toBe(summary)
    expect(withPausedLine(padded, line)).toBe(withPausedLine(summary, line))
  })
})

describe("pauseReply", () => {
  it("confirms a pause, or says it was already paused", () => {
    expect(pauseReply(false, "andabot")).toBe("Paused: pushes won't start reviews until `@andabot resume`.")
    expect(pauseReply(true, "andabot")).toBe("Already paused.")
  })
})

describe("headReviewed", () => {
  it("counts a head the last push skipped as unchanged as reviewed", () => {
    expect(headReviewed("b", "b", false)).toBe(true)
    expect(headReviewed("b", "a", true)).toBe(true)
    expect(headReviewed("b", "a", false)).toBe(false)
    expect(headReviewed("b", undefined, false)).toBe(false)
  })
})

describe("resumeStep", () => {
  const open = { open: true, draft: false, reviewRunning: false, reviewed: false }

  it("chooses what resume does next", () => {
    expect(resumeStep({ open: false, draft: true, reviewRunning: true, reviewed: true })).toBe("closed")
    expect(resumeStep({ ...open, draft: true, reviewRunning: true, reviewed: true })).toBe("draft")
    expect(resumeStep({ ...open, reviewRunning: true, reviewed: true })).toBe("running")
    expect(resumeStep({ ...open, reviewed: true })).toBe("evaluate")
    expect(resumeStep(open)).toBe("review")
  })
})

describe("resumeReply", () => {
  it("words each resume step", () => {
    const head = "def5678901"
    expect(resumeReply("not_paused", head)).toBe("Not paused.")
    expect(resumeReply("review", head)).toBe("Resumed: reviewing `def5678`.")
    expect(resumeReply("evaluate", head)).toBe("Resumed: `def5678` is reviewed already.")
    expect(resumeReply("running", head)).toBe("Resumed: a review of `def5678` is already running.")
    expect(resumeReply("closed", head)).toBe("Resumed. The pull request is closed, so there's nothing to review.")
    expect(resumeReply("draft", head)).toBe("Resumed. It's a draft, so I'll review it once it's ready for review.")
  })
})

describe("evaluatesAfterCatchUp", () => {
  const caughtUp = { headSha: "b", reviewedHead: "b", posted: false, inFlight: false }

  it("evaluates after a catch-up review only when it found nothing new to review", () => {
    expect(evaluatesAfterCatchUp(caughtUp)).toBe(true)
    expect(evaluatesAfterCatchUp({ ...caughtUp, posted: true })).toBe(false)
    expect(evaluatesAfterCatchUp({ ...caughtUp, inFlight: true })).toBe(false)
    expect(evaluatesAfterCatchUp({ ...caughtUp, reviewedHead: "a" })).toBe(false)
  })
})
