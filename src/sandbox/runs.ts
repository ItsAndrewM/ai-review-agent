import { log, logError, errorText } from "../log.ts"
import type { PullRequestKey } from "../records.ts"
import {
  checkoutArgv,
  detectArgv,
  installArgv,
  parseCheckout,
  parseManager,
  REPO_DIR,
  repositoryUrl,
  STEP_TIMEOUT_MS,
  type Manager,
} from "./checkout.ts"
import type { RunOptions } from "./review-sandbox.ts"
import type { RunOutcome } from "./run.ts"

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
  sandbox(): SandboxCalls
  head(): Promise<SandboxHead>
  now(): number
}

export type UnavailableReason = "lease" | "start" | "checkout" | "install"

export type SandboxAccess =
  | { readonly kind: "ready"; readonly sandbox: SandboxCalls; readonly dir: string; readonly manager: Manager }
  | { readonly kind: "off" }
  | { readonly kind: "spent"; readonly seconds: number; readonly budget: number }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason }

export type SandboxEnd = "review_end" | "closed"

type Settled = Extract<SandboxAccess, { kind: "ready" | "unavailable" }>

export class SandboxRuns {
  #started: number | undefined
  #leased = false
  #running = false
  #settled: Settled | undefined
  #preparing: Promise<Settled> | undefined

  constructor(
    private readonly host: SandboxHost,
    private readonly budgetSeconds: number,
  ) {}

  seconds(): number | undefined {
    return this.#started === undefined ? undefined : Math.floor((this.host.now() - this.#started) / 1000)
  }

  async access(): Promise<SandboxAccess> {
    if (!(await this.host.enabled())) return { kind: "off" }
    const seconds = this.seconds()
    if (seconds !== undefined && seconds >= this.budgetSeconds) {
      return { kind: "spent", seconds, budget: this.budgetSeconds }
    }
    if (this.#settled) return this.#settled
    this.#preparing ??= this.#prepare()
    return this.#preparing
  }

  async end(reason: SandboxEnd): Promise<void> {
    if (this.#preparing) await this.#preparing
    const head = this.#started === undefined ? undefined : await this.host.head()
    if (this.#running) await this.#destroy()
    if (this.#leased) await this.host.unlease()
    if (head) log("sandbox.destroy", { number: head.number, reason, seconds: this.seconds() })
    this.#started = undefined
    this.#leased = false
    this.#running = false
    this.#settled = undefined
    this.#preparing = undefined
  }

  async #prepare(): Promise<Settled> {
    this.#started = this.host.now()
    const head = await this.host.head()
    const settled = await this.#prepareSteps(head)
    this.#settled = settled
    this.#preparing = undefined
    return settled
  }

  async #prepareSteps(head: SandboxHead): Promise<Settled> {
    const ttlMs = this.budgetSeconds * 1000 + LEASE_GRACE_MS
    if (!(await this.host.lease(ttlMs))) {
      log("sandbox.unavailable", { number: head.number, reason: "lease" })
      return { kind: "unavailable", reason: "lease" }
    }
    this.#leased = true
    const sandbox = this.host.sandbox()
    const started = await this.#start(sandbox, head)
    if (started) return started
    const checkedOut = await this.#checkout(sandbox, head)
    if (checkedOut) return checkedOut
    return this.#install(sandbox, head)
  }

  async #start(sandbox: SandboxCalls, head: SandboxHead): Promise<Settled | undefined> {
    try {
      await sandbox.start(await this.host.token())
      this.#running = true
      return undefined
    } catch (cause) {
      return this.#failed(head, "start", errorText(cause))
    }
  }

  async #checkout(sandbox: SandboxCalls, head: SandboxHead): Promise<Settled | undefined> {
    const began = this.host.now()
    const outcome = await this.#run(sandbox, checkoutArgv(repositoryUrl(head.key), head.sha), "/workspace")
    const result = parseCheckout(outcome)
    if (result.kind === "failed") return this.#failed(head, "checkout", result.reason)
    log("sandbox.checkout", {
      number: head.number,
      sha: head.sha.slice(0, 7),
      kib: result.kib,
      ms: this.host.now() - began,
    })
    return undefined
  }

  async #install(sandbox: SandboxCalls, head: SandboxHead): Promise<Settled> {
    const began = this.host.now()
    const manager = parseManager(await this.#run(sandbox, detectArgv(), REPO_DIR))
    if (manager === "none") {
      log("sandbox.install", { number: head.number, manager, ms: this.host.now() - began })
      return { kind: "ready", sandbox, dir: REPO_DIR, manager }
    }
    const outcome = await this.#run(sandbox, installArgv(manager), REPO_DIR)
    const exitCode = outcome.outcome === "exited" ? outcome.exitCode : undefined
    log("sandbox.install", { number: head.number, manager, exitCode, ms: this.host.now() - began })
    if (exitCode !== 0)
      return this.#failed(head, "install", exitCode === undefined ? "install timed out" : lastLine(outcome))
    return { kind: "ready", sandbox, dir: REPO_DIR, manager }
  }

  async #run(sandbox: SandboxCalls, command: readonly string[], cwd: string): Promise<RunOutcome> {
    return sandbox.run(command, { cwd, timeoutMs: STEP_TIMEOUT_MS })
  }

  async #failed(head: SandboxHead, step: UnavailableReason, reason: string): Promise<Settled> {
    logError("sandbox.failed", { number: head.number, step, reason })
    if (this.#running) await this.#destroy()
    if (this.#leased) await this.host.unlease()
    this.#leased = false
    return { kind: "unavailable", reason: step }
  }

  async #destroy(): Promise<void> {
    try {
      await this.host.sandbox().destroy()
    } catch (cause) {
      logError("sandbox.destroy_failed", { error: errorText(cause) })
    }
    this.#running = false
  }
}

function lastLine(outcome: RunOutcome): string {
  const lines = outcome.tail.trim().split("\n")
  return lines[lines.length - 1] ?? ""
}
