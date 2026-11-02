# Approve on Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@andabot approve` approves the current, already-reviewed head past andabot's own blocking threads and withheld reasons. It still waits for the other checks, and lasts for that head only.

**Architecture:** A pure `approveStep` (`src/review/approve.ts`) decides whether the command may proceed. On `override` the object stores `approvalOverride: { head, by, at }`. `decideApproval` gains an `override` flag that skips the judgment waits and keeps the rest, so the existing check triggers approve once checks pass. Rendering helpers mark an overridden approval in the review body, the summary verdict and the check run.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, TypeBox, vitest, oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-11-02-approve-command-design.md`

## Global Constraints

- Command text `approve`, top-level comments only; a thread reply is refused (`thread`).
- `approveStep` order: `thread`, `disabled`, `author`, `workflow_off`, `not_open`, `paused`, `review_running`, `not_reviewed`, `approved`, then `override`.
- Config: `reviews.approve` defaults to `{ enabled: true, allow_author: false }`; the file's partial object merges key by key.
- Storage key `approvalOverride` = `{ head: string, by: string, at: number }` (TypeBox `ApprovalOverride`), honoured only when `head` equals the current head.
- Copy, exact:
  - Body: "Approved at `<sha7>` on request by @<who>, past my open blocking threads and the reasons my review gave. A human review is still required to merge."
  - Verdict segment: "**Verdict:** Approved at `<sha7>` on request by @<who>".
  - Check-run title: "Approved on request by @<who>".
  - Replies:
    - approved: "Approved `<sha7>` on your request. My open threads stay open; `@<login> resolve` closes them."
    - checks pending: "I'll approve `<sha7>` once the other checks pass."
    - checks failing: "I'll approve `<sha7>` once the failing checks pass."
    - `thread`: "Type `@<login> approve` as a comment on the pull request, not in a thread."
    - `disabled`: "`<config file>` turns `approve` off for this repository."
    - `author`: "You opened this pull request, so `approve` needs someone else; `<config file>` can allow authors with `reviews.approve.allow_author: true`."
    - `workflow_off`: "I never approve here: the request-changes workflow is off."
    - `not_open`: "This pull request is closed or a draft, so there's nothing to approve."
    - `paused`: "I'm paused here; `@<login> resume` first."
    - `review_running`: "My review of `<sha7>` is still running; type approve once it posts."
    - `not_reviewed`: "I haven't reviewed `<sha7>` yet; type approve once my review posts."
    - `approved`: "`<sha7>` is approved already."
- Logs: `command.approve` (`author`, `head`, `step`); `approval.posted` gains `override` (the requester) when used.
- Lint: no comments, no assertions but `as const`, complexity ≤ 10, anti-slop, no `vi.mock`.

## Review Focus

- An override stored for head A must not approve head B after a push. Pinned in Task 2.
- An override must not approve while a review of the head is running or checks fail. Pinned in Task 2.
- `approve: { allow_author: true }` in a file must keep `enabled: true`. Pinned in Task 1.
- An evaluation with an override on a head whose review already approved must not post a second approval (`approved` wait stays first). Pinned in Task 2.
- The author check must compare logins case-insensitively, since GitHub logins are case-insensitive. Pinned in Task 3.

---

### Task 1: Config

**Files:** Modify `src/repository/config.ts`. Test `test/config.test.ts`.

**Interfaces:**
- Produces: `AndabotConfig.reviews.approve: { enabled: boolean; allow_author: boolean }`.

- [ ] **Step 1: Write failing tests:**
  - With no file, the default is `{ enabled: true, allow_author: false }`.
  - `reviews: { approve: { allow_author: true } }` gives `{ enabled: true, allow_author: true }`.
  - `approve: { enabled: false }` keeps `allow_author: false`.
  - An unknown key under `approve` is rejected with an error.
- [ ] **Step 2:** Run `pnpm vitest run test/config.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement: `Approve` schema; `Reviews.approve`; the file's `approve` is `Type.Partial(Approve)`; `withDefaults` merges `approve` key by key.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit "Read reviews.approve from the config, on by default and closed to authors".

### Task 2: The decision with an override

**Files:** Modify `src/review/approval.ts`. Test `test/approval.test.ts`.

**Interfaces:**
- Produces:
  - `ApprovalState.override: boolean`.
  - `ApprovalTrigger` gains `"approve"`.
  - `export const ApprovalOverride`, its type, and `export function overrideFor(stored: ApprovalOverride | undefined, head: string): ApprovalOverride | undefined`.

- [ ] **Step 1: Write failing tests**, from a state that would wait on `blocking_threads`, on `review_stands` (REQUEST_CHANGES, and a COMMENT with `withheld: 2`) and on `threads_unknown`:
  - With `override: true` it approves.
  - With `override: true` it still waits for `checks_pending`, `checks_failing`, `review_in_flight`, `not_reviewed`, `paused`, `workflow_off`, `no_record` and `approved`.
  - `overrideFor({ head: "a", … }, "b")` is `undefined`, and the same head returns it.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. `recordWait` and `liveStateWait` take the override into account; `approved` and `no_record` still come first.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit "Let a stored override for the head approve past andabot's own judgment".

### Task 3: The command's step, replies and copy

