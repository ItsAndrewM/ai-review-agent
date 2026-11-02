# Daily Spend Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once a deploy's model spend for the UTC day reaches `MAX_DAILY_NEURONS`, new reviews and questions stop until midnight, with a neutral check run, a summary line and log events, and the sweep reviews the skipped heads after midnight.

**Architecture:** A `DailySpend` Durable Object per UTC day holds settled spend and per-review reservations; its arithmetic is pure functions in `src/budget/ledger.ts`. `src/budget/daily.ts` wraps the object in a fail-open client the `PullRequest` object calls: `reserve` before a review starts, `settle` at every exit that ends a run, `room`/`add` around a question.

**Tech Stack:** TypeScript, Cloudflare Workers (Durable Objects, alarms), TypeBox, vitest, oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-11-01-hardening-design.md`, section "Slice 2, #186".

## Global Constraints

- `MAX_DAILY_NEURONS` default `"200000"` in `wrangler.jsonc` vars, production and `env.staging` alike; anything but a positive whole number falls back to `200000`.
- Reservation per review: `min(reviewBudgetOf(MAX_REVIEW_NEURONS), dailyBudgetOf(MAX_DAILY_NEURONS))`. Refused when `spent + reserved + neurons > cap`. A question is refused when `spent + reserved >= cap`.
- Day key: UTC `YYYY-MM-DD` of `Date.now()`; object name is that key. Storage deleted by an alarm 8 days after first write.
- Holder: `<owner>/<repo>#<number>:<deliveryId>`.
- Warning at 80%: `spent + reserved >= 0.8 × cap`, logged once a day.
- Check run: conclusion `neutral`, title `Daily review budget spent`, summary "This deploy's daily model budget is spent. `<short sha>` is reviewed after midnight UTC, or comment `@<login> review` then."
- Summary line, exact: "⏳ Today's review budget is spent: `<short sha>` is reviewed after midnight UTC. <!-- <login>:budget -->"
- Tagged-review reply: "Today's review budget is spent, so I can't review `<short sha>` until midnight UTC."
- Question reply: "Today's review budget is spent, so I can't answer until midnight UTC."
- Logs: `review.skip` reason `daily_budget` (`number`, `head`, `day`, `spent`, `reserved`, `cap`); `answer.skip` reason `daily_budget`; `budget.daily_warning`, `budget.daily_spent` (`day`, `spent`, `reserved`, `cap`); `budget.settled` (`holder`, `neurons`, `sandboxSeconds`, `spent`); `budget.ledger_unreadable` error (`when`: `reserve` | `settle` | `room` | `add`, `error`).
- Fail open: a ledger call that throws logs `budget.ledger_unreadable` and lets the review or question run.
- Lint: no comments of any kind, no assertions but `as const`, complexity ≤ 10, anti-slop rules, no `vi.mock`. Parse stored JSON with TypeBox and `Value.Check`.

## Review Focus

- A review that crosses midnight UTC must settle into the day it started, not the day it ended. Pinned in Task 2 (the client settles to `ledger.day`).
- `#118`'s retry or a resume of the same delivery must not reserve twice. Pinned in Task 1 (repeat reserve) and wired in Task 4.
- A settings skip (draft, path filters, already reviewed) must never touch the ledger, so a draft PR pushed all day spends no ledger call. Wired in Task 4 by placement after `settingsSkip`; the reviewer checks the order.
- The sweep re-handing a budget-skipped head every 15 minutes must create one check run and one summary edit per head per day, not one per sweep. Pinned in Task 3 (`budgetSkipShown`).
- A cap smaller than `MAX_REVIEW_NEURONS` must still let one review start (reservation is the min of the two). Pinned in Task 1.

---

### Task 1: Ledger arithmetic

**Files:**
- Create: `src/budget/ledger.ts`
- Test: `test/daily-ledger.test.ts`

