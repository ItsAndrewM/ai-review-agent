# Transient GitHub errors retry the delivery (#118) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A delivery whose handling fails on a transient GitHub error (5xx, Cloudflare's 52x, a network failure) is replayed from storage on a 30 s, 2 min, 10 min ladder, a retried review resumes under its own in-progress check run, and when the ladder is spent the author sees a failed check run or a reply instead of silence.

**Architecture:** `src/github/errors.ts` types the client's failures (`GitHubError` with the status, `TransientFailure`, `isTransient`, `softenUnlessTransient`). `src/review/delivery.ts` is the door: the ladder, the keys, and `Deliveries`, a class with a host interface (storage, jobs, clock) that `PullRequest` implements, as `SandboxRuns` does. `flight.ts` gains `resume`; the review's catch keeps the `pending` on a transient throw; five swallow points use the helper; `onJob` dispatches `event.retry`; abandon completes or creates the check run, or replies.

**Tech Stack:** TypeScript on Cloudflare Workers, TypeBox, vitest, oxlint/oxfmt; `agents/lifecycle` jobs (`push` with a stable id, `cancel`).

**Spec:** `docs/superpowers/specs/2026-10-29-reviews-that-hold-up-design.md`, "Slice 1, #118".

## Global Constraints

- `CLAUDE.md`: no comments; no type assertions except `as const`; complexity at most 10; no `unknown`/`object` parameters or returns (a caught error's `cause` as `unknown` is allowed only into `errorText`), no `typeof`, no `vi.mock`; parse what crosses a boundary with TypeBox.
- `pnpm check` passes on every commit; `pnpm format` before committing.
- Ladder `RETRY_DELAYS_MS = [30_000, 120_000, 600_000]`; storage key `delivery:<id>:<kind>`; job fn and id `event.retry` / `event.retry:<id>:<kind>`; payload `{ delivery, kind, attempt }`; transient = `GitHubError` with status 500 to 599 or no status, or a `TransientFailure`.
- Log events: `event.failed` gains `transient` and `attempt`; new `event.retry` (`delivery`, `kind`, `attempt`, `inMs`, `error`) and `event.abandoned` (`delivery`, `kind`, `attempts`, `error`). Every new event and field is named in `docs/design.md`.
- Abandon texts: review check run "GitHub was unreachable for <minutes> minutes (<error>); comment `@andabot review` to retry."; comment reply "I couldn't act on this: GitHub was unreachable for <minutes> minutes (<error>). Say it again and I'll try again."

## Review Focus

- A stored incoming that no longer parses (a build changed the shape): the retry logs `event.abandoned` with `error: "stored delivery unreadable"` and forgets it, never throws (Task 2 test).
- The retry job firing while the delivery's first attempt is still running (a slow review): `decideFlight` answers `skip` because the harness lists the operation, and the retry completes without scheduling another rung (Task 3 test).
- A transient throw after the review posted (inside `evaluateApproval` after publish): `evaluateApproval` keeps its catch, so the posted review's check run is never failed by it (Task 5, read in review; the catch is unchanged).
- A comment that was answered, then the reply's own `createIssueComment` got a 522: the retry re-runs the whole handler, the model answers again and posts once; the first answer never reached GitHub (Task 2, read in review; the handler's last step is the post).
- Abandon's own writes failing (a 522 on the final check-run update): logged as `event.abandon_failed`, never thrown (Task 6 test on the pure decision, read in review for the wiring).

---

### Task 1: Typed GitHub errors and the transient rule

**Files:** Create `src/github/errors.ts`; test `test/github-errors.test.ts`; modify `src/github/client.ts` (`error()` and the GraphQL/tarball throws, `request()` wraps a rejected fetch), `src/github/app-auth.ts` (`fetchInstallationToken`), `test/client.test.ts`, `test/app-auth.test.ts`.

**Interfaces:**
```ts
export class GitHubError extends Error { constructor(message: string, readonly status: number | undefined, readonly path: string) }
export class TransientFailure extends Error {}        // thrown by the host when it classified a failure itself
export function isTransient(error: Error): boolean    // GitHubError with status undefined or 500..599, or TransientFailure
export function softenUnlessTransient(error: Error): void   // throws `error` back when transient, returns otherwise
```
The client: `error(response)` and the GraphQL `errors` and tarball throws become `GitHubError` with the status (GraphQL `errors` in a 200 body get status undefined? No: a 200 with `errors` is final, give it status 200); `request()` catches a rejected `fetchImpl` and throws `GitHubError(message, undefined, path)`. `fetchInstallationToken` throws `GitHubError(…, response.status, "/app/installations/…/access_tokens")` and wraps its rejected fetch the same way.

