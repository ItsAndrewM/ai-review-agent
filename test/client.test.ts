import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { GitHubClient, type CreateCheckRun, type UpdateCheckRun } from "../src/github/client.ts"

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
