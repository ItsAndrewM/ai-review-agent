# Incremental Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a push, andabot reviews only the commits since its last review, never repeats an open thread, and resolves the threads the push fixed. `@andabot full review` and Re-run start over.

**Architecture:** A pure module, `src/review/incremental.ts`, picks the mode (`fresh`, `full` or `incremental`), computes the covered files and marked lines, lists the bot's open threads, and filters validated findings by the delta. New GitHub client calls fetch the compare, the threads, and the posted comments, and reply and resolve. The object plans the review at run start, stores the plan as one `scope` record, applies it in `postReview`, and records `reviewed` and `finding:<commentId>` afterwards.

**Tech Stack:** TypeScript on Cloudflare Workers and Durable Objects, Pi Durable through `agents/harness/pi`, TypeBox, vitest, the GitHub REST and GraphQL APIs.

**Spec:** `docs/superpowers/specs/2026-10-19-incremental-review-design.md`

## Global Constraints

- `pnpm format && pnpm check` passes before every commit: oxlint, oxfmt, both `tsc` configs and vitest.
- `CLAUDE.md` rules apply:
  - no comments;
  - no type assertions except `as const`;
  - every GitHub response, including GraphQL, and every stored record (`reviewed`, `finding:<id>`, `scope`) is parsed with TypeBox and `Value.Check`;
  - complexity at most 10 per function;
  - the anti-slop rules;
  - no `vi.mock`. Client tests use a local `node:http` server, as `test/client.test.ts` does.
- Design reasons go in `docs/design.md`, never in code.
- `agents` stays 0.28.1 and `@earendil-works/pi-durable` stays 1.3.0. No new runtime dependency.
- Commit messages are one descriptive sentence with no conventional-commit prefix.
- The PR body says "Part of #24" and never puts a closing keyword before `#24`, because the live check has to pass first.

## Review Focus

1. **Many open threads.** PR #9 has 42 open andabot threads. The thread lists cap at 30, with a note naming how many were left out. Test in Task 3.
2. **A push that only merges the base branch in.** No PR file is covered, so there is no model call, no review is posted, and the run completes as "No changes to review since `abc1234`". Tested as `coveredFiles` coming back empty in Task 3; the wiring in Task 6.
3. **Threads andabot didn't open,** whether a person's or CodeRabbit's (a `Bot` with another login). They are never listed, re-checked or resolved. Test in Task 3.
4. **A changed file with no patch** (binary or too large). It has no marked lines, so it isn't covered. Test in Task 2.
5. **The threads query fails** (rate limit, outage). The thread lists are empty and nothing is resolved. Open blocking threads count as unknown, so the review never approves. Test in Task 4.

---

### Task 1: GitHub client calls for compare, threads, posted comments, reply and resolve

**Files:**
- Modify: `src/github/client.ts`
- Create: `test/client-threads.test.ts`, with a local server whose reply body each test sets.

**Interfaces:**
- Produces:
  - `type CompareStatus = "ahead" | "behind" | "diverged" | "identical"`
  - `interface Comparison { status: CompareStatus; files: ChangedFile[] }`
  - `compareCommits(ref: RepoRef, base: string, head: string): Promise<Comparison>` calls `GET /repos/{o}/{r}/compare/{base}...{head}`. A missing `files` reads as `[]`.
  - `interface PostedComment { id: number; reviewId: number; path: string; line: number | null; side: Side | null }`
  - `listReviewComments(ref: RepoRef, number: number, reviewId: number): Promise<PostedComment[]>` calls `GET /pulls/{n}/comments?per_page=100`, paginated up to 10 pages, filtered by `pull_request_review_id`. The per-review endpoint returns `line: null`, so it can't be used.
  - `interface ReviewThread { id: string; resolved: boolean; outdated: boolean; path: string; line: number | null; side: Side; firstCommentId: number; firstCommentBody: string; authorLogin: string | null; authorIsBot: boolean }`
  - `listReviewThreads(ref: RepoRef, number: number): Promise<ReviewThread[]>` posts GraphQL `reviewThreads(first: 100, after: $cursor)` with `id isResolved isOutdated path line diffSide comments(first: 1) { nodes { databaseId body author { login __typename } } }`, up to 5 pages.
  - `replyToReviewComment(ref: RepoRef, number: number, commentId: number, body: string): Promise<{ id: number }>` calls `POST /pulls/{n}/comments/{commentId}/replies`.
  - `resolveReviewThread(threadId: string): Promise<void>` posts the GraphQL `resolveReviewThread(input: { threadId })` mutation.
  - A private `graphql(schema, query, variables)` posts `{ query, variables }` to `${apiBase}/graphql`. It throws when the response has an `errors` array, or when it fails its schema.

