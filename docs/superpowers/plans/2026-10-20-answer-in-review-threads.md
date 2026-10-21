# Answer Replies in Review Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reply under one of andabot's inline comments, or a review comment that mentions `@andabot`, gets its answer or runs its command in that review thread.

**Architecture:** The router routes `pull_request_review_comment` `created` events that mention the bot or reply in a thread. It passes the thread's ids, path, line and diff hunk to the pull request's Durable Object as a `comment` incoming with a `thread` field. The object looks the thread up with `listReviewThreads`. It treats an unmentioned reply as a question only when the thread's first comment is andabot's, prompts with the thread's context, and answers with `replyToReviewComment` under the thread's first comment.

**Tech Stack:** TypeScript on Cloudflare Workers and Durable Objects, TypeBox, vitest, GitHub REST and GraphQL.

**Spec:** issue #26, https://github.com/ItsAndrewM/ai-review-agent/issues/26

## Global Constraints

- **Lint (CLAUDE.md):**
  - no comments of any kind;
  - no type assertions except `as const`;
  - complexity at most 10 per function;
  - the anti-slop rules: no `unknown` or `object` parameters, no `typeof` checks, no `...(cond ? {...} : {})` spreads.
- **Parsing:** parse what crosses a boundary with TypeBox and `Value.Check`.
- **Who can command:** only users with write access (`canCommand`) make the bot act. The bot's own comments are ignored.
- **Replies:** go to `POST /repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies`, with the thread's top-level comment id. GitHub refuses replies to replies.
- **Checks:** `pnpm format`, then `pnpm check` passes, before every commit.

## Review Focus

1. **No write access:** a reply in andabot's thread from a user without write access gets no answer, and logs `command.ignored`, as an issue comment does. Task 2 adds `canCommand`'s first tests.
2. **A reply to a reply:** GitHub sets `in_reply_to_id` to the thread's first comment, so the answer goes under that first comment. Task 1's reply test pins `rootId`.
3. **Failed lookup:** when the thread lookup fails, a mention is still answered without the opening comment, and an unmentioned reply is ignored and logged. Task 2 tests an undefined thread.
4. **The bot's own reply:** it arrives as a `pull_request_review_comment` and must not loop. Task 1 tests it as "sent by a bot".
5. **Another bot's thread:** a reply in a thread another bot opened (CodeRabbit) is not andabot's. Task 2 tests a `Bot` author with a different login.

---

### Task 1: Route review comments to the pull request's object

**Files:**
- Modify: `src/route.ts`, adding `WebhookPayload.comment` fields, a branch in `routeEvent`, `routeReviewComment` and `mentions`.
- Modify: `src/pull-request.ts`, adding `ThreadContext` and `thread?` on the `comment` incoming.
- Test: `test/route.test.ts`.

**Interfaces:**
- Produces: `export interface ThreadContext { commentId: number; rootId: number; path: string; line: number | null; diffHunk: string }` in `src/pull-request.ts`. The `comment` variant of `Incoming` gains `thread?: ThreadContext`.
- `WebhookPayload.comment` gains these optional fields: `id` (Integer), `in_reply_to_id` (Integer), `path` (String), `line` (Integer or Null), and `diff_hunk` (String).

- [ ] **Step 1: Write the failing tests.** They live in `test/route.test.ts`, with a payload `reviewComment(comment)` that has `...base, action: "created", pull_request: { number: 3, head: { sha: "abc" } }`.
  - `it("accepts a review comment with its thread's fields")`: `Value.Check(WebhookPayload, reviewComment({ id: 11, in_reply_to_id: 7, body: "x", user: { login: "andrew" }, path: "src/a.ts", line: null, diff_hunk: "@@ -1 +1 @@" }))` is `true`.
  - `it("routes a review comment that mentions the bot, with its path, line and hunk")`: the comment `{ id: 11, body: "@andabot why?", user: { login: "andrew" }, path: "src/a.ts", line: 12, diff_hunk: "@@ -1 +1 @@" }` gives `incoming[0]` equal to `{ kind: "comment", key: { installationId: 99, owner: "ItsAndrewM", repo: "ai-review-agent", number: 3 }, deliveryId: "d1", author: "andrew", body: "@andabot why?", thread: { commentId: 11, rootId: 11, path: "src/a.ts", line: 12, diffHunk: "@@ -1 +1 @@" } }`.
  - `it("routes a reply in a review thread without a mention, for the object to check whose thread it is")`: with `in_reply_to_id: 7` and body `"why?"`, the thread is `{ commentId: 11, rootId: 7, … }`.
  - `it("ignores a top-level review comment that doesn't mention the bot")`: `{ kind: "ignore", reason: "no mention" }`.
  - `it("ignores an edited review comment")`: `action: "edited"` gives the reason `"pull_request_review_comment edited"`.
  - `it("ignores the bot's own reply in a thread")`: `sender: { login: "andabot[bot]", type: "Bot" }` gives the reason `"sent by a bot"`.
