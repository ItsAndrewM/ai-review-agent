import { describe, expect, it } from "vitest"
import { summaryMarkerOf } from "../src/names.ts"
import {
  evaluatesAfterCatchUp,
  headReviewed,
  NOT_PAUSED_REPLY,
  pauseReply,
  pausedLine,
  pausesReview,
  resumeReply,
  resumeStep,
  withoutPausedLine,
  withPausedLine,
} from "../src/review/pause.ts"

const summary = [
  summaryMarkerOf("andabot"),
  "## andabot review",
  "",
  "**Head:** `abc1234`",
  "",
  "_Not reviewed yet._",
].join("\n")

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
    expect(withPausedLine(summary, line, "andabot")).toBe(
      [
        summaryMarkerOf("andabot"),
        "## andabot review",
        "",
        line,
        "",
        "**Head:** `abc1234`",
        "",
        "_Not reviewed yet._",
      ].join("\n"),
    )
  })

  it("replaces an earlier paused line instead of adding a second", () => {
    const bea = pausedLine("bea", "andabot")
    const body = withPausedLine(withPausedLine(summary, line, "andabot"), bea, "andabot")
    expect(body.match(/@bea/g)).toHaveLength(1)
    expect(body).not.toContain("@andrew")
    expect(body).toBe(withPausedLine(summary, bea, "andabot"))
  })

  it("leaves a comment that isn't the summary alone", () => {
    expect(withPausedLine("hello", line, "andabot")).toBe("hello")
  })

  it("puts the paused line under the marker when the summary has no header", () => {
    expect(withPausedLine(summaryMarkerOf("andabot"), line, "andabot")).toBe(
      [summaryMarkerOf("andabot"), "", line].join("\n"),
    )
  })
})

describe("withoutPausedLine", () => {
  it("takes the paused line out and gives the summary back as it was", () => {
    expect(withoutPausedLine(withPausedLine(summary, line, "andabot"), "andabot")).toBe(summary)
    expect(withoutPausedLine(summary, "andabot")).toBe(summary)
  })

  it("takes out every paused line it finds, each with the blank line before it", () => {
    const twice = [
      summaryMarkerOf("andabot"),
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
    expect(withoutPausedLine(twice, "andabot")).toBe(summary)
  })

  const quotingLines = [
    "The pause adds `<!-- andabot:paused -->` under the header.",
    "",
    "| File | Change |",
    "| --- | --- |",
    "| `src/review/pause.ts` | adds `<!-- andabot:paused -->` |",
  ]
  const quoting = [
    summaryMarkerOf("andabot"),
    "## andabot review",
    "",
    "**Head:** `abc1234`",
    "",
    ...quotingLines,
  ].join("\n")

  it("keeps a summary line that quotes the paused marker", () => {
    expect(withoutPausedLine(quoting, "andabot")).toBe(quoting)
    expect(withPausedLine(quoting, line, "andabot")).toBe(
      [summaryMarkerOf("andabot"), "## andabot review", "", line, "", "**Head:** `abc1234`", "", ...quotingLines].join(
        "\n",
      ),
    )
    expect(withoutPausedLine(withPausedLine(quoting, line, "andabot"), "andabot")).toBe(quoting)
  })

  it("takes out only a line that opens like the paused line and ends with its marker", () => {
    const body = [
      summaryMarkerOf("andabot"),
      "## andabot review",
      "",
      `${line} Pushes stay paused.`,
      "",
      "Pushes are skipped <!-- andabot:paused -->",
    ].join("\n")
    expect(withoutPausedLine(body, "andabot")).toBe(body)
    expect(withoutPausedLine(withPausedLine(body, line, "andabot"), "andabot")).toBe(body)
  })

  it("leaves another deploy's paused line alone, even when its login starts with this one's", () => {
    const staging = withPausedLine(summary, pausedLine("andrew", "andabot-staging"), "andabot")
    expect(staging).toContain("<!-- andabot-staging:paused -->")
    expect(withoutPausedLine(staging, "andabot")).toBe(staging)
    expect(withoutPausedLine(staging, "andabot-staging")).toBe(summary)
  })

  it("finds its paused line through whitespace after the marker", () => {
    const padded = withPausedLine(summary, `${line}  `, "andabot")
    expect(withoutPausedLine(padded, "andabot")).toBe(summary)
    expect(withPausedLine(padded, line, "andabot")).toBe(withPausedLine(summary, line, "andabot"))
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
  const open = { open: true, reviewRunning: false, reviewed: false, settingsSkip: undefined }

  it("chooses what resume does next", () => {
    expect(resumeStep({ open: false, reviewRunning: true, reviewed: true, settingsSkip: "draft" })).toBe("closed")
    expect(resumeStep({ ...open, reviewRunning: true, reviewed: true, settingsSkip: "draft" })).toBe("running")
    expect(resumeStep({ ...open, reviewed: true, settingsSkip: "auto" })).toBe("evaluate")
    expect(resumeStep({ ...open, settingsSkip: "draft" })).toBe("draft")
    expect(resumeStep(open)).toBe("review")
  })

  it("skips the catch-up review as a push would, by each of the push settings", () => {
    for (const settingsSkip of ["auto", "draft", "base_branch", "title_keyword"] as const) {
      expect(resumeStep({ ...open, settingsSkip })).toBe(settingsSkip)
    }
  })

  it("evaluates a reviewed head whatever the push settings, since approval doesn't depend on them", () => {
    expect(resumeStep({ ...open, reviewed: true, settingsSkip: "title_keyword" })).toBe("evaluate")
  })
})

describe("resumeReply", () => {
  const head = "def5678901"

  it("words each resume step", () => {
    expect(NOT_PAUSED_REPLY).toBe("Not paused.")
    expect(resumeReply("review", head, "andabot")).toBe("Resumed: reviewing `def5678`.")
    expect(resumeReply("evaluate", head, "andabot")).toBe("Resumed: `def5678` is reviewed already.")
    expect(resumeReply("running", head, "andabot")).toBe("Resumed: a review of `def5678` is already running.")
    expect(resumeReply("closed", head, "andabot")).toBe(
      "Resumed. The pull request is closed, so there's nothing to review.",
    )
    expect(resumeReply("draft", head, "andabot")).toBe(
      "Resumed. It's a draft, so I'll review it once it's ready for review.",
    )
  })

  it("says which .andabot.yaml setting keeps pushes unreviewed, and how to ask for a review", () => {
    expect(resumeReply("auto", head, "andabot")).toBe(
      "Resumed. `.andabot.yaml` turns automatic reviews off, so pushes aren't reviewed; `@andabot review` reviews on request.",
    )
    expect(resumeReply("base_branch", head, "andabot")).toBe(
      "Resumed. `.andabot.yaml`'s `base_branches` leave out this pull request's base, so pushes aren't reviewed; `@andabot review` reviews on request.",
    )
    expect(resumeReply("title_keyword", head, "andabot")).toBe(
      "Resumed. This pull request's title holds one of `.andabot.yaml`'s `ignore_title_keywords`, so pushes aren't reviewed; `@andabot review` reviews on request.",
    )
  })

  it("names the bot to ask for a review", () => {
    expect(resumeReply("auto", head, "reviewer-bot")).toContain("`@reviewer-bot review` reviews on request.")
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