- [ ] **Step 1: Write the failing tests** in `test/client-threads.test.ts`:
  - `compares with a three-dot GET and keeps status and files`: reply `{ status: "ahead", files: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b" }] }`. Expect the URL `/repos/o/r/compare/aaa...bbb` and the result `{ status: "ahead", files: [<that file>] }`.
  - `rejects a compare status GitHub never sends`: reply `{ status: "weird", files: [] }`, and expect it to reject with `/unexpected response/`.
  - `lists a review's comments with their lines from the PR-wide list`: reply two comments with `pull_request_review_id` 7 and 8. Expect only review 7's, mapped to `{ id, reviewId: 7, path, line, side }`.
  - `pages through review threads and flattens the first comment`: the first reply has `hasNextPage: true` and `endCursor: "c1"`, the second `false`. Expect two GraphQL POSTs to `/graphql`, the second with `variables.cursor === "c1"`, and the flattened `ReviewThread` fields (`authorIsBot: true` for `__typename: "Bot"`).
  - `replies to a review comment with a POST to its replies`: expect the URL `/repos/o/r/pulls/5/comments/99/replies` and the body `{ body: "Fixed in \`def5678\`." }`.
  - `resolves a thread with the GraphQL mutation and throws on GraphQL errors`: an `errors: [{ message: "nope" }]` reply rejects with `/nope/`.
- [ ] **Step 2:** Run `pnpm vitest run test/client-threads.test.ts`. Expected: FAIL, because the methods are not defined.
- [ ] **Step 3: Implement** the methods above in `src/github/client.ts`, with TypeBox schemas for each response, following `json()`.
- [ ] **Step 4:** Run `pnpm vitest run test/client-threads.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** "Add the compare, review thread, review comment, reply and resolve calls to the GitHub client".

### Task 2: Delta lines and marked patches

**Files:**
- Modify: `src/github/diff.ts`. Move `comparable(text)` here from `src/review/findings.ts` and export it as `comparableText`. `findings.ts` imports it.
- Test: `test/diff.test.ts`

**Interfaces:**
- Produces:
  - `interface DeltaLines { added: Set<number>; deletedTexts: Set<string> }`. `added` holds the RIGHT numbers of `+` lines; `deletedTexts` holds the `comparableText` of `-` lines.
  - `deltaLines(patch: string | undefined): DeltaLines`. An undefined patch gives empty sets.
  - `interface MarkedLines { right: Set<number>; left: Set<number> }`
  - `markedLines(pr: CommentableLines, delta: DeltaLines): MarkedLines`. RIGHT is `pr.right`'s keys in `delta.added`. LEFT is `pr.left`'s keys whose `comparableText` is in `delta.deletedTexts`.
  - `renderPatches(files, maxCharsPerFile = 40_000, marked?: ReadonlyMap<string, MarkedLines>)` puts `*` after the anchor of a marked line, as in `R12*`, keeping the column width.

- [ ] **Step 1: Write the failing tests:**
  - `deltaLines takes added lines by new number and deleted lines by text`;
  - `markedLines marks the PR's lines the delta added, and its deleted lines by text`, using an added file and a modified file;
  - `a file with no patch has no delta lines`;
  - `renderPatches stars marked anchors and leaves the others alone`: expect `"R2*    +const b = 3;"` and `"R1      const a = 1;"`.