- [ ] **Step 2: Run** `pnpm exec vitest run test/route.test.ts`. Expected: the routing tests FAIL, routed as `"event pull_request_review_comment"`.
- [ ] **Step 3: Implement.** Add `routeReviewComment(pullRequest: PullRequestEvent, comment: CommentEvent, delivery: Delivery, botLogin: string): Routed` in `src/route.ts`, and one `pull_request_review_comment` branch in `routeEvent`.
  - Ignore with `"review comment without its thread"` when `id`, `path` or `diff_hunk` is missing.
  - Share the mention test with `routeComment` through `mentions(body: string, botLogin: string): boolean`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** "Route review comments that mention andabot or reply in a thread to the pull request's object (#26)".

### Task 2: Decide which thread comments andabot answers

**Files:**
- Create: `src/review/thread-question.ts`.
- Test: `test/thread-question.test.ts` and `test/client.test.ts`, where `canCommand` gets its tests.

**Interfaces:**
- Consumes: `ReviewThread` from `src/github/client.ts`, and `Command` and `parseCommand` from `src/commands.ts`.
- Produces: `export function threadOf(threads: readonly ReviewThread[], rootId: number): ReviewThread | undefined`, which matches on `firstCommentId`.
- Produces: `export function commandInThread(body: string, botLogin: string, thread: ReviewThread | undefined): Command | undefined`.
  - A mention parses as `parseCommand` does.
  - Without a mention, a non-blank body in a thread whose `authorIsBot && authorLogin === botLogin` is `{ kind: "chat", text: body.trim() }`.
  - Anything else is `undefined`.

- [ ] **Step 1: Write the failing tests.** They use `botThread` (`authorIsBot: true, authorLogin: "andabot", firstCommentId: 7`), `humanThread` (`authorIsBot: false, authorLogin: "andrew"`) and `otherBotThread` (`authorIsBot: true, authorLogin: "coderabbitai"`).
  - `it("answers a reply in andabot's thread that doesn't mention it")`: `commandInThread(" why is this a problem? ", "andabot", botThread)` gives `{ kind: "chat", text: "why is this a problem?" }`.
  - `it("ignores a reply in someone else's thread that doesn't mention andabot")`: `humanThread` and `otherBotThread` both give `undefined`.
  - `it("takes a mention as a command in any thread")`: `"@andabot full review"` with `humanThread` gives `{ kind: "review", full: true }`.
  - `it("ignores an unmentioned reply when the thread couldn't be looked up")`: a `thread` of `undefined` gives `undefined`.
  - `it("ignores a blank reply in andabot's thread")`: `"  "` gives `undefined`.
  - `it("finds a thread by its first comment")`: `threadOf([humanThread, botThread], 7)` is `botThread`, and an unknown id gives `undefined`.
  - In `test/client.test.ts`, `it("lets admins, maintainers and writers command the bot, and no one else")`: `canCommand` is `true` for `"admin"`, `"maintain"` and `"write"`, and `false` for `"triage"`, `"read"` and `"none"`.
