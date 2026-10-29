import { Type, type Static } from "typebox"
import type { Incoming, ThreadContext } from "./pull-request.ts"
import type { PullRequestKey } from "./records.ts"
import type { WebhookTrigger } from "./review/approval.ts"

const Account = Type.Object({ login: Type.String() })

const CheckTarget = Type.Object({
  head_sha: Type.String(),
  pull_requests: Type.Array(Type.Object({ number: Type.Integer() })),
  app: Type.Optional(Type.Union([Type.Object({ slug: Type.Optional(Type.String()) }), Type.Null()])),
})

export const WebhookPayload = Type.Object({
  action: Type.Optional(Type.String()),
  installation: Type.Optional(Type.Object({ id: Type.Integer() })),
  repository: Type.Optional(Type.Object({ name: Type.String(), owner: Account })),
  sender: Type.Optional(Type.Object({ login: Type.String(), type: Type.String() })),
  pull_request: Type.Optional(
    Type.Object({
      number: Type.Integer(),
      node_id: Type.Optional(Type.String()),
      draft: Type.Optional(Type.Boolean()),
      body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      head: Type.Object({ sha: Type.String() }),
    }),
  ),
  issue: Type.Optional(Type.Object({ number: Type.Integer(), pull_request: Type.Optional(Type.Object({})) })),
  review: Type.Optional(
    Type.Object({
      node_id: Type.Optional(Type.String()),
      body: Type.Union([Type.String(), Type.Null()]),
      user: Type.Union([Account, Type.Null()]),
    }),
  ),
  comment: Type.Optional(
    Type.Object({
      id: Type.Optional(Type.Integer()),
      node_id: Type.Optional(Type.String()),
      in_reply_to_id: Type.Optional(Type.Integer()),
      body: Type.String(),
      user: Type.Union([Account, Type.Null()]),
      path: Type.Optional(Type.String()),
      line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
      diff_hunk: Type.Optional(Type.String()),
    }),
  ),
  check_run: Type.Optional(CheckTarget),
  check_suite: Type.Optional(CheckTarget),
})

export type WebhookPayload = Static<typeof WebhookPayload>

type PullRequestEvent = NonNullable<WebhookPayload["pull_request"]>
type CommentEvent = NonNullable<WebhookPayload["comment"]>
type CheckTarget = Static<typeof CheckTarget>
type ReviewIncoming = Extract<Incoming, { kind: "review" }>
type CommentIncoming = Extract<Incoming, { kind: "comment" }>
type RepoKey = Omit<PullRequestKey, "number">

interface Delivery {
  repo: RepoKey
  deliveryId: string
  action: string | undefined
}

export type Routed = { kind: "handle"; incoming: Incoming[] } | { kind: "ignore"; reason: string }

const REVIEW_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"])

export function routeWebhook(eventName: string, payload: WebhookPayload, deliveryId: string, botLogin: string): Routed {
  const repo = repoKeyOf(payload)
  if (!repo) return ignore("no installation or repository")
  const delivery = { repo, deliveryId, action: payload.action }
  const fromAnySender = routeFromAnySender(eventName, payload, delivery, botLogin)
  if (fromAnySender) return fromAnySender
  if (payload.sender?.type === "Bot") return ignore("sent by a bot")
  return routeEvent(eventName, payload, delivery, botLogin)
}

function routeFromAnySender(
  eventName: string,
  payload: WebhookPayload,
  delivery: Delivery,
  botLogin: string,
): Routed | undefined {
  if (eventName === "check_suite" && delivery.action === "completed") {
    return routeCompletedSuite(payload.check_suite, delivery, botLogin)
  }
  if (eventName === "pull_request" && delivery.action === "closed" && payload.pull_request) {
    const key = { ...delivery.repo, number: payload.pull_request.number }
    return { kind: "handle", incoming: [{ kind: "closed", key, deliveryId: delivery.deliveryId }] }
  }
  return undefined
}

