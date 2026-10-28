import { describe, expect, it } from "vitest"
import { decideOutbound, forwardedHeaders, forwardedRequest } from "../src/sandbox/policy.ts"

const basic = (token: string) => `Basic ${btoa(`x-access-token:${token}`)}`

describe("decideOutbound", () => {
  it("forwards github.com with the installation token as Basic x-access-token", () => {
    expect(decideOutbound(new URL("https://github.com/o/r.git/info/refs"), "tok")).toEqual({
      kind: "forward",
      authorization: basic("tok"),
    })
  })

  it("forwards github.com without a token when none is held", () => {
    expect(decideOutbound(new URL("https://github.com/o/r.git/info/refs"), undefined)).toEqual({
      kind: "forward",
      authorization: undefined,
    })
  })

  it("forwards the npm registry without a token", () => {
    expect(decideOutbound(new URL("https://registry.npmjs.org/vitest"), "tok")).toEqual({
      kind: "forward",
      authorization: undefined,
    })
  })

  it("refuses a host off the allowlist", () => {
    expect(decideOutbound(new URL("https://example.com/"), "tok")).toEqual({
      kind: "refuse",
      reason: "example.com is not reachable from this sandbox",
    })
  })

  it("refuses plain HTTP to an allowed host, since the token would travel unencrypted", () => {
    expect(decideOutbound(new URL("http://github.com/"), "tok")).toEqual({
      kind: "refuse",
      reason: "github.com is reachable only over HTTPS",
    })
  })

  it("refuses plain HTTP before it looks at the host", () => {
    expect(decideOutbound(new URL("http://example.com/"), undefined)).toEqual({
      kind: "refuse",
      reason: "example.com is reachable only over HTTPS",
    })
  })

  it("matches the host exactly, so a subdomain of github.com is off the allowlist", () => {
    expect(decideOutbound(new URL("https://api.github.com/"), "tok")).toEqual({
      kind: "refuse",
      reason: "api.github.com is not reachable from this sandbox",
    })
  })
})

describe("forwardedHeaders", () => {
  it("replaces an authorization the container sent with the token's", () => {
    const sent = new Headers({ authorization: "Bearer leaked", accept: "*/*" })
    const headers = forwardedHeaders(sent, basic("tok"))
    expect(headers.get("authorization")).toBe(basic("tok"))
    expect(sent.get("authorization")).toBe("Bearer leaked")
  })

  it("drops an authorization the container sent when no token is held", () => {
    const headers = forwardedHeaders(new Headers({ authorization: "Bearer leaked" }), undefined)
    expect(headers.has("authorization")).toBe(false)
  })

  it("keeps the other headers", () => {
    const headers = forwardedHeaders(new Headers({ accept: "*/*", "user-agent": "git/2.39" }), undefined)
    expect(headers.get("accept")).toBe("*/*")
    expect(headers.get("user-agent")).toBe("git/2.39")
  })
})

describe("forwardedRequest", () => {
  it("returns a redirect to the container instead of following it, so every hop is decided by the policy", () => {
    const sent = new Request("https://github.com/o/r/archive/main.tar.gz", {
      headers: { authorization: "Bearer leaked" },
    })
    const request = forwardedRequest(sent, basic("tok"))
    expect(request.redirect).toBe("manual")
    expect(request.url).toBe("https://github.com/o/r/archive/main.tar.gz")
    expect(request.headers.get("authorization")).toBe(basic("tok"))
  })
})
