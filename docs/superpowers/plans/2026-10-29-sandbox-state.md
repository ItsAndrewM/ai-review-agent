# Sandbox state across a restart (#140) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the sandbox's lease, container, head, clock, settled answer and check runs in the pull request object's storage, so an object that restarts mid-review reuses the sandbox it has, tears down what it started, and still vouches for a finding's `check` reference.

**Architecture:** `src/sandbox/record.ts` is the stored shape (TypeBox) and the conversions to and from `CheckRun`. `SandboxRuns` owns the record: it restores once per instance before any call, saves at each step that changes what a teardown must undo, owns the check cache, asks the container whether it still runs, and schedules a drop job through the host. `PullRequest` answers the four new host calls from its storage and Lifecycle jobs, drops an idle sandbox wherever it releases a review's `pending`, refuses `run_check` with no review in flight, and the probe gains `end`.

**Tech Stack:** TypeScript on Cloudflare Workers, TypeBox, vitest, oxlint/oxfmt; `agents/lifecycle` jobs (`push` with a stable id, `cancel`); slices 2 to 4 of the sandbox.

**Spec:** `docs/superpowers/specs/2026-10-28-sandbox-design.md`, section "Slice 6, #140".

## Global Constraints

- `CLAUDE.md`: no comments; no type assertions except `as const`; complexity at most 10; no `unknown`/`object` parameters or returns, no `typeof`, no `vi.mock`; parse what crosses a boundary with a TypeBox schema and `Value.Check`.
- `pnpm check` passes on every commit; `pnpm format` before committing.
- Storage key `sandbox` on the pull request object. Job id and fn `sandbox.drop`, due at `started + budgetSeconds * 1000 + LEASE_GRACE_MS`. Refusal kind `ended`. Log events `sandbox.restored` (`number`, `sha`, `kind`, `checks`, `seconds`) and `sandbox.lost` (`number`, `sha`, `seconds`); `check.refused` reason `ended`.
- Every new log event and field is named in `docs/design.md`.
- The branch stacks on #145's branch (`feature/measure-the-sandbox-tier-…GH-135`), since both edit the sandbox paragraph of `docs/design.md`; the PR's base is that branch until #145 merges.

## Review Focus

- A `save` that throws mid-preparation: the review keeps its sandbox and only loses restart-safety; logged as `sandbox.save_failed`, never thrown (Task 2 test).
- A `load` that throws on restore: treated as no record, logged `sandbox.load_failed` (Task 2 test).
- A container that can't say whether it runs (`running()` throws): treated as lost, so the next access prepares afresh rather than every check throwing (Task 2 test).
- The drop job firing while a review is active on a live object: nothing happens, the review's own `end()` follows (Task 4 test).
- A stored record for a head the pull request has moved past, met first by `end()` rather than `access()`: destroyed and unleased all the same, since the container is the pull request's one container (Task 2 test).

---

### Task 1: The stored shape

**Files:** Create `src/sandbox/record.ts`; test `test/sandbox-record.test.ts`; modify `src/sandbox/checkout.ts` (`MANAGERS`), `src/sandbox/runs.ts` (`UnavailableReason` derives from the record module).