- [ ] **Step 1: Failing tests**: `isTransient` is true for status 500, 502, 522, 525 and undefined, false for 404, 422, 200 and a plain `Error`; `softenUnlessTransient` rethrows a 522 and returns on a 404; a client `getPullRequest` against a fetch answering 522 rejects with a `GitHubError` whose `status` is 522 and `path` the request path; a fetch that rejects gives status undefined; a GraphQL body with `errors` gives status 200; `fetchInstallationToken` on a 525 rejects with `GitHubError` status 525.
- [ ] **Step 2: Run** `pnpm vitest run test/github-errors.test.ts test/client.test.ts test/app-auth.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm check` → PASS.
- [ ] **Step 5: Commit** `Type the client's failures, and say which are transient`.

### Task 2: The door

**Files:** Create `src/review/delivery.ts`; test `test/delivery.test.ts`.

**Interfaces:**
```ts
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const
export function retryDelay(attempt: number): number | undefined     // attempt 0 → 30_000, 1 → 120_000, 2 → 600_000, 3 → undefined
export const RetryJob = Type.Object({ delivery: Type.String(), kind: Type.String(), attempt: Type.Integer() })
export type RetryJob = Static<typeof RetryJob>
export const RETRY_JOB = "event.retry"
export function deliveryKey(delivery: string, kind: string): string    // `delivery:${delivery}:${kind}`
export function retryJobId(delivery: string, kind: string): string     // `event.retry:${delivery}:${kind}`
export const StoredIncoming = <TypeBox union of the five Incoming shapes>   // moves `Incoming` to a schema; `Incoming = Static<typeof StoredIncoming>`
export interface DeliveryHost {
  store(key: string, incoming: Incoming): Promise<void>
  load(key: string): Promise<Incoming | undefined>       // Value.Check(StoredIncoming) in the object
  forget(key: string): Promise<void>
  schedule(id: string, time: number, payload: RetryJob): Promise<void>
  now(): number
}
export type Abandon = (incoming: Incoming, error: Error, attempts: number, sinceMs: number) => Promise<void>
export class Deliveries {
  constructor(host: DeliveryHost)
  accept(incoming: Incoming, handle: (incoming: Incoming) => Promise<void>): Promise<void>   // store, handle, forget; on a transient throw schedule attempt 0's rung and log event.failed { transient: true, attempt: 0 }; on a final throw log event.failed { transient: false, attempt: 0 } and forget; never throws
  retry(job: RetryJob, handle: …, abandon: Abandon): Promise<void>   // load (unreadable → event.abandoned, forget), log event.retry, handle, forget; transient throw → next rung or abandon(…) then forget; final throw → event.failed, forget; never throws
}
```
`sinceMs` for the abandon text is the time since the first attempt, kept in the stored record (`{ incoming, firstAt }` under the key, so the schema stored is `StoredDelivery = { incoming: StoredIncoming, firstAt: Integer }`).

- [ ] **Step 1: Failing tests** with a fake host recording stores, forgets and schedules: the ladder values; `accept` with a handler that resolves stores then forgets and schedules nothing; a handler throwing a 522 leaves the record and schedules `event.retry:<id>:<kind>` at `now + 30_000` with attempt 0; a handler throwing a 404 forgets and schedules nothing; `retry` at attempt 0 replays the stored incoming and forgets on success; at attempt 0 with a 522 schedules attempt 1 at `now + 120_000`; at attempt 2 with a 522 calls `abandon` with attempts 3 and the ms since `firstAt`, then forgets; a record that doesn't parse abandons nothing, logs and forgets; a `reaction` and a `review` of one delivery keep separate records.
- [ ] **Step 2: Run** `pnpm vitest run test/delivery.test.ts` → FAIL.
- [ ] **Step 3: Implement**; the `Incoming` type in `pull-request.ts` becomes the re-export of the schema's static type.
- [ ] **Step 4: Run** `pnpm check` → PASS.
- [ ] **Step 5: Commit** `Add the door: a transient failure stores the delivery and schedules its retry`.

### Task 3: Resuming a review

**Files:** Modify `src/review/flight.ts`; test `test/flight.test.ts`.

**Interfaces:**
```ts
export type FlightDecision = { kind: "start" } | { kind: "skip" } | { kind: "resume"; previous: PendingReview } | { kind: "replace"; … }
export function decideFlight(pending, headSha, liveness, deliveryId: string): FlightDecision
// same head, pending.deliveryId === deliveryId: running → skip; not running → resume (whatever the grace)
// other delivery: as today
export function afterReviewThrow(error: Error): "keep" | "release"   // transient → keep (pending and check run stay), else release
```

