import { describe, expect, it } from "vitest"
import type { PullRequestKey } from "../src/records.ts"
import { MAX_CHECKOUT_KIB } from "../src/sandbox/checkout.ts"
import { checkKey, knownChecksOf, type CheckRun } from "../src/sandbox/checks.ts"
import { storedCheckOf, type SandboxRecord } from "../src/sandbox/record.ts"
import type { RunOptions, RunOutcome } from "../src/sandbox/run.ts"
import {
  DEFAULT_SANDBOX_SECONDS,
  LEASE_GRACE_MS,
  sandboxBudgetOf,
  sandboxOn,
  SandboxRuns,
  type SandboxCalls,
  type SandboxHost,
} from "../src/sandbox/runs.ts"

const KEY: PullRequestKey = { installationId: 1, owner: "o", repo: "r", number: 7 }

const ok = (tail: string): RunOutcome => ({ outcome: "exited", exitCode: 0, tail, cut: false })

type Scripted = Partial<Record<"andabot-checkout" | "andabot-detect" | "pnpm" | "npm", RunOutcome>>

class FakeSandbox implements SandboxCalls {
  calls: string[] = []
  tokens: (string | undefined)[] = []
  destroyThrows = false
  alive = true
  runningThrows = false
  rejects: string | undefined
  constructor(private readonly scripted: Scripted) {}

  async running(): Promise<boolean> {
    this.calls.push("running")
    if (this.runningThrows) throw new Error("sandbox object unreachable")
    return this.alive
  }

  async start(token: string | undefined): Promise<void> {
    this.calls.push("start")
    this.tokens.push(token)
  }

  async run(command: readonly string[], _options: RunOptions): Promise<RunOutcome> {
    const name = (command[0] === "/bin/sh" ? command[3] : command[0]) ?? ""
    this.calls.push(`run:${name}`)
    if (name === this.rejects) throw new Error("container gone")
    const outcome =
      this.scripted[
        name === "andabot-checkout" || name === "andabot-detect" || name === "pnpm" || name === "npm" ? name : "pnpm"
      ]
    return outcome ?? ok("")
  }

  async destroy(): Promise<void> {
    this.calls.push("destroy")
    if (this.destroyThrows) throw new Error("gone")
  }
}

class FakeHost implements SandboxHost {
  on = true
  grant = true
  leases: number[] = []
  unleased = 0
  unleaseThrows = false
  headThrows = false
  sha = "abc123"
  clock = 1_000_000
  stored: SandboxRecord | undefined
  saved: (SandboxRecord | undefined)[] = []
  loadThrows = false
  saveThrows = false
  drops: number[] = []
  cancels = 0
  readonly box: FakeSandbox
  constructor(scripted: Scripted) {
    this.box = new FakeSandbox(scripted)
  }
  enabledCalls = 0
  async enabled(): Promise<boolean> {
    this.enabledCalls += 1
    return this.on
  }
  async lease(ttlMs: number): Promise<boolean> {
    this.leases.push(ttlMs)
    return this.grant
  }
  async unlease(): Promise<void> {
    this.unleased += 1
    if (this.unleaseThrows) throw new Error("leases object unreachable")
  }
  async token(): Promise<string> {
    return "scoped-token"
  }
  async sandbox(): Promise<SandboxCalls> {
    return this.box
  }
  async head(): Promise<{ number: number; key: PullRequestKey; sha: string }> {
    if (this.headThrows) throw new Error("GitHub 502")
    return { number: 7, key: KEY, sha: this.sha }
  }
  now(): number {
    return this.clock
  }
  async load(): Promise<SandboxRecord | undefined> {
    if (this.loadThrows) throw new Error("storage unreadable")
    return this.stored
  }
  async save(record: SandboxRecord | undefined): Promise<void> {
    if (this.saveThrows) throw new Error("storage unwritable")
    this.saved.push(record)
  }
  async scheduleDrop(time: number): Promise<void> {
    this.drops.push(time)
  }
  async cancelDrop(): Promise<void> {
    this.cancels += 1
  }
}

const readyRecord = (sha = "abc123"): SandboxRecord => ({
  head: { number: 7, key: KEY, sha },
  started: 900_000,
  leased: true,
  running: true,
  settled: { kind: "ready", manager: "pnpm" },
  checks: [],
})

const READY = { "andabot-checkout": ok("kib=100\n"), "andabot-detect": ok("pnpm\n"), pnpm: ok("done\n") }

