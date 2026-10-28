import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import { createAppJwt, fetchInstallationToken, type TokenScope } from "../github/app-auth.ts"
import { verifyWebhookSignature } from "../github/webhook.ts"
import { log } from "../log.ts"
import { PullRequestKey } from "../records.ts"
import { objectName } from "../route.ts"

const DEFAULT_PROBE_TIMEOUT_MS = 60_000

export const ProbeRequest = Type.Object(
  {
    key: PullRequestKey,
    action: Type.Union([Type.Literal("run"), Type.Literal("destroy")]),
    command: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
    cwd: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    tailBytes: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
)

export type ProbeRequest = Static<typeof ProbeRequest>

export function sandboxTokenScope(key: PullRequestKey): TokenScope {
  return { repositories: [key.repo], permissions: { contents: "read" } }
}

export function probeEnabled(value: string | undefined): boolean {
  return value === "true"
}

export function parseProbe(body: string): ProbeRequest | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!Value.Check(ProbeRequest, parsed)) return undefined
  if (parsed.action === "run" && parsed.command === undefined) return undefined
  return parsed
}

export async function serveProbe(request: Request, env: Env): Promise<Response> {
  if (!probeEnabled(env.SANDBOX_PROBE)) return new Response("Not found", { status: 404 })
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
  const body = await request.text()
  const signature = request.headers.get("x-hub-signature-256")
  if (!(await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, body, signature))) {
    return new Response("Bad signature", { status: 401 })
  }
  const probe = parseProbe(body)
  if (probe === undefined) return new Response("Bad probe", { status: 400 })
  log("sandbox.probe", { action: probe.action, number: probe.key.number })
  const sandbox = env.REVIEW_SANDBOX.getByName(objectName(probe.key))
  if (probe.action === "destroy") {
    await sandbox.destroy()
    return Response.json({ destroyed: true })
  }
  const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY)
  const token = await fetchInstallationToken(jwt, probe.key.installationId, sandboxTokenScope(probe.key))
  await sandbox.start(token.token)
  const outcome = await sandbox.run(probe.command ?? [], {
    cwd: probe.cwd ?? "/workspace",
    timeoutMs: probe.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    tailBytes: probe.tailBytes,
  })
  return Response.json(outcome)
}
