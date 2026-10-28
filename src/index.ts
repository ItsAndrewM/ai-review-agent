import { Value } from "typebox/value"
import { verifyWebhookSignature } from "./github/webhook.ts"
import { objectName, routeWebhook, WebhookPayload } from "./route.ts"
import { serveProbe } from "./sandbox/probe.ts"
import { versionOf } from "./version.ts"

export { PullRequest } from "./pull-request.ts"
export { Outbound } from "./sandbox/outbound.ts"
export { ReviewSandbox } from "./sandbox/review-sandbox.ts"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ name: env.BOT_LOGIN, ok: true })
    }
    if (url.pathname === "/sandbox-probe") return serveProbe(request, env)
    if (url.pathname !== "/webhook") return new Response("Not found", { status: 404 })
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
    return receiveWebhook(request, env)
  },
} satisfies ExportedHandler<Env>

async function receiveWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text()
  const verified = await verifyWebhookSignature(
    env.GITHUB_WEBHOOK_SECRET,
    body,
    request.headers.get("x-hub-signature-256"),
  )
  if (!verified) return new Response("Bad signature", { status: 401 })

  const eventName = request.headers.get("x-github-event") ?? ""
  const deliveryId = request.headers.get("x-github-delivery") ?? crypto.randomUUID()
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return new Response("Bad JSON", { status: 400 })
  }
  if (!Value.Check(WebhookPayload, payload)) return new Response("Unexpected payload", { status: 400 })

  const routed = routeWebhook(eventName, payload, deliveryId, env.BOT_LOGIN)
  if (routed.kind === "ignore") {
    return Response.json({ ignored: routed.reason }, { status: 200 })
  }
  const version = versionOf(env.CF_VERSION_METADATA)
  await Promise.all(
    routed.incoming.map((incoming) => env.PULL_REQUEST.getByName(objectName(incoming.key)).accept(incoming, version)),
  )
  return Response.json(
    { accepted: routed.incoming.map((incoming) => incoming.kind), delivery: deliveryId },
    { status: 202 },
  )
}
