import { createServer, type Server } from "node:http"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import type { OpenPullRequest, RepoRef } from "../src/github/client.ts"
import type { SweepIncoming, SweepOutcome } from "../src/review/sweep-decision.ts"
import {
  runSweep,
  SWEEP_FLOOR_MS,
  SWEEP_WINDOW_MS,
  sweepGitHub,
  sweepIncoming,
  type SweepGitHub,
} from "../src/sweep.ts"

const NOW = Date.parse("2026-11-01T12:00:00Z")
const MINUTE = 60_000

function pull(number: number, minutesAgo: number): OpenPullRequest {
  return {
    number,
    headSha: `${number}`.padStart(8, "a"),
    draft: false,
    baseRef: "main",
    title: `PR ${number}`,
    updatedAt: NOW - minutesAgo * MINUTE,
  }
}

interface Repository {
  ref: RepoRef
  pulls: OpenPullRequest[] | Error
}

interface Installation {
  id: number
  repositories: Repository[] | Error
}

class FakeGitHub implements SweepGitHub {
  sinces: number[] = []
  visited: string[] = []
  constructor(private readonly installed: Installation[] | Error) {}
  async installations(): Promise<number[]> {
    if (this.installed instanceof Error) throw this.installed
    return this.installed.map(({ id }) => id)
  }
  async repositories(installationId: number): Promise<RepoRef[]> {
    const repositories = this.installation(installationId).repositories
    if (repositories instanceof Error) throw repositories
    return repositories.map(({ ref }) => ref)
  }
  async openPullRequests(installationId: number, ref: RepoRef, since: number): Promise<OpenPullRequest[]> {
    this.sinces.push(since)
    this.visited.push(`${installationId}:${ref.owner}/${ref.repo}`)
    const repositories = this.installation(installationId).repositories
    const repository = repositories instanceof Error ? undefined : repositories.find((each) => each.ref === ref)
    if (repository === undefined) throw new Error(`no repository ${ref.repo}`)
    if (repository.pulls instanceof Error) throw repository.pulls
    return repository.pulls
  }
  private installation(id: number): Installation {
    const found = this.installed instanceof Error ? undefined : this.installed.find((each) => each.id === id)
    if (found === undefined) throw new Error(`no installation ${id}`)
    return found
  }
}

class Objects {
  handed: SweepIncoming[] = []
  constructor(
    private readonly answer: (incoming: SweepIncoming) => SweepOutcome | Error = () => ({ kind: "reviewed" }),
  ) {}
  handOff = async (incoming: SweepIncoming): Promise<SweepOutcome> => {
    this.handed.push(incoming)
    const outcome = this.answer(incoming)
    if (outcome instanceof Error) throw outcome
    return outcome
  }
}

const repo = (owner: string, name: string, pulls: OpenPullRequest[] | Error): Repository => ({
  ref: { owner, repo: name },
  pulls,
})

let logged: MockInstance<typeof console.log>
let errors: MockInstance<typeof console.error>

beforeEach(() => {
  logged = vi.spyOn(console, "log").mockImplementation(() => undefined)
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  logged.mockRestore()
  errors.mockRestore()
})

function events(spy: MockInstance<typeof console.log>, name: string): Record<string, string | number>[] {
  return spy.mock.calls.flatMap(([line]) => {
    const parsed: Record<string, string | number> = JSON.parse(String(line))
    return parsed.event === name ? [parsed] : []
  })
}