describe("SandboxRuns.access", () => {
  it("leases, starts with the scoped token, checks out and installs in that order, then answers ready", async () => {
    const host = new FakeHost(READY)
    const runs = new SandboxRuns(host, 900)
    const access = await runs.access()
    expect(access).toEqual({ kind: "ready", sandbox: host.box, dir: "/workspace/repo", manager: "pnpm" })
    expect(host.box.calls).toEqual(["start", "run:andabot-checkout", "run:andabot-detect", "run:pnpm"])
    expect(host.box.tokens).toEqual(["scoped-token"])
    expect(host.leases).toEqual([900_000 + LEASE_GRACE_MS])
  })

  it("saves the record at each step a teardown would have to undo: head read, leased, running, settled", async () => {
    const host = new FakeHost(READY)
    await new SandboxRuns(host, 900).access()
    expect(host.saved.map((record) => [record?.leased, record?.running, record?.settled?.kind])).toEqual([
      [false, false, undefined],
      [true, false, undefined],
      [true, true, undefined],
      [true, true, "ready"],
    ])
    expect(host.saved[0]).toMatchObject({
      head: { number: 7, key: KEY, sha: "abc123" },
      started: 1_000_000,
      checks: [],
    })
  })

  it("answers from the memo without asking again whether the tier is on", async () => {
    const host = new FakeHost(READY)
    const runs = new SandboxRuns(host, 900)
    await runs.access()
    await runs.access()
    await runs.access()
    expect(host.enabledCalls).toBe(1)
  })

  it("answers off without touching anything when the tier is off", async () => {
    const host = new FakeHost(READY)
    host.on = false
    const access = await new SandboxRuns(host, 900).access()
    expect(access).toEqual({ kind: "off" })
    expect(host.box.calls).toEqual([])
    expect(host.leases).toEqual([])
  })

  it("answers unavailable for the rest of the review when no lease is granted, and never starts", async () => {
    const host = new FakeHost(READY)
    host.grant = false
    const runs = new SandboxRuns(host, 900)
    expect(await runs.access()).toEqual({ kind: "unavailable", reason: "lease" })
    expect(await runs.access()).toEqual({ kind: "unavailable", reason: "lease" })
    expect(host.box.calls).toEqual([])
    expect(host.leases).toHaveLength(1)
  })

  it("destroys, unleases and answers unavailable when the checkout is over the cap, with no second attempt", async () => {
    const host = new FakeHost({ ...READY, "andabot-checkout": ok(`kib=${MAX_CHECKOUT_KIB + 1}\n`) })
    const runs = new SandboxRuns(host, 900)
    expect(await runs.access()).toEqual({ kind: "unavailable", reason: "checkout" })
    expect(host.box.calls).toEqual(["start", "run:andabot-checkout", "destroy"])
    expect(host.unleased).toBe(1)
    expect(await runs.access()).toEqual({ kind: "unavailable", reason: "checkout" })
    expect(host.box.calls).toHaveLength(3)
  })

  it("skips the install and still answers ready when there is no lockfile", async () => {
    const host = new FakeHost({ ...READY, "andabot-detect": ok("none\n") })
    const access = await new SandboxRuns(host, 900).access()
    expect(access.kind).toBe("ready")
    expect(access.kind === "ready" && access.manager).toBe("none")
    expect(host.box.calls).toEqual(["start", "run:andabot-checkout", "run:andabot-detect"])
  })

  it("answers unavailable when the install fails", async () => {
    const host = new FakeHost({ ...READY, pnpm: { outcome: "exited", exitCode: 1, tail: "ERR_PNPM\n", cut: false } })
    expect(await new SandboxRuns(host, 900).access()).toEqual({ kind: "unavailable", reason: "install" })
    expect(host.box.calls.at(-1)).toBe("destroy")
  })

  it("shares one preparation between concurrent callers", async () => {
    const host = new FakeHost(READY)
    const runs = new SandboxRuns(host, 900)
    const [first, second] = await Promise.all([runs.access(), runs.access()])
    expect(first.kind).toBe("ready")
    expect(second.kind).toBe("ready")
    expect(host.box.calls.filter((call) => call === "start")).toHaveLength(1)
  })

  it("answers spent once the wall time since the first call reaches the budget", async () => {
    const host = new FakeHost(READY)
    const runs = new SandboxRuns(host, 10)
    expect((await runs.access()).kind).toBe("ready")
    host.clock += 9_999
    expect((await runs.access()).kind).toBe("ready")
    host.clock += 1
    expect(await runs.access()).toEqual({ kind: "spent", seconds: 10, budget: 10 })
    expect(await runs.seconds()).toBe(10)
  })
})