- [ ] **Step 2: Run** `pnpm exec vitest run test/thread-question.test.ts test/client.test.ts`. Expected: FAIL, since the module doesn't exist. The `canCommand` test passes at once: it pins existing behaviour that the thread path now relies on.
- [ ] **Step 3: Implement** both functions in `src/review/thread-question.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** "Answer an unmentioned reply only in andabot's own threads (#26)".

### Task 3: Answer in the thread with its context

**Files:**
- Modify: `src/review/prompt.ts` (`threadAnswerPrompt`), `src/commands.ts` (`helpText`) and `src/pull-request.ts` (`comment()`).
- Test: `test/prompt.test.ts` and `test/commands.test.ts`.

**Interfaces:**
- Consumes: `ThreadContext` from Task 1, and `threadOf` and `commandInThread` from Task 2.
- Consumes: `GitHubClient.listReviewThreads(ref, number)` and `GitHubClient.replyToReviewComment(ref, number, commentId, body)`.
- Produces: `export interface ThreadQuestion { path: string; line: number | null; diffHunk: string; opening: string | undefined }`.
- Produces: `export function threadAnswerPrompt(author: string, text: string, skill: string, thread: ThreadQuestion): string`.

- [ ] **Step 1: Write the failing tests.**
  - `it("puts the thread's file, line, hunk and opening comment before the question")`: the text starts with the skill. It contains ``andrew replies in a review thread on `src/a.ts` line 12:``, then the hunk in a `diff` fence, then `"The thread opens with this comment:\n\n**🔴 Blocking: x**"`. It ends with `"why?\n\nAnswer them directly, in text."`.
  - `it("calls a thread with no line outdated")`: with `line: null` it contains ``on `src/a.ts`, on a line the latest push no longer shows``.
  - `it("leaves the opening comment out when the thread couldn't be read")`: with `opening: undefined` it doesn't contain `"The thread opens with this comment"`.
  - In `test/commands.test.ts`, `it("says a reply under an inline comment is answered in that thread")`: `helpText("andabot")` contains `"Reply under one of my inline comments to ask about it, and I'll answer in that thread."`.
- [ ] **Step 2: Run** `pnpm exec vitest run test/prompt.test.ts test/commands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `threadAnswerPrompt` and the `helpText` line. Then change `comment()`:
  - When `incoming.thread` is set, look the thread up with `threadOf(await github.listReviewThreads(key, key.number), rootId)`. A failure logs `thread.lookup_failed` and gives `undefined`.
  - Decide with `commandInThread`. Otherwise use `parseCommand`, as today.
  - Answer through one `respond(…)`, which calls `replyToReviewComment(key, key.number, thread.rootId, text)` for a thread and `createIssueComment` otherwise. That covers `help` and the chat answer, which is still prefixed `@author`.
  - A chat in a thread prompts with `threadAnswerPrompt`, with `opening` set to the thread's `firstCommentBody`.
  - `command.received` gains `where: "thread" | "conversation"`.
  - Split `comment()` as needed to keep each function's complexity at 10 or under.
- [ ] **Step 4: Run** `pnpm check`. Expected: lint, typecheck and every test pass.
- [ ] **Step 5: Commit** "Answer in the review thread, with its file, line, hunk and opening comment (#26)".

### Task 4: Docs and the live check

**Files:**
- Modify: `docs/design.md`, in "Commands and chat" and the `pull_request_review_comment` row of the events table.
- Modify: `docs/setup.md`, section 4.

The issue's step 5, the App subscription, is already done: `scripts/register-app.mjs` lists `pull_request_review_comment` in `default_events`, and `docs/setup.md` lists "Pull request review comment" among the events. The router simply ignored those deliveries until Task 1.

- [ ] **Step 1: Update `docs/design.md`.** In "Commands and chat", add three points:
  - A reply in a review thread whose first comment is andabot's is a question about that finding and needs no mention.
  - Elsewhere in a review thread, `@andabot` asks.
  - The object looks the thread up through GraphQL `reviewThreads`, answers with the thread's file, line, hunk and opening comment, and replies under the thread's first comment.
- [ ] **Step 2: Update `docs/setup.md` section 4** with a step: a reply under an andabot comment is answered in that thread.
- [ ] **Step 3: Run** `pnpm check`. Expected: PASS. Commit "Document answers in review threads (#26)".
- [ ] **Step 4: Live check, inside a deploy window agreed with the other sessions.**
  1. Deploy the branch.
  2. Open a throwaway pull request with a defect andabot comments on.
  3. Wait for andabot's review.
  4. As Andrew, reply "why is this a problem?" under its inline comment: `gh api repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies -f body=…`.
  5. Expected: `command.received` with `where: "thread"`, and andabot's answer in that thread.
  6. Then reply in a thread Andrew started, without a mention. Expected: no answer.
  7. Close the throwaway unmerged, delete its branch, deploy plain main, and record the run on #26.
- [ ] **Step 5: Open the PR** against `main`, with the live check in "How to test".