- [ ] **Step 2:** Run `pnpm vitest run test/diff.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `deltaLines` walks `patchLines`. `markedLines` is set intersection.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS, including `test/findings.test.ts` after the `comparableText` move.
- [ ] **Step 5: Commit:** "Mark the pull request's lines that changed since the last review".

### Task 3: Choosing the mode, covered files and open threads

**Files:**
- Create: `src/review/incremental.ts`
- Test: `test/incremental.test.ts`

**Interfaces:**
- Consumes: `Comparison`, `ReviewThread` (Task 1); `DeltaLines`, `MarkedLines`, `deltaLines`, `markedLines`, `commentableLines` (Task 2); `Walkthrough` and `Severity` from `findings.ts`.
- Produces:
  - `type ReviewMode = "fresh" | "full" | "incremental"`
  - `const SinceSection` (TypeBox) `{ from, to, summary, files: string[], resolved: integer }`
  - `const ReviewedRecord` (TypeBox) `{ headSha, baseRef, at, mode, summary, walkthrough: Walkthrough[], since?: SinceSection }`. It keeps the base branch's name, so retargeting is detected. That swaps the spec's `baseSha` for `baseRef` (builder's call).
  - `const StoredFinding` (TypeBox) `{ severity, title, quote, path }`
  - `chooseMode(input: { full: boolean; reviewed: ReviewedRecord | undefined; baseRef: string; compareStatus: CompareStatus | undefined }): ReviewMode`. `compareStatus` is undefined when the compare failed or wasn't made.
  - `coveredFiles(prFiles: readonly ChangedFile[], delta: readonly ChangedFile[]): Map<string, MarkedLines>`. It keeps files in both lists that have at least one marked line.
  - `const OpenThread` is a TypeBox schema, with `type OpenThread = Static<typeof OpenThread>`, because `scope` stores it: `{ handle: string; threadId: string; firstCommentId: integer; path: string; line: integer | null; side: "LEFT" | "RIGHT"; outdated: boolean; title: string; quote?: string; blocking: boolean }`.
  - `openBotThreads(threads: readonly ReviewThread[], findings: ReadonlyMap<number, StoredFinding>, botLogin: string): { open: OpenThread[]; leftOut: number }`.
    - It keeps unresolved threads whose author is the bot: `authorIsBot` and `authorLogin === botLogin`.
    - Handles are `T1`, `T2`, … in input order, capped at `MOST_LISTED_THREADS = 30`.
    - Severity and title come from the stored finding. Otherwise they come from the first comment's label, which `severityOfComment(body)` and `titleOfComment(body)` parse from `**🔴 Blocking: <title>**`.
  - `threadsToRecheck(open: readonly OpenThread[], mode: ReviewMode, covered: ReadonlyMap<string, MarkedLines>): OpenThread[]`.
    - `incremental`: outdated threads, plus threads whose current line is marked on their side in a covered file.
    - `full`: outdated threads only.
    - `fresh`: none.

- [ ] **Step 1: Write the failing tests:**
  - **`chooseMode`:** a `full` request gives `fresh`; no record gives `full`; `diverged`, `behind`, `identical` and undefined give `full`; a different `baseRef` gives `full`; `ahead` with the same base gives `incremental`.
  - `coveredFiles skips a file only the compare changed, as a merge from the base would`;
  - `openBotThreads keeps only the bot's unresolved threads and ignores a person's and CodeRabbit's`;
  - `openBotThreads caps the list at 30 and counts the rest`;
  - `openBotThreads reads severity from the stored finding, else from the comment's label`;
  - `threadsToRecheck takes outdated threads and those on marked lines, and only outdated ones in a full review`.
- [ ] **Step 2:** Run `pnpm vitest run test/incremental.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** these in `src/review/incremental.ts`, each function under complexity 10.
- [ ] **Step 4:** Run `pnpm vitest run test/incremental.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** "Choose between a fresh, full or incremental review and list the bot's open threads".

### Task 4: Delta policy, addressed threads, and the event

**Files:**
- Modify: `src/review/incremental.ts`, `src/review/render.ts`, `src/review/findings.ts`
- Test: `test/incremental.test.ts`, `test/findings.test.ts`