describe("runSweep", () => {
  it("leaves a pull request updated under 5 minutes ago for the next sweep, and hands off one exactly 5 minutes old", async () => {
    const github = new FakeGitHub([{ id: 1, repositories: [repo("o", "r", [pull(1, 4.99), pull(2, 5)])] }])
    const objects = new Objects()
    await runSweep(github, objects.handOff, NOW)
    expect(objects.handed.map(({ key }) => key.number)).toEqual([2])
    expect(SWEEP_FLOOR_MS).toBe(5 * MINUTE)
  })

  it("asks each repository for pull requests updated within the last day", async () => {
    const github = new FakeGitHub([{ id: 1, repositories: [repo("o", "a", []), repo("o", "b", [])] }])
    await runSweep(github, new Objects().handOff, NOW)
    expect(github.sinces).toEqual([NOW - SWEEP_WINDOW_MS, NOW - SWEEP_WINDOW_MS])
    expect(SWEEP_WINDOW_MS).toBe(24 * 60 * MINUTE)
  })

  it("visits every repository of every installation, and keys each hand-off by its installation", async () => {
    const github = new FakeGitHub([
      { id: 1, repositories: [repo("o", "a", [pull(1, 10)]), repo("o", "b", [pull(2, 10)])] },
      { id: 2, repositories: [repo("p", "c", [pull(3, 10)])] },
    ])
    const objects = new Objects()
    await runSweep(github, objects.handOff, NOW)
    expect(github.visited).toEqual(["1:o/a", "1:o/b", "2:p/c"])
    expect(objects.handed.map(({ key }) => key)).toEqual([
      { installationId: 1, owner: "o", repo: "a", number: 1 },
      { installationId: 1, owner: "o", repo: "b", number: 2 },
      { installationId: 2, owner: "p", repo: "c", number: 3 },
    ])
  })

  it("goes on to the next repository and installation when a repository's listing throws", async () => {
    const github = new FakeGitHub([
      { id: 1, repositories: [repo("o", "gone", new Error("GitHub 404")), repo("o", "b", [pull(2, 10)])] },
      { id: 2, repositories: [repo("p", "c", [pull(3, 10)])] },
    ])
    const objects = new Objects()
    await runSweep(github, objects.handOff, NOW)
    expect(objects.handed.map(({ key }) => key.number)).toEqual([2, 3])
    expect(events(errors, "sweep.failed")).toEqual([
      { event: "sweep.failed", repo: "o/gone", error: "Error: GitHub 404" },
    ])
  })

  it("goes on to the next installation when an installation's repositories can't be listed", async () => {
    const github = new FakeGitHub([
      { id: 1, repositories: new Error("GitHub 401") },
      { id: 2, repositories: [repo("p", "c", [pull(3, 10)])] },
    ])
    const objects = new Objects()
    await runSweep(github, objects.handOff, NOW)
    expect(objects.handed.map(({ key }) => key.number)).toEqual([3])
    expect(events(errors, "sweep.failed")).toEqual([
      { event: "sweep.failed", installation: 1, error: "Error: GitHub 401" },
    ])
  })

  it("logs the failure and reports an empty sweep when the installations can't be listed", async () => {
    const report = await runSweep(new FakeGitHub(new Error("GitHub 500")), new Objects().handOff, NOW)
    expect(report).toEqual({ installations: 0, repositories: 0, pulls: 0, found: 0 })
    expect(events(errors, "sweep.failed")).toEqual([{ event: "sweep.failed", error: "Error: GitHub 500" }])
    expect(events(logged, "sweep.done")).toHaveLength(1)
  })

  it("goes on to the next pull request when a hand-off throws", async () => {
    const github = new FakeGitHub([{ id: 1, repositories: [repo("o", "r", [pull(1, 10), pull(2, 10)])] }])
    const objects = new Objects((incoming) =>
      incoming.key.number === 1 ? new Error("object overloaded") : { kind: "reviewed" },
    )
    const report = await runSweep(github, objects.handOff, NOW)
    expect(objects.handed.map(({ key }) => key.number)).toEqual([1, 2])
    expect(report.found).toBe(1)
    expect(events(errors, "sweep.failed")).toEqual([
      { event: "sweep.failed", repo: "o/r", number: 1, error: "Error: object overloaded" },
    ])
  })

  it("counts reviewed, restarted and gave_up as found, but not known, and logs each one found", async () => {
    const answers: SweepOutcome[] = [
      { kind: "reviewed" },
      { kind: "restarted" },
      { kind: "gave_up" },
      { kind: "known", reason: "already_reviewed" },
    ]
    const github = new FakeGitHub([
      {
        id: 1,
        repositories: [
          repo(
            "o",
            "r",
            [1, 2, 3, 4].map((n) => pull(n, 10)),
          ),
        ],
      },
    ])
    const objects = new Objects((incoming) => answers[incoming.key.number - 1] ?? { kind: "reviewed" })
    const report = await runSweep(github, objects.handOff, NOW)
    expect(report.found).toBe(3)
    expect(events(logged, "sweep.found")).toEqual([
      { event: "sweep.found", repo: "o/r", number: 1, head: "aaaaaaa", reason: "unreviewed" },
      { event: "sweep.found", repo: "o/r", number: 2, head: "aaaaaaa", reason: "restarted" },
      { event: "sweep.found", repo: "o/r", number: 3, head: "aaaaaaa", reason: "gave_up" },
    ])
  })

  it("reports the installations, repositories and pull requests it handed off", async () => {
    const github = new FakeGitHub([
      { id: 1, repositories: [repo("o", "a", [pull(1, 10), pull(2, 1)]), repo("o", "b", [])] },
      { id: 2, repositories: [repo("p", "c", [pull(3, 10)])] },
    ])
    const objects = new Objects((incoming) =>
      incoming.key.number === 3 ? { kind: "known", reason: "draft" } : { kind: "reviewed" },
    )
    const report = await runSweep(github, objects.handOff, NOW)
    expect(report).toEqual({ installations: 2, repositories: 3, pulls: 2, found: 1 })
    const [done] = events(logged, "sweep.done")
    expect(done).toMatchObject({ installations: 2, repositories: 3, pulls: 2, found: 1 })
    expect(done?.ms).toEqual(expect.any(Number))
  })
})

