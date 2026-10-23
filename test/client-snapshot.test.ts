import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { GitHubClient } from "../src/github/client.ts"

const ref = { owner: "o", repo: "r" }

const GraphQLRequest = Type.Object({ query: Type.String(), variables: Type.Record(Type.String(), Type.String()) })

type GraphQLRequest = Static<typeof GraphQLRequest>

interface Recorded {
  url: string
  method: string | undefined
  authorization: string | null
  body: string
}

interface BlobAnswer {
  text: string | null
  isBinary: boolean
  isTruncated: boolean
}

interface RecordingClient {
  client: GitHubClient
  calls: Recorded[]
}

function recordingClient(answer: (recorded: Recorded) => Response): RecordingClient {
  const calls: Recorded[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const recorded = {
      url: String(input),
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization"),
      body: await new Response(init?.body).text(),
    }
    calls.push(recorded)
    return answer(recorded)
  }
  return { client: new GitHubClient("tok", "https://api.example", fetchImpl), calls }
}

function graphqlRequest(recorded: Recorded): GraphQLRequest {
  const request = JSON.parse(recorded.body)
  if (!Value.Check(GraphQLRequest, request)) throw new Error(`not a GraphQL request: ${recorded.body}`)
  return request
}

function blobFor(path: string): BlobAnswer | null {
  if (path === "p3") return { text: null, isBinary: true, isTruncated: false }
  if (path === "p4") return { text: "cut", isBinary: false, isTruncated: true }
  if (path === "p5") return null
  if (path === "p6") return { text: null, isBinary: false, isTruncated: false }
  return { text: `text of ${path}`, isBinary: false, isTruncated: false }
}

function answerBlobs(recorded: Recorded): Response {
  const repository: Record<string, BlobAnswer | null> = {}
  for (const [name, expression] of Object.entries(graphqlRequest(recorded).variables)) {
    if (name.startsWith("e")) repository[`f${name.slice(1)}`] = blobFor(expression.slice(expression.indexOf(":") + 1))
  }
  return new Response(JSON.stringify({ data: { repository } }))
}

describe("downloadTarball", () => {
  it("downloads the tarball of a sha", async () => {
    const { client, calls } = recordingClient(() => new Response("tar"))
    const stream = await client.downloadTarball(ref, "abc")
    expect(calls.map((call) => call.url)).toEqual(["https://api.example/repos/o/r/tarball/abc"])
    expect(calls[0]?.authorization).toBe("Bearer tok")
    expect(await new Response(stream).text()).toBe("tar")
  })

  it("throws on a failed tarball", async () => {
    const { client } = recordingClient(() => new Response("missing", { status: 404 }))
    await expect(client.downloadTarball(ref, "abc")).rejects.toThrow("GitHub tarball 404")
  })

  it("cancels the body of a failed tarball response so the connection is released", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const { client } = recordingClient(() => new Response(body, { status: 502 }))
    await expect(client.downloadTarball(ref, "abc")).rejects.toThrow("GitHub tarball 502")
    expect(cancelled).toBe(true)
  })

  it("throws when the response has no body", async () => {
    const { client } = recordingClient(() => new Response(null, { status: 200 }))
    await expect(client.downloadTarball(ref, "abc")).rejects.toThrow("GitHub tarball 200")
  })
})

describe("getTreeListing", () => {
  it("lists blobs, trees and submodules with modes and sizes", async () => {
    const { client, calls } = recordingClient(
      () =>
        new Response(
          JSON.stringify({
            sha: "abc",
            truncated: true,
            tree: [
              { path: "a.ts", mode: "100644", type: "blob", sha: "s1", size: 12 },
              { path: "link", mode: "120000", type: "blob", sha: "s2", size: 5 },
              { path: "vendor/lib", mode: "160000", type: "commit", sha: "s3" },
              { path: "src", mode: "040000", type: "tree", sha: "s4" },
            ],
          }),
        ),
    )
    const listing = await client.getTreeListing(ref, "abc")
    expect(calls.map((call) => call.url)).toEqual(["https://api.example/repos/o/r/git/trees/abc?recursive=1"])
    expect(listing.truncated).toBe(true)
    expect(listing.entries).toEqual([
      { path: "a.ts", type: "blob", mode: "100644", size: 12 },
      { path: "link", type: "blob", mode: "120000", size: 5 },
      { path: "vendor/lib", type: "commit", mode: "160000", size: undefined },
      { path: "src", type: "tree", mode: "040000", size: undefined },
    ])
  })

  it("rejects a listing that does not match the schema", async () => {
    const { client } = recordingClient(() => new Response(JSON.stringify({ sha: "abc", truncated: false })))
    await expect(client.getTreeListing(ref, "abc")).rejects.toThrow("unexpected response")
  })
})

describe("getBlobTexts", () => {
  it("reads blob texts in batches of 50", async () => {
    const { client, calls } = recordingClient(answerBlobs)
    const paths = Array.from({ length: 120 }, (_, index) => `p${index}`)
    const texts = await client.getBlobTexts(ref, "abc", paths)
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "https://api.example/graphql"],
      ["POST", "https://api.example/graphql"],
      ["POST", "https://api.example/graphql"],
    ])
    const [first] = calls.map(graphqlRequest)
    expect(first?.variables.e0).toBe("abc:p0")
    expect(first?.variables.owner).toBe("o")
    expect(first?.variables.name).toBe("r")
    expect(first?.query).toContain("f49: object(expression: $e49)")
    expect(first?.query).not.toContain("f50")
    expect(texts.map((blob) => blob.path)).toEqual(paths)
    expect(texts[0]).toEqual({ path: "p0", text: "text of p0" })
    expect(texts[119]).toEqual({ path: "p119", text: "text of p119" })
  })

  it("gives no text for a binary, truncated, missing or textless object", async () => {
    const { client } = recordingClient(answerBlobs)
    const texts = await client.getBlobTexts(ref, "abc", ["p2", "p3", "p4", "p5", "p6"])
    expect(texts).toEqual([
      { path: "p2", text: "text of p2" },
      { path: "p3", text: undefined },
      { path: "p4", text: undefined },
      { path: "p5", text: undefined },
      { path: "p6", text: undefined },
    ])
  })

  it("makes no request for no paths", async () => {
    const { client, calls } = recordingClient(answerBlobs)
    expect(await client.getBlobTexts(ref, "abc", [])).toEqual([])
    expect(calls).toEqual([])
  })

  it("throws on GraphQL errors", async () => {
    const { client } = recordingClient(() => new Response(JSON.stringify({ errors: [{ message: "rate limited" }] })))
    await expect(client.getBlobTexts(ref, "abc", ["a"])).rejects.toThrow("GitHub GraphQL: rate limited")
  })
})
