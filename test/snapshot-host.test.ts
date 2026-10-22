import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { GitHubClient } from "../src/github/client.ts"
import { SnapshotUnavailable } from "../src/repository/load-snapshot.ts"
import {
  leftOutText,
  loadedFields,
  snapshotFailure,
  SnapshotRuns,
  snapshotSource,
  type LoadInto,
} from "../src/repository/snapshot-host.ts"
import { MemorySnapshotFiles, type SnapshotFiles, type SnapshotRecord } from "../src/repository/snapshot.ts"

const record = {
  sha: "0123456789abcdef",
  files: 1200,
  bytes: 3_400_000,
  gapFilled: 12,
  leftOut: { lfs: 1, binary: 30, too_large: 0 },
  capped: false,
  treeTruncated: true,
}

describe("loadedFields", () => {
  it("logs the snapshot's numbers with a short head and the left-out counts as one sorted field", () => {
    expect(loadedFields(54, record, 8_200)).toEqual({
      number: 54,
      head: "0123456",
      files: 1200,
      bytes: 3_400_000,
      leftOut: "binary=30,lfs=1",
      gapFilled: 12,
      capped: false,
      treeTruncated: true,
      ms: 8_200,
    })
  })

  it("says none when nothing was left out, so the field is never missing from the log", () => {
    expect(leftOutText({})).toBe("none")
    expect(leftOutText({ binary: 0 })).toBe("none")
  })
})

describe("snapshotFailure", () => {
  it("names the step GitHub refused, so the model is told what could not be read", () => {
    expect(snapshotFailure(new SnapshotUnavailable("tarball", "404"))).toEqual({
      step: "tarball",
      reason: "the repository's tarball could not be read from GitHub",
    })
    expect(snapshotFailure(new SnapshotUnavailable("tree", "500")).step).toBe("tree")
  })

  it("files any other error under the load step", () => {
    expect(snapshotFailure(new Error("SQLITE_FULL"))).toEqual({
      step: "load",
      reason: "the repository's files could not be loaded",
    })
  })
})

describe("snapshotSource", () => {
  it("asks GitHub for the pull request's repository at the sha the load names", async () => {
    const urls: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(new Request(input).url)
      return Response.json({ sha: "abc", truncated: false, tree: [] })
    }
    const source = snapshotSource(new GitHubClient("token", "https://api.github.com", fetchImpl), {
      owner: "acme",
      repo: "app",
    })
    await source.listing("abc")
    expect(urls).toEqual(["https://api.github.com/repos/acme/app/git/trees/abc?recursive=1"])
  })
})

const NUMBER = 54

const SHA = "0123456789abcdef"

const headAt = (sha: string) => async () => ({ number: NUMBER, sha })

async function fill(store: SnapshotFiles, sha: string): Promise<SnapshotRecord> {
  store.begin(sha)
  store.add([{ path: "src/a.ts", content: "export const a = 1\n" }])
  const loaded = { ...record, sha }
  store.finish(loaded)
  return loaded
}

function runsWith(loadInto: LoadInto = fill, files: SnapshotFiles = new MemorySnapshotFiles()) {
  const loads: string[] = []
  const runs = new SnapshotRuns(
    () => files,
    async (store, sha) => {
      loads.push(sha)
      return loadInto(store, sha)
    },
  )
  return { files, loads, runs }
}

const dropped = (reason: string) => JSON.stringify({ event: "snapshot.dropped", number: NUMBER, reason })

class UndroppableFiles extends MemorySnapshotFiles {
  override drop(): boolean {
    throw new Error("SQLITE_BUSY")
  }
}

class RecordingFiles extends MemorySnapshotFiles {
  readonly events: string[] = []

  override finish(finished: SnapshotRecord): void {
    this.events.push(`finish ${finished.sha}`)
    super.finish(finished)
  }

  override drop(): boolean {
    this.events.push("drop")
    return super.drop()
  }
}

const OTHER_SHA = "fedcba9876543210"

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function gatedLoader() {
  const gates = new Map<string, () => void>()
  const loadInto: LoadInto = async (store, sha) => {
    store.begin(sha)
    store.add([{ path: `src/${sha}.ts`, content: sha }])
    await new Promise<void>((resolve) => {
      gates.set(sha, resolve)
    })
    const loaded = { ...record, sha }
    store.finish(loaded)
    return loaded
  }
  return {
    loadInto,
    waiting: (sha: string) => gates.has(sha),
    open: (sha: string) => gates.get(sha)?.(),
  }
}

