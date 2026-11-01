# Summary Tidy-Up Implementation Plan (slice 7: #119, #50, #126)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The summary comment says what the push did (`changes_since`, thread handles linked), how long the review took, and in correct plurals; walkthrough rows outside the reviewable set are dropped on every path; the approval retitles the check run.

**Architecture:** Pure helpers in `src/review/` (a plural function, `rowsWithin`, `linkThreads`, `approvedCheckRun`, `elapsedSeconds`) with the object wiring in `src/pull-request.ts`; one new optional field on `ReviewSubmission`, one on `ReviewedRecord`, two on the stored records (`openedAt`, `checkRunId`). Every stored record stays parseable without the new fields.

**Tech Stack:** TypeScript on Cloudflare Workers, TypeBox schemas, vitest, oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-10-29-reviews-that-hold-up-design.md`, section "Slice 7, #119, #50 and #126".

## Global Constraints

- `pnpm check` green after every task; `pnpm format` before each commit.
- `CLAUDE.md`: no comments of any kind, no `as` but `as const`, parse boundary data with TypeBox + `Value.Check`, complexity ≤ 10, anti-slop rules, never a disable comment.
- New record fields are `Type.Optional`; a record from before the slice parses and renders as today.
- Copy fixed by the spec: "in 34.8 s", "Resolved 1 thread." / "Resolved 0 threads.", "1 finding was dropped" / "2 findings were dropped", "1 blocking finding couldn't be posted inline and holds approval back:" / "2 blocking findings couldn't be posted inline and hold approval back:", "1 suggestion" / "2 suggestions", "1 nitpick" / "2 nitpicks", "1 major finding worth fixing", "1 blocking finding to address before approval", "Posted review 12 (APPROVE) with 1 inline comment." / "2 inline comments.", "1 finding that still failed the checks was dropped." / "2 findings … were dropped."; the check-run summary on approval: "Approved once the checks passed; the summary comment has the review."
- The review skill becomes version 13.

## Review Focus

1. A `changes_since` on a full review is ignored, and a full review's Since-less record is unchanged.
2. Handle rewriting: `T1` must not rewrite inside `T10`, `T1a` or a URL; two handles in one sentence both link; a handle that names no listed thread is left as written.
3. An approval on a posted record without `counts` titles the run "Approved"; one without `checkRunId` logs nothing and changes only `shown`.
4. A `reviewed` record from before `seconds` renders the footer exactly as today; a `summary` command keeps the record's `seconds`.
5. A written row whose path carries a leading `./` or backticks is matched through `rowPath` before the reviewable-set filter, so the normalisation `summarizedRows` already does is not lost.

---

### Task 1: one plural helper for every reader-facing count

**Files:**
- Create: `src/review/copy.ts`
- Modify: `src/review/render.ts:176-196` (status line, dropped line), `:207-218` (Since footer), `:473-492` (held back), `:517-525` (counts line); `src/review/check.ts:124-126` (`counted`); `src/pull-request.ts:1276-1283` (the submit tool's reply)
- Test: `test/copy.test.ts` (create), `test/findings.test.ts` (render), `test/check.test.ts`

**Interfaces:**
- Produces: `export function plural(count: number, noun: string, plurals = \`${noun}s\`): string` → `"1 thread"`, `"0 threads"`; `export function were(count: number): "was" | "were"`.

- [x] **Step 1: Write the failing tests.** `test/copy.test.ts`: `plural(1, "thread")` → `"1 thread"`, `plural(0, "thread")` → `"0 threads"`, `plural(2, "finding")` → `"2 findings"`, `were(1)` → `"was"`, `were(3)` → `"were"`. In `test/findings.test.ts` (describe `renderSummaryComment`): the status line with one suggestion and one nitpick reads `· 🟡 1 suggestion · ⚪ 1 nitpick`; the Since footer reads `Resolved 1 thread.` and `Resolved 0 threads.` (update the two existing assertions at ~1131 and ~1170); the dropped line reads `1 finding was dropped because` and `2 findings were dropped because`; held back reads `1 blocking finding couldn't be posted inline and holds approval back:` and `2 blocking findings couldn't be posted inline and hold approval back:`; `countsLine` (through the review body) reads `1 blocking finding to address before approval, 1 major finding worth fixing, 1 suggestion, 2 nitpicks.`. In `test/check.test.ts` the title with one suggestion still reads `1 suggestion` (pins the shared helper).
- [x] **Step 2: Run them.** `pnpm vitest run test/copy.test.ts test/findings.test.ts test/check.test.ts` — Expected: FAIL (`plural` not found; copy mismatches).
- [x] **Step 3: Implement.** `copy.ts` with `plural` and `were`; `render.ts` uses them at the five sites (the status line keeps `🔴 N blocking · 🟠 N major`); `check.ts` deletes `counted` and imports `plural`; `pull-request.ts` reply: `` `Posted review ${review.id} (${event}) with ${plural(n, "inline comment")}.` `` and `` ` ${plural(d, "finding")} that still failed the checks ${were(d)} dropped.` ``.
- [x] **Step 4: Run.** Same command — Expected: PASS; then `pnpm check` green.
- [x] **Step 5: Commit.** `git add src/review/copy.ts src/review/render.ts src/review/check.ts src/pull-request.ts test/copy.test.ts test/findings.test.ts test/check.test.ts && git commit -m "Say one thread and two threads: one plural helper for every count the reader sees"`.

---

### Task 2: rows outside the reviewable set are dropped on every path, and the skill says what a row is

**Files:**
- Modify: `src/review/findings.ts:459-468` (beside `rowPath`), `src/review/summary.ts:71-85`, `src/review/incremental.ts:144-153` and `:532-560` (`NextReviewedInput`, `nextReviewed`), `src/pull-request.ts:1199-1208` and `:2620-2633`, `skills/review/SKILL.md:5,26`
- Test: `test/findings.test.ts`, `test/summary.test.ts`, `test/incremental.test.ts`, `test/skills.test.ts:35`

**Interfaces:**
- Produces: `export function rowsWithin(rows: readonly WalkthroughInput[], files: readonly ChangedFile[]): WalkthroughInput[]` in `findings.ts` (keeps, in order, the rows whose `rowPath(row.path)` is a `file.filename`; the returned rows carry the normalised path). `NextReviewedInput` gains `files: readonly ChangedFile[]` (the reviewable files).

- [x] **Step 1: Failing tests.** `rowsWithin` keeps `src/a.ts` and drops `vendor/x.js` when only `src/a.ts` is reviewable, and matches `` `./src/a.ts` `` through `rowPath`. `summarizedRecord` with a written row for a file outside `files` leaves it out (and keeps the stored-row behaviour). `nextReviewed` full mode drops a written row for a file not in `files`; incremental mode drops it before the merge. `test/skills.test.ts` expects version `"13"` and the body to contain `never what the review did or saw there`.
- [x] **Step 2: Run** `pnpm vitest run test/findings.test.ts test/summary.test.ts test/incremental.test.ts test/skills.test.ts` — Expected: FAIL.
- [x] **Step 3: Implement.** `rowsWithin`; `summarizedRows` applies it to `written`; `storeSummary` with no record returns `{ ...answer, walkthrough: rowsWithin(answer.walkthrough, files) }`; `nextReviewed` takes `files` and filters `submission.walkthrough` in both branches; the object passes `files` (the reviewable list it already holds) at the `nextReviewed` call. `SKILL.md` line 26 becomes "Note the file's walkthrough row for `submit_review`: one sentence on what changed in the file, never what the review did or saw there. Every changed file gets a row; …"; `metadata.version: "13"`.
- [x] **Step 4: Run** — Expected: PASS; `pnpm check` green.
- [x] **Step 5: Commit.** `git commit -m "Drop a walkthrough row for a file the filters leave out, on the summary and the review, and say what a row is"` with the touched paths.

---

### Task 3: `changes_since`, refused once, and thread handles linked

**Files:**
- Modify: `src/review/findings.ts:112-125` (`ReviewSubmission`), `src/review/prompt.ts:36-39,90-100,268-296` (request sentence, `problemsText`), `src/review/incremental.ts` (`linkThreads`, `nextReviewed`), `src/review/tools.ts:197` (submit_review description), `src/pull-request.ts:937-950` (submit path), `:1199-1208`
- Test: `test/findings.test.ts`, `test/prompt.test.ts`, `test/incremental.test.ts`, `test/tools.test.ts`

**Interfaces:**
- `ReviewSubmission.changes_since: Type.Optional(Type.String({ description: "In an incremental review, two to five sentences on what the new commits since the last review do. Markdown." }))`.
- `export function changesSinceMissing(submission: ReviewSubmissionInput, scope: ReviewScope): boolean` in `findings.ts` (incremental mode and the field absent or blank).
- `problemsText(rejected, missing, reasons, changesSinceMissing = false)` adds the paragraph "An incremental review needs `changes_since`: two to five sentences on what the new commits since the last review do. Add it, then call submit_review again with the whole review." when the flag is set.
- `export function linkThreads(text: string, threads: readonly OpenThread[], linkOf: (thread: OpenThread) => string): string` in `incremental.ts`: each whole-word handle (`\bT\d+\b` not followed by a word character) that names a thread becomes `[<title on one line, clipped to 80 characters>](<linkOf(thread)>)`.
- `export function threadLink(repo: string, number: number, thread: OpenThread): string` → `https://github.com/${repo}/pull/${number}#discussion_r${thread.firstCommentId}`.
- `NextReviewedInput` gains `linkOf: (thread: OpenThread) => string`; the Since text is `linkThreads(submission.changes_since ?? submission.summary, [...scope.recheck, ...threadLists(scope.open, scope.recheck).otherThreads], linkOf)`.
- The incremental request sentence gains: "Put what the new commits do in `changes_since`; `summary` still describes the pull request."

- [x] **Step 1: Failing tests.** Schema accepts and omits `changes_since`; `changesSinceMissing` is true in incremental mode for a missing and a blank field, false in full mode; `problemsText` with the flag names the field and without it doesn't; `linkThreads` on `"Fixes T1 and T2; T10 is untouched."` with threads T1 ("Null total", first comment 5) and T2 links both and leaves `T10`; a handle inside `T1a` or inside a URL is left; `nextReviewed` incremental writes `since.summary` from `changes_since` with the links and falls back to `summary` when the field is absent; `nextReviewed` full mode ignores the field; the incremental prompt contains the new sentence and the full prompt doesn't; the submit_review description names `changes_since`.
- [x] **Step 2: Run** `pnpm vitest run test/findings.test.ts test/prompt.test.ts test/incremental.test.ts test/tools.test.ts` — Expected: FAIL.
- [x] **Step 3: Implement.** The schema field; `changesSinceMissing`; `problemsText`'s paragraph; in `submitReview`, `problems` includes `changesSinceMissing(submission, checked.scope)` and the text is passed the flag; on the second submission with it still missing the review proceeds and logs `review.changes_since_missing` with `number` and `head`; `linkThreads`, `threadLink`; `nextReviewed` as above; the object passes `linkOf: (thread) => threadLink(pr.base.repo.full_name, pr.number, thread)`; the prompt sentence; the tool description adds "an incremental review also says what the new commits do in `changes_since`".
- [x] **Step 4: Run** — Expected: PASS; `pnpm check` green.
- [x] **Step 5: Commit.** `git commit -m "Ask an incremental review what the new commits do, and link the threads its Since text names"`.

---

### Task 4: how long the review took

**Files:**
- Modify: `src/review/flight.ts:8-24,66-68` (`StoredPending.openedAt`, `resumedPending`), `src/review/incremental.ts:48-60,144-153,532-560` (`ReviewedRecord.seconds`, `nextReviewed`), `src/review/summary.ts:52-70` (`summarizedRecord` copies `seconds`), `src/review/render.ts:70-105,336-347` (`seconds` input, footer), `src/pull-request.ts:1199-1225` (record and render), `:1424-1440` (first pending write), `:1837-1848` (`review.done`), every `renderSummaryComment` call (grep), `:2620-2633`
- Test: `test/flight.test.ts`, `test/incremental.test.ts`, `test/summary.test.ts`, `test/findings.test.ts`

**Interfaces:**
- `StoredPending.openedAt: Type.Optional(Type.Integer())`, set once with the first pending write (`openedAt: run.started`), untouched by `restartGrace` (which spreads the record) and by `resumedPending`.
- `export function elapsedSeconds(from: number, now: number): number` in `flight.ts` → `Math.round((now - from) / 100) / 10`.
- `ReviewedRecord.seconds: Type.Optional(Type.Number())`; `NextReviewedInput.seconds: number | undefined`; `renderSummaryComment` input `seconds?: number | undefined`; `reviewedBy(model, skills, repo, verify, seconds)` ends `` ` in ${seconds} s.` `` when given (`in 34.8 s.`, `in 35 s.` for a whole number).
- `review.done` logs `seconds: elapsedSeconds(pending.openedAt ?? run.started, Date.now())` and no `ms`.

- [x] **Step 1: Failing tests.** `elapsedSeconds(0, 34_760)` → `34.8`, `(0, 35_040)` → `35`; `resumedPending` keeps `openedAt`; `migratePending` leaves a record without it; `nextReviewed` writes `seconds` in both modes and leaves it out when undefined; `summarizedRecord` copies `seconds`; the footer reads `<sub>Reviewed by \`m\` with skills \`review@…\` in 34.8 s.</sub>` with `seconds` and exactly today's text without.
- [x] **Step 2: Run** `pnpm vitest run test/flight.test.ts test/incremental.test.ts test/summary.test.ts test/findings.test.ts` — Expected: FAIL.
- [x] **Step 3: Implement** as the interfaces say; the object's one `renderSummaryComment` call (the review's post) passes the record's `seconds`; the approval's verdict rewrite patches the comment text in place and keeps the footer, and the `summary` command renders its own "Summarized by" footer, so no other call changes.
- [x] **Step 4: Run** — Expected: PASS; `pnpm check` green.
- [x] **Step 5: Commit.** `git commit -m "Say how long each review took, in review.done and in the footer"`.

