import { describe, expect, it } from "vitest"
import { GitHubClient } from "../src/github/client.ts"

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

const ref = { owner: "o", repo: "r" }

interface FakeGitHub {
  client: GitHubClient
  urls: string[]
}

function github(...bodies: Json[]): FakeGitHub {
  const urls: string[] = []
  const queue = bodies.map((body) => JSON.stringify(body))
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input))
    urls.push(`${url.pathname}${url.search}`)
    const body = queue.shift()
    return body === undefined ? new Response("{}", { status: 500 }) : new Response(body, { status: 200 })
  }
  return { client: new GitHubClient("t", "https://api.test", fetchImpl), urls }
}

function run(name: string, overrides: { [key: string]: Json } = {}) {
  return {
    id: 1,
    name,
    status: "completed",
    conclusion: "success",
    app: { id: 15368, slug: "github-actions" },
    ...overrides,
  }
}

const jobs = (count: number) => Array.from({ length: count }, (_, i) => run(`job ${i}`))

describe("listCheckRuns", () => {
  it("lists a head's check runs a page at a time until it holds total_count", async () => {
    const { client, urls } = github(
      { total_count: 101, check_runs: jobs(100) },
      { total_count: 101, check_runs: [run("last")] },
    )
    const runs = await client.listCheckRuns(ref, "abc")
    expect(urls).toEqual([
      "/repos/o/r/commits/abc/check-runs?per_page=100&page=1",
      "/repos/o/r/commits/abc/check-runs?per_page=100&page=2",
    ])
    expect(runs).toHaveLength(101)
    expect(runs.at(-1)).toEqual({ name: "last", status: "completed", conclusion: "success", app: "github-actions" })
  })

  it("stops at a short page, so a head with no checks costs one request", async () => {
    const { client, urls } = github({ total_count: 0, check_runs: [] })
    expect(await client.listCheckRuns(ref, "abc")).toEqual([])
    expect(urls).toHaveLength(1)
  })

  it("keeps each run's status and conclusion as GitHub sends them, and its app as the slug or null", async () => {
    const { client } = github({
      total_count: 3,
      check_runs: [
        run("a", { conclusion: "stale" }),
        run("b", { app: null, status: "queued", conclusion: null }),
        run("c", { app: { id: 1 } }),
      ],
    })
    expect(await client.listCheckRuns(ref, "abc")).toEqual([
      { name: "a", status: "completed", conclusion: "stale", app: "github-actions" },
      { name: "b", status: "queued", conclusion: null, app: null },
      { name: "c", status: "completed", conclusion: "success", app: null },
    ])
  })

  it("throws past 1000 check runs, so the evaluation can count the checks as unknown", async () => {
    const page = { total_count: 1001, check_runs: jobs(100) }
    const { client, urls } = github(...Array.from({ length: 10 }, () => page))
    await expect(client.listCheckRuns(ref, "abc")).rejects.toThrow(/more than 1000 check runs on abc/)
    expect(urls).toHaveLength(10)
  })
})

describe("getIssueComment", () => {
  it("reads one issue comment by its id", async () => {
    const { client, urls } = github({ id: 7, body: "x" })
    expect(await client.getIssueComment(ref, 7)).toEqual({ id: 7, body: "x" })
    expect(urls).toEqual(["/repos/o/r/issues/comments/7"])
  })
})

describe("getPullRequest's draft flag", () => {
  const pr = {
    number: 3,
    title: "t",
    body: null,
    state: "open",
    user: { login: "a" },
    base: { ref: "main", sha: "b", repo: { full_name: "o/r" } },
    head: { ref: "f", sha: "h" },
    changed_files: 1,
    additions: 1,
    deletions: 0,
    labels: [],
  }

  it("parses a pull request's draft flag, rejects one that isn't a boolean, and parses a pull request without one", async () => {
    expect((await github({ ...pr, draft: true }).client.getPullRequest(ref, 3)).draft).toBe(true)
    await expect(github({ ...pr, draft: "yes" }).client.getPullRequest(ref, 3)).rejects.toThrow(/unexpected response/)
    expect((await github(pr).client.getPullRequest(ref, 3)).draft).toBeUndefined()
  })
})
