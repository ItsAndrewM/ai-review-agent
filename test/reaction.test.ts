import { describe, expect, it } from "vitest"
import { GitHubClient } from "../src/github/client.ts"
import { reactWithEyes } from "../src/reaction.ts"

function github(status: number, body: string, requests: string[]): GitHubClient {
  return new GitHubClient("t", "https://api", async (input) => {
    requests.push(String(input))
    return new Response(body, { status })
  })
}

const added = JSON.stringify({ data: { addReaction: { reaction: { content: "EYES" } } } })

describe("reactWithEyes", () => {
  it("adds the reaction to the subject", async () => {
    const requests: string[] = []
    await reactWithEyes(github(200, added, requests), "IC_1", 3)
    expect(requests).toEqual(["https://api/graphql"])
  })

  it("doesn't throw when GitHub refuses, so the command after it still runs", async () => {
    const refused = github(403, JSON.stringify({ message: "Resource not accessible by integration" }), [])
    await expect(reactWithEyes(refused, "IC_1", 3)).resolves.toBeUndefined()
  })

  it("adds nothing when there is no subject to react to", async () => {
    const requests: string[] = []
    await reactWithEyes(github(200, added, requests), undefined, 3)
    expect(requests).toEqual([])
  })
})
