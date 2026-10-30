import { describe, expect, it } from "vitest"
import { checkWorkersAiAccess } from "../tools/replay/preflight.ts"

describe("checkWorkersAiAccess", () => {
  it("accepts an authorized Workers AI model search", async () => {
    const requests: string[] = []
    const fetcher: typeof fetch = async (input) => {
      requests.push(String(input))
      return Response.json({ success: true, result: [] })
    }
    await checkWorkersAiAccess("account-id", "token", fetcher)
    expect(requests).toEqual(["https://api.cloudflare.com/client/v4/accounts/account-id/ai/models/search?per_page=1"])
  })

  it("refuses a valid token without Workers AI permission before any paid requests", async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 })
    await expect(checkWorkersAiAccess("account-id", "token", fetcher)).rejects.toThrow("Workers AI permission")
  })
})
