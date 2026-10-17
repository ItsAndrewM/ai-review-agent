import { describe, expect, it } from "vitest"
import { objectName, routeWebhook } from "../src/route.ts"

const repository = { name: "ai-review-agent", owner: { login: "ItsAndrewM" } }
const base = { installation: { id: 99 }, repository, sender: { login: "andrew", type: "User" } }

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
      incoming: {
        kind: "review",
        key: { installationId: 99, owner: "ItsAndrewM", repo: "ai-review-agent", number: 3 },
        deliveryId: "d1",
        headSha: "abc",
        full: false,
      },
    })
  })

  it("ignores drafts, closed events, bots and other events", () => {
    const pr = { number: 3, draft: true, head: { sha: "abc" } }
    expect(routeWebhook("pull_request", { ...base, action: "opened", pull_request: pr }, "d", "andabot")).toMatchObject(
      { kind: "ignore", reason: "draft pull request" },
    )
    expect(
      routeWebhook(
        "pull_request",
        { ...base, action: "closed", pull_request: { ...pr, draft: false } },
        "d",
        "andabot",
      ),
    ).toMatchObject({ kind: "ignore" })
    expect(
      routeWebhook(
        "pull_request",
        {
          ...base,
          sender: { login: "andabot[bot]", type: "Bot" },
          action: "opened",
          pull_request: { ...pr, draft: false },
        },
        "d",
        "andabot",
      ),
    ).toMatchObject({ reason: "sent by a bot" })
    expect(routeWebhook("push", base, "d", "andabot")).toMatchObject({ reason: "event push" })
  })

  it("turns a mention in a pull request comment into a comment event, and ignores the rest", () => {
    const comment = { id: 5, body: "@andabot review", user: { login: "andrew", type: "User" } }
    expect(
      routeWebhook(
        "issue_comment",
        { ...base, action: "created", issue: { number: 3, pull_request: {} }, comment },
        "d2",
        "andabot",
      ),
    ).toEqual({
      kind: "handle",
      incoming: {
        kind: "comment",
        key: { installationId: 99, owner: "ItsAndrewM", repo: "ai-review-agent", number: 3 },
        deliveryId: "d2",
        author: "andrew",
        body: "@andabot review",
      },
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
  })

  it("names the object by installation, repo and number", () => {
    expect(objectName({ installationId: 99, owner: "a", repo: "b", number: 7 })).toBe("99/a/b#7")
  })
})