function routeEvent(eventName: string, payload: WebhookPayload, delivery: Delivery, botLogin: string): Routed {
  if (eventName === "pull_request" && payload.pull_request) {
    return routePullRequest(payload.pull_request, delivery, botLogin)
  }
  if (eventName === "pull_request_review_thread" && payload.pull_request) {
    return routeThread(payload.pull_request, delivery)
  }
  if (eventName === "issue_comment") return routeComment(payload, delivery, botLogin)
  if (eventName === "pull_request_review_comment") return routeReviewComment(payload, delivery, botLogin)
  if (eventName === "pull_request_review") return routeReview(payload, delivery, botLogin)
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

function routePullRequest(pullRequest: PullRequestEvent, delivery: Delivery, botLogin: string): Routed {
  const action = delivery.action ?? ""
  if (!REVIEW_ACTIONS.has(action)) return ignore(`pull_request ${action}`)
  const reaction = action === "opened" ? descriptionReaction(pullRequest, delivery, botLogin) : undefined
  const review = reviewOf(pullRequest, delivery)
  return { kind: "handle", incoming: reaction ? [reaction, review] : [review] }
}

function descriptionReaction(
  pullRequest: PullRequestEvent,
  delivery: Delivery,
  botLogin: string,
): Incoming | undefined {
  const { node_id: nodeId, body } = pullRequest
  if (nodeId === undefined || !mentions(body ?? "", botLogin)) return undefined
  return {
    kind: "reaction",
    key: { ...delivery.repo, number: pullRequest.number },
    deliveryId: delivery.deliveryId,
    nodeId,
  }
}

function reviewOf(pullRequest: PullRequestEvent, delivery: Delivery): Incoming {
  return {
    kind: "review",
    key: { ...delivery.repo, number: pullRequest.number },
    deliveryId: delivery.deliveryId,
    headSha: pullRequest.head.sha,
    full: false,
  }
}

function routeComment(payload: WebhookPayload, delivery: Delivery, botLogin: string): Routed {
  const { issue, comment } = payload
  if (delivery.action !== "created") return ignore(`issue_comment ${delivery.action ?? ""}`)
  if (!issue || !comment) return ignore("comment without its issue")
  if (!issue.pull_request) return ignore("comment on an issue, not a pull request")
  if (!mentions(comment.body, botLogin)) return ignore("no mention")
  if (!comment.user) return ignore("comment without an author")
  return {
    kind: "handle",
    incoming: [
      commentOf(delivery, issue.number, { author: comment.user.login, body: comment.body, nodeId: comment.node_id }),
    ],
  }
}

function commentOf(
  delivery: Delivery,
  number: number,
  comment: Pick<CommentIncoming, "author" | "body" | "nodeId">,
): CommentIncoming {
  return { kind: "comment", key: { ...delivery.repo, number }, deliveryId: delivery.deliveryId, ...comment }
}

function routeReview(payload: WebhookPayload, delivery: Delivery, botLogin: string): Routed {
  const { pull_request: pullRequest, review } = payload
  if (delivery.action !== "submitted") return ignore(`pull_request_review ${delivery.action ?? ""}`)
  if (!pullRequest || !review) return ignore("review without its pull request")
  const body = review.body ?? ""
  if (!mentions(body, botLogin)) return ignore("no mention")
  if (!review.user) return ignore("review without an author")
  return {
    kind: "handle",
    incoming: [commentOf(delivery, pullRequest.number, { author: review.user.login, body, nodeId: review.node_id })],
  }
}

function routeReviewComment(payload: WebhookPayload, delivery: Delivery, botLogin: string): Routed {
  const { pull_request: pullRequest, comment } = payload
  if (delivery.action !== "created") return ignore(`pull_request_review_comment ${delivery.action ?? ""}`)
  if (!pullRequest || !comment) return ignore("review comment without its pull request")
  if (!comment.user) return ignore("comment without an author")
  const thread = threadContextOf(comment)
  if (!thread) return ignore("review comment without its thread")
  if (!mentions(comment.body, botLogin) && comment.in_reply_to_id === undefined) return ignore("no mention")
  const asked = commentOf(delivery, pullRequest.number, {
    author: comment.user.login,
    body: comment.body,
    nodeId: comment.node_id,
  })
  return { kind: "handle", incoming: [{ ...asked, thread }] }
}

function threadContextOf(comment: CommentEvent): ThreadContext | undefined {
  const { id, path, diff_hunk: diffHunk } = comment
  if (id === undefined || path === undefined || diffHunk === undefined) return undefined
  return { commentId: id, rootId: comment.in_reply_to_id ?? id, path, line: comment.line ?? null, diffHunk }
}

export function mentions(body: string, botLogin: string): boolean {
  return new RegExp(`(?:^|\\s)@${botLogin}(?![\\w-])`, "i").test(body)
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

function routeThread(pullRequest: PullRequestEvent, delivery: Delivery): Routed {
  const trigger = threadTrigger(delivery.action)
  if (trigger === undefined) return ignore(`pull_request_review_thread ${delivery.action ?? ""}`)
  return { kind: "handle", incoming: [approval(delivery, pullRequest.number, trigger)] }
}

function threadTrigger(action: string | undefined): WebhookTrigger | undefined {
  if (action === "resolved") return "thread_resolved"
  if (action === "unresolved") return "thread_unresolved"
  return undefined
}

function routeCompletedSuite(suite: CheckTarget | undefined, delivery: Delivery, botLogin: string): Routed {
  if (!suite) return ignore("check_suite completed without a suite")
  if (suite.app?.slug === botLogin) return ignore(`${botLogin}'s own check suite`)
  if (suite.pull_requests.length === 0) return ignore("check with no pull request")
  return {
    kind: "handle",
    incoming: suite.pull_requests.map(({ number }) => approval(delivery, number, "checks_completed")),
  }
}

function approval(delivery: Delivery, number: number, trigger: WebhookTrigger): Incoming {
  return { kind: "approval", key: { ...delivery.repo, number }, deliveryId: delivery.deliveryId, trigger }
}

function ignore(reason: string): Routed {
  return { kind: "ignore", reason }
}
