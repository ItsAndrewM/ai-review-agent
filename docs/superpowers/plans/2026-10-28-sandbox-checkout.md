# Sandbox checkout, install, lifetime and lease (#132) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a review's first call for the sandbox, take a lease, start the container with a read-only token, check out the head and install; destroy it when the review ends; cap running sandboxes at three and a review's sandbox time at `MAX_SANDBOX_SECONDS`.

**Architecture:** `SandboxRuns` is the pull request object's view of its sandbox, modelled on `SnapshotRuns`: `access()` lazily prepares and memoises, `end()` destroys. Its decisions (budget, availability, the lease's grant and expiry, the checkout and install commands and their parsing) are pure modules with tests; the object supplies the stub, the token and the clock through an interface. `SandboxLeases` is one Durable Object that holds the lease map. The probe gains `prepare` so the live check drives the real path.

**Tech Stack:** TypeScript on Cloudflare Workers, Durable Objects (`ReviewSandbox` from #131, a new `SandboxLeases`), TypeBox, vitest, oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-10-28-sandbox-design.md`, section "Slice 2, #132".

## Global Constraints

- `CLAUDE.md`: no comments (a `wrangler.jsonc` comment is the one exception); no type assertions except `as const`; complexity at most 10; no `unknown`/`object` parameters or returns, no `typeof`, no `vi.mock` (fakes implement the real interface).
- `pnpm check` passes on every commit; `pnpm format` before committing.
- Repository directory `/workspace/repo`; checkout cap 512 MiB (524,288 KiB); checkout and install timeouts 300,000 ms each; `MAX_SANDBOX_SECONDS` default 900; at most 3 leases; lease ttl is the budget plus 120 s; the alarm interval is 60,000 ms.
- The sandbox token is `sandboxTokenScope(key)` from #131; the object's full token never reaches the sandbox.
- Every new log event and field is named in `docs/design.md`.

## Review Focus

- A second `access()` while the first is still preparing: one preparation, both callers get its result (Task 3 test).
- `end()` while a run is still in flight inside the container: destroy proceeds and the run's RPC rejects, the review's `finally` never throws (Task 3 test, `end` swallows and logs a destroy failure).
- A lease whose holder died: the expired entry is dropped on the next `acquire` (Task 1 test).
- A checkout whose `HEAD` isn't the requested sha, because the fetch resolved something else: the step fails and the sandbox is destroyed (Task 2 test on the script's check; Task 3 test on the failure path).
- A repository whose lockfile is `yarn.lock`: no install, logged as `manager: none`, checks still run (Task 2 test).

---

### Task 1: The lease, as a pure module and one object

**Files:**
- Create: `src/sandbox/lease.ts`, `src/sandbox/sandbox-leases.ts`
- Modify: `src/index.ts` (export), `wrangler.jsonc` (binding `SANDBOX_LEASES`, migration `v3`)
- Test: `test/sandbox-lease.test.ts`

**Interfaces:**
```ts
export const MAX_SANDBOXES = 3
export const LeaseState = Type.Record(Type.String(), Type.Integer())   // holder → expiresAt (ms)
export type LeaseState = Static<typeof LeaseState>
export function liveLeases(state: LeaseState, now: number): LeaseState  // drops entries with expiresAt <= now
export function acquire(state: LeaseState, holder: string, now: number, ttlMs: number): { state: LeaseState; granted: boolean }
export function release(state: LeaseState, holder: string): LeaseState
export class SandboxLeases extends DurableObject<Env> { acquire(holder: string, ttlMs: number): Promise<boolean>; release(holder: string): Promise<void> }
```
- `acquire`: a holder that already has a live lease is renewed and granted; otherwise granted only when the live count is under `MAX_SANDBOXES`. The object keeps the state under storage key `leases`, read through `Value.Check(LeaseState, …)` with `{}` for a missing or unreadable value, and logs `sandbox.lease` with `holder`, `granted` and `live`.

- [ ] **Step 1: Write the failing tests**: grants three distinct holders and refuses a fourth; renews a holder it already holds without counting it twice; drops an expired lease so a fourth holder gets its slot; `release` frees the slot and is a no-op for an unknown holder.
- [ ] **Step 2: Run** `pnpm vitest run test/sandbox-lease.test.ts` → FAIL, module missing.
- [ ] **Step 3: Implement** both files, the export, the binding and the migration.
- [ ] **Step 4: Run** `pnpm check` → PASS (`SANDBOX_LEASES` on `Env`).
- [ ] **Step 5: Commit** `Cap running sandboxes at three with a lease one object hands out`.

### Task 2: The checkout and install commands, as a pure module