describe("SandboxRuns.end", () => {
  it("destroys and unleases once, then starts the next review clean", async () => {
    const host = new FakeHost(READY)
    const runs = new SandboxRuns(host, 900)
    await runs.access()
    await runs.end("review_end")
    expect(host.box.calls.at(-1)).toBe("destroy")
    expect(host.unleased).toBe(1)
    expect(await runs.seconds()).toBeUndefined()
    await runs.end("closed")
    expect(host.box.calls.filter((call) => call === "destroy")).toHaveLength(1)
    await runs.access()
    expect(host.box.calls.filter((call) => call === "start")).toHaveLength(2)
  })

  it("calls nothing when nothing was started", async () => {
    const host = new FakeHost(READY)
    await new SandboxRuns(host, 900).end("review_end")
    expect(host.box.calls).toEqual([])
    expect(host.unleased).toBe(0)
  })

  it("never throws when destroy does, and still unleases", async () => {
    const host = new FakeHost(READY)
    host.box.destroyThrows = true
    const runs = new SandboxRuns(host, 900)
    await runs.access()
    await expect(runs.end("review_end")).resolves.toBeUndefined()
    expect(host.unleased).toBe(1)
  })
})

describe("SandboxRuns.status", () => {
  it("says none before any call, then what the sandbox answered, and none again after end", async () => {
    const host = new FakeHost(READY)
    const runs = new SandboxRuns(host, 10)
    expect(await runs.status()).toEqual({ kind: "none" })
    await runs.access()
    expect(await runs.status()).toEqual({ kind: "ready" })
    host.clock += 10_000
    await runs.access()
    expect(await runs.status()).toEqual({ kind: "spent" })
    await runs.end("review_end")
    expect(await runs.status()).toEqual({ kind: "none" })
  })

  it("says off after an off answer, and names the step after a failure", async () => {
    const off = new FakeHost(READY)
    off.on = false
    const offRuns = new SandboxRuns(off, 900)
    await offRuns.access()
    expect(await offRuns.status()).toEqual({ kind: "off" })
    const failing = new FakeHost(READY)
    failing.grant = false
    const failingRuns = new SandboxRuns(failing, 900)
    await failingRuns.access()
    expect(await failingRuns.status()).toEqual({ kind: "unavailable", reason: "lease" })
  })
})

describe("sandboxBudgetOf and sandboxOn", () => {
  it("parses a positive whole number of seconds and falls back to 900", () => {
    expect(DEFAULT_SANDBOX_SECONDS).toBe(900)
    expect(sandboxBudgetOf("120")).toBe(120)
    expect(sandboxBudgetOf("0")).toBe(900)
    expect(sandboxBudgetOf("1.5")).toBe(900)
    expect(sandboxBudgetOf(undefined)).toBe(900)
  })

  it("turns the tier on only for the exact string true", () => {
    expect(sandboxOn("true")).toBe(true)
    expect(sandboxOn("TRUE")).toBe(false)
    expect(sandboxOn(undefined)).toBe(false)
  })
})

describe("SandboxRuns when a step throws", () => {
  it("answers unavailable, destroys and unleases once, remembers it, and lets end resolve", async () => {
    const host = new FakeHost(READY)
    host.box.rejects = "andabot-checkout"
    const runs = new SandboxRuns(host, 900)
    runs.start()
    expect(await runs.access()).toEqual({ kind: "unavailable", reason: "checkout" })
    expect(host.box.calls).toEqual(["start", "run:andabot-checkout", "destroy"])
    expect(host.unleased).toBe(1)
    expect(await runs.access()).toEqual({ kind: "unavailable", reason: "checkout" })
    expect(host.box.calls).toHaveLength(3)
    await expect(runs.end("review_end")).resolves.toBeUndefined()
    expect(host.box.calls.filter((call) => call === "destroy")).toHaveLength(1)
  })

  it("answers unavailable for a head it can't read, before any lease", async () => {
    const host = new FakeHost(READY)
    host.headThrows = true
    const runs = new SandboxRuns(host, 900)
    expect(await runs.access()).toEqual({ kind: "unavailable", reason: "head" })
    expect(host.leases).toEqual([])
    await expect(runs.end("review_end")).resolves.toBeUndefined()
  })

  it("never lets a throwing unlease out of access or end", async () => {
    const host = new FakeHost(READY)
    host.unleaseThrows = true
    host.box.rejects = "andabot-checkout"
    const runs = new SandboxRuns(host, 900)
    expect((await runs.access()).kind).toBe("unavailable")
    await expect(runs.end("review_end")).resolves.toBeUndefined()
  })
})

