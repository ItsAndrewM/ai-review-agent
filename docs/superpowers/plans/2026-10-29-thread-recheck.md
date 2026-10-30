# Threads that close when they should (#123) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A push's incremental review re-checks andabot's open threads in the files it changed and their test files; the answer session in one of andabot's threads can verify a claimed fix or withdraw a finding and resolve the thread with one reply; a thread the other path already closed gets no second reply.

**Architecture:** The selection rule and the stem match are pure functions in `src/review/incremental.ts`. The tool and its refusal texts are a pure module, `src/review/thread-resolution.ts`, offered through `createReviewExtension` and answered by a new `ReviewHost.resolveThread`. The thread-answer prompt carries the finding's severity, title and the head sha; the answer skill tells the model when to call the tool. `PullRequest` holds the thread it is answering, guards the tool by the running root operation, reads the thread live before it resolves, drops a reply on a thread the review closed, and re-evaluates approval after the reply.

**Tech Stack:** TypeScript on Cloudflare Workers, TypeBox, vitest, oxlint/oxfmt; Pi Durable tools (`defineTool`, `replay: "unsafe"`).

**Spec:** `docs/superpowers/specs/2026-10-29-reviews-that-hold-up-design.md`, "Slice 2, #123".

## Global Constraints

- `CLAUDE.md`: no comments; no type assertions except `as const`; complexity at most 10; no `unknown`/`object` parameters or returns, no `typeof`, no `vi.mock`; parse what crosses a boundary with TypeBox.
- `pnpm check` passes on every commit; `pnpm format` before committing.
- Tool name `resolve_thread`, parameters `{ reason: "fixed" | "withdrawn", evidence: string }`; refusals `no_evidence`, `not_answering`, `already_resolved`, `unreachable`; the not-answering text ends with "a review lists fixed threads in addressed_threads". Cap stays `MOST_LISTED_THREADS` (30). Log events `thread.resolved` (`number`, `thread`, `reason`, `by: "answer"`), `review.resolve_skipped` (`number`, `thread`), `answer.skipped` (`number`, `thread`, `reason: "thread_resolved"`). Every new event is named in `docs/design.md`.
- The answer skill's `version` bumps; its fingerprint changes with it.

## Review Focus

- A thread reply that lands while a push's review runs: the answer queues behind the review in the root conversation; a `resolve_thread` call from the review's own run is refused `not_answering` (Task 2 test on the pure guard; Task 5 read in review).
- `resolve_thread` called twice in one answer: the second call answers that the thread is already resolved by this answer, and the reply still posts once (Task 2 test).
- The author's reply claims a fix but names a sha the head doesn't contain: the model reads the head, finds nothing, says so; the host never checks shas (Task 3, skill text; read in review).
- The head read at the start of an answer fails: a transient failure reaches the door and the reply retries; a final one answers from the cached pull request as today (Task 5, read in review).
- The review's live read finds every addressed thread closed (a human resolved them meanwhile): nothing is resolved or replied, `review.resolved` logs `attempted` and `resolved: 0` (Task 4 test on the pure partition).

---

### Task 1: The wider selection

**Files:** Modify `src/review/incremental.ts`; test `test/incremental.test.ts`.

**Interfaces:**
```ts
export function fileStem(path: string): string          // basename without extension and without a trailing .test or .spec
export function isTestPath(path: string): boolean      // a segment test, tests, __tests__ or spec, or .test. / .spec. in the name
export function matchesThreadFile(threadPath: string, changedPath: string): boolean   // same path, or a test path whose stem equals the thread file's stem
// threadsToRecheck: in incremental mode, also keep an open thread for which some `since` file matchesThreadFile
```