**Files:**
- Create `src/review/approve.ts`.
- Modify `src/commands.ts` (`approve` in the table and in `helpText`), `src/review/render.ts` (`overriddenApprovalBody`, `withOverriddenVerdict`) and `src/review/check.ts` (`approvedCheckRun` takes an optional `by`).
- Tests: `test/approve.test.ts`, `test/commands.test.ts`, `test/summary.test.ts` or the render test that holds `approvalBody`, and `test/check.test.ts`.

**Interfaces:**
- Produces:
  - `export type ApproveStep = "thread" | "disabled" | "author" | "workflow_off" | "not_open" | "paused" | "review_running" | "not_reviewed" | "approved" | "override"`.
  - `export interface ApproveFacts { inThread: boolean; enabled: boolean; allowAuthor: boolean; commenter: string; author: string; workflow: WorkflowState; open: boolean; paused: boolean; reviewRunning: boolean; reviewedHead: string | undefined; lastReview: LastReview | undefined; head: string }`.
  - `export function approveStep(facts: ApproveFacts): ApproveStep`. A `workflow` of `"unknown"` counts as off.
  - `export function approveReply(step: Exclude<ApproveStep, "override">, head: string, botLogin: string): string`.
  - `export function overrideReply(outcome: ApprovalOutcome, head: string, botLogin: string): string`: approved, checks pending, or checks failing per Global Constraints. Any other wait gives "I couldn't approve `<sha7>` yet: <reason>." with the `WaitReason` as the reason.
  - `export function overriddenApprovalBody(head: string, by: string): string`.
  - `export function withOverriddenVerdict(body: string, head: string, by: string, botLogin: string): string | undefined`.
  - `approvedCheckRun(posted, detailsUrl, completedAt, by?: string)`: with `by`, the title is the Global Constraints one.

- [ ] **Step 1: Write failing tests:**
  - Each step in order, with exactly one fact flipped from the override case. The author rule: same login in different case → `author`; with `allowAuthor` → it goes on to `override`.
  - Every reply's exact copy.
  - `parseCommand("@andabot approve", "andabot")` is `{ kind: "approve" }`.
  - `helpText` lists `approve`.
  - The body, verdict and check-run title copy.
- [ ] **Step 2:** Run the four files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit "Decide and word @andabot approve".

### Task 4: Wire the command into the object

**Files:** Modify `src/pull-request.ts`.

The object has no unit tests (#188), so this task's gate is `pnpm check` plus the live check (Task 6).

- [ ] **Step 1:** `runCommand` handles `approve` with `approveOnRequest(call)`:
  - Build `ApproveFacts` from:
    - `freshPullRequest()`, `repositoryConfig(pr)` (`config.reviews.approve`) and `evaluationWorkflow`;
    - `isPaused()`, `readPending()`, `readReviewed()`, `readLastReview()`;
    - `call.incoming.thread !== undefined`, `call.incoming.author` and `pr.user.login`.
  - On a refusal, log `command.approve` and reply `approveReply`.
  - On `override`: put `approvalOverride`, log, `evaluateApproval("approve", incoming.deliveryId)`, and reply `overrideReply`.
- [ ] **Step 2:** `approvalState` sets `override` from `overrideFor(stored, pr.head.sha) !== undefined`.
- [ ] **Step 3:** In `submitApproval`, read the override for the head. When it is set and the last review's event isn't already approvable on its own (`!awaitsApproval(last)` or open blocking threads), use `overriddenApprovalBody`, `withOverriddenVerdict` and `approvedCheckRun(…, by)`, and log `approval.posted` with `override`.
  - Ruling for the builder: decide "overrode anything" as `!awaitsApproval(lastReview) || openBlocking > 0` at decision time. Pass it through `ApprovalContext` rather than recomputing it.
- [ ] **Step 4:** Run `pnpm check`. Expected: pass.
- [ ] **Step 5:** Commit "Approve on request: @andabot approve stores an override for the head and re-evaluates".

### Task 5: Docs and this repository's config

**Files:** Modify `docs/setup.md` (commands and section 6, `reviews.approve`) and `docs/design.md` (the approval policy). Create `.andabot.yaml` holding `reviews:\n  approve:\n    allow_author: true`.

- [ ] **Step 1:** Write them.
- [ ] **Step 2:** Run `pnpm check`. Expected: pass.
- [ ] **Step 3:** Commit "Document @andabot approve, and let this repository's authors use it".

### Task 6: Live check on staging

- [ ] Push `.andabot-staging.yaml` with `reviews: { approve: { allow_author: true } }` to `main-with-checks`, the fixture base, since config is read at the base.
- [ ] Deploy the branch to staging: `pnpm exec wrangler deploy --env staging`, verifying branch, HEAD and a clean tree in the same command.
- [ ] Open a fixture PR from `main-with-checks` with a planted blocking defect. Tag `@andabot-staging review` and confirm it requests changes.
- [ ] Comment `@andabot-staging approve`. Confirm all of:
  - the reply;
  - an APPROVE review with the override body;
  - the summary verdict;
  - the check-run title;
  - `command.approve` and `approval.posted override` in Workers Logs.
- [ ] Push again. Confirm the new head gets a normal review that requests changes. Typing approve while it runs gets the `review_running` reply.
- [ ] Results go on #212. Close the fixture unmerged and keep its branch.
