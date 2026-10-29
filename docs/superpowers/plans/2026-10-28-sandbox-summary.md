# Checks line and sandbox cost (#134) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show in the summary comment which checks the review ran and how they ended, name a finding's check in its inline comment, and add the sandbox's time and dollars to the cost line.

**Architecture:** A pure `checksSection` in `src/review/render.ts` renders the line and the collapsed tails from a `ChecksDisplay` the object builds from `SandboxRuns.status()` and its run cache; `spendLine` takes the sandbox seconds and `sandboxUsd` prices them; `toReviewComment` renders the finding's check line; `posted:<sha>` stores both so re-renders and logs agree.

**Tech Stack:** TypeScript, TypeBox, vitest; slices 2 and 3's `SandboxRuns` and `CheckRun`.

**Spec:** `docs/superpowers/specs/2026-10-28-sandbox-design.md`, section "Slice 4, #134".

## Global Constraints

- `CLAUDE.md`: no comments; no type assertions except `as const`; complexity at most 10; no `unknown`/`object` parameters or returns, no `typeof`, no `vi.mock`.
- `pnpm check` passes on every commit; `pnpm format` before committing.
- Tail cut at 2,000 characters; the Checks line sits after the dropped-findings line and before the Verify section; the cost rate is $0.00002056 per second; dollars render as the cost line's other dollars do (`dollarText`).
- Every new log field is named in `docs/design.md`.

## Review Focus

- A tail containing a fenced block or `</details>`: the tail is placed in a fenced block with a longer fence than any it contains, so the comment's structure survives (Task 2 test).
- A run with a path containing `|` or backticks: the line's code span escapes as `codeSpan` does elsewhere (Task 2 test).
- A review that asked for the sandbox but ran no check (preparation ran, the model never called): `Checks: none` with the sandbox seconds still on the cost line (Task 2 and Task 3 tests).
- A `posted:<sha>` record from before this slice: `checks` and `sandboxSeconds` optional, the comment renders without them (Task 4, schema optional).
- Zero sandbox seconds (asked and answered `off` at once): no sandbox part on the cost line (Task 3 test).

---

### Task 1: `SandboxRuns.status()`

**Files:** Modify `src/sandbox/runs.ts`; test `test/sandbox-runs.test.ts`.

**Interfaces:**
```ts
export type SandboxStatus =
  | { readonly kind: "none" } | { readonly kind: "off" } | { readonly kind: "ready" }
  | { readonly kind: "spent" } | { readonly kind: "unavailable"; readonly reason: UnavailableReason }
export class SandboxRuns { status(): SandboxStatus }
```
- `none` until `access()` is called; `off` when the last answer was off; `ready`/`unavailable` from the settled memo; `spent` once the budget answered spent. `end()` resets it to `none`.

- [ ] **Step 1: Failing tests**: none before any call; off after an off answer; ready after a ready one; unavailable with the step after a failure; spent after the budget; none again after `end`.
- [ ] **Step 2: Run** `pnpm vitest run test/sandbox-runs.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `Let the host ask what the sandbox answered`.

### Task 2: The Checks section and the finding's check line

**Files:** Modify `src/review/render.ts` (`checksLines`, exported `ChecksDisplay`, the `renderSummaryComment` input), `src/review/findings.ts` (`toReviewComment`), `src/records.ts` (`CheckRecord`); test `test/findings.test.ts`.

**Interfaces:**
```ts
// src/records.ts
export const CheckRecord = Type.Object({ name: Type.String(), paths: Type.Array(Type.String()), outcome: Type.Union([Type.Literal("exited"), Type.Literal("timeout")]), exitCode: Type.Optional(Type.Integer()), ms: Type.Integer(), tail: Type.String() })
export type CheckRecord = Static<typeof CheckRecord>
// src/review/render.ts
export type ChecksDisplay = { readonly status: SandboxStatus["kind"]; readonly reason?: string | undefined; readonly runs: readonly CheckRecord[] }
// renderSummaryComment input gains `checks?: ChecksDisplay | undefined`
export const MOST_CHECK_TAIL_CHARS = 2000
```
- `checksLines(display)`: `[]` when `display` is undefined; `["", "**Checks:** none"]` and the other statuses as the spec words them; with runs, `**Checks:**` followed by one bullet per run and, for each failed or timed-out run, a `<details>` block whose summary is `test on test/x.test.ts, exit 1` (or `, timed out`) and whose body is the tail's last 2,000 characters in a fence of four backticks (five when the tail holds four).
- `toReviewComment`: after the basis line, `_Check: test on \`test/x.test.ts\` exited 1_` when `finding.check` is set (no paths: `_Check: lint exited 1_`).

- [ ] **Step 1: Failing tests** for each status, the run lines, the collapsed tail with its cut and fence, a path with backticks, and the finding line. **Step 2: Run** `pnpm vitest run test/findings.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `Show the checks a review ran under its walkthrough, and the run a finding rests on`.

### Task 3: The sandbox on the cost line

**Files:** Modify `src/review/cost.ts`; test `test/cost.test.ts`.

**Interfaces:**
```ts
export const SANDBOX_USD_PER_SECOND = 0.00002056
export function sandboxUsd(seconds: number): number
export function spendLine(spend: ReviewSpend, sandboxSeconds?: number): string | undefined   // appends ` · sandbox 2m 14s ($0.0028)` when seconds > 0
export function sandboxFields(seconds: number | undefined): LogFields                       // { sandboxSeconds, sandboxUsd } or {}
```
- Time renders as `14s`, `2m 14s`, `1h 2m 3s`; dollars through the module's `dollarText`.

- [ ] **Step 1: Failing tests**: the line with 134 s; no part at 0 or undefined; an hour's rendering; `sandboxUsd(134)` to 8 places; `sandboxFields`. **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `Price the sandbox's time on the cost line`.

### Task 4: Wire the object, the record and the docs

**Files:** Modify `src/pull-request.ts` (build `ChecksDisplay` from `#sandbox.status()` and `#checks`, pass `checks` and `sandboxSeconds` to the summary, store both on `posted:<sha>`, `sandboxFields` in `review.done`), `src/records.ts` (`PostedReview` gains `sandboxSeconds` and `checks`, optional), `src/review/render.ts` (`spendLines` takes seconds), `docs/design.md`, `docs/setup.md`.

- [ ] **Step 1: Make the changes.** **Step 2: Run** `pnpm check` → PASS. **Step 3: Commit** `Carry the review's checks and sandbox time into the summary, the record and the log`.

### Task 5: Live check

Under `wrangler dev` with the probe: `prepare`, then `check` `test` on `test/sandbox-policy.test.ts` and `check` `test` on `test/sandbox-runs.test.ts`, then render the summary for those runs through a unit test fixture built from the probe's answers (no review runs locally). The production shape, a review whose model calls `run_check` on a planted failure and whose summary shows the Checks line, is #135's measurement.