- [ ] **Step 1: Failing tests**: `resume` for the same delivery when the harness lists nothing, inside and outside the grace; `skip` for the same delivery while running; the existing answers unchanged for another delivery; `afterReviewThrow` keeps on a 522 and releases on a 404 and a plain `Error`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm check` → PASS (the object's call site passes the delivery id). **Step 5: Commit** `Let a retried review resume its own pending`.

### Task 4: The object: door, resume, abandon

**Files:** Modify `src/pull-request.ts`; the wiring is read in review (no object-level tests exist).

In `PullRequest`: `#deliveries = new Deliveries(this.#deliveryHost())` with `store`/`load`/`forget` over `ctx.storage` and `schedule` over `lifecycle.jobs.push({ id, fn: RETRY_JOB, time, payload })`. `accept` becomes `await this.ctx.storage.put("key", incoming.key); this.ctx.waitUntil(this.#deliveries.accept(incoming, (i) => this.handle(i, version)))`. `onJob`: `if (job.fn === RETRY_JOB && Value.Check(RetryJob, job.payload)) return this.#deliveries.retry(job.payload, (i) => this.handle(i), (i, error, attempts, sinceMs) => this.#abandon(i, error, attempts, sinceMs))`. `review()`: `clearFlight(pr.head.sha, incoming.deliveryId)`; on `resume` skip the `pending` write and build `run` from `previous` (`operationId`, `deliveryId`, `started`, `checkRunId: previous.checkRunId`); `ReviewRun` gains `checkRunId?: number` and `openRun` skips `startCheckRun` when it is set. `runReview`'s catch: `if (afterReviewThrow(error) === "release") await this.endOwnRun(…failedRun…)`, then rethrow either way. `#abandon`: for `review`, `pendingFor(delivery)` → complete its `checkRunId` as `failedRun(text)` or, with none, `createCheckRun` then complete, and `endOwnRun`; for `comment`, `respond(github, key, incoming, text)`; every kind logs through `Deliveries` already; a throw inside abandon is caught and logged `event.abandon_failed`. Texts per Global Constraints, minutes = `Math.round(sinceMs / 60_000)`.

- [ ] **Step 1: Implement** as above. **Step 2: Run** `pnpm check` → PASS. **Step 3: Commit** `Retry a delivery at the object's door, resume a retried review, and say when the ladder is spent`.

### Task 5: The swallow points and the approval

**Files:** Modify `src/pull-request.ts` (`threadFor`, `latestHeadSha`, `compareSince`, `threadPlan`, `resolveScope`, `evaluateApproval`, `evaluateWithRecheck`, `handle`'s approval branch), `src/review/approval.ts` (`ApprovalOutcome` failed gains `transient: boolean`); tests `test/approval.test.ts` for the pure rule.

**Interfaces:**
```ts
// approval.ts
export type ApprovalOutcome = … | { kind: "failed"; transient: boolean }
export function retriesAtDoor(outcome: ApprovalOutcome, recheck: Recheck | undefined): boolean   // failed && transient && recheck === undefined
```
Each of the five catches calls `softenUnlessTransient(error)` first, then keeps its logging and soft answer. `evaluateApproval`'s catch answers `{ kind: "failed", transient: isTransient(error) }`. `evaluateWithRecheck` returns `{ outcome, recheck }`; `handle`'s approval branch throws `new TransientFailure("approval: …")` when `retriesAtDoor` says so.

- [ ] **Step 1: Failing test**: `retriesAtDoor` true for a transient failure with no recheck, false with a recheck, false for a final failure and for a wait.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm check` → PASS. **Step 5: Commit** `Let a transient read reach the door instead of a soft answer`.

### Task 6: Docs

**Files:** `docs/design.md` (the router/object section where `accept` and `event.failed` are described, the Phases list: phase 4 becomes "Reviews that hold up" with the milestone's issues and slice 1 marked shipped, the old extras folded in; the new events), `docs/setup.md` if it names `event.failed`.

- [ ] **Step 1: Edit.** **Step 2: Run** `pnpm check` → PASS. **Step 3: Commit** `Describe the delivery retry and reframe phase 4`.

### Task 7: Live evidence

No seam makes GitHub answer 522 on demand (spec, builder's call). After the deploy: confirm a normal review and a comment leave no `delivery:` record behind (a probe-free check: the next review's logs show no `event.retry`; the storage key count is visible through the local explorer in `wrangler dev`), and note on #118 that the ladder's first live firing will be read in `event.retry` and `event.abandoned` at GitHub's next outage.

- [ ] **Step 1:** local `wrangler dev` review of a fixture through a webhook replay is out of reach; run the full suite, deploy, watch the next real review's logs for `event.failed`, and comment on #118.
