import { describe, expect, it } from "vitest"
import type { LastReview } from "../src/review/approval.ts"
import { approveReply, approveStep, overrideReply, type ApproveFacts } from "../src/review/approve.ts"

const requested: LastReview = {
  reviewId: 1,
  event: "REQUEST_CHANGES",
  headSha: "abcdef1234",
  verdict: "request_changes",
  heldBack: 0,
  at: 1,
}

const ready: ApproveFacts = {
  inThread: false,
  enabled: true,
  allowAuthor: false,
  commenter: "reviewer",
  author: "Author",
  workflow: true,
  open: true,
  paused: false,
  reviewRunning: false,
  reviewedHead: "abcdef1234",
  lastReview: requested,
  head: "abcdef1234",
}

describe("approveStep", () => {
  it("overrides a reviewed head whose review stands", () => {
    expect(approveStep(ready)).toBe("override")
  })

  it.each([
    ["thread", { inThread: true }],
    ["disabled", { enabled: false }],
    ["author", { commenter: "author" }],
    ["workflow_off", { workflow: false }],
    ["workflow_off", { workflow: "unknown" as const }],
    ["not_open", { open: false }],
    ["paused", { paused: true }],
    ["review_running", { reviewRunning: true }],
    ["not_reviewed", { reviewedHead: "0000000" }],
    ["not_reviewed", { lastReview: undefined }],
    ["not_reviewed", { lastReview: { ...requested, headSha: "0000000" } }],
    ["approved", { lastReview: { ...requested, event: "APPROVE" as const } }],
  ])("refuses as %s", (step, facts) => {
    expect(approveStep({ ...ready, ...facts })).toBe(step)
  })

  it("checks in order, so a thread reply is refused before anything else", () => {
    expect(approveStep({ ...ready, inThread: true, enabled: false, paused: true })).toBe("thread")
    expect(approveStep({ ...ready, paused: true, reviewRunning: true })).toBe("paused")
  })

  it("lets the author through only when the repository allows authors, comparing logins without case", () => {
    expect(approveStep({ ...ready, commenter: "AUTHOR" })).toBe("author")
    expect(approveStep({ ...ready, commenter: "author", allowAuthor: true })).toBe("override")
  })
})

describe("approveReply", () => {
  it.each([
    ["thread", "Type `@andabot approve` as a comment on the pull request, not in a thread."],
    ["disabled", "`.andabot.yaml` turns `approve` off for this repository."],
    [
      "author",
      "You opened this pull request, so `approve` needs someone else; `.andabot.yaml` can allow authors with `reviews.approve.allow_author: true`.",
    ],
    ["workflow_off", "I never approve here: the request-changes workflow is off."],
    ["not_open", "This pull request is closed or a draft, so there's nothing to approve."],
    ["paused", "I'm paused here; `@andabot resume` first."],
    ["review_running", "My review of `abcdef1` is still running; type approve once it posts."],
    ["not_reviewed", "I haven't reviewed `abcdef1` yet; type approve once my review posts."],
    ["approved", "`abcdef1` is approved already."],
  ] as const)("words %s", (step, text) => {
    expect(approveReply(step, "abcdef1234", "andabot")).toBe(text)
  })
})

describe("overrideReply", () => {
  it("says it approved, or what it waits for", () => {
    expect(overrideReply({ kind: "approved", head: "abcdef1234" }, "abcdef1234", "andabot")).toBe(
      "Approved `abcdef1` on your request. My open threads stay open; `@andabot resolve` closes them.",
    )
    expect(overrideReply({ kind: "wait", reason: "checks_pending" }, "abcdef1234", "andabot")).toBe(
      "I'll approve `abcdef1` once the other checks pass.",
    )
    expect(overrideReply({ kind: "wait", reason: "checks_failing" }, "abcdef1234", "andabot")).toBe(
      "I'll approve `abcdef1` once the failing checks pass.",
    )
    expect(overrideReply({ kind: "wait", reason: "head_moved" }, "abcdef1234", "andabot")).toBe(
      "I couldn't approve `abcdef1` yet: head_moved.",
    )
    expect(overrideReply({ kind: "failed", transient: true }, "abcdef1234", "andabot")).toBe(
      "I couldn't approve `abcdef1`: GitHub didn't answer. Try `@andabot approve` again.",
    )
  })
})