**Interfaces:**
- Produces:
  - `export const DEFAULT_DAILY_NEURONS = 200_000`
  - `export function dailyBudgetOf(value: string | undefined): number`
  - `export function reservationOf(reviewBudget: number, dailyBudget: number): number` (the min)
  - `export function utcDay(ms: number): string`
  - `export const DayLedger` (TypeBox): `{ spent: number, sandboxSeconds: number, reservations: Record<string, number>, warned: boolean, refused: boolean }`; `export const EMPTY_DAY: DayLedger`
  - `export function reserveIn(day: DayLedger, holder: string, neurons: number, cap: number): { granted: boolean; day: DayLedger }`
  - `export function settleIn(day: DayLedger, holder: string, neurons: number, sandboxSeconds: number): DayLedger`
  - `export function roomIn(day: DayLedger, cap: number): boolean`
  - `export function addIn(day: DayLedger, neurons: number): DayLedger`
  - `export function reservedOf(day: DayLedger): number`
  - `export function crossings(before: DayLedger, after: DayLedger, cap: number, refusedNow: boolean): { warn: boolean; refuse: boolean; day: DayLedger }`: `warn` true the first time `spent + reserved >= 0.8 × cap` (sets `warned`), `refuse` true the first refusal of the day (sets `refused`).

- [ ] **Step 1: Write the failing tests:**
  - `dailyBudgetOf` gives `200000` for `undefined`, `""`, `"0"`, `"-5"`, `"1.5"`, `"abc"`, and `5000` for `"5000"`.
  - `reservationOf(10_000, 200_000)` is `10_000`; `reservationOf(10_000, 4_000)` is `4_000`.
  - `utcDay(Date.UTC(2026, 10, 1, 23, 59, 59, 999))` is `"2026-11-01"`, and one ms later is `"2026-11-02"`.
  - `reserveIn` with cap 25,000 grants two 10,000 reservations and refuses a third, leaving the day unchanged on refusal; exactly reaching the cap is granted.
  - Reserving the same holder twice is granted and counts once.
  - `settleIn` on a held reservation drops it and adds 2,014 to `spent` and 120 to `sandboxSeconds`; on an unknown holder it still adds the spend.
  - `roomIn` is true at `spent + reserved = cap - 1`, false at `= cap`.
  - `crossings`: warns once when crossing 80% (a second crossing that day doesn't warn), refuses once (a second refusal doesn't log).
- [ ] **Step 2:** Run `pnpm vitest run test/daily-ledger.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3:** Implement as pure functions returning new values.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: "Keep a day's model spend and review reservations against a daily cap".

### Task 2: The `DailySpend` object and its fail-open client

**Files:**
- Create: `src/budget/daily-spend.ts` (the object), `src/budget/daily.ts` (the client)
- Modify: `src/index.ts` (export the class), `wrangler.jsonc` (binding `DAILY_SPEND` → `DailySpend` in both `durable_objects` blocks, migration `{ "tag": "v4", "new_sqlite_classes": ["DailySpend"] }`, var `MAX_DAILY_NEURONS: "200000"` in both var blocks with a why-comment on the production one)
- Test: `test/daily-client.test.ts`, `test/wrangler.test.ts` (parity already covers the new var; add an assertion that both deploys bind `DAILY_SPEND`)

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `class DailySpend extends DurableObject<Env>` with RPC `reserve(holder, neurons, cap): Promise<{ granted: boolean; spent: number; reserved: number }>`, `settle(holder, neurons, sandboxSeconds): Promise<void>`, `room(cap): Promise<{ open: boolean; spent: number; reserved: number }>`, `add(neurons): Promise<void>`, and `alarm()` that calls `deleteAll`. Each call reads the one record under key `day` (parsed with `Value.Check(DayLedger, …)`, else `EMPTY_DAY`), applies Task 1, writes it, logs per Global Constraints, and sets the alarm 8 days on if none is set. The day name comes from `this.ctx.id.name`.
  - `export interface DayStore { reserve: …; settle: …; room: …; add: … }` (the four RPC signatures above), and `export type DayStores = (day: string) => DayStore`.
  - `export interface LedgerRef { day: string; holder: string; reserved: number }` and its TypeBox `LedgerRef`.
  - `export async function reserveReview(stores: DayStores, holder: string, neurons: number, cap: number, now: number): Promise<{ kind: "granted"; ledger: LedgerRef } | { kind: "refused"; day: string; spent: number; reserved: number } | { kind: "uncounted" }>`
  - `export async function settleReview(stores: DayStores, ledger: LedgerRef | undefined, neurons: number, sandboxSeconds: number): Promise<void>`: settles to `ledger.day`; no-op when `ledger` is `undefined`.
  - `export async function questionRoom(stores: DayStores, cap: number, now: number): Promise<boolean>` and `export async function addQuestion(stores: DayStores, neurons: number, now: number): Promise<void>`.
  - Each client function catches a throw, logs `budget.ledger_unreadable` with its `when`, and fails open (`uncounted`, `true`, or nothing).

- [ ] **Step 1: Write the failing tests** with an in-memory `DayStores` built on Task 1 (a real implementation of the interface, no mocks):
  - `reserveReview` at 23:59:59.999Z UTC returns a `LedgerRef` with day `2026-11-01`; `settleReview` of it one minute later charges `2026-11-01`, and `2026-11-02` stays empty.
  - A refused reserve returns `refused` with `spent` and `reserved`.
  - A store that throws makes `reserveReview` return `uncounted`, `questionRoom` return `true`, `settleReview` and `addQuestion` resolve, and each logs `budget.ledger_unreadable` (capture with `vi.spyOn(console, …)` as `test/sweep.test.ts` does).
  - `settleReview(stores, undefined, …)` calls no store.
  - `test/wrangler.test.ts`: both deploys bind `DAILY_SPEND` to `DailySpend`, and production's `MAX_DAILY_NEURONS` is `"200000"`.
- [ ] **Step 2:** Run `pnpm vitest run test/daily-client.test.ts test/wrangler.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the client, the object, the export and the `wrangler.jsonc` changes. Run `pnpm types` so `Env` gains `DAILY_SPEND` and `MAX_DAILY_NEURONS`.
- [ ] **Step 4:** Run the tests, then `pnpm check`. Expected: PASS.
- [ ] **Step 5:** Commit: "Hold each UTC day's spend in its own object, and reach it through a client that fails open".

