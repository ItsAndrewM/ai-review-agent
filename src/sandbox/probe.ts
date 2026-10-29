import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import { createAppJwt, fetchInstallationToken, type TokenScope } from "../github/app-auth.ts"
import { verifyWebhookSignature } from "../github/webhook.ts"
import { log } from "../log.ts"
import { PullRequestKey } from "../records.ts"
import { objectName } from "../route.ts"
import type { RunOutcome } from "./run.ts"

const DEFAULT_PROBE_TIMEOUT_MS = 60_000

const RunProbe = Type.Object(
  {
    key: PullRequestKey,
    action: Type.Literal("run"),
    command: Type.Array(Type.String(), { minItems: 1 }),
    cwd: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    tailBytes: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
)

const DestroyProbe = Type.Object(
  { key: PullRequestKey, action: Type.Literal("destroy") },
  { additionalProperties: false },
)

const EndProbe = Type.Object({ key: PullRequestKey, action: Type.Literal("end") }, { additionalProperties: false })

const PrepareProbe = Type.Object(
  { key: PullRequestKey, action: Type.Literal("prepare") },
  { additionalProperties: false },
)

const CheckProbe = Type.Object(
  {
    key: PullRequestKey,
    action: Type.Literal("check"),
    name: Type.Union([Type.Literal("lint"), Type.Literal("typecheck"), Type.Literal("test")]),
    paths: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
)

export const ProbeRequest = Type.Union([RunProbe, DestroyProbe, PrepareProbe, CheckProbe, EndProbe])

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
  return Value.Check(ProbeRequest, parsed) ? parsed : undefined
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
  return dispatchProbe(probe, env)
}

async function dispatchProbe(probe: ProbeRequest, env: Env): Promise<Response> {
  const object = env.PULL_REQUEST.getByName(objectName(probe.key))
  switch (probe.action) {
    case "prepare":
      return Response.json(await object.prepareSandbox(probe.key))
    case "check":
      return new Response(await object.probeCheck(probe.key, probe.name, probe.paths ?? []))
    case "end":
      return Response.json(await object.endSandbox(probe.key))
    case "destroy":
      await env.REVIEW_SANDBOX.getByName(objectName(probe.key)).destroy()
      return Response.json({ destroyed: true })
    case "run":
      return Response.json(await runProbe(probe, env))
  }
}

async function runProbe(probe: Static<typeof RunProbe>, env: Env): Promise<RunOutcome> {
  const sandbox = env.REVIEW_SANDBOX.getByName(objectName(probe.key))
  const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY)
  const token = await fetchInstallationToken(jwt, probe.key.installationId, sandboxTokenScope(probe.key))
  await sandbox.start(token.token)
  return sandbox.run(probe.command, {
    cwd: probe.cwd ?? "/workspace",
    timeoutMs: probe.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    tailBytes: probe.tailBytes,
  })
}
