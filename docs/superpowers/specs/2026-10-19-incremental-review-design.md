# Incremental review: design

Status: agreed with Andrew on 19 Oct 2026 for issue #24. Choices marked *(builder's call)* were made by the writer and can be changed without going back to him.

## Why

Every push re-reviews the whole pull request. `review()` skips a head only when a `posted:<sha>` record exists for that exact head. Otherwise the prompt carries every changed file's full patch against the base. On a pull request with several pushes:

- the model re-reads unchanged code on every push;
- a finding on an unchanged line comes back as a duplicate comment;
- a fixed problem's thread stays open until someone resolves it by hand;
- with Kimi K2.7 Code a single review takes up to ten minutes (#2).

Andrew's mental model is CodeRabbit. It reviews only the commits added since its last review, restricted to the files the pull request changes ("Reviewing files that changed from the base of the PR and between X and Y", as on #16). During that review it resolves its own threads that the new changes fixed. Each review says what it covered. `full review` starts over.

## Goals

1. **Review only the new commits.** A push reviews the commits since the last review, in the files the pull request changes.
2. **Never repeat a comment on a push.** A review started by a push, incremental or full, never posts a comment that duplicates an open andabot thread. Only `@andabot full review` and a check Re-run start over.
3. **Resolve what the push fixed.** A push resolves the open andabot threads whose problems it fixed, with a reply naming the commit.
4. **Say what was covered.** The review and the summary comment state the commit range, the files and the threads resolved.
5. **Fall back to a full review** when an incremental one isn't meaningful.

## Non-goals

- **Answering or conceding in threads (#26).** CodeRabbit also resolves a thread when the author's reply convinces it, as on #23. That needs thread replies.
- **Re-evaluating approval** when a human resolves a thread or a check completes (#25). This design only keeps an incremental review from approving while a blocking thread is open.
- **The `resolve`, `pause` and `resume` commands (#27).**
- **Configuration (#28).**

## Anti-goals

These would make it a failure even if it technically worked:

- andabot resolving a thread whose problem still stands, or one it didn't open.
- andabot reopening or touching a thread a person resolved.
- An incremental review approving while one of andabot's blocking threads is still open.
- An incremental review commenting on code that didn't change since the last review. That's the repeat noise this design exists to remove.
- A comment landing on the wrong line. #4's anchors and quotes must hold in incremental mode too.

## Decided behaviour (with Andrew)

On a push to a pull request andabot has already reviewed:

- **Only the new commits.** andabot reviews only what changed since its last review, in files the pull request itself changes. Merging `main` into the branch doesn't drag `main`'s changes in.
- **Re-check touched threads.** For each open andabot thread whose lines the push touched, the model judges whether the problem is fixed. A fixed thread gets a reply, "Fixed in `abc1234`.", and is resolved. A thread that isn't fixed stays open and gets nothing new.
- **Leave the rest alone.** Threads on lines the push didn't touch are untouched. A thread a person resolved stays resolved, and andabot never reopens it.
- **Moved isn't fixed.** If the push only moved the flagged code, the problem counts as still standing unless the model says it's fixed.
- **No duplicates.** New problems in the pushed code get new comments, but never one that duplicates an open thread on the same line.
- **Full review instead** after a force-push or rebase, and on `@andabot full review` or a check Re-run.
- **A push's full review still doesn't repeat** (decided after the builder check). It covers the whole pull request, but like an incremental review it skips open threads, re-checks the outdated ones, and never approves while a blocking one is open. This applies after a rebase, force-push or base change, after a failed compare, and on the first push to each pull request after this ships. Only `@andabot full review` and a check Re-run start over as today. #2's measurement runs on #9 depend on those repeated full reviews posting fresh findings.
- **A blocking bug off the new lines** (decided after the builder check). In an incremental review, a blocking finding the push caused in code it didn't change, such as a caller of a changed function, still gets an inline comment, as long as its line is in the pull request's diff. A non-blocking finding off the new lines is dropped.

## How *(builder's call unless noted)*

### Choosing the mode

Before the prompt, the object picks one of three modes:

- **`fresh`**: the request is `full`, from the command or a Re-run. It reviews the whole pull request exactly as today: no thread lists, no duplicate check, no resolving, and the event follows only this review's findings.
- **`full`**: a push, when any of these hold:
  - there is no `reviewed` record for this pull request;
  - the compare between the reviewed head and the new head is anything but `"status": "ahead"`. `diverged` means rewritten history; `behind` and `identical` mean nothing new.
  - the compare call fails;
  - the pull request's base branch changed since the reviewed head.

  It reviews the whole pull request, with the thread lists, the duplicate check, resolving and the open-blocking rule below. Its threads to re-check are the open andabot threads GitHub reports `isOutdated`.
- **`incremental`**: any other push, against `reviewed.headSha`.

This decision is a pure function, with unit tests, of the request, the `reviewed` record, the compare status and the current base. The help text for `full review` says it starts over.

### The delta

- **Files.** `GET /repos/{owner}/{repo}/compare/{reviewed}...{head}` gives the files changed since the last review. The incremental review covers the files in both that list and the pull request's own list (`listPullRequestFiles`), by filename. A file only in the compare list came from a merge of the base branch and is skipped.
- **Marked lines.** For each covered file, mark the pull request's own diff lines that changed since the last review:
  - **RIGHT:** the PR's RIGHT lines that are added lines in the compare patch. Both are line numbers at the head, so they compare directly.
  - **LEFT:** the PR's LEFT (deleted) lines whose text matches a line the compare patch deletes from that file, compared as #4's quotes are. Old-file numbers differ between the two diffs, so matching is by text. A duplicate text over-marks, which only widens what may be commented on.
- **Nothing to review.** If no PR file is covered, or no line is marked, there is no model call:
  - `review.skip` logs reason `no_new_changes`;
  - the `reviewed` record moves to the new head;
  - the check run completes as success, titled "No changes to review since `abc1234`";
  - no GitHub review is posted.

### What the model sees

The incremental prompt replaces the diff section:

- the commit range, `abc1234..def5678`;
- the PR's numbered patch for each covered file only, with marked lines flagged after the anchor (for example `R12*`), plus a legend saying to comment only on marked lines;
- the list of the PR's other changed files without patches, marked "unchanged since the last review; `read_file` if needed";
- **threads to re-check:** each open andabot thread on a covered file that GitHub reports `isOutdated`, or whose current line is marked, as a short handle (`T1`, `T2`, …) with path, current line (or "outdated"), its title and the code it was about;
- **other open threads:** the remaining open andabot threads, path, line and title only, so the model doesn't repeat them.

The PR's title, description and the material-under-review note stay as they are. The review skill is unchanged, apart from one paragraph on incremental reviews:

- comment on marked lines only, except for a blocking bug the new changes cause elsewhere in the diff;
- list the fixed threads;
- don't repeat open ones.

A `full` review's prompt is today's whole diff plus the same two thread lists. Its threads to re-check are the outdated ones. A `fresh` review's prompt is today's, unchanged.

### The submission

`ReviewSubmission` gains `addressed_threads?: string[]`, the handles of threads to re-check whose problems the new changes fix. It is ignored in `fresh` reviews.

### Validation in `incremental` and `full` mode

On top of today's checks:

- **Marked lines, or blocking** (`incremental` only). A finding's `line` must be a marked line, unless the finding is blocking. A blocking finding may sit on any line of the pull request's diff, validated as today. A non-blocking finding off the marked lines is rejected with "line N was not changed since the last review; only a blocking finding may go elsewhere". It goes back to the model once, as every rejection does (#12), then is dropped. It doesn't hold approval back, since #12's rule counts blocking findings only.
- **No duplicates.** A finding on the same path and current line as an open andabot thread, or whose quote matches that thread's quoted line, is rejected with "duplicates open thread Tn". It goes back to the model once with the other rejections. It is kept out of the event and the held-back list, because the open thread already gates approval.
- **Known handles only.** `addressed_threads` entries that aren't handles of threads to re-check are ignored and logged.

### Resolving

After the review posts, for each valid entry in `addressed_threads`:

1. Reply on the thread's first comment with `POST /repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies`: "Fixed in `def5678`."
2. Resolve it with GraphQL `resolveReviewThread(input: {threadId})`.

Each call is wrapped like the check-run calls. A failure is logged as `review.resolve_failed` and never fails the review. Only threads whose first comment's author is the bot (GraphQL login `andabot`, type `Bot`) and which GitHub reports unresolved at review start are touched.

### The event

In `incremental` and `full` mode, `chooseReviewEvent` also counts **open blocking andabot threads that remain after this review's resolutions**. The review requests changes if any remain, and never approves while one stays open. A `fresh` review keeps today's rule. A thread's severity comes from the stored finding record (below). For threads posted before this feature, it falls back to the comment's leading label (`🔴 Blocking`).

### What gets stored *(builder's call)*

- `reviewed`: `{ headSha, baseSha, reviewId, at, mode }`. It is written after every posted review, and after a skip for no new changes. Parse it with TypeBox when reading it back.
- `finding:<commentId>`: `{ severity, title, quote, path }` for each inline comment of a posted review. After `createReview`, the comment ids come from `GET /pulls/{n}/reviews/{reviewId}/comments`, matched to the accepted findings by path, line and side (unique within a review).
- **Thread state is not stored.** Resolved, outdated and current line are fetched live from GraphQL `reviewThreads` at the start of each incremental review, so a person's resolution is always respected.

### What the review and the summary say

- **Review body.** A line in the manner of CodeRabbit's review info: "Incremental review of `abc1234..def5678`: 3 files; 2 threads resolved." A full review says "Full review."
- **Summary comment.**
  - It keeps the last full review's summary and walkthrough. Store them with the `reviewed` record, or alongside it.
  - It adds a "Since `abc1234`" section with the incremental review's summary, the files and the resolved threads.
  - Walkthrough rows for covered files are replaced by the incremental review's rows for those files.
  - The latest "Since" section is the only one kept *(builder's call)*.

### Logs

- `review.start` gains `mode`, `since` (the short reviewed head), `covered` (the file count) and `recheck` (the count of threads to re-check).
- `review.resolved` logs the count of threads resolved.
- `review.skip` gains reason `no_new_changes`.

## Constraints

- **`CLAUDE.md`:** no comments, no casts, TypeBox at every boundary (the compare response, review comments, the GraphQL responses, stored records), complexity at most 10, no `vi.mock`. The client tests use the local server already in `test/client.test.ts`. Design reasons go in `docs/design.md`, not in code.
- **Fit with the existing code:**
  - single-flight and the check run (#16);
  - the return-once rejection loop (#12);
  - suggestion re-indentation (#15);
  - the skills (#17, #20);
  - and, if they land first, #18's forced retry (#23) and #22's slice 2. Keep the incremental logic in its own module (`src/review/incremental.ts`) so `src/pull-request.ts` changes stay small.
- **Pins:** `agents` 0.28.1 and `@earendil-works/pi-durable` 1.3.0 stay pinned. No new runtime dependency is needed.
- **GraphQL:** calls go to `https://api.github.com/graphql` with the installation token. The App already has Pull requests write, which `resolveReviewThread` needs.

## Tests

Unit tests, in the existing Node suite:

- choosing among the three modes;
- covered files and marked lines on an added file, a modified file, and a merge from the base;
- the incremental prompt's marked lines and thread lists, and the `full` prompt's thread lists;
- marked-line validation, with the blocking exception, and duplicate validation;
- duplicates kept out of the held-back count;
- handling of addressed handles;
- the event with open blocking threads;
- the summary's "Since" section and its walkthrough merge;
- the client calls (compare, review comments, the GraphQL threads query, reply, resolve) against the local server.

## Done when (from #24)

- The unit tests above pass.
- On a throwaway pull request:
  - a second push reviews only its own commits;
  - it posts no duplicate of an open comment;
  - it resolves, with a reply, a thread whose problem the push fixed;
  - it leaves a person-resolved thread alone;
  - a force-push gets a full review that repeats no open thread;
  - `@andabot full review` starts over.

## Amended after the final review (19 Oct 2026)

The whole-branch review found five places where the mechanism above defeated a goal. The builder changed the mechanism and kept the goals:

- **Marked lines.** Only the pull request's own `+` lines are marked on the RIGHT. A context line the compare added is the base's change, merged in, so marking it broke "Merging `main` into the branch doesn't drag `main`'s changes in".
- **Threads to re-check.** In `incremental` mode, these are the threads on a marked line, and the outdated threads whose quoted line the push added or deleted in that file. For a thread with no stored quote, any change to its file counts.
  - **The skip.** A push skips only when no line is marked and no thread is due a re-check. Before, a push that only deleted the flagged line, the most common fix, marked nothing, so it was skipped and its thread never re-checked.
  - **The prompt.** Such a file's compare patch appears under "New changes outside the diff".
- **The cap.** The 30-thread cap applies only to the prompt's lists, newest first with the threads to re-check ahead. Duplicates and the open-blocking count use every open thread. Before, capping first hid the newest threads from re-check and from the duplicate check.
- **Duplicates.** A quote matches only an outdated thread, and a blocking finding on the line of a thread that isn't blocking still posts. Before, a common line anywhere in the file counted as a repeat, and a blocking finding could vanish from the event.
- **Resolving.** Threads are resolved before the event is chosen, so the event counts only real resolutions. The "Fixed in" reply comes after the review posts. "After the review posts" and "remain after this review's resolutions" couldn't both hold.
- **`identical`** is treated as `incremental` with nothing new, not as `full`, so a redelivered push is skipped instead of fully reviewed.

## Left to the builder

- The exact marker syntax for marked lines.
- The thread handle format.
- The wording of the replies and the review line.
- How many threads to list before capping, with a note.
- The storage key layout.
- Whether the "Since" section keeps a short history.
