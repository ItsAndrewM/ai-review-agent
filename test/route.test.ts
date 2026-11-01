import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { objectName, routeWebhook, WebhookPayload } from "../src/route.ts"

const repository = { name: "ai-review-agent", owner: { login: "ItsAndrewM" } }
const base = { installation: { id: 99 }, repository, sender: { login: "andrew", type: "User" } }

describe("WebhookPayload", () => {
  it("accepts deliveries the router ignores, a ping and a deleted account's comment among them", () => {
    const ping = { zen: "Keep it logically awesome.", hook_id: 1, hook: { type: "App" } }
    const deletedAccountComment = {
      ...base,
      action: "edited",
      issue: { number: 3, pull_request: { url: null } },
      comment: { id: 5, body: "old", user: null },
    }
    const pullRequest = {
      ...base,
      action: "closed",
      number: 3,
      pull_request: { number: 3, head: { sha: "abc", ref: "feature" }, merged: true },
    }
    for (const payload of [ping, deletedAccountComment, pullRequest]) {
      expect(Value.Check(WebhookPayload, payload)).toBe(true)
    }
  })

  it("accepts a check run with the fields GitHub sends beyond the head and the pull requests", () => {
    const rerun = {
      ...base,
      action: "rerequested",
      check_run: { id: 1, head_sha: "abc", pull_requests: [{ number: 3, url: "x" }], app: { id: 2 } },
    }
    expect(Value.Check(WebhookPayload, rerun)).toBe(true)
  })

  it("rejects a pull request without the head the review is pinned to", () => {
    expect(Value.Check(WebhookPayload, { ...base, pull_request: { number: 3 } })).toBe(false)
  })

  it("accepts a pull request with an empty description and a review with no summary, both of which GitHub sends as null", () => {
    const pullRequest = { number: 3, head: { sha: "abc" }, node_id: "PR_1", body: null }
    expect(Value.Check(WebhookPayload, { ...base, action: "opened", pull_request: pullRequest })).toBe(true)
    const review = { node_id: "PRR_1", body: null, user: { login: "andrew" } }
    expect(Value.Check(WebhookPayload, { ...base, action: "submitted", pull_request: pullRequest, review })).toBe(true)
  })
})

