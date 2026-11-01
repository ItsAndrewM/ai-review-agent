import { describe, expect, it } from "vitest"
import { GitHubClient } from "../src/github/client.ts"
import { GitHubError } from "../src/github/errors.ts"

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

interface Reply {
  status: number
  body: Json
}

interface FakeGitHub {
  client: GitHubClient
  urls: string[]
  authorizations: (string | null)[]
}

function github(...replies: Reply[]): FakeGitHub {
  const urls: string[] = []
  const authorizations: (string | null)[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    urls.push(`${url.pathname}${url.search}`)
    authorizations.push(new Headers(init?.headers).get("authorization"))
    const reply = replies.shift()
    if (reply === undefined) return new Response("{}", { status: 500 })
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }
  return { client: new GitHubClient("t", "https://api.test", fetchImpl), urls, authorizations }
}

const ok = (body: Json): Reply => ({ status: 200, body })

const installation = (id: number) => ({ id, account: { login: `org${id}` } })

const repository = (owner: string, name: string) => ({
  id: 1,
  name,
  full_name: `${owner}/${name}`,
  owner: { login: owner },
})

const HOUR = 3_600_000
const now = Date.parse("2026-11-01T12:00:00Z")

function pull(number: number, updatedAt: number, overrides: { [key: string]: Json } = {}) {
  return {
    number,
    title: `PR ${number}`,
    draft: false,
    updated_at: new Date(updatedAt).toISOString(),
    head: { sha: `sha${number}`, ref: `branch${number}` },
    base: { ref: "main", sha: "base" },
    ...overrides,
  }
}

describe("listInstallations", () => {
  it("returns every installation's id across pages", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => installation(index + 1))
    const { client, urls } = github(ok(firstPage), ok([installation(101)]))
    const ids = await client.listInstallations()
    expect(ids).toEqual(Array.from({ length: 101 }, (_, index) => index + 1))
    expect(urls).toEqual(["/app/installations?per_page=100&page=1", "/app/installations?per_page=100&page=2"])
  })

  it("sends the client's token, which for this call is the App JWT", async () => {
    const { client, authorizations } = github(ok([]))
    await client.listInstallations()
    expect(authorizations).toEqual(["Bearer t"])
  })
})

describe("listInstallationRepositories", () => {
  it("maps every repository across pages to its owner and name", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => repository("o", `r${index}`))
    const { client, urls } = github(
      ok({ total_count: 101, repositories: firstPage }),
      ok({ total_count: 101, repositories: [repository("p", "last")] }),
    )
    const repos = await client.listInstallationRepositories()
    expect(repos).toHaveLength(101)
    expect(repos[0]).toEqual({ owner: "o", repo: "r0" })
    expect(repos.at(-1)).toEqual({ owner: "p", repo: "last" })
    expect(urls).toEqual([
      "/installation/repositories?per_page=100&page=1",
      "/installation/repositories?per_page=100&page=2",
    ])
  })
})

describe("listOpenPullRequests", () => {
  const ref = { owner: "o", repo: "r" }
  const since = now - 24 * HOUR

  it("asks for open pull requests, most recently updated first", async () => {
    const { client, urls } = github(ok([]))
    await client.listOpenPullRequests(ref, since)
    expect(urls).toEqual(["/repos/o/r/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1"])
  })

  it("keeps the facts the sweep hands the object", async () => {
    const { client } = github(ok([pull(7, now - HOUR, { draft: true, title: "Draft it" })]))
    expect(await client.listOpenPullRequests(ref, since)).toEqual([
      { number: 7, headSha: "sha7", draft: true, baseRef: "main", title: "Draft it", updatedAt: now - HOUR },
    ])
  })

  it("reads a missing draft as not a draft", async () => {
    const { draft: _draft, ...withoutDraft } = pull(8, now - HOUR)
    const { client } = github(ok([withoutDraft]))
    const [listed] = await client.listOpenPullRequests(ref, since)
    expect(listed?.draft).toBe(false)
  })

  it("keeps one updated exactly at since and drops those updated before it", async () => {
    const { client } = github(ok([pull(1, now - HOUR), pull(2, since), pull(3, since - 1)]))
    const listed = await client.listOpenPullRequests(ref, since)
    expect(listed.map(({ number }) => number)).toEqual([1, 2])
  })

  it("asks for no further page once a page holds a pull request older than since", async () => {
    const firstPage = [
      ...Array.from({ length: 99 }, (_, index) => pull(index + 1, now - HOUR)),
      pull(100, since - HOUR),
    ]
    const { client, urls } = github(ok(firstPage), ok([pull(101, now - HOUR)]))
    const listed = await client.listOpenPullRequests(ref, since)
    expect(listed).toHaveLength(99)
    expect(urls).toHaveLength(1)
  })

  it("reads the next page while every pull request on a full page is inside the window", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => pull(index + 1, now - HOUR))
    const { client, urls } = github(ok(firstPage), ok([pull(101, now - 2 * HOUR)]))
    const listed = await client.listOpenPullRequests(ref, since)
    expect(listed).toHaveLength(101)
    expect(urls).toHaveLength(2)
  })
})

describe("sweep listings on a GitHub error", () => {
  it("throws a GitHubError carrying the status", async () => {
    const { client } = github({ status: 500, body: { message: "boom" } })
    const failure = await client.listInstallations().catch((cause: Error) => cause)
    expect(failure).toBeInstanceOf(GitHubError)
    expect(failure instanceof GitHubError ? failure.status : undefined).toBe(500)
  })
})

describe("sweep listings stop at a page cap", () => {
  function endless(page: () => Json): FakeGitHub {
    const urls: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input))
      urls.push(`${url.pathname}${url.search}`)
      return new Response(JSON.stringify(page()), { status: 200 })
    }
    return { client: new GitHubClient("t", "https://api.test", fetchImpl), urls, authorizations: [] }
  }

  const full = <Item extends Json>(item: (index: number) => Item): Item[] =>
    Array.from({ length: 100 }, (_, index) => item(index))

  it("refuses more than 10 pages of installations rather than paging forever", async () => {
    const { client, urls } = endless(() => full((index) => installation(index + 1)))
    await expect(client.listInstallations()).rejects.toThrow("more than 1000 installations")
    expect(urls).toHaveLength(10)
  })

  it("refuses more than 10 pages of repositories rather than paging forever", async () => {
    const { client, urls } = endless(() => ({
      total_count: 5000,
      repositories: full((index) => repository("o", `r${index}`)),
    }))
    await expect(client.listInstallationRepositories()).rejects.toThrow("more than 1000 repositories")
    expect(urls).toHaveLength(10)
  })

  it("refuses more than 10 pages of recently updated pull requests rather than paging forever", async () => {
    const { client, urls } = endless(() => full((index) => pull(index + 1, now - HOUR)))
    await expect(client.listOpenPullRequests({ owner: "o", repo: "r" }, now - 24 * HOUR)).rejects.toThrow(
      "more than 1000 open pull requests updated since",
    )
    expect(urls).toHaveLength(10)
  })
})
