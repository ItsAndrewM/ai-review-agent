import { Type, type Static } from "typebox"
import { Value } from "typebox/value"

export const InstallationToken = Type.Object({ token: Type.String(), expiresAt: Type.Number() })

export type InstallationToken = Static<typeof InstallationToken>

const InstallationTokenResponse = Type.Object({ token: Type.String(), expires_at: Type.String() })

const CLOCK_DRIFT_SECONDS = 60

export async function createAppJwt(appId: string, privateKeyPem: string, now = Date.now()): Promise<string> {
  const key = await importPrivateKey(privateKeyPem)
  const iat = Math.floor(now / 1000) - CLOCK_DRIFT_SECONDS
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId })))
  const signingInput = `${header}.${payload}`
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)),
  )
  return `${signingInput}.${base64Url(signature)}`
}

export interface TokenScope {
  readonly repositories: readonly string[]
  readonly permissions: Readonly<Record<string, "read" | "write">>
}

export function tokenRequestBody(scope: TokenScope | undefined): string | undefined {
  return scope === undefined ? undefined : JSON.stringify(scope)
}

export async function fetchInstallationToken(
  jwt: string,
  installationId: number,
  scope?: TokenScope,
  apiBase = "https://api.github.com",
): Promise<InstallationToken> {
  const body = tokenRequestBody(scope)
  const response = await fetch(`${apiBase}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "andabot",
    },
    body: body ?? null,
  })
  if (!response.ok) {
    throw new Error(`installation token: ${response.status} ${await response.text()}`)
  }
  const data: unknown = await response.json()
  if (!Value.Check(InstallationTokenResponse, data)) throw new Error("installation token: unexpected response")
  return { token: data.token, expiresAt: Date.parse(data.expires_at) }
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, "\n").trim()
  const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(normalized)
  if (!match) throw new Error("private key: not a PEM block")
  const label = match[1]
  const der = fromBase64((match[2] ?? "").replace(/\s+/g, ""))
  const pkcs8 = label === "RSA PRIVATE KEY" ? wrapPkcs1InPkcs8(der) : der
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])
}

const DER_SEQUENCE = 0x30
const DER_OCTET_STRING = 0x04

export function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
  const versionZero = new Uint8Array([0x02, 0x01, 0x00])
  const rsaEncryption = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ])
  const privateKey = derTagged(DER_OCTET_STRING, pkcs1)
  return derTagged(DER_SEQUENCE, concat(versionZero, rsaEncryption, privateKey))
}

export function unwrapPkcs8ToPkcs1(pkcs8: Uint8Array): Uint8Array {
  let offset = 0
  const outer = readTlv(pkcs8, offset)
  offset = outer.contentStart
  const version = readTlv(pkcs8, offset)
  offset = version.end
  const algorithm = readTlv(pkcs8, offset)
  offset = algorithm.end
  const octet = readTlv(pkcs8, offset)
  if (octet.tag !== DER_OCTET_STRING) throw new Error("pkcs8: expected OCTET STRING")
  return pkcs8.slice(octet.contentStart, octet.end)
}

interface DerElement {
  tag: number
  contentStart: number
  end: number
}

function readTlv(bytes: Uint8Array, offset: number): DerElement {
  const tag = bytes[offset]
  if (tag === undefined) throw new Error("der: truncated")
  let lengthByte = bytes[offset + 1]
  if (lengthByte === undefined) throw new Error("der: truncated")
  let contentStart = offset + 2
  let length = lengthByte
  if (lengthByte & 0x80) {
    const count = lengthByte & 0x7f
    length = 0
    for (let i = 0; i < count; i++) {
      const b = bytes[offset + 2 + i]
      if (b === undefined) throw new Error("der: truncated")
      length = (length << 8) | b
    }
    contentStart = offset + 2 + count
  }
  return { tag, contentStart, end: contentStart + length }
}

function derTagged(tag: number, content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag]), derLength(content.length), content)
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length])
  const bytes: number[] = []
  let remaining = length
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining >>= 8
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes])
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function base64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