- [ ] **Step 1: Failing tests**: `fileStem("src/review/cost.ts")` → `cost`, `fileStem("test/cost.test.ts")` → `cost`, `fileStem("a/b.spec.tsx")` → `b`; `isTestPath` true for `test/x.ts`, `src/__tests__/x.ts`, `src/x.test.ts`, `spec/x.ts`, false for `src/x.ts`; `matchesThreadFile` true for the same path and for `test/cost.test.ts` against `src/review/cost.ts`, false for `test/other.test.ts` and for `src/cost.ts` against `src/review/cost.ts`… no: two non-test files with the same stem in different directories do not match; `threadsToRecheck` in incremental mode keeps an open thread on `src/review/cost.ts` line 40 when `since` holds `test/cost.test.ts` or `src/review/cost.ts` with changes elsewhere in the file, drops it when `since` holds `src/other.ts`, keeps today's starred-line and touched-quote answers, applies the cap, and in full and fresh modes behaves as today.
- [ ] **Step 2: Run** `pnpm vitest run test/incremental.test.ts` → FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** `pnpm check` → PASS. **Step 5: Commit** `Re-check open threads in the files a push changed and their test files`.

### Task 2: The tool and its refusals

**Files:** Create `src/review/thread-resolution.ts`; test `test/thread-resolution.test.ts`; modify `src/review/tools.ts` (`ReviewHost.resolveThread`, the tool in `createReviewExtension`), `test/tools.test.ts` (the host fake gains `resolveThread`; the tool is offered with its parameters).

**Interfaces:**
```ts
export const ResolveThreadParameters = Type.Object({ reason: Type.Union([Type.Literal("fixed"), Type.Literal("withdrawn")]), evidence: Type.String() })
export type ResolveThreadArgs = Static<typeof ResolveThreadParameters>
export type ResolveRefusal = "no_evidence" | "not_answering" | "already_resolved" | "resolved_by_this_answer" | "unreachable"
export type ResolveOutcome = { kind: "resolved"; reason: "fixed" | "withdrawn" } | { kind: "refused"; refusal: ResolveRefusal }
export function resolveOutcomeText(outcome: ResolveOutcome): string
export function evidenceProblem(evidence: string): "no_evidence" | undefined   // empty after trim
export function answeringGuard(runningOperation: string | undefined, answerDeliveryId: string | undefined): "not_answering" | undefined   // ok only when runningOperation === `chat:${answerDeliveryId}`
export function resolveThreadTool(run: (args: ResolveThreadArgs, conversationId: ConversationId) => Promise<string>)   // defineTool, replay "unsafe"; description tells the model to call it only in one of andabot's threads, with the head's path:line as evidence
// ReviewHost gains resolveThread(args: ResolveThreadArgs, conversationId: ConversationId): Promise<string>
```

