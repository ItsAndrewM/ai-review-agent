import { describe, expect, it } from "vitest"
import type { ReviewThread } from "../src/github/client.ts"
import type { WaitReason } from "../src/review/approval.ts"
import { approvalNote, resolveRefusal, resolveReply, resolveTargets } from "../src/review/resolve.ts"

const thread = (firstCommentId: number, authorLogin: string | null, authorIsBot: boolean) =>
  ({
    id: `T${firstCommentId}`,
    resolved: false,
    outdated: false,
    path: "src/a.ts",
    line: 12,
    side: "RIGHT",
    firstCommentId,
    firstCommentBody: "**🔴 Blocking: x**",
    authorLogin,
    authorIsBot,
  }) satisfies ReviewThread

const botThread = thread(7, "andabot", true)
const resolvedBotThread = { ...thread(6, "andabot", true), resolved: true }
const humanThread = thread(8, "andrew", false)
const otherBotThread = thread(9, "coderabbitai", true)
const deletedAuthorThread = thread(10, null, false)

describe("resolveTargets", () => {
  it("takes every one of andabot's open threads from the conversation", () => {
    const threads = [botThread, resolvedBotThread, humanThread, otherBotThread, deletedAuthorThread]
    expect(resolveTargets({ where: "conversation", threads }, "andabot")).toEqual({
      kind: "resolve",
      threads: [expect.objectContaining({ threadId: "T7" })],
    })
  })

  it("resolves nothing, and doesn't refuse, when none of its threads is open in the conversation", () => {
    expect(resolveTargets({ where: "conversation", threads: [resolvedBotThread, humanThread] }, "andabot")).toEqual({
      kind: "resolve",
      threads: [],
    })
    expect(resolveTargets({ where: "conversation", threads: [] }, "andabot")).toEqual({ kind: "resolve", threads: [] })
  })

  it("takes only the thread it's typed in", () => {
    expect(resolveTargets({ where: "thread", thread: botThread }, "andabot")).toEqual({
      kind: "resolve",
      threads: [expect.objectContaining({ threadId: "T7" })],
    })
    expect(resolveTargets({ where: "thread", thread: humanThread }, "andabot")).toEqual({ kind: "not_mine" })
    expect(resolveTargets({ where: "thread", thread: resolvedBotThread }, "andabot")).toEqual({
      kind: "resolved_already",
    })
    expect(resolveTargets({ where: "thread", thread: undefined }, "andabot")).toEqual({ kind: "unknown" })
  })

  it("refuses a thread that isn't andabot's, resolved or not", () => {
    const resolvedHumanThread = { ...humanThread, resolved: true }
    expect(resolveTargets({ where: "thread", thread: resolvedHumanThread }, "andabot")).toEqual({ kind: "not_mine" })
    expect(resolveTargets({ where: "thread", thread: otherBotThread }, "andabot")).toEqual({ kind: "not_mine" })
    expect(resolveTargets({ where: "thread", thread: deletedAuthorThread }, "andabot")).toEqual({ kind: "not_mine" })
  })
})

describe("resolveRefusal", () => {
  it("words a refusal", () => {
    expect(resolveRefusal("not_mine")).toBe("I only resolve my own threads, and this one isn't mine.")
    expect(resolveRefusal("resolved_already")).toBe("Already resolved.")
    expect(resolveRefusal("unknown")).toBe("I couldn't find this thread.")
    expect(resolveRefusal("unreadable")).toBe("I couldn't read the threads, so I resolved none.")
  })
})

