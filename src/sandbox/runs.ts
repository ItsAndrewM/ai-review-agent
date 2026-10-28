import { log, logError, errorText } from "../log.ts"
import type { PullRequestKey } from "../records.ts"
import {
  checkoutArgv,
  detectArgv,
  installArgv,
  lastLine,
  parseCheckout,
  parseManager,
  REPO_DIR,
  repositoryUrl,
  STEP_TIMEOUT_MS,
  type Manager,
} from "./checkout.ts"
import type { RunOptions, RunOutcome } from "./run.ts"

export const DEFAULT_SANDBOX_SECONDS = 900

export const LEASE_GRACE_MS = 120_000

export function sandboxBudgetOf(value: string | undefined): number {
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : DEFAULT_SANDBOX_SECONDS
}

export function sandboxOn(value: string | undefined): boolean {
  return value === "true"
}

export interface SandboxCalls {
  start(token: string | undefined): Promise<void>
  run(command: readonly string[], options: RunOptions): Promise<RunOutcome>
  destroy(): Promise<void>
}

export interface SandboxHead {
  readonly number: number
  readonly key: PullRequestKey
  readonly sha: string
}

export interface SandboxHost {
  enabled(): Promise<boolean>
  lease(ttlMs: number): Promise<boolean>
  unlease(): Promise<void>
  token(): Promise<string>
  sandbox(): Promise<SandboxCalls>
  head(): Promise<SandboxHead>
  now(): number
}

export type UnavailableReason = "head" | "lease" | "start" | "checkout" | "install"

export type SandboxAccess =
  | { readonly kind: "ready"; readonly sandbox: SandboxCalls; readonly dir: string; readonly manager: Manager }
  | { readonly kind: "off" }
  | { readonly kind: "spent"; readonly seconds: number; readonly budget: number }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason }

export type SandboxEnd = "review_end" | "closed" | "new_head"

export type AccessSummary =
  | { readonly kind: "ready"; readonly dir: string; readonly manager: Manager }
  | Exclude<SandboxAccess, { kind: "ready" }>

export function accessSummary(access: SandboxAccess): AccessSummary {
  return access.kind === "ready" ? { kind: "ready", dir: access.dir, manager: access.manager } : access
}

type Settled = Extract<SandboxAccess, { kind: "ready" | "unavailable" }>

class StepFailure extends Error {
  constructor(
    readonly step: UnavailableReason,
    readonly reason: string,
  ) {
    super(reason)
  }
}

export class SandboxRuns {
  #active = 0
  #started: number | undefined
  #head: SandboxHead | undefined
  #leased = false
  #running = false
  #spentLogged = false
  #settled: Settled | undefined
  #preparing: Promise<Settled> | undefined

  constructor(
    private readonly host: SandboxHost,
    private readonly budgetSeconds: number,
  ) {}

  start(): void {
    this.#active += 1
  }

  seconds(): number | undefined {
    return this.#started === undefined ? undefined : Math.floor((this.host.now() - this.#started) / 1000)
  }

