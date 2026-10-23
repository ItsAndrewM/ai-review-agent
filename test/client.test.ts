import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { canCommand, GitHubClient, type CreateCheckRun, type UpdateCheckRun } from "../src/github/client.ts"

interface Received {
  method: string | undefined
  url: string | undefined
  authorization: string | undefined
  body: string
}

const ref = { owner: "o", repo: "r" }
const received: Received[] = []
let server: Server
let base = ""
let status = 201

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body })
      res.writeHead(status, { "content-type": "application/json" })
      res.end(
        status < 300
          ? JSON.stringify({ id: 42, name: "andabot", extra: true })
          : JSON.stringify({ message: "Resource not accessible by integration" }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!(address instanceof Object)) throw new Error("the test server has no port")
  base = `http://127.0.0.1:${address.port}`
})

afterAll(() => {
  server.close()
})

const create: CreateCheckRun = {
  name: "andabot",
  head_sha: "abc",
  status: "in_progress",
  external_id: "d-1",
  started_at: "2026-10-17T20:35:55Z",
  output: { title: "Review in progress", summary: "Reviewing 1 file" },
}

const update: UpdateCheckRun = {
  conclusion: "success",
  completed_at: "2026-10-17T20:36:38Z",
  output: { title: "Approved", summary: "## andabot review" },
  details_url: "https://github.com/o/r/pull/5#issuecomment-1",
}

describe("GitHubClient check runs", () => {
  it("creates a run with a POST to the repository's check-runs and keeps only the id", async () => {
    status = 201
    const created = await new GitHubClient("tok", base).createCheckRun(ref, create)
    expect(created).toEqual({ id: 42 })
    const last = received.at(-1)
    expect(last?.method).toBe("POST")
    expect(last?.url).toBe("/repos/o/r/check-runs")
    expect(last?.authorization).toBe("Bearer tok")
    const body: unknown = JSON.parse(last?.body ?? "")
    expect(body).toEqual(create)
  })

  it("updates a run with a PATCH to its id", async () => {
    status = 200
    const updated = await new GitHubClient("tok", base).updateCheckRun(ref, 42, update)
    expect(updated).toEqual({ id: 42 })
    const last = received.at(-1)
    expect(last?.method).toBe("PATCH")
    expect(last?.url).toBe("/repos/o/r/check-runs/42")
    const body: unknown = JSON.parse(last?.body ?? "")
    expect(body).toEqual(update)
  })

  it("throws with the status and body when GitHub refuses", async () => {
    status = 403
    await expect(new GitHubClient("tok", base).updateCheckRun(ref, 42, update)).rejects.toThrow(
      /GitHub 403 .*Resource not accessible by integration/,
    )
  })
})

const respond = (status: number, body: string) => async () => new Response(body, { status })

describe("getIssue", () => {
  it("parses an issue, returns undefined for a missing one, and keeps a pull request's marker", async () => {
    const found = new GitHubClient(
      "t",
      "https://api",
      respond(200, JSON.stringify({ number: 4, title: "T", body: null, state: "open" })),
    )
    expect(await found.getIssue({ owner: "o", repo: "r" }, 4)).toEqual({
      number: 4,
      title: "T",
      body: null,
      state: "open",
    })
    const missing = new GitHubClient("t", "https://api", respond(404, "{}"))
    expect(await missing.getIssue({ owner: "o", repo: "r" }, 4)).toBeUndefined()
    const pr = new GitHubClient(
      "t",
      "https://api",
      respond(200, JSON.stringify({ number: 5, title: "P", body: "", state: "open", pull_request: {} })),
    )
    expect((await pr.getIssue({ owner: "o", repo: "r" }, 5))?.pull_request).toEqual({})
  })

  it("throws on any other refusal, as the other calls do", async () => {
    const failing = new GitHubClient("t", "https://api", respond(500, "boom"))
    await expect(failing.getIssue({ owner: "o", repo: "r" }, 4)).rejects.toThrow(/GitHub 500 .*boom/)
  })

  it("calls fetch with no receiver, since workerd's global fetch refuses the client as its this", async () => {
    function workerdFetch(this: void): Promise<Response> {
      if (this !== undefined) throw new TypeError("Illegal invocation")
      return Promise.resolve(new Response("{}", { status: 404 }))
    }
    expect(
      await new GitHubClient("t", "https://api", workerdFetch).getIssue({ owner: "o", repo: "r" }, 4),
    ).toBeUndefined()
  })
})