describe("approvalNote", () => {
  const waiting = (reason: WaitReason, heldBack = 0, withheld = 0) =>
    approvalNote({ kind: "wait", reason }, { heldBack, withheld }, "andabot")

  it("says what approval does next", () => {
    expect(approvalNote({ kind: "approved", head: "def5678901" }, undefined, "andabot")).toBe("Approved `def5678`.")
    expect(waiting("paused")).toBe("Approval waits until `@andabot resume`.")
    expect(waiting("review_stands", 1)).toBe(
      "Approval still waits: my last review holds back 1 blocking finding that isn't in a thread; push a fix or ask for a `full review`.",
    )
    expect(waiting("review_stands", 2)).toBe(
      "Approval still waits: my last review holds back 2 blocking findings that aren't in a thread; push a fix or ask for a `full review`.",
    )
    expect(waiting("review_stands", 0)).toBe("Approval waits for my next review, since my last one only commented.")
    expect(waiting("workflow_off")).toBeUndefined()
    expect(approvalNote({ kind: "failed", transient: false }, undefined, "andabot")).toBe(
      "I couldn't check approval this time.",
    )
  })

  it("names the deploy's own config file when it couldn't read it", () => {
    expect(approvalNote({ kind: "wait", reason: "workflow_unknown" }, undefined, "andabot")).toBe(
      "Approval waits: I couldn't read `.andabot.yaml`.",
    )
    expect(approvalNote({ kind: "wait", reason: "workflow_unknown" }, undefined, "andabot-staging")).toBe(
      "Approval waits: I couldn't read `.andabot-staging.yaml`.",
    )
  })

  it("says the last review withheld approval, unless it also holds a finding back", () => {
    expect(waiting("review_stands", 0, 2)).toBe(
      "Approval waits for my next review, since my last one withheld it; its body says why.",
    )
    expect(waiting("review_stands", 1, 2)).toContain("holds back 1 blocking finding")
    expect(approvalNote({ kind: "wait", reason: "review_stands" }, undefined, "andabot")).toBe(
      "Approval waits for my next review, since my last one only commented.",
    )
  })

  it("names the bot that has to resume", () => {
    expect(approvalNote({ kind: "wait", reason: "paused" }, undefined, "reviewer-bot")).toBe(
      "Approval waits until `@reviewer-bot resume`.",
    )
  })

  it("says approval waits when it couldn't read the repository's .andabot.yaml to know the workflow", () => {
    expect(waiting("workflow_unknown")).toBe("Approval waits: I couldn't read `.andabot.yaml`.")
  })

  it("words every other wait plainly", () => {
    expect(waiting("not_open")).toBe("Approval waits: the pull request is closed or a draft.")
    expect(waiting("review_in_flight")).toBe("Approval waits for the review that's running.")
    expect(waiting("not_reviewed")).toBe("Approval waits for my review of the current head.")
    expect(waiting("no_record")).toBe("Approval waits for my next review.")
    expect(waiting("approved")).toBe("I approved this pull request already.")
    expect(waiting("threads_unknown")).toBe("Approval waits: I couldn't read the threads.")
    expect(waiting("blocking_threads")).toBe("Approval waits: one of my blocking threads is still open.")
    expect(waiting("checks_unknown")).toBe("Approval waits: I couldn't read the checks.")
    expect(waiting("checks_failing")).toBe("Approval waits: a check is failing.")
    expect(waiting("checks_pending")).toBe("Approval waits for the checks to finish.")
    expect(waiting("head_moved")).toBe("Approval waits: the head moved, so my review of the new head decides.")
    expect(waiting("approving")).toBe("An approval of this head is already on its way.")
  })
})

describe("resolveReply", () => {
  it("counts what it resolved and adds the approval note", () => {
    expect(resolveReply({ resolved: 3, failed: 0, note: "Approved `def5678`." })).toBe(
      "Resolved 3 of my threads. Approved `def5678`.",
    )
    expect(resolveReply({ resolved: 1, failed: 2, note: undefined })).toBe(
      "Resolved 1 of my threads. 2 couldn't be resolved.",
    )
    expect(resolveReply({ resolved: 0, failed: 0, note: "Approval waits for the checks to finish." })).toBe(
      "None of my threads is open. Approval waits for the checks to finish.",
    )
  })

  it("doesn't say none is open when every open thread failed to resolve", () => {
    expect(resolveReply({ resolved: 0, failed: 2, note: undefined })).toBe(
      "Resolved 0 of my threads. 2 couldn't be resolved.",
    )
  })

  it("ends at the count when there's no approval note", () => {
    expect(resolveReply({ resolved: 2, failed: 0, note: undefined })).toBe("Resolved 2 of my threads.")
    expect(resolveReply({ resolved: 0, failed: 0, note: undefined })).toBe("None of my threads is open.")
  })
})