---

### Task 5: the approval retitles the check run and marks the posted record

**Files:**
- Modify: `src/records.ts:45-58` (`PostedReview.checkRunId`), `src/review/check.ts` (`approvedCheckRun`), `src/review/approval.ts` (`approvedPosted`), `src/pull-request.ts:1257-1270` (write `checkRunId`), `:2743-2762` (`submitApproval`)
- Test: `test/check.test.ts`, `test/approval.test.ts`, `test/records.test.ts`

**Interfaces:**
- `PostedReview.checkRunId: Type.Optional(Type.Integer())`, written from `pending.checkRunId` where the review posts.
- `export function approvedCheckRun(posted: Pick<PostedReview, "counts" | "unverified">, detailsUrl: string | undefined, completedAt: number): UpdateCheckRun` in `check.ts`: title `markedUnverified(checkRunTitle("APPROVE", posted.counts ?? { blocking: 0, major: 0, suggestion: 0, nitpick: 0 }), posted.unverified === true)`, summary "Approved once the checks passed; the summary comment has the review.", conclusion `success`, `completed_at` from `completedAt`.
- `export function approvedPosted(posted: PostedReview): PostedReview` in `approval.ts` → `{ ...posted, shown: "APPROVE" }`.
- `submitApproval`, after `rewriteSummaryVerdict`: reads `posted:${head}`; when it parses, writes `approvedPosted(posted)` back and, when `checkRunId` is set, calls `updateCheckRun(key, checkRunId, approvedCheckRun(posted, await this.summaryCommentUrl(), Date.now()))` inside try/catch that logs `approval.check_run_failed` with `head`, `checkRunId` and `error`.