describe("routeWebhook", () => {
  it("turns an opened pull request into a review", () => {
    const routed = routeWebhook(
      "pull_request",
      { ...base, action: "opened", pull_request: { number: 3, draft: false, head: { sha: "abc" } } },
      "d1",
      "andabot",
    )
    expect(routed).toEqual({
      kind: "handle",
      incoming: [
        {
          kind: "review",
          key: { installationId: 99, owner: "ItsAndrewM", repo: "ai-review-agent", number: 3 },
          deliveryId: "d1",
          headSha: "abc",
          full: false,
        },
      ],
    })
  })

  it("forwards a draft pull request, since the object applies reviews.drafts from the base's .andabot.yaml", () => {
    for (const action of ["opened", "synchronize"]) {
      const pr = { number: 3, draft: true, head: { sha: "abc" } }
      expect(routeWebhook("pull_request", { ...base, action, pull_request: pr }, "d", "andabot")).toEqual({
        kind: "handle",
        incoming: [
          {
            kind: "review",
            key: { installationId: 99, owner: "ItsAndrewM", repo: "ai-review-agent", number: 3 },
            deliveryId: "d",
            headSha: "abc",
            full: false,
          },
        ],
      })
    }
  })

  it("starts no review on an edit, and leaves an edit that names no body or base change unrouted", () => {
    const pr = { number: 3, draft: false, head: { sha: "abc" } }
    expect(routeWebhook("pull_request", { ...base, action: "edited", pull_request: pr }, "d", "andabot")).toEqual({
      kind: "ignore",
      reason: "pull_request edited without a body or base change",
    })
  })

  it("turns a closed pull request into a closed event for its object, even when a bot closed or merged it", () => {
    const pr = { number: 3, draft: false, head: { sha: "abc" } }
    const closed = {
      kind: "handle",
      incoming: [
        {
          kind: "closed",
          key: { installationId: 99, owner: "ItsAndrewM", repo: "ai-review-agent", number: 3 },
          deliveryId: "d",
        },
      ],
    }
    const bot = { login: "github-merge-queue[bot]", type: "Bot" }
    expect(routeWebhook("pull_request", { ...base, action: "closed", pull_request: pr }, "d", "andabot")).toEqual(
      closed,
    )
    expect(
      routeWebhook("pull_request", { ...base, sender: bot, action: "closed", pull_request: pr }, "d", "andabot"),
    ).toEqual(closed)
  })

  it("turns an edit of the description or the base into an edited event, and ignores an edit of the title alone", () => {
    const pr = { number: 3, draft: false, head: { sha: "abc" } }
    const edited = {
      kind: "handle",
      incoming: [
        {
          kind: "edited",
          key: { installationId: 99, owner: "ItsAndrewM", repo: "ai-review-agent", number: 3 },
          deliveryId: "d",
        },
      ],
    }
    const editOf = (changes: Record<string, { from: string }>) =>
      routeWebhook("pull_request", { ...base, action: "edited", pull_request: pr, changes }, "d", "andabot")
    expect(editOf({ body: { from: "Closes #1 and #2" } })).toEqual(edited)
    expect(editOf({ base: { from: "staging" } })).toEqual(edited)
    expect(editOf({ title: { from: "old" } })).toEqual({
      kind: "ignore",
      reason: "pull_request edited without a body or base change",
    })
    const bot = { login: "release-please[bot]", type: "Bot" }
    expect(
      routeWebhook(
        "pull_request",
        { ...base, sender: bot, action: "edited", pull_request: pr, changes: { body: { from: "x" } } },
        "d",
        "andabot",
      ),
    ).toEqual(edited)
  })

  it("ignores bots and other events", () => {
    const pr = { number: 3, draft: false, head: { sha: "abc" } }
    expect(
      routeWebhook(
        "pull_request",
        { ...base, sender: { login: "andabot[bot]", type: "Bot" }, action: "opened", pull_request: pr },
        "d",
        "andabot",
      ),
    ).toMatchObject({ reason: "sent by a bot" })
    expect(routeWebhook("push", base, "d", "andabot")).toMatchObject({ reason: "event push" })
  })

  it("turns a mention in a pull request comment into a comment event with the node id to react to, and ignores the rest", () => {
    const comment = { id: 5, node_id: "IC_1", body: "@andabot review", user: { login: "andrew", type: "User" } }
    expect(
      routeWebhook(
        "issue_comment",
        { ...base, action: "created", issue: { number: 3, pull_request: {} }, comment },
        "d2",
        "andabot",
      ),
    ).toEqual({
      kind: "handle",
      incoming: [
        {
          kind: "comment",
          key: { installationId: 99, owner: "ItsAndrewM", repo: "ai-review-agent", number: 3 },
          deliveryId: "d2",
          author: "andrew",
          body: "@andabot review",
          nodeId: "IC_1",
        },
      ],
    })
    expect(
      routeWebhook("issue_comment", { ...base, action: "created", issue: { number: 3 }, comment }, "d", "andabot"),
    ).toMatchObject({ reason: "comment on an issue, not a pull request" })
    expect(
      routeWebhook(
        "issue_comment",
        { ...base, action: "created", issue: { number: 3, pull_request: {} }, comment: { ...comment, body: "lgtm" } },
        "d",
        "andabot",
      ),
    ).toMatchObject({ reason: "no mention" })
    expect(
      routeWebhook(
        "issue_comment",
        { ...base, action: "edited", issue: { number: 3, pull_request: {} }, comment },
        "d",
        "andabot",
      ),
    ).toMatchObject({ reason: "issue_comment edited" })
    expect(
      routeWebhook(
        "issue_comment",
        { ...base, action: "created", issue: { number: 3, pull_request: {} }, comment: { ...comment, user: null } },
        "d",
        "andabot",
      ),
    ).toMatchObject({ reason: "comment without an author" })
  })

  it("names the object by installation, repo and number", () => {
    expect(objectName({ installationId: 99, owner: "a", repo: "b", number: 7 })).toBe("99/a/b#7")
  })
})

