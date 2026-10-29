import { log, logError, errorText } from "../log.ts"
import type { PullRequestKey } from "../records.ts"
import {
  checkoutArgv,
  detectArgv,
  installArgv,
  lastLine,
  overcommitArgv,
  parseCheckout,
  parseManager,
  REPO_DIR,
  repositoryUrl,
  STEP_TIMEOUT_MS,
  type Manager,
} from "./checkout.ts"
import { checkKey, type CheckRun } from "./checks.ts"
import { checkRunOf, storedCheckOf, type SandboxRecord, type UnavailableReason } from "./record.ts"
import type { RunOptions, RunOutcome } from "./run.ts"

export type { UnavailableReason } from "./record.ts"

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
  running(): Promise<boolean>
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
  load(): Promise<SandboxRecord | undefined>
  save(record: SandboxRecord | undefined): Promise<void>
  scheduleDrop(time: number): Promise<void>
  cancelDrop(): Promise<void>
}

export type SandboxAccess =
  | { readonly kind: "ready"; readonly sandbox: SandboxCalls; readonly dir: string; readonly manager: Manager }
  | { readonly kind: "off" }
  | { readonly kind: "spent"; readonly seconds: number; readonly budget: number }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason }

export type SandboxEnd = "review_end" | "closed" | "new_head"