**Interfaces:**
- Consumes: `ValidatedReview`, `Rejected` and `FindingInput` (`findings.ts`); `OpenThread`, `ReviewMode` and `MarkedLines` (Tasks 2 and 3).
- Produces:
  - `ReviewSubmission` gains `addressed_threads: Type.Optional(Type.Array(Type.String({ description: "A handle from the threads to re-check, such as T2, whose problem the new changes fix." })))`.
  - `interface DeltaScope { mode: ReviewMode; covered: ReadonlyMap<string, MarkedLines>; open: readonly OpenThread[] }`
  - `interface ScopedReview { accepted: FindingInput[]; rejected: Rejected[]; duplicates: Rejected[] }`
  - `applyDeltaPolicy(validated: ValidatedReview, scope: DeltaScope): ScopedReview`. The reasons are verbatim:
    - "line N was not changed since the last review; only a blocking finding may go elsewhere";
    - "duplicates open thread Tn".

    A duplicate is a finding on the same path, side and current line as an open thread, or whose `comparableText` quote equals that thread's stored quote. `fresh` passes everything through.
  - `addressedThreads(handles: readonly string[] | undefined, recheck: readonly OpenThread[]): { resolve: OpenThread[]; unknown: string[] }`
  - `chooseReviewEvent(submission, accepted, rejected, requestChangesWorkflow, openBlocking?: number | "unknown")`.
    - With the workflow on, `openBlocking > 0` gives `REQUEST_CHANGES`.
    - `"unknown"` never gives `APPROVE`; it gives `COMMENT` unless a finding is blocking.
    - Undefined keeps today's rule; that's `fresh`.

- [ ] **Step 1: Write the failing tests:**
  - `applyDeltaPolicy rejects a non-blocking finding off the marked lines and keeps a blocking one`;
  - `applyDeltaPolicy sets aside a duplicate of an open thread by line or by quote`;
  - `applyDeltaPolicy passes a fresh review through untouched`;
  - `addressedThreads resolves only handles from the re-check list`;
  - **`chooseReviewEvent`:** it requests changes while a blocking thread stays open, never approves when open threads are unknown, and keeps today's rule without them;
  - in `findings.test.ts`: `parseWrittenReview accepts addressed_threads`.
- [ ] **Step 2:** Run `pnpm vitest run test/incremental.test.ts test/findings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** "Keep an incremental review to the new lines, set aside duplicates of open threads, and hold approval while a blocking thread is open".

### Task 5: Prompts, the review body, the summary and the skill

**Files:**
- Modify: `src/review/prompt.ts`, `src/review/render.ts`, `src/review/check.ts`, `skills/review/SKILL.md` (`metadata.version` goes to "2"), `src/commands.ts` (the help text)
- Test: `test/prompt.test.ts`, `test/findings.test.ts`, `test/check.test.ts`, `test/commands.test.ts`, `test/skills.test.ts` if it pins the version

**Interfaces:**
- Consumes: `OpenThread`, `MarkedLines`, `SinceSection` and `ReviewMode` (Tasks 2–4).
- Produces:
  - `incrementalPrompt(pr: PullRequestInfo, input: { from: string; covered: readonly ChangedFile[]; marked: ReadonlyMap<string, MarkedLines>; others: readonly ChangedFile[]; recheck: readonly OpenThread[]; open: readonly OpenThread[]; leftOut: number }): string`. It has:
    - the range `from..head`;
    - the legend: "A `*` after an anchor marks a line changed since your last review. Comment only on marked lines, except for a blocking bug the new changes cause elsewhere in the diff.";
    - the covered patches, via `renderPatches(covered, undefined, marked)`;
    - the other files by name, marked "unchanged since the last review; read_file if needed";
    - two thread lists, "Threads to re-check" and "Other open threads", with lines like `T1 src/x.ts:12 — <title> — code: \`<quote>\``, or `(outdated)` in place of the line number.
  - `fullPrompt(pr, files, lists: { recheck; open; leftOut }): string` is today's `reviewPrompt(pr, files, false)` plus the two lists.
  - `interface Coverage { mode: ReviewMode; from?: string; to: string; files: number; resolved: number }`
  - `renderReviewBody(event, accepted, rejected, coverage?: Coverage)` appends `<sub>Incremental review of \`abc1234..def5678\`: 3 files; 2 threads resolved.</sub>`, or `<sub>Full review.</sub>`.
  - `renderSummaryComment` input gains `since?: SinceSection`, rendered after the walkthrough as `### Since \`abc1234\``: the summary, the files and "Resolved N thread(s).".
  - `mergeWalkthrough(stored: readonly Walkthrough[], incoming: readonly Walkthrough[], covered: ReadonlySet<string>): Walkthrough[]`
  - `unchangedCheckRun(sinceSha: string, completedAt: number): UpdateCheckRun` has `success` and the title "No changes to review since `abc1234`".
  - Help text: `@andabot full review`: "start over: review the whole pull request again, ignoring earlier reviews."

