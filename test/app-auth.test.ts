import { describe, expect, it } from "vitest"
import { createAppJwt, fromBase64, unwrapPkcs8ToPkcs1, wrapPkcs1InPkcs8 } from "../src/github/app-auth.ts"

async function generateKeyPair() {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
}

function toPem(label: string, der: Uint8Array): string {
  let binary = ""
  for (const b of der) binary += String.fromCharCode(b)
  const base64 = btoa(binary).replace(/(.{64})/g, "$1\n")
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`
}

describe("GitHub App JWT", () => {
  it("signs a JWT GitHub can verify, from a PKCS#8 key", async () => {
    const pair = await generateKeyPair()
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer)
    const jwt = await createAppJwt("4242", toPem("PRIVATE KEY", pkcs8), 1_760_000_000_000)
    const [header, payload, signature] = jwt.split(".")
    expect(JSON.parse(atob(header!))).toEqual({ alg: "RS256", typ: "JWT" })
    const claims = JSON.parse(atob(payload!.replace(/-/g, "+").replace(/_/g, "/")))
    expect(claims.iss).toBe("4242")
    expect(claims.exp - claims.iat).toBe(540)
    expect(claims.iat).toBe(1_760_000_000 - 60)
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      fromBase64(signature!),
      new TextEncoder().encode(`${header}.${payload}`),
    )
    expect(ok).toBe(true)
  })

  it("wraps the PKCS#1 key GitHub downloads into PKCS#8 and signs with it", async () => {
    const pair = await generateKeyPair()
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer)
    const pkcs1 = unwrapPkcs8ToPkcs1(pkcs8)
    expect(Array.from(wrapPkcs1InPkcs8(pkcs1))).toEqual(Array.from(pkcs8))
    const jwt = await createAppJwt("1", toPem("RSA PRIVATE KEY", pkcs1))
    const [header, payload, signature] = jwt.split(".")
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      fromBase64(signature!),
      new TextEncoder().encode(`${header}.${payload}`),
    )
    expect(ok).toBe(true)
  })

  it("accepts a PEM pasted with literal backslash-n", async () => {
    const pair = await generateKeyPair()
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer)
    const pem = toPem("PRIVATE KEY", pkcs8).replace(/\n/g, "\\n")
    await expect(createAppJwt("1", pem)).resolves.toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)
  })
})