### Task 3: What the author sees

**Files:**
- Modify: `src/names.ts` (`budgetMarkerOf`), `src/review/check.ts`, `src/review/pause.ts` or a new `src/review/budget-line.ts`, `src/commands.ts` (`ReviewSkip` gains `"daily_budget"`, `skippedReviewText` answers it)
- Test: `test/check.test.ts`, `test/budget-line.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Produces:
  - `export const budgetMarkerOf = (login: string): string => \`<!-- ${login}:budget -->\``
  - `export function dailyBudgetCheckRun(headSha: string, botLogin: string, completedAt: number): UpdateCheckRun`
  - `export function budgetLine(headSha: string, botLogin: string): string`, `withBudgetLine(body, line, botLogin): string`, `withoutBudgetLine(body, botLogin): string`: the paused line's insert-after-header behaviour, replacing an earlier budget line rather than stacking.
  - `export const BudgetSkipShown = Type.Object({ head: Type.String(), day: Type.String() })` and `export function budgetSkipShown(stored: BudgetSkipShown | undefined, head: string, day: string): boolean`
  - `export const QUESTION_BUDGET_REPLY` (exact copy from Global Constraints).

- [ ] **Step 1: Write the failing tests:**
  - `dailyBudgetCheckRun("abcdef1234", "andabot", t)`: conclusion `neutral`, title `Daily review budget spent`, summary holding `` `abcdef1` `` and `` `@andabot review` ``, `completed_at` set.
  - `withBudgetLine` on a summary with a header puts the line right after it; applied twice it holds one budget line; on a body that also holds the paused line, both lines remain; `withoutBudgetLine` removes it; a body without the summary marker comes back unchanged.
  - `budgetSkipShown`: true for same head and day; false for a new day, a new head, or `undefined`.
  - `skippedReviewText("daily_budget", "abcdef1234", "andabot")` is the tagged-review reply.
- [ ] **Step 2:** Run the three test files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5:** Commit: "Show a daily-budget skip as a neutral check run and one line in the summary".

### Task 4: Reviews reserve, skip and settle

**Files:**
- Modify: `src/pull-request.ts`, `src/review/flight.ts` (`StoredPending.ledger: Type.Optional(LedgerRef)`)