const checkTarget = { head_sha: "abc", pull_requests: [{ number: 3 }, { number: 4 }] }

describe("routeWebhook for checks", () => {
  it("turns a re-run into a full review of each listed pull request", () => {
    const expected = {
      kind: "handle",
      incoming: [3, 4].map((number) => ({
        kind: "review",
        key: { installationId: 99, owner: "ItsAndrewM", repo: "ai-review-agent", number },
        deliveryId: "d2",
        headSha: "abc",
        full: true,
        requestedBy: "andrew",
      })),
    }
    expect(
      routeWebhook("check_run", { ...base, action: "rerequested", check_run: checkTarget }, "d2", "andabot"),
    ).toEqual(expected)
    expect(
      routeWebhook("check_suite", { ...base, action: "rerequested", check_suite: checkTarget }, "d2", "andabot"),
    ).toEqual(expected)
  })

  it("ignores check events with no pull request, other check actions, and the suite GitHub requests on every push", () => {
    const fork = { head_sha: "abc", pull_requests: [] }
    expect(routeWebhook("check_run", { ...base, action: "rerequested", check_run: fork }, "d", "andabot")).toEqual({
      kind: "ignore",
      reason: "check with no pull request",
    })
    expect(routeWebhook("check_run", { ...base, action: "completed", check_run: checkTarget }, "d", "andabot")).toEqual(
      {
        kind: "ignore",
        reason: "check_run completed",
      },
    )
    expect(routeWebhook("check_run", { ...base, action: "created", check_run: checkTarget }, "d", "andabot")).toEqual({
      kind: "ignore",
      reason: "check_run created",
    })
    expect(
      routeWebhook("check_suite", { ...base, action: "requested", check_suite: checkTarget }, "d", "andabot"),
    ).toEqual({
      kind: "ignore",
      reason: "check_suite requested",
    })
  })
})

const key3 = { installationId: 99, owner: "ItsAndrewM", repo: "ai-review-agent", number: 3 }
const threadPr = { number: 3, head: { sha: "abc" } }

function threadEvent(overrides: Partial<WebhookPayload>) {
  return routeWebhook(
    "pull_request_review_thread",
    { ...base, action: "resolved", pull_request: threadPr, ...overrides },
    "d",
    "andabot",
  )
}

function completedSuite(check_suite: NonNullable<WebhookPayload["check_suite"]>, sender = base.sender) {
  return routeWebhook("check_suite", { ...base, sender, action: "completed", check_suite }, "d", "andabot")
}

describe("routeWebhook for approval", () => {
  it("turns a resolved or an unresolved thread into an approval evaluation", () => {
    expect(threadEvent({})).toEqual({
      kind: "handle",
      incoming: [{ kind: "approval", key: key3, deliveryId: "d", trigger: "thread_resolved" }],
    })
    expect(threadEvent({ action: "unresolved" })).toEqual({
      kind: "handle",
      incoming: [{ kind: "approval", key: key3, deliveryId: "d", trigger: "thread_unresolved" }],
    })
  })

  it("forwards a thread event on a draft, whose evaluation waits as not_open, and ignores one from a bot or with another action", () => {
    expect(threadEvent({ pull_request: { ...threadPr, draft: true } })).toEqual({
      kind: "handle",
      incoming: [{ kind: "approval", key: key3, deliveryId: "d", trigger: "thread_resolved" }],
    })
    expect(threadEvent({ sender: { login: "andabot[bot]", type: "Bot" } })).toEqual({
      kind: "ignore",
      reason: "sent by a bot",
    })
    expect(threadEvent({ action: "edited" })).toEqual({ kind: "ignore", reason: "pull_request_review_thread edited" })
  })

  it("evaluates each pull request a finished suite lists, even when a bot sent it", () => {
    const routed = completedSuite(
      { head_sha: "abc", pull_requests: [{ number: 3 }, { number: 4 }], app: { slug: "github-actions" } },
      { login: "github-actions[bot]", type: "Bot" },
    )
    expect(routed).toEqual({
      kind: "handle",
      incoming: [3, 4].map((number) => ({
        kind: "approval",
        key: { ...key3, number },
        deliveryId: "d",
        trigger: "checks_completed",
      })),
    })
  })

  it("ignores andabot's own finished suite and a finished suite with no pull request", () => {
    expect(completedSuite({ head_sha: "abc", pull_requests: [{ number: 3 }], app: { slug: "andabot" } })).toEqual({
      kind: "ignore",
      reason: "andabot's own check suite",
    })
    expect(completedSuite({ head_sha: "abc", pull_requests: [], app: { slug: "github-actions" } })).toEqual({
      kind: "ignore",
      reason: "check with no pull request",
    })
  })

  it("evaluates a finished suite whose app is null or has no slug", () => {
    const withApp = { ...base, action: "completed", check_suite: { ...checkTarget, app: { id: 2, name: "Legacy" } } }
    expect(Value.Check(WebhookPayload, withApp)).toBe(true)
    expect(Value.Check(WebhookPayload, { ...withApp, check_suite: { ...checkTarget, app: null } })).toBe(true)
    expect(completedSuite({ ...checkTarget, app: null })).toMatchObject({ kind: "handle" })
    expect(completedSuite({ ...checkTarget, app: {} })).toMatchObject({ kind: "handle" })
  })
})