**Interfaces:**
```ts
// src/sandbox/checkout.ts
export const MANAGERS = ["pnpm", "npm", "none"] as const
export type Manager = (typeof MANAGERS)[number]
// src/sandbox/record.ts
export const UNAVAILABLE_REASONS = ["head", "lease", "start", "checkout", "install"] as const
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number]   // runs.ts re-exports its type from here
export const StoredCheck = Type.Union([
  Type.Object({ name, paths, outcome: Type.Literal("exited"), exitCode: Type.Integer(), ms, tail, cut: Type.Boolean() }),
  Type.Object({ name, paths, outcome: Type.Literal("timeout"), ms, tail, cut }),
])   // name is Type.Union(CHECK_NAMES.map(Type.Literal)), paths Type.Array(Type.String()), ms Type.Integer(), tail Type.String()
export type StoredCheck = Static<typeof StoredCheck>
export const SandboxRecord = Type.Object({
  head: Type.Object({ number: Type.Integer(), key: PullRequestKey, sha: Type.String() }),
  started: Type.Integer(),
  leased: Type.Boolean(),
  running: Type.Boolean(),
  settled: Type.Optional(Type.Union([
    Type.Object({ kind: Type.Literal("ready"), manager: Type.Union(MANAGERS.map(Type.Literal)) }),
    Type.Object({ kind: Type.Literal("unavailable"), reason: Type.Union(UNAVAILABLE_REASONS.map(Type.Literal)) }),
  ])),
  checks: Type.Array(StoredCheck),
})
export type SandboxRecord = Static<typeof SandboxRecord>
export function storedCheckOf(run: CheckRun): StoredCheck
export function checkRunOf(stored: StoredCheck): CheckRun
```
`CheckRun` and `CHECK_NAMES` come from `src/sandbox/checks.ts` (value import; `checks.ts` imports only types from `runs.ts`, so no value cycle).

- [ ] **Step 1: Failing tests** in `test/sandbox-record.test.ts`: `checkRunOf(storedCheckOf(run))` equals `run` for an exited run with a cut tail and for a timed-out run; `Value.Check(SandboxRecord, …)` accepts a ready record with one check and an unavailable record with none, and refuses a record with a settled kind it doesn't know, a check with an unknown name, and an exited check without an exit code.
- [ ] **Step 2: Run** `pnpm vitest run test/sandbox-record.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `record.ts`, `MANAGERS`, and move `UnavailableReason` (`runs.ts` keeps exporting the type: `export type { UnavailableReason } from "./record.ts"`).
- [ ] **Step 4: Run** `pnpm check` → PASS.
- [ ] **Step 5: Commit** `Define the sandbox record a restart restores from`.

### Task 2: Restore, lost container, teardown from the record

**Files:** Modify `src/sandbox/runs.ts`; test `test/sandbox-runs.test.ts`.

**Interfaces:**
```ts
export interface SandboxCalls { start; run; destroy; running(): Promise<boolean> }
export interface SandboxHost {
  …existing…
  load(): Promise<SandboxRecord | undefined>
  save(record: SandboxRecord | undefined): Promise<void>   // undefined deletes
  scheduleDrop(time: number): Promise<void>                 // Task 4 uses it; declare now, the fake records calls
  cancelDrop(): Promise<void>
}
export class SandboxRuns {
  async start(): Promise<void>           // was sync; restores, then (Task 3) clears the runs and saves
  async seconds(): Promise<number | undefined>   // restores first
  async status(): Promise<SandboxStatus>         // restores first
  // access, end, dropIdle restore first
}
```
Behaviour: `#restore()` runs once per instance (a flag), `await host.load()`; a thrown load logs `sandbox.load_failed` and counts as no record. A record becomes memory: head, `started`, `leased`, `running`, settled (`ready` gets `host.sandbox()` as its stub and `REPO_DIR`), checks (Task 3). A `ready` record whose `sandbox.running()` answers false or throws is lost: log `sandbox.lost` `{ number, sha, seconds }`, unlease if leased, clear `running`, `leased` and settled, keep head and `started`, save. Otherwise log `sandbox.restored` `{ number, sha, kind: "ready" | "unavailable" | "preparing", checks, seconds }` (`preparing` when no settled answer was stored). `#prepare` keeps an existing `#started` (`??=`). `#save()` writes the record whenever a head is in memory and swallows a throw as `sandbox.save_failed`; it runs after the head read, the lease, the start, the settled answer and in `#failed`. `#teardown` ends with `host.cancelDrop()` and `host.save(undefined)`. `FakeHost` gains `stored: SandboxRecord | undefined`, `saved: (SandboxRecord | undefined)[]`, `loadThrows`, `saveThrows`, `drops: number[]`, `cancels: number`; `FakeSandbox` gains `alive = true`, `runningThrows = false`, `running()`.