export type SandboxStatus =
  | { readonly kind: "none" }
  | { readonly kind: "off" }
  | { readonly kind: "ready" }
  | { readonly kind: "spent" }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason }

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
  #restoring: Promise<void> | undefined
  #started: number | undefined
  #head: SandboxHead | undefined
  #leased = false
  #running = false
  #spentLogged = false
  #answeredOff = false
  #settled: Settled | undefined
  #preparing: Promise<Settled> | undefined
  #checks = new Map<string, CheckRun>()

  constructor(
    private readonly host: SandboxHost,
    private readonly budgetSeconds: number,
  ) {}

  async start(): Promise<void> {
    await this.#restore()
    this.#active += 1
    this.#checks.clear()
    await this.#save()
  }

  async checks(): Promise<ReadonlyMap<string, CheckRun>> {
    await this.#restore()
    return this.#checks
  }

  async remember(key: string, run: CheckRun): Promise<void> {
    await this.#restore()
    this.#checks.set(key, run)
    await this.#save()
  }

  async seconds(): Promise<number | undefined> {
    await this.#restore()
    return this.#seconds()
  }

  async access(): Promise<SandboxAccess> {
    await this.#restore()
    await this.#forgetOtherHead()
    const spent = this.#spent()
    if (spent) return spent
    if (this.#settled) return this.#settled
    if (this.#preparing) return this.#preparing
    if (!(await this.host.enabled())) {
      this.#answeredOff = true
      return { kind: "off" }
    }
    this.#preparing ??= this.#prepare()
    return this.#preparing
  }

  async status(): Promise<SandboxStatus> {
    await this.#restore()
    if (this.#spentLogged) return { kind: "spent" }
    if (this.#settled?.kind === "unavailable") return { kind: "unavailable", reason: this.#settled.reason }
    if (this.#settled?.kind === "ready") return { kind: "ready" }
    if (this.#answeredOff) return { kind: "off" }
    return { kind: "none" }
  }

  async end(reason: SandboxEnd): Promise<void> {
    await this.#restore()
    this.#active = Math.max(0, this.#active - 1)
    if (this.#active === 0) await this.#teardown(reason)
  }

  async dropIdle(reason: SandboxEnd): Promise<boolean> {
    await this.#restore()
    if (this.#active > 0) return true
    await this.#teardown(reason)
    return false
  }

  #seconds(): number | undefined {
    return this.#started === undefined ? undefined : Math.floor((this.host.now() - this.#started) / 1000)
  }

  #restore(): Promise<void> {
    this.#restoring ??= this.#restoreOnce()
    return this.#restoring
  }

  async #restoreOnce(): Promise<void> {
    const record = await this.#load()
    if (record === undefined) return
    this.#adopt(record)
    if (record.settled?.kind !== "unavailable") await this.#scheduleDrop()
    if (record.settled?.kind === "ready") return this.#reattach(record)
    this.#logRestored(record.settled === undefined ? "preparing" : "unavailable")
  }

  #adopt(record: SandboxRecord): void {
    this.#head = record.head
    this.#started = record.started
    this.#leased = record.leased
    this.#running = record.running
    if (record.settled?.kind === "unavailable") this.#settled = { kind: "unavailable", reason: record.settled.reason }
    for (const stored of record.checks) {
      const run = checkRunOf(stored)
      this.#checks.set(checkKey(record.head.sha, run.name, run.paths), run)
    }
  }

  async #reattach(record: SandboxRecord): Promise<void> {
    const sandbox = await this.#reachable()
    if (sandbox === undefined) return this.#lost()
    const manager = record.settled?.kind === "ready" ? record.settled.manager : "none"
    this.#settled = { kind: "ready", sandbox, dir: REPO_DIR, manager }
    this.#logRestored("ready")
  }

  async #reachable(): Promise<SandboxCalls | undefined> {
    try {
      const sandbox = await this.host.sandbox()
      return (await sandbox.running()) ? sandbox : undefined
    } catch {
      return undefined
    }
  }

  async #lost(): Promise<void> {
    log("sandbox.lost", { number: this.#head?.number, sha: this.#shortSha(), seconds: this.#seconds() })
    if (this.#leased) await this.#unlease()
    this.#running = false
    this.#settled = undefined
    await this.#save()
  }

  #logRestored(kind: "ready" | "unavailable" | "preparing"): void {
    log("sandbox.restored", {
      number: this.#head?.number,
      sha: this.#shortSha(),
      kind,
      checks: this.#checks.size,
      seconds: this.#seconds(),
    })
  }

  #shortSha(): string | undefined {
    return this.#head?.sha.slice(0, 7)
  }

  async #load(): Promise<SandboxRecord | undefined> {
    try {
      return await this.host.load()
    } catch (cause) {
      logError("sandbox.load_failed", { error: errorText(cause) })
      return undefined
    }
  }

  async #save(): Promise<void> {
    if (this.#head === undefined) return
    const record: SandboxRecord = {
      head: this.#head,
      started: this.#started ?? this.host.now(),
      leased: this.#leased,
      running: this.#running,
      checks: [...this.#checks.values()].map(storedCheckOf),
    }
    const settled = this.#settledRecord()
    if (settled !== undefined) record.settled = settled
    await this.#persist(record)
  }

  #settledRecord(): SandboxRecord["settled"] {
    if (this.#settled === undefined) return undefined
    return this.#settled.kind === "ready"
      ? { kind: "ready", manager: this.#settled.manager }
      : { kind: "unavailable", reason: this.#settled.reason }
  }

  async #scheduleDrop(): Promise<void> {
    const started = this.#started ?? this.host.now()
    try {
      await this.host.scheduleDrop(started + this.budgetSeconds * 1000 + LEASE_GRACE_MS)
    } catch (cause) {
      logError("sandbox.drop_job_failed", { number: this.#head?.number, step: "schedule", error: errorText(cause) })
    }
  }

  async #cancelDrop(): Promise<void> {
    try {
      await this.host.cancelDrop()
    } catch (cause) {
      logError("sandbox.drop_job_failed", { number: this.#head?.number, step: "cancel", error: errorText(cause) })
    }
  }

  async #persist(record: SandboxRecord | undefined): Promise<void> {
    try {
      await this.host.save(record)
    } catch (cause) {
      logError("sandbox.save_failed", { number: this.#head?.number, error: errorText(cause) })
    }
  }

  #spent(): SandboxAccess | undefined {
    const seconds = this.#seconds()
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
    if (head && destroyed) log("sandbox.destroy", { number: head.number, reason, seconds: this.#seconds() })
    if (head) await this.#cancelDrop()
    this.#started = undefined
    this.#head = undefined
    this.#spentLogged = false
    this.#answeredOff = false
    this.#settled = undefined
    this.#preparing = undefined
    this.#checks.clear()
    if (head) await this.#persist(undefined)
  }

  async #prepare(): Promise<Settled> {
    this.#started ??= this.host.now()
    await this.#scheduleDrop()
    let step: UnavailableReason = "head"
    try {
      const head = await this.host.head()
      this.#head = head
      await this.#save()
      step = "lease"
      if (!(await this.host.lease(this.budgetSeconds * 1000 + LEASE_GRACE_MS))) {
        throw new StepFailure("lease", "no lease free")
      }
      this.#leased = true
      await this.#save()
      const sandbox = await this.host.sandbox()
      step = "start"
      await sandbox.start(await this.host.token())
      this.#running = true
      await this.#save()
      await this.#allowOvercommit(sandbox, head)
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

  async #allowOvercommit(sandbox: SandboxCalls, head: SandboxHead): Promise<void> {
    try {
      const outcome = await this.#run(sandbox, overcommitArgv(), "/workspace")
      const exitCode = outcome.outcome === "exited" ? outcome.exitCode : undefined
      log("sandbox.overcommit", {
        number: head.number,
        exitCode,
        reason: exitCode === 0 ? undefined : lastLine(outcome.tail),
      })
    } catch (cause) {
      logError("sandbox.overcommit", { number: head.number, error: errorText(cause) })
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

  async #ready(sandbox: SandboxCalls, manager: Manager): Promise<Settled> {
    const settled: Settled = { kind: "ready", sandbox, dir: REPO_DIR, manager }
    this.#settled = settled
    await this.#save()
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
    await this.#save()
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
