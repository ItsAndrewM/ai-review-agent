import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { GitHubClient } from "../src/github/client.ts"

interface Received {
  method: string | undefined
  url: string | undefined
  body: string
}

interface Reply {
  status: number
  body: string
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

const ref = { owner: "o", repo: "r" }
const received: Received[] = []
const replies: Reply[] = []
let server: Server
let base = ""

function reply(status: number, body: Json): void {
  replies.push({ status, body: JSON.stringify(body) })
}

function client(): GitHubClient {
  return new GitHubClient("tok", base)
}

function last(): Received {
  const request = received.at(-1)
  if (!request) throw new Error("the test server received nothing")
  return request
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body })
      const next = replies.shift() ?? { status: 500, body: JSON.stringify({ message: "no reply queued" }) }
      res.writeHead(next.status, { "content-type": "application/json" })
      res.end(next.body)
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

beforeEach(() => {
  replies.length = 0
})

function threadNode(id: string, author: { login: string; __typename: string } | null) {
  return {
    id,
    isResolved: false,
    isOutdated: id === "t1",
    path: "a.ts",
    line: id === "t1" ? null : 7,
    diffSide: "RIGHT",
    comments: { nodes: [{ databaseId: id === "t1" ? 11 : 12, body: "**🔴 Blocking: x**", author }] },
  }
}

function threadsPage(hasNextPage: boolean, endCursor: string | null, nodes: Json[]) {
  return { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes } } } } }
}

describe("GitHubClient compare", () => {
  it("compares with a three-dot GET and keeps status and files", async () => {
    const file = { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b" }
    reply(200, { status: "ahead", ahead_by: 1, files: [file] })
    expect(await client().compareCommits(ref, "aaa", "bbb")).toEqual({ status: "ahead", files: [file] })
    expect(last().method).toBe("GET")
    expect(last().url).toBe("/repos/o/r/compare/aaa...bbb")
  })

  it("reads a compare without files as no files", async () => {
    reply(200, { status: "identical" })
    expect(await client().compareCommits(ref, "aaa", "aaa")).toEqual({ status: "identical", files: [] })
  })

  it("rejects a compare status GitHub never sends", async () => {
    reply(200, { status: "weird", files: [] })
    await expect(client().compareCommits(ref, "aaa", "bbb")).rejects.toThrow(/unexpected response/)
  })
})

describe("GitHubClient review comments", () => {
  it("lists a review's comments with their lines from the PR-wide list", async () => {
    reply(200, [
      { id: 1, pull_request_review_id: 7, path: "a.ts", line: 3, side: "RIGHT", body: "x" },
      { id: 2, pull_request_review_id: 8, path: "b.ts", line: 4, side: "RIGHT", body: "y" },
    ])
    expect(await client().listReviewComments(ref, 5, 7)).toEqual([
      { id: 1, reviewId: 7, path: "a.ts", line: 3, side: "RIGHT" },
    ])
    expect(last().url).toBe("/repos/o/r/pulls/5/comments?per_page=100&page=1")
  })

  it("replies to a review comment with a POST to its replies", async () => {
    reply(201, { id: 123 })
    expect(await client().replyToReviewComment(ref, 5, 99, "Fixed in `def5678`.")).toEqual({ id: 123 })
    expect(last().method).toBe("POST")
    expect(last().url).toBe("/repos/o/r/pulls/5/comments/99/replies")
    expect(JSON.parse(last().body)).toEqual({ body: "Fixed in `def5678`." })
  })
})

describe("GitHubClient review threads", () => {
  it("pages through review threads and flattens the first comment", async () => {
    reply(200, threadsPage(true, "c1", [threadNode("t1", { login: "andabot", __typename: "Bot" })]))
    reply(200, threadsPage(false, null, [threadNode("t2", null)]))
    const before = received.length
    expect(await client().listReviewThreads(ref, 5)).toEqual([
      {
        id: "t1",
        resolved: false,
        outdated: true,
        path: "a.ts",
        line: null,
        side: "RIGHT",
        firstCommentId: 11,
        firstCommentBody: "**🔴 Blocking: x**",
        authorLogin: "andabot",
        authorIsBot: true,
      },
      {
        id: "t2",
        resolved: false,
        outdated: false,
        path: "a.ts",
        line: 7,
        side: "RIGHT",
        firstCommentId: 12,
        firstCommentBody: "**🔴 Blocking: x**",
        authorLogin: null,
        authorIsBot: false,
      },
    ])
    const posts = received.slice(before)
    expect(posts.map((p) => [p.method, p.url])).toEqual([
      ["POST", "/graphql"],
      ["POST", "/graphql"],
    ])
    expect(JSON.parse(posts[1]?.body ?? "")).toMatchObject({
      variables: { owner: "o", name: "r", number: 5, cursor: "c1" },
    })
  })

  it("throws rather than return a thread list it had to cut short, so the review counts the threads as unknown", async () => {
    for (let page = 1; page <= 5; page++) {
      reply(200, threadsPage(true, `c${page}`, [threadNode(`t${page}`, { login: "andabot", __typename: "Bot" })]))
    }
    await expect(client().listReviewThreads(ref, 5)).rejects.toThrow("more than 500 review threads")
  })

  it("resolves a thread with the GraphQL mutation and throws on GraphQL errors", async () => {
    reply(200, { data: { resolveReviewThread: { thread: { id: "t1", isResolved: true } } } })
    await expect(client().resolveReviewThread("t1")).resolves.toBeUndefined()
    expect(JSON.parse(last().body)).toMatchObject({ variables: { threadId: "t1" } })
    expect(last().body).toContain("resolveReviewThread")
    reply(200, { data: null, errors: [{ message: "nope" }] })
    await expect(client().resolveReviewThread("t1")).rejects.toThrow(/nope/)
  })
})