- [ ] **Step 1: Write the failing tests** for each producer above, asserting the exact strings shown.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.** Add one paragraph to the skill, under "3. Record findings":
  > In an incremental review, comment only on lines marked `*`, except for a blocking bug the new changes cause elsewhere in the diff. List in `addressed_threads` each thread to re-check whose problem the new changes fix. Don't repeat an open thread.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** "Prompt, report and summarize incremental reviews, and say that full review starts over".

### Task 6: Wire it into the object

**Files:**
- Modify: `src/pull-request.ts`, `docs/design.md`. In the design doc:
  - the Review pipeline's incremental paragraph describes the shipped behaviour;
  - the state list replaces `reviewed_head` and `bot_threads` with `reviewed`, `finding:<commentId>` and `scope`, with reasons;
  - the `pull_request` synchronize row stays "incremental".
- Test: none new. The Durable Object has no tests (`docs/design.md`, Tests), so the pure modules above carry the logic, and Task 7 is the live check.

**Interfaces:**
- Consumes: everything above.
- Produces:
  - The `scope` record, as TypeBox `ReviewScope`: `{ deliveryId, mode, from?, covered: { path, right: integer[], left: integer[] }[], recheck: OpenThread[], open: OpenThread[], leftOut, threadsKnown: boolean }`.
  - It is written after planning in `runReview`, read in `postReview` only while its `deliveryId` names the pending review, and deleted in `releasePending`.

- [ ] **Step 1: `planReview(pr, files, incoming, run): Promise<ReviewScope>`.**
  - It reads `reviewed`.
  - For a push with a record, it calls `compareCommits`, under a guard: a failure is logged and leaves `compareStatus` undefined. Then `chooseMode`.
  - For `incremental`, it computes `coveredFiles`.
  - Unless `fresh`, it reads the threads with `listReviewThreads` (a failure leaves `threadsKnown: false` and empty lists) and the stored `finding:<id>` records for their first comments, then `openBotThreads` and `threadsToRecheck`.
  - Call it in `runReview` after `openRun`. Log `review.start` with `mode`, `since`, `covered` and `recheck`.
- [ ] **Step 2: Nothing to review.** When the mode is `incremental` and no file is covered:
  - log `review.skip` with reason `no_new_changes`;
  - write `reviewed` with the new head, keeping its summary and walkthrough;
  - complete the run with `unchangedCheckRun`;
  - release the pending record, and make no model call.
- [ ] **Step 3: The prompt.** `fresh` uses `reviewPrompt(pr, files, true)`, `full` uses `fullPrompt`, and `incremental` uses `incrementalPrompt`.
- [ ] **Step 4: `postReview`.**
  - Run `applyDeltaPolicy` after `validateFindings`, and pass `rejected` plus `duplicates` to `rejectionsText`.
  - The event takes the `openBlocking` count after `addressedThreads`, or `"unknown"` when the threads weren't known.
  - The summary takes `mergeWalkthrough` and `since` in incremental mode.
  - After `createReview`, `listReviewComments` stores `finding:<id>` for each comment matched by path, line and side.
  - Then reply to and resolve each addressed thread, each call guarded. A failure logs `review.resolve_failed`; successes log `review.resolved` with a count.
  - Finally write `reviewed`, the posted record and the check run, as today.
  - Split it into private helpers, each under complexity 10.
- [ ] **Step 5:** Run `pnpm format && pnpm check`. Expected: PASS, with every existing test still green.
- [ ] **Step 6: Commit:** "Review each push incrementally, resolve the threads it fixed, and record what each review covered".

### Task 7: Live check and PR

- [ ] **Step 1:** Push the branch, and open a PR to `main` titled "Review only what changed since the last review on each push". The body says "Part of #24", gives the live-check steps, and says that merging deploys nothing.
- [ ] **Step 2: After Andrew merges and deploys**, wait about 8 minutes, then on a throwaway PR against `main`:
  - push a second commit, and check that only its commits are reviewed and that no open comment repeats;
  - push a fix for a flagged line, and check the reply "Fixed in `<sha>`." and that the thread resolves;
  - resolve a thread by hand, push, and check it's untouched;
  - force-push, and check for a full review that repeats no open thread;
  - send `@andabot full review`, and check that it starts over.

  Tail the logs for `review.start` (`mode`), `review.resolved` and `review.skip`. Comment the results on #24, and close it when they pass.
