import { describe, expect, it } from "vitest"
import { GitHubClient } from "../src/github/client.ts"
import { reactWithEyes } from "../src/reaction.ts"

interface FakeGitHub {
  client: GitHubClient
  urls: string[]
}

function github(status: number, body: string): FakeGitHub {
  const urls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(new URL(String(input)).pathname)
    return new Response(body, { status })
  }
  return { client: new GitHubClient("t", "andabot", "https://api.test", fetchImpl), urls }
}

const added = JSON.stringify({ data: { addReaction: { reaction: { content: "EYES" } } } })

describe("reactWithEyes", () => {
  it("adds the reaction to the subject", async () => {
    const { client, urls } = github(200, added)
    await reactWithEyes(client, "IC_1", 3)
    expect(urls).toEqual(["/graphql"])
  })

  it("doesn't throw when GitHub refuses the reaction, so the command after it still runs", async () => {
    const { client, urls } = github(403, JSON.stringify({ message: "Resource not accessible by integration" }))
    await expect(reactWithEyes(client, "IC_1", 3)).resolves.toBeUndefined()
    expect(urls).toEqual(["/graphql"])
  })

  it("adds nothing when there is no subject to react to", async () => {
    const { client, urls } = github(200, added)
    await reactWithEyes(client, undefined, 3)
    expect(urls).toEqual([])
  })
})