- [ ] **Step 1: Failing tests**: `evidenceProblem("")`/`("  ")` → `no_evidence`, `("src/a.ts:12")` → undefined; `answeringGuard("chat:d-1", "d-1")` → undefined, `("review:d-2", "d-1")` and `(undefined, "d-1")` and `("chat:d-1", undefined)` → `not_answering`; `resolveOutcomeText` for each outcome (the not-answering text contains "addressed_threads"; the unreachable text says the thread stays open); `createReviewExtension` offers `resolve_thread` with the two parameters, `replay: "unsafe"`, and its `execute` calls `host.resolveThread`.
- [ ] **Step 2: Run** `pnpm vitest run test/thread-resolution.test.ts test/tools.test.ts` → FAIL.
- [ ] **Step 3: Implement** (the preamble's tool-name list in `src/review/prompt.ts` takes the names from the offered tools already; confirm `resolve_thread` appears without a change, else add it).
- [ ] **Step 4: Run** `pnpm check` → PASS (the object's `ReviewHost` implementation gets a `resolveThread` that answers `not_answering` until Task 5 wires it; ledger it).
- [ ] **Step 5: Commit** `Offer resolve_thread, with its refusals`.

### Task 3: The prompt and the skill

**Files:** Modify `src/review/prompt.ts` (`ThreadQuestion` gains `severity: Severity | undefined`, `title: string | undefined`, `headSha: string`; `threadAnswerPrompt` renders "The thread is andabot's <severity> finding \"<title>\"; the head is now `<sha>`." when a severity is known), `test/prompt.test.ts`, `skills/answer/SKILL.md` (version "2"; the rule from the spec's "The skill"), the skills fingerprint test if one pins the answer skill's text.

- [ ] **Step 1: Failing tests**: the thread prompt names the severity, the title and the short head sha when given, and neither when the severity is undefined; the answer skill's text contains `resolve_thread`, "withdrawn" and "never resolve on the author's word alone".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm check` → PASS. **Step 5: Commit** `Tell the answer session what it is verifying, and when to resolve`.

### Task 4: Reading before resolving, as a pure step

**Files:** Modify `src/review/incremental.ts`; test `test/incremental.test.ts`.

**Interfaces:**
```ts
export function stillOpen(threads: readonly OpenThread[], live: readonly ReviewThread[]): { open: OpenThread[]; closed: OpenThread[] }
// a thread is closed when the live list has it (by threadId) resolved; a thread the live list lacks counts as open (the read is a snapshot, not an oracle)
```

- [ ] **Step 1: Failing test**: two addressed threads, the live list resolving one → `open` holds the other, `closed` the resolved one; a thread missing from the live list stays open.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm check` → PASS. **Step 5: Commit** `Tell addressed threads still open from those already closed`.

### Task 5: The object

**Files:** Modify `src/pull-request.ts`; read in review (no object-level tests).

- `#answering: { deliveryId: string; thread: ReviewThread; rootId: number; resolved: boolean } | undefined`, set by `answer()` for a thread reply before the prompt and cleared in its `finally`.
- `answer()`: for a thread reply, `const pr = await this.freshPullRequest()` (a transient throw reaches the door; a final one falls back to `this.pullRequest()`), `const stored = await this.storedFindings([rootId])`, and the prompt gets `severity`, `title` (the stored finding's, else undefined) and `headSha: pr.head.sha`. After the prompt: if `#answering.resolved` → reply, then `await this.evaluateApproval("resolve", incoming.deliveryId, new Set([thread.id]))`; else read the thread live (`threadFor`); if resolved → `log("answer.skipped", …)` and no reply; else reply as today.
- `resolveThread(args, conversationId)` on the host: `answeringGuard(await this.runningRootOperation(), this.#answering?.deliveryId)` → refuse; `evidenceProblem` → refuse; `#answering.resolved` → `resolved_by_this_answer`; read the thread live (`threadFor`), resolved → `already_resolved`; `resolveReviewThread(thread.id)`; a `GitHubError` on either call → `unreachable`; on success set `resolved = true`, `log("thread.resolved", …)`, answer `resolveOutcomeText`.
- `resolveAddressed`: `const { open, closed } = stillOpen(threads, await github.listReviewThreads(key, key.number))`; log `review.resolve_skipped` per closed; resolve `open`; `review.resolved` logs `attempted: threads.length`.

- [ ] **Step 1: Implement.** **Step 2: Run** `pnpm check` → PASS. **Step 3: Commit** `Let the answer session resolve its thread, and reply once`.

### Task 6: Docs

**Files:** `docs/design.md` (the object's thread re-check rule under "Review pipeline" or where `threadsToRecheck` is described; the answer's tool and the three events; the answer skill version), the phase 4 spec unchanged.

- [ ] **Step 1: Edit.** **Step 2: Run** `pnpm check` → PASS. **Step 3: Commit** `Describe the wider re-check, resolve_thread and the one-reply rule`.

### Task 7: Live check, after the deploy

A fixture pull request on this repository with two planted findings (a missing test the review asks for; a nitpick andabot can be argued out of): a push adding the test further down the file resolves the first with one "Fixed in" reply; a reply arguing the second away gets a withdrawal resolved by the tool with one reply; a "Fixed in `sha`" reply on a thread whose fix is absent gets a reply saying what is still wrong and no resolution. Post the events (`thread.resolved`, `review.resolve_skipped`, `answer.skipped`) and the replies on #123.

- [ ] **Step 1:** after merge and deploy, build the fixture, run the three cases, read the tail, comment on #123.