describe("SandboxRuns across reviews", () => {
  it("keeps the sandbox for an active review when a closed event arrives, and ends it when nothing is active", async () => {
    const host = new FakeHost(READY)
    const runs = new SandboxRuns(host, 900)
    runs.start()
    await runs.access()
    await runs.dropIdle("closed")
    expect(host.box.calls).not.toContain("destroy")
    await runs.end("review_end")
    expect(host.box.calls.at(-1)).toBe("destroy")
    await runs.dropIdle("closed")
    expect(host.box.calls.filter((call) => call === "destroy")).toHaveLength(1)
  })

  it("lets a replacing review keep the sandbox when the replaced one ends", async () => {
    const host = new FakeHost(READY)
    const runs = new SandboxRuns(host, 900)
    runs.start()
    await runs.access()
    runs.start()
    await runs.end("review_end")
    expect(host.box.calls).not.toContain("destroy")
    expect((await runs.access()).kind).toBe("ready")
    expect(host.box.calls.filter((call) => call === "start")).toHaveLength(1)
    await runs.end("review_end")
    expect(host.box.calls.at(-1)).toBe("destroy")
  })

  it("prepares afresh for a new head, ending the old head's sandbox first", async () => {
    const host = new FakeHost(READY)
    const runs = new SandboxRuns(host, 900)
    runs.start()
    await runs.access()
    host.sha = "def456"
    host.clock += 60_000
    expect((await runs.access()).kind).toBe("ready")
    const calls = host.box.calls
    expect(calls.filter((call) => call === "start")).toHaveLength(2)
    expect(calls.filter((call) => call === "destroy")).toHaveLength(1)
    expect(calls.indexOf("destroy")).toBeLessThan(calls.lastIndexOf("start"))
    expect(host.leases).toHaveLength(2)
    expect(host.unleased).toBe(1)
    expect(await runs.seconds()).toBe(0)
  })
})