- [ ] **Step 1: Failing tests**, `describe("SandboxRuns after a restart")`: a ready record: `end("review_end")` on a fresh instance destroys and unleases, logs nothing new, saves `undefined` last; `dropIdle("closed")` does the same; `access()` answers `ready` with the fake's stub and no `start`, checkout or install call, `seconds()` counts from the stored `started`, and the lease list stays empty; a record for another head is torn down on `end()` (destroy and unlease) and, on `access()`, torn down first and the current head prepared; a record whose `alive` is false: `access()` unleases once, then leases, starts, checks out and installs, with `seconds()` still counted from the stored `started`; the same when `running()` throws; a record with no settled answer and `leased: true, running: true`: `end()` destroys and unleases; a thrown `load` answers as with no record; a thrown `save` leaves `access()` ready. Also in `describe("SandboxRuns.access")`: the saves during one preparation are, in order, head read (`leased: false, running: false`), leased, running, settled ready.
- [ ] **Step 2: Run** `pnpm vitest run test/sandbox-runs.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `runs.ts`; split `#restore` into `#adopt(record)` and `#lost(record)` to stay under the complexity cap.
- [ ] **Step 4: Run** `pnpm check` → PASS (the pull request object fails to typecheck until Task 5's host; if so, run `pnpm vitest run test/sandbox-runs.test.ts` and lint here and let Task 5 restore `pnpm check`; commit anyway only if lint and the sandbox tests pass).
- [ ] **Step 5: Commit** `Restore the sandbox from its record, and tear down what an earlier instance started`.

### Task 3: The check cache lives with the runs

**Files:** Modify `src/sandbox/runs.ts`; test `test/sandbox-runs.test.ts`.

**Interfaces:**
```ts
export class SandboxRuns {
  async checks(): Promise<ReadonlyMap<string, CheckRun>>   // keyed as checkKey(sha, name, paths); restores first
  async remember(key: string, run: CheckRun): Promise<void> // sets and saves
}
```
`start()` restores, clears the runs and saves (a record in memory is rewritten with `checks: []`). The record's `checks` are stored as `storedCheckOf(run)` and keyed on restore with `checkKey(record.head.sha, …)`.

- [ ] **Step 1: Failing tests**: `remember` then `checks()` answers the run and the last save carries it as a stored check; a fresh instance with a record holding one check answers it from `checks()` under `checkKey(sha, name, paths)` and `knownChecksOf` sees its exit code; `start()` on a fresh instance with a same-head ready record keeps the sandbox (`access()` makes no `start` call) and answers an empty `checks()`; `end()` leaves `checks()` empty.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the sandbox tests and lint → PASS. **Step 5: Commit** `Keep the review's check runs with the sandbox record`.

### Task 4: The drop job

**Files:** Modify `src/sandbox/runs.ts`; test `test/sandbox-runs.test.ts`.

`#prepare` calls `host.scheduleDrop(started + budgetSeconds * 1000 + LEASE_GRACE_MS)` right after it sets `started`; `#restore` calls it with the restored `started` for a ready or preparing record; `#teardown` calls `host.cancelDrop()` after the destroy and unlease. A thrown schedule or cancel is logged (`sandbox.drop_job_failed` with `step: "schedule" | "cancel"`) and never thrown.

- [ ] **Step 1: Failing tests**: a preparation schedules one drop at `clock + 900_000 + LEASE_GRACE_MS`; a restore of a ready record schedules at `record.started + …`; `end()` cancels once; `dropIdle("review_end")` with a review active (`start()` called) destroys nothing and cancels nothing; a thrown `scheduleDrop` leaves `access()` ready.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `Schedule a drop job so a dead review's sandbox ends at the lease's bound`.

### Task 5: The pull request object, the refusal and the probe

**Files:** Modify `src/pull-request.ts`, `src/sandbox/checks.ts`, `src/sandbox/probe.ts`; tests `test/sandbox-checks.test.ts`, `test/sandbox-probe.test.ts`.

**Interfaces:**
```ts
// checks.ts
export type CheckRefusal = … | { readonly kind: "ended" }
// refusalText: `No review is in flight for this pull request, so ${name} did not run.`
// probe.ts
const EndProbe = Type.Object({ key: PullRequestKey, action: Type.Literal("end") }, { additionalProperties: false })
// ProbeRequest gains it; dispatch: `case "end": return Response.json(await object.endSandbox(probe.key))`
// pull-request.ts
async endSandbox(key: PullRequestKey): Promise<{ ended: true }>   // puts the key, dropIdle("review_end")
const SANDBOX_DROP_JOB = "sandbox.drop"
```
In `PullRequest`: the host adds `load` (`Value.Check(SandboxRecord, await this.ctx.storage.get("sandbox"))`), `save` (`put` or `delete("sandbox")`), `scheduleDrop` (`lifecycle.jobs.push({ id: SANDBOX_DROP_JOB, fn: SANDBOX_DROP_JOB, time })`), `cancelDrop` (`lifecycle.jobs.cancel(SANDBOX_DROP_JOB)`); `onJob` dispatches `SANDBOX_DROP_JOB` to `this.#sandbox.dropIdle("review_end")` before the recheck check. `#checks` and `#checks.clear()` go: `runCheck` and `#cachedCheck` read `await this.#sandbox.checks()`, `#runCheckNow` calls `remember`, `#checksDisplay` and `checkSubmission` and the `review.done` `checks` count read `checks()`, `runReview` awaits `start()`, the two `seconds()` reads and the `status()` read await. `runCheck(args)` (the tool) refuses `ended` when `await this.readPending()` is undefined, then calls a new `#check(args)` that holds today's body; `probeCheck` calls `#check` directly. `endOwnRun` and `releasePending` call `dropIdle("review_end")` after their delete; `clearFlight` calls `dropIdle("new_head")` after its delete when `decision.because === "superseded"`.

- [ ] **Step 1: Failing tests**: `refusalText("test", { kind: "ended" })` contains "No review is in flight"; `parseProbe` accepts `{ key, action: "end" }` and refuses it with an extra field.
- [ ] **Step 2: Run** `pnpm vitest run test/sandbox-checks.test.ts test/sandbox-probe.test.ts` → FAIL.
- [ ] **Step 3: Implement** the three files as above.
- [ ] **Step 4: Run** `pnpm check` → PASS.
- [ ] **Step 5: Commit** `Drop an idle sandbox wherever a review's pending is released, refuse run_check with no review in flight, and let the probe end one`.

### Task 6: Docs

**Files:** Modify `docs/design.md` (execution tier 3: the record, the restore, the lost container, the drop job's bound, the `ended` refusal, the three new events and the `check.refused` reason; the #135 sentence "until #140 persists the sandbox's state" becomes the new bound), `docs/setup.md` (the probe's `end` action beside `prepare` and `check`; the cost paragraph's $0.037 backstop sentence becomes the lease bound, with the inactivity timeout as the last resort).

- [ ] **Step 1: Edit** both. **Step 2: Run** `pnpm check` → PASS. **Step 3: Commit** `Describe the sandbox record, the drop job and the probe's end action`.

### Task 7: Live check

Locally, as #132 and #133 were checked (memory `phase-3-sandbox-issues`): Docker up, `.dev.vars` plus `SANDBOX_PROBE=true` and `SANDBOX=true`, `wrangler dev` with `CLOUDFLARE_ACCOUNT_ID=d480022c72607e9e5b9317904332ca44`, probe bodies in files, key = a real pull request of this repository (installation 172433025).

- [ ] **Step 1:** `prepare` → `sandbox.start` (`started: true`), `sandbox.checkout`, `sandbox.install`, the saves.
- [ ] **Step 2:** wait for the object's eviction (or send a request after a pause) and `check` → `sandbox.restored` with `kind: ready`, no second `sandbox.start`/checkout/install, one `check.run`.
- [ ] **Step 3:** `end` → one `sandbox.destroy`, the lease released; a second `end` does nothing.
- [ ] **Step 4:** `prepare`, stop and restart `wrangler dev`, `check` → `sandbox.lost`, then a fresh preparation; `end`.
- [ ] **Step 5:** Post the events and timings as a comment on #140.
