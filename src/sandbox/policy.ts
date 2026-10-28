export const ALLOWED_HOSTS = ["github.com", "registry.npmjs.org"] as const

export const TOKEN_HOST = "github.com"

export type OutboundDecision =
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "forward"; readonly authorization: string | undefined }

export function decideOutbound(url: URL, token: string | undefined): OutboundDecision {
  if (url.protocol !== "https:") return { kind: "refuse", reason: `${url.hostname} is reachable only over HTTPS` }
  if (url.port !== "" || !ALLOWED_HOSTS.some((host) => host === url.hostname)) {
    return { kind: "refuse", reason: `${url.host} is not reachable from this sandbox` }
  }
  const authorization = url.hostname === TOKEN_HOST && token !== undefined ? basicAccessToken(token) : undefined
  return { kind: "forward", authorization }
}

export function forwardedHeaders(sent: Headers, authorization: string | undefined): Headers {
  const headers = new Headers(sent)
  headers.delete("authorization")
  if (authorization !== undefined) headers.set("authorization", authorization)
  return headers
}

export function forwardedRequest(sent: Request, authorization: string | undefined): Request {
  return new Request(sent, { headers: forwardedHeaders(sent.headers, authorization), redirect: "manual" })
}

function basicAccessToken(token: string): string {
  return `Basic ${btoa(`x-access-token:${token}`)}`
}