- [x] **Step 1: Failing tests.** `PostedReview` parses with and without `checkRunId`; `approvedCheckRun` with counts `{blocking: 0, major: 0, suggestion: 1, nitpick: 2}` titles `Approved: 1 suggestion, 2 nitpicks`, with no counts `Approved`, with `unverified` `… (unverified)`, summary text as fixed, `details_url` passed through; `approvedPosted` sets `shown` to `APPROVE` and keeps the rest; `postedEarlierCheckRun(approvedPosted(posted), …)` titles `Approved…`.
- [x] **Step 2: Run** `pnpm vitest run test/check.test.ts test/approval.test.ts test/records.test.ts` — Expected: FAIL.
- [x] **Step 3: Implement** as above.
- [x] **Step 4: Run** — Expected: PASS; `pnpm check` green.
- [x] **Step 5: Commit.** `git commit -m "Retitle the check run and mark the posted record when the evaluation approves"`.

---

### Task 6: docs

**Files:**
- Modify: `docs/design.md:189` (summary comment paragraph: the Since text comes from `changes_since`, handles become links; written rows outside the reviewable set are dropped), `:191` (`summary` keeps `seconds`), `:224` (the footer ends "in 34.8 s"), `:246` ("The check run keeps the review's title" → the approval retitles it to "Approved: …" and marks the posted record), `:323` (`path_filters`: a written row for a filtered file is dropped on the summary and the review), the `reviewed`/`posted` record entries (`seconds`, `checkRunId`, `openedAt`); the plan's boxes.
- [x] **Step 1: Edit the paragraphs**; `pnpm format`; `pnpm check`.
- [x] **Step 2: Commit.** `git commit -m "Describe the Since text, the thread links, the footer's time and the approval's retitle"`.

---

### Task 7: after merge and deploy, the first real pull request

- [ ] **Step 1:** After the merge Andrew deploys main (or allows the deploy); record the previous version id as the rollback target.
- [ ] **Step 2:** On the first real pull request with an incremental review and an approval, check the summary comment (Since text from `changes_since`, linked threads, "in N s", plurals) and the check run's title after the approval; read `review.done`'s `seconds` from Workers Logs.
- [ ] **Step 3:** Post the result on #119, #50 and #126 and close them.
