import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { GitHubError } from "../src/github/errors.ts"
import {
  abandonReplyWanted,
  Deliveries,
  deliveryKey,
  RETRY_DELAYS_MS,
  retryDelay,
  retryJobId,
  StoredIncoming,
  type DeliveryHost,
  type Incoming,
  type RetryJob,
  type StoredDelivery,
} from "../src/review/delivery.ts"

const KEY = { installationId: 1, owner: "o", repo: "r", number: 7 }

const review: Incoming = { kind: "review", key: KEY, deliveryId: "d-1", headSha: "abc", full: false }
const reaction: Incoming = { kind: "reaction", key: KEY, deliveryId: "d-1", nodeId: "n1" }

const outage = new GitHubError("GitHub 522 /repos/o/r/pulls/7", 522, "/repos/o/r/pulls/7")
const refused = new GitHubError("GitHub 404 /repos/o/r/pulls/7", 404, "/repos/o/r/pulls/7")

class FakeHost implements DeliveryHost {
  records = new Map<string, StoredDelivery>()
  forgets: string[] = []
  schedules: { id: string; time: number; payload: RetryJob }[] = []
  clock = 1_000_000
  async store(key: string, record: StoredDelivery): Promise<void> {
    this.records.set(key, record)
  }
  async load(key: string): Promise<StoredDelivery | undefined> {
    return this.records.get(key)
  }
  async forget(key: string): Promise<void> {
    this.forgets.push(key)
    this.records.delete(key)
  }
  async schedule(id: string, time: number, payload: RetryJob): Promise<void> {
    this.schedules.push({ id, time, payload })
  }
  now(): number {
    return this.clock
  }
}

const failing = (error: Error) => async () => {
  throw error
}

describe("the ladder and the keys", () => {
  it("retries after 30 s, 2 min and 10 min, then no more", () => {
    expect(RETRY_DELAYS_MS).toEqual([30_000, 120_000, 600_000])
    expect([0, 1, 2, 3].map(retryDelay)).toEqual([30_000, 120_000, 600_000, undefined])
  })

  it("keys the record and the job by delivery and kind, since one delivery can carry two incomings", () => {
    expect(deliveryKey("d-1", "review")).toBe("delivery:d-1:review")
    expect(retryJobId("d-1", "review")).toBe("event.retry:d-1:review")
  })
})

describe("StoredIncoming", () => {
  it("keeps an edited event, which refreshes the summary's close block", () => {
    const key = { installationId: 99, owner: "ItsAndrewM", repo: "ai-review-agent", number: 3 }
    expect(Value.Check(StoredIncoming, { kind: "edited", key, deliveryId: "d" })).toBe(true)
  })

  it("keeps a sweep's review incoming with the listing's facts", () => {
    const sweep = { draft: true, baseRef: "main", title: "WIP" }
    const stored = { ...review, deliveryId: "sweep:abc", sweep }
    const roundTripped: unknown = JSON.parse(JSON.stringify(stored))
    expect(Value.Check(StoredIncoming, roundTripped)).toBe(true)
    expect(roundTripped).toEqual(stored)
  })

  it("still keeps a webhook's review incoming, which has no sweep facts", () => {
    expect(Value.Check(StoredIncoming, review)).toBe(true)
  })

  it("refuses sweep facts missing a field", () => {
    expect(Value.Check(StoredIncoming, { ...review, sweep: { draft: false, baseRef: "main" } })).toBe(false)
  })
})

describe("Deliveries.accept", () => {
  it("stores the incoming, handles it, and forgets it when the handler resolves", async () => {
    const host = new FakeHost()
    const handled: Incoming[] = []
    await new Deliveries(host).accept(review, async (incoming) => {
      handled.push(incoming)
      expect(host.records.get("delivery:d-1:review")).toEqual({ incoming: review, firstAt: 1_000_000 })
    })
    expect(handled).toEqual([review])
    expect(host.forgets).toEqual(["delivery:d-1:review"])
    expect(host.schedules).toEqual([])
  })

  it("keeps the record and schedules the first rung when the handler throws a transient error", async () => {
    const host = new FakeHost()
    await new Deliveries(host).accept(review, failing(outage))
    expect(host.records.has("delivery:d-1:review")).toBe(true)
    expect(host.schedules).toEqual([
      { id: "event.retry:d-1:review", time: 1_030_000, payload: { delivery: "d-1", kind: "review", attempt: 0 } },
    ])
  })

  it("forgets and schedules nothing when the handler throws a final error", async () => {
    const host = new FakeHost()
    await new Deliveries(host).accept(review, failing(refused))
    expect(host.records.size).toBe(0)
    expect(host.schedules).toEqual([])
  })

  it("keeps a reaction and a review of one delivery apart", async () => {
    const host = new FakeHost()
    const deliveries = new Deliveries(host)
    await deliveries.accept(reaction, failing(outage))
    await deliveries.accept(review, failing(outage))
    expect([...host.records.keys()]).toEqual(["delivery:d-1:reaction", "delivery:d-1:review"])
    expect(host.schedules.map((job) => job.id)).toEqual(["event.retry:d-1:reaction", "event.retry:d-1:review"])
  })
})