describe("routeWebhook for review comments", () => {
  const reviewPayload = { ...base, action: "created", pull_request: { number: 3, head: { sha: "abc" } } }
  const asked = {
    id: 11,
    node_id: "PRRC_1",
    body: "@andabot why?",
    user: { login: "andrew" },
    path: "src/a.ts",
    line: 12,
    diff_hunk: "@@ -1 +1 @@",
  }

  it("accepts a review comment with its thread's fields", () => {
    const reply = { ...reviewPayload, comment: { ...asked, body: "x", in_reply_to_id: 7, line: null } }
    expect(Value.Check(WebhookPayload, reply)).toBe(true)
  })

  it("rejects a review comment whose line is neither a number nor null", () => {
    expect(Value.Check(WebhookPayload, { ...reviewPayload, comment: { ...asked, line: "12" } })).toBe(false)
  })

  it("routes a review comment that mentions the bot, with its path, line, hunk and node id", () => {
    expect(routeWebhook("pull_request_review_comment", { ...reviewPayload, comment: asked }, "d1", "andabot")).toEqual({
      kind: "handle",
      incoming: [
        {
          kind: "comment",
          key: { installationId: 99, owner: "ItsAndrewM", repo: "ai-review-agent", number: 3 },
          deliveryId: "d1",
          author: "andrew",
          body: "@andabot why?",
          nodeId: "PRRC_1",
          thread: { commentId: 11, rootId: 11, path: "src/a.ts", line: 12, diffHunk: "@@ -1 +1 @@" },
        },
      ],
    })
  })

  it("routes a reply in a review thread without a mention, with its node id, for the object to check whose thread it is", () => {
    const reply = { ...reviewPayload, comment: { ...asked, body: "why?", in_reply_to_id: 7 } }
    expect(routeWebhook("pull_request_review_comment", reply, "d1", "andabot")).toMatchObject({
      kind: "handle",
      incoming: [{ kind: "comment", body: "why?", nodeId: "PRRC_1", thread: { commentId: 11, rootId: 7 } }],
    })
  })

  it("ignores a top-level review comment that doesn't mention the bot", () => {
    const remark = { ...reviewPayload, comment: { ...asked, body: "lgtm" } }
    expect(routeWebhook("pull_request_review_comment", remark, "d1", "andabot")).toEqual({
      kind: "ignore",
      reason: "no mention",
    })
  })

  it("ignores an edited review comment", () => {
    const edited = { ...reviewPayload, action: "edited", comment: asked }
    expect(routeWebhook("pull_request_review_comment", edited, "d1", "andabot")).toMatchObject({
      reason: "pull_request_review_comment edited",
    })
  })

  it("ignores the bot's own reply in a thread", () => {
    const own = {
      ...reviewPayload,
      sender: { login: "andabot[bot]", type: "Bot" },
      comment: { ...asked, body: "Because the caller drops it.", in_reply_to_id: 7 },
    }
    expect(routeWebhook("pull_request_review_comment", own, "d1", "andabot")).toMatchObject({ reason: "sent by a bot" })
  })

  it("ignores a review comment that arrives without its thread's id, path or hunk", () => {
    const bare = { ...reviewPayload, comment: { body: "@andabot why?", user: { login: "andrew" } } }
    expect(routeWebhook("pull_request_review_comment", bare, "d1", "andabot")).toMatchObject({
      reason: "review comment without its thread",
    })
  })
})