**Files:**
- Create: `src/sandbox/checkout.ts`
- Test: `test/sandbox-checkout.test.ts`

**Interfaces:**
```ts
export const REPO_DIR = "/workspace/repo"
export const MAX_CHECKOUT_KIB = 524_288
export const STEP_TIMEOUT_MS = 300_000
export function repositoryUrl(key: PullRequestKey): string            // `https://github.com/${owner}/${repo}.git`
export function checkoutArgv(url: string, sha: string): string[]        // ["/bin/sh", "-c", CHECKOUT_SCRIPT, "andabot-checkout", url, sha]
export function parseCheckout(outcome: RunOutcome): { kind: "ok"; kib: number } | { kind: "failed"; reason: string }
export type Manager = "pnpm" | "npm" | "none"
export function detectArgv(): string[]                                  // prints pnpm | npm | none from the lockfiles in REPO_DIR
export function parseManager(outcome: RunOutcome): Manager
export function installArgv(manager: "pnpm" | "npm"): string[]          // pnpm: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]; npm: ["npm", "ci", "--ignore-scripts"]
```
- `CHECKOUT_SCRIPT` (`$1` url, `$2` sha): `rm -rf /workspace/repo && git init -q /workspace/repo && cd /workspace/repo && git fetch -q --depth 1 "$1" "$2" && git -c advice.detachedHead=false checkout -q FETCH_HEAD && [ "$(git rev-parse HEAD)" = "$2" ] || { echo "head is $(git rev-parse HEAD 2>/dev/null), not $2"; exit 1; }; echo "kib=$(du -sk /workspace/repo | cut -f1)"`. `parseCheckout`: `exited` 0 with a final `kib=N` line → `ok` with `kib`, over `MAX_CHECKOUT_KIB` → `failed` "checkout is N KiB, over the cap of 524288"; a timeout → `failed` "checkout timed out"; a non-zero exit → `failed` with the tail's last line.
- `DETECT_SCRIPT`: `cd /workspace/repo && if [ -f pnpm-lock.yaml ]; then echo pnpm; elif [ -f package-lock.json ]; then echo npm; else echo none; fi`. `parseManager`: the trimmed tail when it is `pnpm` or `npm`, else `none` (a timeout or non-zero exit is `none`).

- [ ] **Step 1: Write the failing tests**: the argv shapes; the script checks `HEAD` against the sha and prints `kib=`; `parseCheckout` ok, over cap, timeout, failed exit; `parseManager` for `pnpm`, `npm`, `none`, `yarn` (→ `none`), and a timeout; `installArgv` for both managers.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `Describe the sandbox checkout and install as commands the object runs`.

### Task 3: `SandboxRuns`, the budget and the setting

**Files:**
- Create: `src/sandbox/runs.ts`
- Modify: `src/repository/config.ts` (`reviews.sandbox: boolean`, default `true`), `docs/setup.md` section 6 row
- Test: `test/sandbox-runs.test.ts`, `test/config.test.ts` (the default and the schema)

**Interfaces:**
```ts
export const DEFAULT_SANDBOX_SECONDS = 900
export const LEASE_GRACE_MS = 120_000
export function sandboxBudgetOf(value: string | undefined): number     // positive safe integer, else the default
export function sandboxOn(value: string | undefined): boolean          // exactly "true"
export interface SandboxCalls { start(token: string | undefined): Promise<void>; run(command: readonly string[], options: RunOptions): Promise<RunOutcome>; destroy(): Promise<void> }
export interface SandboxHost {
  enabled(): Promise<boolean>                       // the var and the base's reviews.sandbox
  lease(ttlMs: number): Promise<boolean>
  unlease(): Promise<void>
  token(): Promise<string>
  sandbox(): SandboxCalls
  head(): Promise<{ number: number; key: PullRequestKey; sha: string }>
  now(): number
}
export type SandboxAccess =
  | { kind: "ready"; sandbox: SandboxCalls; dir: string; manager: Manager }
  | { kind: "off" } | { kind: "spent"; seconds: number; budget: number } | { kind: "unavailable"; reason: "lease" | "start" | "checkout" | "install" }