describe("Deliveries.retry", () => {
  const stored = (host: FakeHost, incoming: Incoming, firstAt = 1_000_000) =>
    host.records.set(deliveryKey(incoming.deliveryId, incoming.kind), { incoming, firstAt })
  const never = async () => {
    throw new Error("abandon should not be called")
  }

  it("replays the stored incoming and forgets it on success", async () => {
    const host = new FakeHost()
    stored(host, review)
    const handled: Incoming[] = []
    await new Deliveries(host).retry(
      { delivery: "d-1", kind: "review", attempt: 0 },
      async (incoming) => {
        handled.push(incoming)
      },
      never,
    )
    expect(handled).toEqual([review])
    expect(host.records.size).toBe(0)
  })

  it("schedules the next rung from the ladder when the replay fails transiently", async () => {
    const host = new FakeHost()
    stored(host, review)
    await new Deliveries(host).retry({ delivery: "d-1", kind: "review", attempt: 0 }, failing(outage), never)
    expect(host.schedules).toEqual([
      { id: "event.retry:d-1:review", time: 1_120_000, payload: { delivery: "d-1", kind: "review", attempt: 1 } },
    ])
    expect(host.records.size).toBe(1)
  })

  it("abandons after the third retry, with the attempts and the time since the first, then forgets", async () => {
    const host = new FakeHost()
    stored(host, review, 1_000_000 - 750_000)
    const abandoned: [Incoming, string, number, number][] = []
    await new Deliveries(host).retry(
      { delivery: "d-1", kind: "review", attempt: 2 },
      failing(outage),
      async (incoming, error, attempts, sinceMs) => {
        abandoned.push([incoming, error.message, attempts, sinceMs])
      },
    )
    expect(abandoned).toEqual([[review, "GitHub 522 /repos/o/r/pulls/7", 3, 750_000]])
    expect(host.schedules).toEqual([])
    expect(host.records.size).toBe(0)
  })

  it("never lets a throwing abandon out, and still forgets", async () => {
    const host = new FakeHost()
    stored(host, review)
    await expect(
      new Deliveries(host).retry({ delivery: "d-1", kind: "review", attempt: 2 }, failing(outage), failing(refused)),
    ).resolves.toBeUndefined()
    expect(host.records.size).toBe(0)
  })

  it("forgets a final failure without another rung", async () => {
    const host = new FakeHost()
    stored(host, review)
    await new Deliveries(host).retry({ delivery: "d-1", kind: "review", attempt: 1 }, failing(refused), never)
    expect(host.schedules).toEqual([])
    expect(host.records.size).toBe(0)
  })

  it("abandons nothing and forgets when the stored record is gone", async () => {
    const host = new FakeHost()
    const handled: Incoming[] = []
    await new Deliveries(host).retry(
      { delivery: "d-9", kind: "review", attempt: 0 },
      async (incoming) => {
        handled.push(incoming)
      },
      never,
    )
    expect(handled).toEqual([])
    expect(host.forgets).toEqual(["delivery:d-9:review"])
  })
})

describe("abandonReplyWanted", () => {
  it("replies only where andabot was addressed: a mention anywhere, or a reply in one of its own threads", () => {
    expect(abandonReplyWanted("@andabot review", "andabot", false)).toBe(true)
    expect(abandonReplyWanted("looks fine to me", "andabot", true)).toBe(true)
    expect(abandonReplyWanted("looks fine to me", "andabot", false)).toBe(false)
    expect(abandonReplyWanted("@andabottle no", "andabot", false)).toBe(false)
  })
})