describe("SnapshotRuns", () => {
  let logged: MockInstance<typeof console.log>
  let errors: MockInstance<typeof console.error>

  beforeEach(() => {
    logged = vi.spyOn(console, "log").mockImplementation(() => undefined)
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("keeps the snapshot while another review or answer is still running, and drops it when the last one ends", async () => {
    const { files, runs } = runsWith()
    runs.start()
    runs.start()
    expect((await runs.access("grep", headAt(SHA))).kind).toBe("ready")
    await runs.end(NUMBER, "answer_end")
    expect(files.record()?.sha).toBe(SHA)
    expect(runs.calls()).toEqual({ greps: 1, trees: 0 })
    await runs.end(NUMBER, "review_end")
    expect(files.record()).toBeUndefined()
    expect(runs.calls()).toEqual({ greps: 0, trees: 0 })
    expect(logged).toHaveBeenCalledWith(dropped("review_end"))
    expect(logged).not.toHaveBeenCalledWith(dropped("answer_end"))
  })

  it("spends the budget on the 41st grep or tree call", async () => {
    const { runs } = runsWith()
    runs.start()
    const kinds: string[] = []
    for (let call = 0; call < 41; call += 1) {
      kinds.push((await runs.access(call % 2 === 0 ? "grep" : "tree", headAt(SHA))).kind)
    }
    expect(kinds.slice(0, 40).every((kind) => kind === "ready")).toBe(true)
    expect(kinds[40]).toBe("spent")
    expect(runs.calls()).toEqual({ greps: 20, trees: 20 })
  })

  it("shares one load between parallel calls for the same head", async () => {
    const gated = gatedLoader()
    const { loads, runs } = runsWith(gated.loadInto)
    runs.start()
    const grepAccess = runs.access("grep", headAt(SHA))
    const treeAccess = runs.access("tree", headAt(SHA))
    await vi.waitFor(() => expect(gated.waiting(SHA)).toBe(true))
    await nextTask()
    expect(loads).toEqual([SHA])
    gated.open(SHA)
    expect([(await grepAccess).kind, (await treeAccess).kind]).toEqual(["ready", "ready"])
    expect(loads).toEqual([SHA])
  })

  it("skips the drop when another run starts while the last run's end waits on a load", async () => {
    const gated = gatedLoader()
    const files = new RecordingFiles()
    const { runs } = runsWith(gated.loadInto, files)
    runs.start()
    const access = runs.access("grep", headAt(SHA))
    await vi.waitFor(() => expect(gated.waiting(SHA)).toBe(true))
    const ended = runs.end(NUMBER, "review_end")
    runs.start()
    gated.open(SHA)
    await Promise.all([access, ended])
    expect(files.events).toEqual([`finish ${SHA}`])
    expect(files.record()?.sha).toBe(SHA)
    expect(logged).not.toHaveBeenCalledWith(dropped("review_end"))
  })

  it("waits out a newer load that starts while the last run's end waits, so the drop never lands mid-load", async () => {
    const gated = gatedLoader()
    const files = new RecordingFiles()
    const { runs } = runsWith(gated.loadInto, files)
    runs.start()
    const first = runs.access("grep", headAt(SHA))
    await vi.waitFor(() => expect(gated.waiting(SHA)).toBe(true))
    const resumed = runs.access("grep", headAt(OTHER_SHA))
    await nextTask()
    const ended = runs.end(NUMBER, "review_end")
    gated.open(SHA)
    await vi.waitFor(() => expect(gated.waiting(OTHER_SHA)).toBe(true))
    expect(files.events).toEqual([`finish ${SHA}`])
    gated.open(OTHER_SHA)
    await Promise.all([first, resumed, ended])
    expect(files.events).toEqual([`finish ${SHA}`, `finish ${OTHER_SHA}`, "drop"])
    expect(files.record()).toBeUndefined()
  })

  it("remembers a failed load until the last run ends, so a review does not retry it on every call", async () => {
    let attempts = 0
    const { loads, runs } = runsWith(async (store, sha) => {
      attempts += 1
      if (attempts === 1) throw new SnapshotUnavailable("tarball", "502")
      return fill(store, sha)
    })
    const unavailable = { kind: "unavailable", reason: "the repository's tarball could not be read from GitHub" }
    runs.start()
    runs.start()
    expect(await runs.access("grep", headAt(SHA))).toEqual(unavailable)
    await runs.end(NUMBER, "answer_end")
    expect(await runs.access("tree", headAt(SHA))).toEqual(unavailable)
    expect(loads).toEqual([SHA])
    await runs.end(NUMBER, "review_end")
    runs.start()
    expect((await runs.access("grep", headAt(SHA))).kind).toBe("ready")
    expect(loads).toEqual([SHA, SHA])
  })

  it("leaves a stale snapshot alone while a load is in flight, and drops it once nothing uses it", async () => {
    let open = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const { files, runs } = runsWith(async (store, sha) => {
      store.begin(sha)
      store.add([{ path: "src/a.ts", content: "a" }])
      await gate
      const loaded = { ...record, sha }
      store.finish(loaded)
      return loaded
    })
    const resumed = runs.access("grep", headAt(SHA))
    await vi.waitFor(() => expect(files.has("src/a.ts")).toBe(true))
    runs.dropStale(NUMBER)
    expect(files.has("src/a.ts")).toBe(true)
    open()
    expect((await resumed).kind).toBe("ready")
    expect(files.record()?.sha).toBe(SHA)
    runs.dropStale(NUMBER)
    expect(files.record()).toBeUndefined()
    expect(logged).toHaveBeenCalledWith(dropped("stale"))
  })

  it("logs a new head replacing the stored snapshot", async () => {
    const { loads, runs } = runsWith()
    runs.start()
    await runs.access("grep", headAt(SHA))
    expect((await runs.access("grep", headAt("fedcba9876543210"))).kind).toBe("ready")
    expect(loads).toEqual([SHA, "fedcba9876543210"])
    expect(logged).toHaveBeenCalledWith(dropped("new_head"))
  })

  it("logs a failed drop instead of failing the review", async () => {
    const { runs } = runsWith(fill, new UndroppableFiles())
    runs.start()
    await expect(runs.end(NUMBER, "review_end")).resolves.toBeUndefined()
    expect(errors).toHaveBeenCalledWith(
      JSON.stringify({
        event: "snapshot.drop_failed",
        number: NUMBER,
        reason: "review_end",
        error: "Error: SQLITE_BUSY",
      }),
    )
  })
})
