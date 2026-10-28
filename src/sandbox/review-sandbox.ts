import { DurableObject } from "cloudflare:workers"
import { log } from "../log.ts"
import {
  killArgv,
  parseResult,
  removeArgv,
  resultArgv,
  runArgv,
  runDir,
  tailBytesOf,
  TRUST_ENV,
  type KillSignal,
  type RunOutcome,
} from "./run.ts"

export const SANDBOX_INSTANCE = "standard-1"

export const INACTIVITY_TIMEOUT_MS = 30 * 60_000

const KILL_GRACE_MS = 5_000

const AWAKE_ALARM_MS = 60_000

export interface RunOptions {
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly timeoutMs: number
  readonly tailBytes?: number | undefined
}

export class ReviewSandbox extends DurableObject<Env> {
  readonly #container: Container
  #inFlight = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    if (ctx.container === undefined) throw new Error("No container is configured")
    this.#container = ctx.container
  }

  async start(token: string | undefined): Promise<void> {
    const began = Date.now()
    const started = !this.#container.running
    if (started) {
      this.#container.start({ image: this.#image(), instance: SANDBOX_INSTANCE, enableInternet: false })
    }
    try {
      await this.#attach(token)
    } catch (cause) {
      await this.#container.destroy()
      throw cause
    }
    log("sandbox.start", { started, ms: Date.now() - began })
  }

  async run(command: readonly string[], options: RunOptions): Promise<RunOutcome> {
    this.#inFlight += 1
    await this.#stayAwake()
    try {
      return await this.#execute(command, options)
    } finally {
      this.#inFlight = Math.max(0, this.#inFlight - 1)
    }
  }

  async alarm(): Promise<void> {
    if (this.#inFlight > 0) await this.ctx.storage.setAlarm(Date.now() + AWAKE_ALARM_MS)
  }

  async #stayAwake(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + AWAKE_ALARM_MS)
  }

  async #execute(command: readonly string[], options: RunOptions): Promise<RunOutcome> {
    const began = Date.now()
    const dir = runDir(crypto.randomUUID())
    const tailBytes = tailBytesOf(options.tailBytes)
    const process = await this.#container.exec(runArgv(dir, command), {
      cwd: options.cwd,
      env: { ...TRUST_ENV, ...options.env },
      stdout: "ignore",
      stderr: "ignore",
    })
    const finished = await this.#waitOrKill(process.exitCode, options.timeoutMs, dir)
    const read = parseResult(await this.#stdout(resultArgv(dir, tailBytes)), tailBytes)
    await this.#stdout(removeArgv(dir))
    const result: RunOutcome = finished ? read : { outcome: "timeout", tail: read.tail, cut: read.cut }
    log("sandbox.run", {
      command: command[0],
      outcome: result.outcome,
      exitCode: result.outcome === "exited" ? result.exitCode : undefined,
      ms: Date.now() - began,
      bytes: result.tail.length,
      cut: result.cut,
    })
    return result
  }

  running(): boolean {
    return this.#container.running
  }

  async destroy(): Promise<void> {
    this.#inFlight = 0
    await this.ctx.storage.deleteAlarm()
    await this.#container.destroy()
    log("sandbox.destroy")
  }

  #image(): string {
    const image = this.#container.images["review"]
    if (image === undefined) throw new Error("No review image is configured")
    return image
  }

  async #attach(token: string | undefined): Promise<void> {
    const outbound = this.ctx.exports.Outbound({ props: { token } })
    await this.#container.interceptAllOutboundHttp(outbound)
    await this.#container.interceptOutboundHttps("*", outbound)
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
  }

  async #waitOrKill(exit: Promise<number>, timeoutMs: number, dir: string): Promise<boolean> {
    if (await settles(exit, timeoutMs)) return true
    await this.#kill(dir, "TERM")
    await settles(exit, KILL_GRACE_MS)
    await this.#kill(dir, "KILL")
    await settles(exit, KILL_GRACE_MS)
    return false
  }

  async #kill(dir: string, signal: KillSignal): Promise<void> {
    await this.#stdout(killArgv(dir, signal))
  }

  async #stdout(argv: string[]): Promise<Uint8Array> {
    const output = await (await this.#container.exec(argv)).output()
    return new Uint8Array(output.stdout)
  }
}

async function settles(exit: Promise<number>, withinMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), withinMs)
  })
  const settled = await Promise.race([exit.then(() => true), expired])
  clearTimeout(timer)
  return settled
}
