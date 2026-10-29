import { Type, type Static } from "typebox"
import { errorOf, isTransient } from "../github/errors.ts"
import { errorText, log, logError } from "../log.ts"
import { PullRequestKey } from "../records.ts"
import { mentions } from "../route.ts"

export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const

export const RETRY_JOB = "event.retry"

export function retryDelay(attempt: number): number | undefined {
  return RETRY_DELAYS_MS[attempt]
}

export function deliveryKey(delivery: string, kind: string): string {
  return `delivery:${delivery}:${kind}`
}

export function retryJobId(delivery: string, kind: string): string {
  return `${RETRY_JOB}:${delivery}:${kind}`
}

export const RetryJob = Type.Object({ delivery: Type.String(), kind: Type.String(), attempt: Type.Integer() })

export type RetryJob = Static<typeof RetryJob>

export const ThreadContext = Type.Object({
  commentId: Type.Integer(),
  rootId: Type.Integer(),
  path: Type.String(),
  line: Type.Union([Type.Integer(), Type.Null()]),
  diffHunk: Type.String(),
})

export type ThreadContext = Static<typeof ThreadContext>

export const WebhookTrigger = Type.Union([
  Type.Literal("thread_resolved"),
  Type.Literal("thread_unresolved"),
  Type.Literal("checks_completed"),
])

export const StoredIncoming = Type.Union([
  Type.Object({
    kind: Type.Literal("review"),
    key: PullRequestKey,
    deliveryId: Type.String(),
    headSha: Type.String(),
    full: Type.Boolean(),
    requestedBy: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("comment"),
    key: PullRequestKey,
    deliveryId: Type.String(),
    author: Type.String(),
    body: Type.String(),
    nodeId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    thread: Type.Optional(ThreadContext),
  }),
  Type.Object({
    kind: Type.Literal("reaction"),
    key: PullRequestKey,
    deliveryId: Type.String(),
    nodeId: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("approval"),
    key: PullRequestKey,
    deliveryId: Type.String(),
    trigger: WebhookTrigger,
  }),
  Type.Object({ kind: Type.Literal("closed"), key: PullRequestKey, deliveryId: Type.String() }),
])

export type Incoming = Static<typeof StoredIncoming>

export const StoredDelivery = Type.Object({ incoming: StoredIncoming, firstAt: Type.Integer() })

export type StoredDelivery = Static<typeof StoredDelivery>

export function abandonReplyWanted(body: string, botLogin: string, ownThread: boolean): boolean {
  return ownThread || mentions(body, botLogin)
}

export interface DeliveryHost {
  store(key: string, record: StoredDelivery): Promise<void>
  load(key: string): Promise<StoredDelivery | undefined>
  forget(key: string): Promise<void>
  schedule(id: string, time: number, payload: RetryJob): Promise<void>
  now(): number
}

export type Handle = (incoming: Incoming) => Promise<void>

export type Abandon = (incoming: Incoming, error: Error, attempts: number, sinceMs: number) => Promise<void>

export class Deliveries {
  constructor(private readonly host: DeliveryHost) {}

  async accept(incoming: Incoming, handle: Handle): Promise<void> {
    const firstAt = this.host.now()
    await this.host.store(deliveryKey(incoming.deliveryId, incoming.kind), { incoming, firstAt })
    await this.#attempt({ incoming, firstAt }, 0, handle, undefined)
  }

  async retry(job: RetryJob, handle: Handle, abandon: Abandon): Promise<void> {
    const key = deliveryKey(job.delivery, job.kind)
    const record = await this.host.load(key)
    if (record === undefined) {
      logError("event.abandoned", {
        delivery: job.delivery,
        kind: job.kind,
        attempts: job.attempt,
        error: "stored delivery unreadable",
      })
      await this.host.forget(key)
      return
    }
    await this.#attempt(record, job.attempt + 1, handle, abandon)
  }

  async #attempt(record: StoredDelivery, next: number, handle: Handle, abandon: Abandon | undefined): Promise<void> {
    const { incoming } = record
    const key = deliveryKey(incoming.deliveryId, incoming.kind)
    try {
      await handle(incoming)
    } catch (cause) {
      await this.#failed(record, next, errorOf(cause), abandon)
      return
    }
    await this.host.forget(key)
  }

  async #failed(record: StoredDelivery, next: number, error: Error, abandon: Abandon | undefined): Promise<void> {
    const { incoming } = record
    const fields = { delivery: incoming.deliveryId, kind: incoming.kind, attempt: next, error: errorText(error) }
    const transient = isTransient(error)
    logError("event.failed", { ...fields, transient })
    const inMs = transient ? retryDelay(next) : undefined
    if (inMs !== undefined) {
      log("event.retry", { ...fields, inMs })
      await this.host.schedule(retryJobId(incoming.deliveryId, incoming.kind), this.host.now() + inMs, {
        delivery: incoming.deliveryId,
        kind: incoming.kind,
        attempt: next,
      })
      return
    }
    if (transient) await this.#abandon(record, next, error, abandon)
    await this.host.forget(deliveryKey(incoming.deliveryId, incoming.kind))
  }

  async #abandon(record: StoredDelivery, attempts: number, error: Error, abandon: Abandon | undefined): Promise<void> {
    const { incoming } = record
    logError("event.abandoned", {
      delivery: incoming.deliveryId,
      kind: incoming.kind,
      attempts,
      error: errorText(error),
    })
    if (abandon === undefined) return
    try {
      await abandon(incoming, error, attempts, this.host.now() - record.firstAt)
    } catch (cause) {
      logError("event.abandon_failed", { delivery: incoming.deliveryId, kind: incoming.kind, error: errorText(cause) })
    }
  }
}