describe("routeWebhook for reviews", () => {
  const submitted = { ...base, action: "submitted", pull_request: { number: 3, head: { sha: "abc" } } }
  const summary = { node_id: "PRR_1", body: "@andabot is this safe?", user: { login: "andrew" } }

  it("turns a review whose summary tags the bot into a conversation comment, with the review's node id", () => {
    expect(routeWebhook("pull_request_review", { ...submitted, review: summary }, "d1", "andabot")).toEqual({
      kind: "handle",
      incoming: [
        {
          kind: "comment",
          key: key3,
          deliveryId: "d1",
          author: "andrew",
          body: "@andabot is this safe?",
          nodeId: "PRR_1",
        },
      ],
    })
  })

  it("ignores a review whose summary doesn't tag the bot or is empty", () => {
    const untagged = { ...submitted, review: { ...summary, body: "Looks good" } }
    expect(routeWebhook("pull_request_review", untagged, "d", "andabot")).toEqual({
      kind: "ignore",
      reason: "no mention",
    })
    const empty = { ...submitted, review: { ...summary, body: null } }
    expect(routeWebhook("pull_request_review", empty, "d", "andabot")).toEqual({ kind: "ignore", reason: "no mention" })
  })

  it("ignores an edited or dismissed review, a review with no author, and the bot's own review", () => {
    expect(
      routeWebhook("pull_request_review", { ...submitted, action: "edited", review: summary }, "d", "andabot"),
    ).toEqual({ kind: "ignore", reason: "pull_request_review edited" })
    expect(
      routeWebhook("pull_request_review", { ...submitted, action: "dismissed", review: summary }, "d", "andabot"),
    ).toEqual({ kind: "ignore", reason: "pull_request_review dismissed" })
    expect(
      routeWebhook("pull_request_review", { ...submitted, review: { ...summary, user: null } }, "d", "andabot"),
    ).toEqual({ kind: "ignore", reason: "review without an author" })
    const own = { ...submitted, sender: { login: "andabot[bot]", type: "Bot" }, review: summary }
    expect(routeWebhook("pull_request_review", own, "d", "andabot")).toEqual({
      kind: "ignore",
      reason: "sent by a bot",
    })
  })
})

describe("routeWebhook for a description that tags the bot", () => {
  const tagged = {
    number: 3,
    draft: false,
    head: { sha: "abc" },
    node_id: "PR_1",
    body: "Fixes the parser. @andabot, check the edge cases",
  }
  const review = { kind: "review", key: key3, deliveryId: "d", headSha: "abc", full: false }
  const reaction = { kind: "reaction", key: key3, deliveryId: "d", nodeId: "PR_1" }

  function pullRequestEvent(action: string, pullRequest: NonNullable<WebhookPayload["pull_request"]>) {
    return routeWebhook("pull_request", { ...base, action, pull_request: pullRequest }, "d", "andabot")
  }

  it("reacts to the pull request beside its review when it opens", () => {
    expect(pullRequestEvent("opened", tagged)).toEqual({ kind: "handle", incoming: [reaction, review] })
  })

  it("reacts to a draft's description beside its review, which the object holds back unless reviews.drafts is on", () => {
    expect(pullRequestEvent("opened", { ...tagged, draft: true })).toEqual({
      kind: "handle",
      incoming: [reaction, review],
    })
  })

  it("reacts only when the pull request opens, and only to a description that tags the bot", () => {
    const reviewOnly = { kind: "handle", incoming: [review] }
    expect(pullRequestEvent("synchronize", tagged)).toEqual(reviewOnly)
    expect(pullRequestEvent("opened", { ...tagged, body: "Fixes the parser." })).toEqual(reviewOnly)
    expect(pullRequestEvent("opened", { ...tagged, body: null })).toEqual(reviewOnly)
  })
})
