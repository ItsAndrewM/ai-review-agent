# Review budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap what one review may spend on the model. `docs/design.md` has long said "a `beforeTool` hook enforces budgets … on total model tokens per review, with the review ending in a shorter summary rather than a failed run", but nothing enforces it: a Kimi K2.7 Code review of a nine-file pull request (#99) took 19 model calls, 2.0 M input tokens and 48,471 neurons, nearly five days of Workers AI's free allowance.

**Architecture:** The review's spend is already measurable mid-run: `pending.usageBefore` is the usage baseline taken when the review starts, and pi's `usage()` gives the session's totals priced in dollars, which `src/review/cost.ts` converts to neurons. Two pi-durable hooks on the `andabot` extension enforce a budget in neurons: a `beforeTool` hook on `ToolTask` that, once the review's spend reaches the budget, blocks every tool but `submit_review` with a message telling the model to submit now (the soft stop, which ends in a shorter review); and a `beforeRequest` hook on `GenerationTask` that refuses the fourth model request made past the budget by throwing, which ends the run through the existing `review.failed` path (the hard stop, for a model that ignores the soft one). The decisions live in a pure module; the object supplies the spend.

**Tech Stack:** TypeScript on Cloudflare Workers, Durable Objects, Pi Durable 1.3.0 (`hook`, `ToolTask`, `GenerationTask`), TypeBox, vitest, oxlint/oxfmt.

**Spec:** `docs/design.md` (the `beforeTool` budget sentence under "Pi harness inside the object", the cost line); the measurements on #2 (GLM-5.3 Flash reviews cost 140 to 1,370 neurons; Kimi fixture reviews 700 to 6,400; the #99 outlier 48,471).

## Global Constraints