export class SandboxRuns {
  constructor(host: SandboxHost, budgetSeconds: number)
  access(): Promise<SandboxAccess>
  seconds(): number | undefined                    // wall seconds since the first call, undefined when never called
  end(reason: "review_end" | "closed"): Promise<void>
}
```
- `access`: `off` when `enabled()` is false; `spent` when `seconds() >= budget`; a memoised in-flight preparation so concurrent callers share it; preparation is lease → `start(token)` → checkout → install, each failure logged as `sandbox.failed` with `step` and `reason`, followed by `destroy` and `unlease`, and remembered as `unavailable` for the rest of the review; a lease refusal logs `sandbox.unavailable` with `reason: "lease"`. Success logs `sandbox.checkout` and `sandbox.install`. `end`: when a sandbox was started, `destroy` (a throw is logged as `sandbox.destroy_failed`, never rethrown), `unlease`, log `sandbox.destroy` with `number`, `reason` and `seconds`; then forget everything so the next review starts clean.

- [ ] **Step 1: Write the failing tests** with a fake `SandboxHost` whose `SandboxCalls` records calls and answers scripted outcomes: ready after lease, start, checkout and install in that order with the scoped token's text passed through; off; lease refused → unavailable and no start; checkout over the cap → destroy, unlease, unavailable, and the next call answers unavailable without a second attempt; two concurrent `access()` calls → one preparation; spent after the budget; `end` destroys, unleases and logs once, and a destroy that throws doesn't propagate; `end` with nothing started calls nothing; `sandboxBudgetOf` and `sandboxOn` edge values; config default `sandbox: true` and the schema refusing a config without it.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm check` → PASS.
- [ ] **Step 5: Commit** `Prepare a review's sandbox on its first call and destroy it when the review ends`.

### Task 4: Wire the object, the alarm and the vars

**Files:**
- Modify: `src/pull-request.ts` (`#sandbox`, the host methods, `end` in the review's `finally`, on `closed`, and `sandboxSeconds` in `review.done`), `src/sandbox/review-sandbox.ts` (the alarm), `wrangler.jsonc` (`SANDBOX`, `MAX_SANDBOX_SECONDS`), `docs/setup.md` (the two rows)
- Test: `pnpm check`; `test/sandbox-run.test.ts` gains nothing (the alarm is object code, read in review)

- `PullRequest`: `#sandbox = new SandboxRuns(host, sandboxBudgetOf(env.MAX_SANDBOX_SECONDS))` where the host's `enabled()` reads `sandboxOn(env.SANDBOX)` and the base config's `reviews.sandbox` through the existing config read; `lease` and `unlease` call `env.SANDBOX_LEASES.getByName("leases")` with the holder `objectName(key)`; `token()` mints with `sandboxTokenScope(key)`; `sandbox()` is `env.REVIEW_SANDBOX.getByName(objectName(key))`; `sandboxAccess()` is a public method for the probe. The review's `finally` calls `this.#sandbox.end("review_end")` after the snapshot's end; `closed` calls `end("closed")`.
- `ReviewSandbox`: `run` increments an in-flight count and sets an alarm 60 s out when none is set; `alarm()` reschedules while the count is positive and otherwise does nothing; `destroy` clears the count.
- `wrangler.jsonc` vars: `"SANDBOX": "false"` with a comment (off until #135's measurement sets the default), `"MAX_SANDBOX_SECONDS": "900"` with a comment.

- [ ] **Step 1: Make the changes.** **Step 2: Run** `pnpm check` → PASS. **Step 3: Commit** `Give the review its sandbox for the length of a run, and keep the container awake while it works`.

### Task 5: The probe's `prepare`, and the docs

**Files:**
- Modify: `src/sandbox/probe.ts` (`action: "prepare"` calls `env.PULL_REQUEST.getByName(objectName(key)).sandboxAccess()` and answers the access without the stub), `docs/design.md` (tier 3's paragraph, the events, `review.done`), `docs/setup.md` (the probe paragraph)
- Test: `test/sandbox-probe.test.ts` (`prepare` parses without a command)

- [ ] **Step 1: Write the failing test**, **Step 2: Run** → FAIL, **Step 3: Implement and document**, **Step 4: Run** `pnpm check` → PASS, **Step 5: Commit** `Let the probe prepare a sandbox through the pull request object, and record slice 2`.

### Task 6: Live check

Locally under `wrangler dev` with Docker and `.dev.vars` (`SANDBOX_PROBE=true`, `SANDBOX=true`), against PR #136's key:
1. `prepare`: expect `ready` with `manager: pnpm`; `sandbox.lease`, `sandbox.start`, `sandbox.checkout` (with `kib`) and `sandbox.install` in the log; record the checkout and install times on #132.
2. `prepare` again: expect `ready` at once, no second checkout.
3. `run` `["pnpm", "vitest", "run", "test/sandbox-lease.test.ts"]` with `cwd: "/workspace/repo"`: expect `exited 0`.
4. `destroy`.
The destroy-at-review-end path runs only where webhooks arrive, so it is covered by Task 3's tests and read in review; the first production deploy after merge shows it in Workers Logs.
