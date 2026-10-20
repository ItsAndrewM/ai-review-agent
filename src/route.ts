import { Type, type Static } from "typebox"
import type { Incoming } from "./pull-request.ts"
import type { PullRequestKey } from "./records.ts"

const Account = Type.Object({ login: Type.String() })

const CheckTarget = Type.Object({
  head_sha: Type.String(),
  pull_requests: Type.Array(Type.Object({ number: Type.Integer() })),
})

export const WebhookPayload = Type.Object({
  action: Type.Optional(Type.String()),
  installation: Type.Optional(Type.Object({ id: Type.Integer() })),
  repository: Type.Optional(Type.Object({ name: Type.String(), owner: Account })),
  sender: Type.Optional(Type.Object({ login: Type.String(), type: Type.String() })),
  pull_request: Type.Optional(
    Type.Object({
      number: Type.Integer(),
      draft: Type.Optional(Type.Boolean()),
      head: Type.Object({ sha: Type.String() }),
    }),
  ),
  issue: Type.Optional(Type.Object({ number: Type.Integer(), pull_request: Type.Optional(Type.Object({})) })),
  comment: Type.Optional(Type.Object({ body: Type.String(), user: Type.Union([Account, Type.Null()]) })),
  check_run: Type.Optional(CheckTarget),
  check_suite: Type.Optional(CheckTarget),
})

export type WebhookPayload = Static<typeof WebhookPayload>

type PullRequestEvent = NonNullable<WebhookPayload["pull_request"]>
type IssueEvent = NonNullable<WebhookPayload["issue"]>
type CommentEvent = NonNullable<WebhookPayload["comment"]>
type CheckTarget = Static<typeof CheckTarget>
type ReviewIncoming = Extract<Incoming, { kind: "review" }>
type RepoKey = Omit<PullRequestKey, "number">

interface Delivery {
  repo: RepoKey
  deliveryId: string
  action: string | undefined
}

export type Routed = { kind: "handle"; incoming: Incoming[] } | { kind: "ignore"; reason: string }

const REVIEW_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"])

export function routeWebhook(eventName: string, payload: WebhookPayload, deliveryId: string, botLogin: string): Routed {
  if (payload.sender?.type === "Bot") return ignore("sent by a bot")
  const repo = repoKeyOf(payload)
  if (!repo) return ignore("no installation or repository")
  return routeEvent(eventName, payload, { repo, deliveryId, action: payload.action }, botLogin)
}

function routeEvent(eventName: string, payload: WebhookPayload, delivery: Delivery, botLogin: string): Routed {
  if (eventName === "pull_request" && payload.pull_request) return routePullRequest(payload.pull_request, delivery)
  if (eventName === "issue_comment" && payload.comment && payload.issue) {
    return routeComment(payload.issue, payload.comment, delivery, botLogin)
  }
  const target = checkTarget(eventName, payload)
  if (target) return routeCheck(eventName, target, delivery, payload.sender?.login)
  return ignore(`event ${eventName}`)
}

export function objectName(key: PullRequestKey): string {
  return `${key.installationId}/${key.owner}/${key.repo}#${key.number}`
}

function repoKeyOf(payload: WebhookPayload): RepoKey | undefined {
  const installationId = payload.installation?.id
  const repository = payload.repository
  if (installationId === undefined || !repository) return undefined
  return { installationId, owner: repository.owner.login, repo: repository.name }
}

function checkTarget(eventName: string, payload: WebhookPayload): CheckTarget | undefined {
  if (eventName === "check_run") return payload.check_run
  if (eventName === "check_suite") return payload.check_suite
  return undefined
}

function routePullRequest(pullRequest: PullRequestEvent, delivery: Delivery): Routed {
  const action = delivery.action ?? ""
  if (!REVIEW_ACTIONS.has(action)) return ignore(`pull_request ${action}`)
  if (pullRequest.draft) return ignore("draft pull request")
  return {
    kind: "handle",
    incoming: [
      {
        kind: "review",
        key: { ...delivery.repo, number: pullRequest.number },
        deliveryId: delivery.deliveryId,
        headSha: pullRequest.head.sha,
        full: false,
      },
    ],
  }
}

function routeComment(issue: IssueEvent, comment: CommentEvent, delivery: Delivery, botLogin: string): Routed {
  if (delivery.action !== "created") return ignore(`issue_comment ${delivery.action ?? ""}`)
  if (!issue.pull_request) return ignore("comment on an issue, not a pull request")
  if (!new RegExp(`(?:^|\\s)@${botLogin}(?![\\w-])`, "i").test(comment.body)) return ignore("no mention")
  if (!comment.user) return ignore("comment without an author")
  return {
    kind: "handle",
    incoming: [
      {
        kind: "comment",
        key: { ...delivery.repo, number: issue.number },
        deliveryId: delivery.deliveryId,
        author: comment.user.login,
        body: comment.body,
      },
    ],
  }
}

function routeCheck(
  eventName: string,
  target: CheckTarget,
  delivery: Delivery,
  requestedBy: string | undefined,
): Routed {
  if (delivery.action !== "rerequested") return ignore(`${eventName} ${delivery.action ?? ""}`)
  if (target.pull_requests.length === 0) return ignore("check with no pull request")
  const incoming = target.pull_requests.map(({ number }) => {
    const review: ReviewIncoming = {
      kind: "review",
      key: { ...delivery.repo, number },
      deliveryId: delivery.deliveryId,
      headSha: target.head_sha,
      full: true,
    }
    if (requestedBy !== undefined) review.requestedBy = requestedBy
    return review
  })
  return { kind: "handle", incoming }
}

function ignore(reason: string): Routed {
  return { kind: "ignore", reason }
}
