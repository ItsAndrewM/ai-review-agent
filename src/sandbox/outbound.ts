import { WorkerEntrypoint } from "cloudflare:workers"
import { decideOutbound, forwardedRequest } from "./policy.ts"

export interface OutboundProps {
  readonly token: string | undefined
}

export class Outbound extends WorkerEntrypoint<Env, OutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const decision = decideOutbound(new URL(request.url), this.ctx.props.token)
    if (decision.kind === "refuse") return new Response(`${decision.reason}\n`, { status: 403 })
    return fetch(forwardedRequest(request, decision.authorization))
  }
}