  async access(): Promise<SandboxAccess> {
    await this.#forgetOtherHead()
    const spent = this.#spent()
    if (spent) return spent
    if (this.#settled) return this.#settled
    if (this.#preparing) return this.#preparing
    if (!(await this.host.enabled())) return { kind: "off" }
    this.#preparing ??= this.#prepare()
    return this.#preparing
  }

  async end(reason: SandboxEnd): Promise<void> {
    this.#active = Math.max(0, this.#active - 1)
    if (this.#active === 0) await this.#teardown(reason)
  }

  async dropIdle(reason: SandboxEnd): Promise<void> {
    if (this.#active === 0) await this.#teardown(reason)
  }

  #spent(): SandboxAccess | undefined {
    const seconds = this.seconds()
    if (seconds === undefined || seconds < this.budgetSeconds) return undefined
    if (!this.#spentLogged) {
      log("sandbox.spent", { number: this.#head?.number, seconds, budget: this.budgetSeconds })
      this.#spentLogged = true
    }
    return { kind: "spent", seconds, budget: this.budgetSeconds }
  }

  async #forgetOtherHead(): Promise<void> {
    if (this.#head === undefined) return
    const now = await this.host.head().catch(() => undefined)
    if (now === undefined || now.sha === this.#head.sha) return
    await this.#teardown("new_head")
  }

  async #teardown(reason: SandboxEnd): Promise<void> {
    if (this.#preparing) await this.#preparing.catch(() => undefined)
    const head = this.#head
    const destroyed = this.#running
    if (this.#running) await this.#destroy()
    if (this.#leased) await this.#unlease()
    if (head && destroyed) log("sandbox.destroy", { number: head.number, reason, seconds: this.seconds() })
    this.#started = undefined
    this.#head = undefined
    this.#spentLogged = false
    this.#settled = undefined
    this.#preparing = undefined
  }

  async #prepare(): Promise<Settled> {
    this.#started = this.host.now()
    let step: UnavailableReason = "head"
    try {
      const head = await this.host.head()
      this.#head = head
      step = "lease"
      if (!(await this.host.lease(this.budgetSeconds * 1000 + LEASE_GRACE_MS))) {
        throw new StepFailure("lease", "no lease free")
      }
      this.#leased = true
      const sandbox = await this.host.sandbox()
      step = "start"
      await sandbox.start(await this.host.token())
      this.#running = true
      step = "checkout"
      await this.#checkout(sandbox, head)
      step = "install"
      return await this.#install(sandbox, head)
    } catch (cause) {
      return this.#failed(cause instanceof StepFailure ? cause : new StepFailure(step, errorText(cause)))
    } finally {
      this.#preparing = undefined
    }
  }

  async #checkout(sandbox: SandboxCalls, head: SandboxHead): Promise<void> {
    const began = this.host.now()
    const result = parseCheckout(
      await this.#run(sandbox, checkoutArgv(repositoryUrl(head.key), head.sha), "/workspace"),
    )
    if (result.kind === "failed") throw new StepFailure("checkout", result.reason)
    log("sandbox.checkout", {
      number: head.number,
      sha: head.sha.slice(0, 7),
      kib: result.kib,
      ms: this.host.now() - began,
    })
  }

  async #install(sandbox: SandboxCalls, head: SandboxHead): Promise<Settled> {
    const began = this.host.now()
    const manager = parseManager(await this.#run(sandbox, detectArgv(), REPO_DIR))
    if (manager === "none") {
      log("sandbox.install", { number: head.number, manager, ms: this.host.now() - began })
      return this.#ready(sandbox, manager)
    }
    const outcome = await this.#run(sandbox, installArgv(manager), REPO_DIR)
    const exitCode = outcome.outcome === "exited" ? outcome.exitCode : undefined
    log("sandbox.install", { number: head.number, manager, exitCode, ms: this.host.now() - began })
    if (exitCode !== 0)
      throw new StepFailure("install", exitCode === undefined ? "install timed out" : lastLine(outcome.tail))
    return this.#ready(sandbox, manager)
  }

  #ready(sandbox: SandboxCalls, manager: Manager): Settled {
    const settled: Settled = { kind: "ready", sandbox, dir: REPO_DIR, manager }
    this.#settled = settled
    return settled
  }

  async #run(sandbox: SandboxCalls, command: readonly string[], cwd: string): Promise<RunOutcome> {
    return sandbox.run(command, { cwd, timeoutMs: STEP_TIMEOUT_MS })
  }

  async #failed(failure: StepFailure): Promise<Settled> {
    logError("sandbox.failed", { number: this.#head?.number, step: failure.step, reason: failure.reason })
    if (failure.step === "lease") log("sandbox.unavailable", { number: this.#head?.number, reason: "lease" })
    if (this.#running) await this.#destroy()
    if (this.#leased) await this.#unlease()
    const settled: Settled = { kind: "unavailable", reason: failure.step }
    this.#settled = settled
    return settled
  }

  async #destroy(): Promise<void> {
    try {
      await (await this.host.sandbox()).destroy()
    } catch (cause) {
      logError("sandbox.destroy_failed", { number: this.#head?.number, error: errorText(cause) })
    }
    this.#running = false
  }

  async #unlease(): Promise<void> {
    try {
      await this.host.unlease()
    } catch (cause) {
      logError("sandbox.unlease_failed", { number: this.#head?.number, error: errorText(cause) })
    }
    this.#leased = false
  }
}