describe("sweepIncoming", () => {
  it("hands the object a push review under the head's sweep delivery id, with the listing's facts", () => {
    const key = { installationId: 1, owner: "o", repo: "r", number: 7 }
    const listed = { ...pull(7, 10), headSha: "abc123", draft: true, title: "WIP" }
    expect(sweepIncoming(key, listed)).toEqual({
      kind: "review",
      key,
      deliveryId: "sweep:abc123",
      headSha: "abc123",
      full: false,
      sweep: { draft: true, baseRef: "main", title: "WIP" },
    })
  })
})

describe("sweepGitHub", () => {
  const seen: { path: string; authorization: string | undefined; userAgent: string | undefined }[] = []
  const bodies = new Map([
    ["/app/installations", JSON.stringify([{ id: 5 }, { id: 6 }])],
    ["/installation/repositories", JSON.stringify({ repositories: [repository("o", "a"), repository("o", "b")] })],
    ["/repos/o/a/pulls", JSON.stringify([])],
    ["/repos/o/b/pulls", JSON.stringify([])],
  ])
  let server: Server
  let base = ""

  function repository(owner: string, name: string) {
    return { name, owner: { login: owner } }
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname
      seen.push({ path, authorization: req.headers.authorization, userAgent: req.headers["user-agent"] })
      const body = bodies.get(path)
      res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" })
      res.end(body ?? "{}")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!(address instanceof Object)) throw new Error("the test server has no port")
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(() => {
    server.close()
  })

  it("lists installations with the App JWT, and each installation's repositories and pulls with its own token, as the deploy's login", async () => {
    const tokens: number[] = []
    const github = sweepGitHub(
      "app-jwt",
      async (installationId) => {
        tokens.push(installationId)
        return `token-${installationId}`
      },
      "andabot-staging",
      base,
    )
    expect(await github.installations()).toEqual([5, 6])
    const repos = await github.repositories(5)
    expect(repos).toEqual([
      { owner: "o", repo: "a" },
      { owner: "o", repo: "b" },
    ])
    for (const ref of repos) await github.openPullRequests(5, ref, 0)
    expect(seen).toEqual([
      { path: "/app/installations", authorization: "Bearer app-jwt", userAgent: "andabot-staging" },
      { path: "/installation/repositories", authorization: "Bearer token-5", userAgent: "andabot-staging" },
      { path: "/repos/o/a/pulls", authorization: "Bearer token-5", userAgent: "andabot-staging" },
      { path: "/repos/o/b/pulls", authorization: "Bearer token-5", userAgent: "andabot-staging" },
    ])
    expect(tokens).toEqual([5])
  })
})