The object has no unit tests yet (#188), so this task's gate is `pnpm check` plus the reviewer reading each call site. Its pure parts are Tasks 1–3.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `private dayStores(): DayStores` (`(day) => this.env.DAILY_SPEND.getByName(day)`), `private async budgetSkip(pr, incoming): Promise<"daily_budget" | undefined>`, `private async settleLedger(pending: PendingReview | undefined): Promise<void>`.

- [ ] **Step 1:** In `review()`, after `settingsSkip` and after `clearFlight` decides `start` (not `resume`, not `skip`), call `reserveReview` with holder `<owner>/<repo>#<number>:<deliveryId>`. On `granted`, put `ledger` on the new pending; on `uncounted`, start with no `ledger`; on `refused`, go to step 2 and return `"daily_budget"`. A `resume` and a sweep restart keep the stored `ledger` and don't reserve.
- [ ] **Step 2:** On refusal: log `review.skip` per Global Constraints. Unless `budgetSkipShown(stored budgetSkip, head, day)`: create a check run (`startedCheckRun` + `createCheckRun` through `guardedCheck`) and complete it with `dailyBudgetCheckRun`; edit the budget line into the summary, or create the unposted summary with the line when none exists (as `refreshPausedLine` does); store `budgetSkip: { head, day }`. Don't write `decided` or `pending`.
- [ ] **Step 3:** Call `settleLedger(pending)` (reading `spendOf(pending)` through a new exported `neuronsOfSpend(spend: ReviewSpend): number` in `src/review/cost.ts` (priced models' `usd` through the existing private `neuronsOf`; pin it in `test/cost.test.ts`), and `#sandbox.seconds()`) at: `releasePending` after a post, `reportFailedReview`, `reportUnpostedReview`, `skipUnchanged`, the release branch of `runReview`'s catch, the sweep's give-up, `clearFlight`'s replace and `headMoved`. Read the pending before the exit deletes it.
- [ ] **Step 4:** `reviewOnRequest` replies with `skippedReviewText` on `daily_budget` (Task 3 already makes it non-`undefined`).
- [ ] **Step 5:** Run `pnpm check`. Expected: lint, types and every test pass.
- [ ] **Step 6:** Commit: "Reserve a review's budget in the day's ledger before it starts, skip it past the cap, and settle its spend when it ends".

### Task 5: Questions check room and add their spend

**Files:**
- Modify: `src/pull-request.ts` (`answer`)

**Interfaces:**
- Consumes: `questionRoom`, `addQuestion` (Task 2), `QUESTION_BUDGET_REPLY` (Task 3), `usageBaseline`, `neuronsSince`, `usageTotals` (existing, `src/review/cost.ts`).

- [ ] **Step 1:** Before `setModel`: if `!(await questionRoom(...))`, log `answer.skip` reason `daily_budget` and reply `@<author> ` + `QUESTION_BUDGET_REPLY` through `#replyUnlessClosed`, then return. After the prompt: `addQuestion` with `neuronsSince(before, after) ?? 0`, best-effort.
- [ ] **Step 2:** Run `pnpm check`. Expected: pass.
- [ ] **Step 3:** Commit: "Refuse questions past the daily cap and count their spend".

### Task 6: Docs

**Files:**
- Modify: `docs/setup.md` (vars table row for `MAX_DAILY_NEURONS`; the events; a "Billing notification" paragraph; the staging live-check recipe), `docs/design.md` (the daily cap beside the per-review cap, and the sweep's midnight pickup)

- [ ] **Step 1:** Write both, from the spec's wording.
- [ ] **Step 2:** Run `pnpm check`. Expected: pass (oxfmt checks Markdown).
- [ ] **Step 3:** Commit: "Document the daily spend cap".

### Task 7: Cloudflare billing notification (needs Andrew's yes)

- [ ] Find the usage-based billing alert types for Workers AI and Containers through the cloudflare-api MCP (`search`, then `execute` against `/accounts/{id}/alerting/v3/available_alerts`).
- [ ] Show Andrew the exact policy body (threshold about 10M neurons / $100 a month, mechanism email). Create it only on his yes; record the policy id in `docs/setup.md`.

### Task 8: Live check on staging (after review, before merge)

- [ ] Deploy the branch to staging: `pnpm exec wrangler deploy --env staging --var MAX_DAILY_NEURONS:10000` (not `pnpm run deploy -- --var`, which drops the var). Verify branch, HEAD and a clean tree in the same command.
- [ ] On a fixture PR against `main-with-checks` with `@andabot-staging` tagged: the review posts and `budget.settled` logs. Push and tag again: a neutral "Daily review budget spent" run, the summary line, the reply, `review.skip` `daily_budget` and `budget.daily_spent`. A question gets the budget reply and `answer.skip`.
- [ ] The next UTC day, a tag reviews again. Redeploy staging from main afterwards.
- [ ] Results on #186; comment on #182 adding `budget.daily_warning` and `budget.daily_spent` to its alert list.