- `CLAUDE.md`: no comments of any kind; no type assertions except `as const`; complexity at most 10 per function; no `unknown`/`object` parameters or returns, no `typeof`, no `vi.mock`; the reason for a thing lives in a name, a test title or `docs/design.md`.
- `pnpm check` passes on every commit (it regenerates `worker-configuration.d.ts` with `wrangler types`); `pnpm format` before committing.
- Log fields are strings, numbers, booleans or undefined; every new event or field is named in `docs/design.md`.
- The budget is a Worker variable, `MAX_REVIEW_NEURONS`, default `10000` (one day of Workers AI's free allowance of 10,000 neurons), parsed as `outputLimitOf` parses `MAX_OUTPUT_TOKENS`: a positive safe integer, else the default.
- Only a review is budgeted: a question answered on the root conversation while no review is pending, and the summary session (which selects no extensions, so no hooks), are not.
- Spend that pi can't price (a model without pricing) doesn't count toward the budget.

## Review Focus

- A review whose model calls `submit_review` as its first tool: never blocked, whatever the spend (Task 1 test).
- A review that crosses the budget while the submit loop returns problems: `submit_review` stays allowed, and the hard stop leaves room for a resubmission and the closing reply (three requests past the budget) (Task 1 test).
- A failure after the review has posted (the hard stop refusing the closing reply): `finishReview` checks `isPosted` first, so the posted review stands (read in review).
- A question during or after a review: not budgeted unless a review is pending on the root conversation (Task 2, read in review).
- An unpriced model: the budget never triggers, as the docs say (Task 1 test).

---

### Task 1: The budget's decisions, as a pure module

**Files:**
- Create: `src/review/budget.ts`
- Modify: `src/review/cost.ts` (export a neuron helper)
- Test: `test/budget.test.ts`, `test/cost.test.ts`

**Interfaces:**
- Produces:

```ts
// src/review/cost.ts
export function neuronsSince(before: UsageTotals, after: UsageTotals): number | undefined
// the neurons of the dollars every model grew by since `before`, or undefined when a model whose tokens grew has no price (usd 0 with tokens > 0)

// src/review/budget.ts
export const DEFAULT_REVIEW_NEURONS = 10_000
export const REQUESTS_PAST_BUDGET = 3
export function reviewBudgetOf(value: string | undefined): number
export type BudgetStanding = { readonly kind: "within" } | { readonly kind: "spent"; readonly neurons: number; readonly budget: number }
export function budgetStanding(neurons: number | undefined, budget: number): BudgetStanding
export function budgetBlock(standing: BudgetStanding, toolName: string): string | undefined
export function refusesRequest(standing: BudgetStanding, requestsPastBudget: number): boolean
export function budgetRefusal(standing: Extract<BudgetStanding, { kind: "spent" }>): string
export function budgetNote(budget: number): string
```

- `budgetStanding` is `spent` when `neurons` is defined and at least `budget`, `within` otherwise.
- `budgetBlock` returns `undefined` when within or when `toolName` is `submit_review`; otherwise exactly: `` `Budget spent: this review has used ${n} of its ${budget} neurons. Call submit_review now with the findings and walkthrough you have; a file you didn't get to still needs its walkthrough row, written from the diff.` `` with both numbers formatted with `toLocaleString("en-US")` and the neurons rounded down to a whole number.
- `refusesRequest` is true when spent and `requestsPastBudget >= REQUESTS_PAST_BUDGET` (the count of requests already made past the budget, before this one).
- `budgetRefusal` is exactly `` `the review spent ${n} neurons, past its budget of ${budget}, and kept calling tools after it was told to submit` `` (same formatting); `budgetNote` is exactly `` `_This review stopped reading early: it spent its budget of ${budget} neurons._` ``.

- [ ] **Step 1: Write the failing tests** in `test/budget.test.ts` and `test/cost.test.ts`, one `it` per rule above: the default and the parse (`"5000"` → 5000; `""`, `"0"`, `"-1"`, `"1.5"`, `"abc"`, `undefined` → 10,000); within below the budget, spent at and above it, within for `undefined` neurons; no block within, no block for `submit_review` when spent, the exact block message for `read_file` when spent; `refusesRequest` false for 0, 1 and 2 requests past the budget and true for 3, and false whenever within; the exact refusal and note texts; `neuronsSince` for one priced model, for two, `undefined` when a model's tokens grew with no price, and 0 when nothing grew.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run test/budget.test.ts test/cost.test.ts`
Expected: FAIL (the module and the helper don't exist).

- [ ] **Step 3: Implement** the two files as in Interfaces; `neuronsSince` reuses `cost.ts`'s neuron conversion (`USD_PER_THOUSAND_NEURONS`).

- [ ] **Step 4: Run the checks**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review/budget.ts src/review/cost.ts test/budget.test.ts test/cost.test.ts
git commit -m "Decide a review's budget in neurons: block every tool but submit_review once it is spent, and refuse the fourth request past it"
```

---

### Task 2: Enforce the budget with pi-durable's hooks

**Files:**
- Modify: `src/review/tools.ts` (`ReviewHost`; `createReviewExtension` gains `hooks`)
- Modify: `src/pull-request.ts` (the host methods; per-review counters reset where `#refusedCalls` is; `review.transcript`; the summary note at publish)
- Modify: `src/review/render.ts` (the review footer's optional note)
- Modify: `wrangler.jsonc` (`MAX_REVIEW_NEURONS: "10000"` beside `MAX_OUTPUT_TOKENS`)
- Modify: `docs/design.md`, `docs/setup.md`
- Test: `test/tools.test.ts`, `test/findings.test.ts` (or wherever `renderReview`'s footer is tested)

**Interfaces:**
- Consumes: Task 1's module; pi-durable's `hook`, `ToolTask` and `GenerationTask` (exported from `@earendil-works/pi-durable`); `ToolHooks.beforeTool(call, api, context)` returning `{ block }`; `GenerationHooks.beforeRequest(request, api, context)`, where a throw ends the request (verify in `node_modules/@earendil-works/pi-durable/dist/harness/generation.js` and the task runner that a throw from `beforeRequest` fails the run rather than being retried; if it is retried, stop and report BLOCKED with what you found).
- Produces: `ReviewHost` gains `budgetBlock(toolName: string, conversationId: ConversationId): Promise<string | undefined>` and `checkRequestBudget(conversationId: ConversationId): Promise<void>`; the events `review.budget_spent` `{ number, head, neurons, budget, tool }` (logged once per review, at the first block) and `review.budget_refused` `{ number, head, neurons, budget, requestsPastBudget }` (at the hard stop, before throwing `new Error(budgetRefusal(standing))`); `review.transcript` gains `budgetBlocked` (the count of calls the budget blocked, cumulative within a review like `refusedCalls`).

- [ ] **Step 1: Wire the hooks** in `createReviewExtension`: `hooks: [hook(ToolTask, { beforeTool: async (call, api) => blockOrNothing(await host.budgetBlock(call.name, api.conversationId)) }), hook(GenerationTask, { beforeRequest: async (_request, api) => { await host.checkRequestBudget(api.conversationId) } })]`, where `blockOrNothing` turns a message into `{ block: message }` and `undefined` into `undefined`. The `beforeRequest` hook returns `undefined`, leaving the messages alone.

- [ ] **Step 2: Implement the host methods** in `src/pull-request.ts`:
  - Both act only when `conversationId` is the root conversation's and a review is pending (`readPending()`); otherwise they return `undefined` / resolve.
  - The standing: `budgetStanding(neuronsSince(pending.usageBefore, usageTotals(await pi.usage(BACKGROUND_CONTEXT))), reviewBudgetOf(this.env.MAX_REVIEW_NEURONS))`; no `usageBefore` (an older pending record) or an unreadable usage means within. Don't read the transcript's messages for this; `usage()` alone prices the spend.
  - `budgetBlock`: when `budgetBlock(standing, toolName)` gives a message, log `review.budget_spent` the first time in this review, increment `#budgetBlocked`, and return the message.
  - `checkRequestBudget`: when spent, if `refusesRequest(standing, this.#requestsPastBudget)` log `review.budget_refused` and throw; otherwise increment `#requestsPastBudget`.
  - Reset `#budgetBlocked` and `#requestsPastBudget` where `runReview` resets `#refusedCalls`; `logTranscript` logs `budgetBlocked`.
  - At publish, when `#budgetBlocked > 0`, the review's summary carries `budgetNote(budget)` in its footer (`renderReview` gains an optional `budgetNote`, rendered as a footer line after the cost line).

- [ ] **Step 3: Tests.** In `test/tools.test.ts`, pin that the extension registers both hooks and that its `beforeTool` handler returns `{ block: message }` when the host returns a message and `undefined` when it returns `undefined`, and that the `beforeRequest` handler propagates the host's throw, if this can be done with the file's existing host fake and no assertion; if pi-durable's `HookApi` can't be built without one, call the handlers through a small structural interface as `test/repository-skills.test.ts`'s `CalledWithoutHarness` does, and say so in the report. In the render test, pin the footer note.

- [ ] **Step 4: Docs.**
  - `docs/design.md`, replace "A `beforeTool` hook enforces budgets: a cap on files read per review, on bytes per read, and on total model tokens per review, with the review ending in a shorter summary rather than a failed run." with the behavior: the budget in neurons (`MAX_REVIEW_NEURONS`, default 10,000, one day of Workers AI's free allowance); measured from the review's usage baseline through pi's priced usage, unpriced spend not counted; the soft stop (every tool but `submit_review` blocked with the message, `review.budget_spent` once, `budgetBlocked` on the transcript, the summary's note); the hard stop (the fourth request past the budget refused, `review.budget_refused`, the run failing through `review.failed` with the summary's "did not complete" note, and a review already posted standing); only reviews are budgeted, not questions or summaries; a single read is bounded by pi-durable's 50 KiB tool-result cap, and the number of reads by the budget.
  - `docs/setup.md`, the variables table: a `MAX_REVIEW_NEURONS` row beside `MAX_OUTPUT_TOKENS`: default `10000`, "Most neurons one review may spend; once spent the model is told to submit, and three model requests later the review stops."

- [ ] **Step 5: Run the checks**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/review/tools.ts src/pull-request.ts src/review/render.ts wrangler.jsonc docs/design.md docs/setup.md test/
git commit -m "Enforce a review's neuron budget with pi-durable's tool and request hooks"
```

---

### Task 3: Finish: live check, pull request

- [ ] **Step 1: Soft stop, live.** Deploy the branch with `pnpm exec wrangler deploy --var MAX_REVIEW_NEURONS:1` (a window announced; `pnpm run deploy -- --var` drops the variable), open a fresh pull request from `chore/shorten-a-list-of-shas-in-one-place` against `main-with-skills` (GLM usually calls `activate_skill` first). Expected: `review.budget_spent` with the first non-submit tool, `budgetBlocked` ≥ 1 on `review.transcript`, the review posted with the summary's note, no `review.failed`.
- [ ] **Step 2: Default, live.** Redeploy the branch plainly (budget 10,000); open the pull request for this branch, whose own review must post with no budget event.
- [ ] **Step 3:** Redeploy plain main; record both on #2; after Andrew merges, deploy main and verify one review.
