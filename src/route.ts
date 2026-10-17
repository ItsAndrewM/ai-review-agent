import { Type, type Static } from "typebox"
import type { Incoming, PullRequestKey } from "./pull-request.ts"

const Account = Type.Object({ login: Type.String() })

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
})

export type WebhookPayload = Static<typeof WebhookPayload>

type PullRequestEvent = NonNullable<WebhookPayload["pull_request"]>
type IssueEvent = NonNullable<WebhookPayload["issue"]>
type CommentEvent = NonNullable<WebhookPayload["comment"]>
type RepoKey = Omit<PullRequestKey, "number">

interface Delivery {
  repo: RepoKey
  deliveryId: string
  action: string | undefined
}

export type Routed = { kind: "handle"; incoming: Incoming } | { kind: "ignore"; reason: string }

const REVIEW_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"])

export function routeWebhook(eventName: string, payload: WebhookPayload, deliveryId: string, botLogin: string): Routed {
  if (payload.sender?.type === "Bot") return ignore("sent by a bot")
  const repo = repoKeyOf(payload)
  if (!repo) return ignore("no installation or repository")
  const delivery = { repo, deliveryId, action: payload.action }
  if (eventName === "pull_request" && payload.pull_request) return routePullRequest(payload.pull_request, delivery)
  if (eventName === "issue_comment" && payload.comment && payload.issue) {
    return routeComment(payload.issue, payload.comment, delivery, botLogin)
  }
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

function routePullRequest(pullRequest: PullRequestEvent, delivery: Delivery): Routed {
  const action = delivery.action ?? ""
  if (!REVIEW_ACTIONS.has(action)) return ignore(`pull_request ${action}`)
  if (pullRequest.draft) return ignore("draft pull request")
  return {
    kind: "handle",
    incoming: {
      kind: "review",
      key: { ...delivery.repo, number: pullRequest.number },
      deliveryId: delivery.deliveryId,
      headSha: pullRequest.head.sha,
      full: false,
    },
  }
}

function routeComment(issue: IssueEvent, comment: CommentEvent, delivery: Delivery, botLogin: string): Routed {
  if (delivery.action !== "created") return ignore(`issue_comment ${delivery.action ?? ""}`)
  if (!issue.pull_request) return ignore("comment on an issue, not a pull request")
  if (!new RegExp(`(?:^|\\s)@${botLogin}(?![\\w-])`, "i").test(comment.body)) return ignore("no mention")
  if (!comment.user) return ignore("comment without an author")
  return {
    kind: "handle",
    incoming: {
      kind: "comment",
      key: { ...delivery.repo, number: issue.number },
      deliveryId: delivery.deliveryId,
      author: comment.user.login,
      body: comment.body,
    },
  }
}

function ignore(reason: string): Routed {
  return { kind: "ignore", reason }
}