function recordingFetch(body: string) {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const { pathname, search } = new URL(String(input))
    calls.push(`${init?.method ?? "GET"} ${pathname}${search}`)
    return new Response(body, { status: 200 })
  }
  return { fetchImpl, calls }
}

describe("getTree", () => {
  const treeAt = (fetchImpl: typeof fetch) =>
    new GitHubClient("t", "https://api.example", fetchImpl).getTree(ref, "abc")

  it("lists the tree recursively at a sha and keeps the truncated flag", async () => {
    const { fetchImpl, calls } = recordingFetch(
      JSON.stringify({
        sha: "abc",
        truncated: false,
        tree: [
          { path: "CLAUDE.md", type: "blob", sha: "1" },
          { path: "src", type: "tree", sha: "2" },
        ],
      }),
    )
    expect(await treeAt(fetchImpl)).toEqual({
      sha: "abc",
      truncated: false,
      entries: [
        { path: "CLAUDE.md", type: "blob", sha: "1" },
        { path: "src", type: "tree", sha: "2" },
      ],
    })
    expect(calls).toEqual(["GET /repos/o/r/git/trees/abc?recursive=1"])
  })

  it("answers with the tree's own sha, not the commit sha it was asked for, and carries a truncated listing through", async () => {
    const body = { sha: "def", truncated: true, tree: [{ path: "a", type: "blob", sha: "1" }] }
    const tree = await treeAt(respond(200, JSON.stringify(body)))
    expect(tree.sha).toBe("def")
    expect(tree.truncated).toBe(true)
    expect(tree.entries).toEqual([{ path: "a", type: "blob", sha: "1" }])
  })

  it("keeps a blob's path, type, sha and size, which the skill caps read before any fetch, a tree's path, type and sha, and drops a submodule's commit entry", async () => {
    const tree = await treeAt(
      respond(
        200,
        JSON.stringify({
          sha: "abc",
          url: "https://api.github.com/repos/o/r/git/trees/abc",
          truncated: false,
          tree: [
            { path: "CLAUDE.md", mode: "100644", type: "blob", sha: "1", size: 120, url: "https://api.github.com/b/1" },
            { path: "vendor/lib", mode: "160000", type: "commit", sha: "3" },
            { path: "src", mode: "040000", type: "tree", sha: "2", url: "https://api.github.com/t/2" },
          ],
        }),
      ),
    )
    expect(tree.entries).toEqual([
      { path: "CLAUDE.md", type: "blob", sha: "1", size: 120 },
      { path: "src", type: "tree", sha: "2" },
    ])
  })

  it("rejects a response that is not a tree, or has no truncated flag, naming the path it asked for", async () => {
    const named = /GitHub \/repos\/o\/r\/git\/trees\/abc\?recursive=1: unexpected response/
    await expect(treeAt(respond(200, JSON.stringify({ sha: "abc", truncated: false })))).rejects.toThrow(named)
    const withoutPath = { sha: "abc", truncated: false, tree: [{ type: "blob", sha: "1" }] }
    await expect(treeAt(respond(200, JSON.stringify(withoutPath)))).rejects.toThrow(named)
    const fractionalSize = { sha: "abc", truncated: false, tree: [{ path: "a", type: "blob", sha: "1", size: 1.5 }] }
    await expect(treeAt(respond(200, JSON.stringify(fractionalSize)))).rejects.toThrow(named)
    await expect(treeAt(respond(200, JSON.stringify({ sha: "abc", tree: [] })))).rejects.toThrow(named)
  })

  it("throws with the status when GitHub refuses, so a missing tree is never read as an empty one", async () => {
    await expect(treeAt(respond(404, JSON.stringify({ message: "Not Found" })))).rejects.toThrow(
      /GitHub 404 .*Not Found/,
    )
  })
})

describe("canCommand", () => {
  it("lets admins, maintainers and writers command the bot, and no one else", () => {
    for (const permission of ["admin", "maintain", "write"]) expect(canCommand(permission)).toBe(true)
    for (const permission of ["triage", "read", "none"]) expect(canCommand(permission)).toBe(false)
  })
})
