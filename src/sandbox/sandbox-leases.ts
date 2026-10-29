import { DurableObject } from "cloudflare:workers"
import { Value } from "typebox/value"
import { log } from "../log.ts"
import { acquire, LeaseState, release } from "./lease.ts"

const LEASES_KEY = "leases"

export class SandboxLeases extends DurableObject<Env> {
  async acquire(holder: string, ttlMs: number): Promise<boolean> {
    const next = acquire(await this.#state(), holder, Date.now(), ttlMs)
    await this.ctx.storage.put(LEASES_KEY, next.state)
    log("sandbox.lease", { holder, granted: next.granted, live: Object.keys(next.state).length })
    return next.granted
  }

  async release(holder: string): Promise<void> {
    await this.ctx.storage.put(LEASES_KEY, release(await this.#state(), holder))
  }

  async #state(): Promise<LeaseState> {
    const stored = await this.ctx.storage.get(LEASES_KEY)
    return Value.Check(LeaseState, stored) ? stored : {}
  }
}
