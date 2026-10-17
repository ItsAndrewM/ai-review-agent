import { describe, expect, it } from "vitest"
import { signWebhookBody, verifyWebhookSignature } from "../src/github/webhook.ts"

describe("webhook signature", () => {
  const secret = "s3cret"
  const body = JSON.stringify({ action: "opened", number: 7 })

  it("accepts a body signed with the secret", async () => {
    const signature = await signWebhookBody(secret, body)
    expect(signature.startsWith("sha256=")).toBe(true)
    expect(await verifyWebhookSignature(secret, body, signature)).toBe(true)
  })

  it("rejects a changed body, a wrong secret and a missing header", async () => {
    const signature = await signWebhookBody(secret, body)
    expect(await verifyWebhookSignature(secret, body + " ", signature)).toBe(false)
    expect(await verifyWebhookSignature("other", body, signature)).toBe(false)
    expect(await verifyWebhookSignature(secret, body, null)).toBe(false)
    expect(await verifyWebhookSignature(secret, body, "sha1=abc")).toBe(false)
  })
})