describe("SandboxRuns after a restart", () => {
  it("ends what an earlier instance started: end destroys, unleases and deletes the record", async () => {
    const host = new FakeHost(READY)
    host.stored = readyRecord()
    await new SandboxRuns(host, 900).end("review_end")
    expect(host.box.calls).toEqual(["running", "destroy"])
    expect(host.unleased).toBe(1)
    expect(host.saved.at(-1)).toBeUndefined()
  })

  it("drops an idle restored sandbox on a closed event", async () => {
    const host = new FakeHost(READY)
    host.stored = readyRecord()
    await new SandboxRuns(host, 900).dropIdle("closed")
    expect(host.box.calls).toContain("destroy")
    expect(host.unleased).toBe(1)
  })

  it("answers ready from the record, with no second lease, start, checkout or install, and keeps the clock", async () => {
    const host = new FakeHost(READY)
    host.stored = readyRecord()
    host.clock = 1_000_000
    const runs = new SandboxRuns(host, 900)
    const access = await runs.access()
    expect(access).toEqual({ kind: "ready", sandbox: host.box, dir: "/workspace/repo", manager: "pnpm" })
    expect(host.box.calls).toEqual(["running"])
    expect(host.leases).toEqual([])
    expect(await runs.seconds()).toBe(100)
    expect(await runs.status()).toEqual({ kind: "ready" })
  })

  it("tears down a record for another head on end, since the container is the pull request's one container", async () => {
    const host = new FakeHost(READY)
    host.stored = readyRecord("old111")
    await new SandboxRuns(host, 900).end("review_end")
    expect(host.box.calls).toContain("destroy")
    expect(host.unleased).toBe(1)
  })

  it("tears down a record for another head first, then prepares the current head", async () => {
    const host = new FakeHost(READY)
    host.stored = readyRecord("old111")
    const runs = new SandboxRuns(host, 900)
    expect((await runs.access()).kind).toBe("ready")
    const calls = host.box.calls
    expect(calls.indexOf("destroy")).toBeLessThan(calls.indexOf("start"))
    expect(host.unleased).toBe(1)
    expect(host.leases).toHaveLength(1)
    expect(await runs.seconds()).toBe(0)
  })

  it("treats a container that no longer runs as lost: unleases, prepares afresh and keeps the clock", async () => {
    const host = new FakeHost(READY)
    host.stored = readyRecord()
    host.box.alive = false
    const runs = new SandboxRuns(host, 900)
    expect((await runs.access()).kind).toBe("ready")
    expect(host.box.calls).toEqual(["running", "start", "run:andabot-checkout", "run:andabot-detect", "run:pnpm"])
    expect(host.unleased).toBe(1)
    expect(host.leases).toHaveLength(1)
    expect(await runs.seconds()).toBe(100)
  })

  it("treats a container that can't say whether it runs as lost", async () => {
    const host = new FakeHost(READY)
    host.stored = readyRecord()
    host.box.runningThrows = true
    expect((await new SandboxRuns(host, 900).access()).kind).toBe("ready")
    expect(host.box.calls.filter((call) => call === "start")).toHaveLength(1)
    expect(host.unleased).toBe(1)
  })

  it("ends a preparation an earlier instance left half done", async () => {
    const host = new FakeHost(READY)
    const { settled: _settled, ...halfDone } = readyRecord()
    host.stored = halfDone
    await new SandboxRuns(host, 900).end("review_end")
    expect(host.box.calls).toContain("destroy")
    expect(host.unleased).toBe(1)
  })

  it("restores an unavailable answer for the rest of the review", async () => {
    const host = new FakeHost(READY)
    host.stored = {
      ...readyRecord(),
      leased: false,
      running: false,
      settled: { kind: "unavailable", reason: "install" },
    }
    const runs = new SandboxRuns(host, 900)
    expect(await runs.access()).toEqual({ kind: "unavailable", reason: "install" })
    expect(host.box.calls).toEqual([])
    expect(await runs.status()).toEqual({ kind: "unavailable", reason: "install" })
  })

  it("counts a load that throws as no record", async () => {
    const host = new FakeHost(READY)
    host.stored = readyRecord()
    host.loadThrows = true
    expect((await new SandboxRuns(host, 900).access()).kind).toBe("ready")
    expect(host.box.calls[0]).toBe("start")
  })

  it("never lets a throwing save out of access", async () => {
    const host = new FakeHost(READY)
    host.saveThrows = true
    expect((await new SandboxRuns(host, 900).access()).kind).toBe("ready")
  })
})

const failedTest: CheckRun = {
  name: "test",
  paths: ["test/a.test.ts"],
  outcome: { outcome: "exited", exitCode: 1, tail: "FAIL\n", cut: false },
  ms: 4_400,
}

describe("SandboxRuns check cache", () => {
  it("remembers a run, answers it from checks, and saves it as a stored check", async () => {
    const host = new FakeHost(READY)
    const runs = new SandboxRuns(host, 900)
    await runs.access()
    await runs.remember(checkKey("abc123", "test", failedTest.paths), failedTest)
    expect((await runs.checks()).get(checkKey("abc123", "test", failedTest.paths))).toEqual(failedTest)
    expect(host.saved.at(-1)?.checks).toEqual([storedCheckOf(failedTest)])
  })

  it("answers a stored run after a restart, under the key a finding's check uses", async () => {
    const host = new FakeHost(READY)
    host.stored = { ...readyRecord(), checks: [storedCheckOf(failedTest)] }
    const runs = new SandboxRuns(host, 900)
    const checks = await runs.checks()
    expect(checks.get(checkKey("abc123", "test", failedTest.paths))).toEqual(failedTest)
    expect(knownChecksOf(checks, "abc123")).toEqual(new Map([["test:test/a.test.ts", 1]]))
  })

  it("lets a review that starts on a fresh instance inherit a same-head sandbox, with an empty cache of its own", async () => {
    const host = new FakeHost(READY)
    host.stored = { ...readyRecord(), checks: [storedCheckOf(failedTest)] }
    const runs = new SandboxRuns(host, 900)
    await runs.start()
    expect((await runs.checks()).size).toBe(0)
    expect(host.saved.at(-1)?.checks).toEqual([])
    expect((await runs.access()).kind).toBe("ready")
    expect(host.box.calls).not.toContain("start")
  })

  it("forgets the runs when the sandbox ends", async () => {
    const host = new FakeHost(READY)
    const runs = new SandboxRuns(host, 900)
    await runs.access()
    await runs.remember(checkKey("abc123", "test", []), failedTest)
    await runs.end("review_end")
    expect((await runs.checks()).size).toBe(0)
  })
})
