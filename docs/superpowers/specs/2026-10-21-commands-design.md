# The summary, resolve, pause and resume commands: design

Status: agreed with Andrew on 21 Oct 2026 for issue #27. Choices marked *(builder's call)* were made by the writer and can be changed without going back to Andrew.

## Why

`parseCommand` knows `review`, `full review` and `help`, and treats anything else as a question. `docs/design.md` lists four more commands, after CodeRabbit's: `summary`, `resolve`, `pause` and `resume`. Each fills a gap:

- **The summary drifts.** Incremental reviews keep the last full review's summary and add a "Since `abc1234`" section, so after a few pushes the summary describes an older pull request. Only a full review refreshes it, at the cost of a whole review that posts its findings again.
- **No one-step override.** Resolving andabot's threads one by one works, and #25 re-evaluates approval after each, but a pull request with many threads takes many clicks.
- **No way to hold reviews off.** A pull request mid-rebase, or taking a run of work-in-progress pushes, starts a review on every push and spends Workers AI neurons on each.
- **`paused` has no writer.** #25's evaluation waits while `paused` is set, and nothing sets it.

## Goals

1. `summary` writes a fresh summary, walkthrough and merge danger for the pull request as it stands, with no review.
2. `resolve` resolves andabot's open threads and re-evaluates approval.
3. `pause` stops andabot's own reviews and the approval evaluation on a pull request until `resume`, and the summary comment says so.
4. `resume` catches up: it reviews a head the pause skipped, or re-evaluates approval on one already reviewed.
5. Each of the four confirms what it did, where it was asked.
6. Help lists all seven commands.

## Non-goals

- A check run while paused. A push skipped while paused leaves no andabot check on its head.
- Resolving a held-back finding, which has no thread, or revoking an approval.
- Pausing a repository or an installation, or pausing by default through `.andabot.yaml` (#28). `paused` belongs to one pull request.
- Looser parsing. A command is still the whole text after the mention, trimmed, in any case.

## Anti-goals

These would make it a failure even if it technically worked:

- `pause` stopping something a person asked for: a requested review, a summary, a resolve, a chat or a thread answer.
- `resolve` typed under one finding resolving any other thread, or any `resolve` touching a thread andabot didn't open.
- `summary` posting a review, a finding or a check run, or changing the verdict.
- A summary run resetting the root Pi session, adding to the transcript chat answers read, or posting through `submit_review`.
- A summary of one head written after the head moved.
- An old verdict reading as a judgement of a newer head.
- `resume` reviewing a head already reviewed, or approving outside the evaluation.

## Decided behaviour (with Andrew, 21 Oct)

### `summary`

- **A new model pass.** The model reads the whole pull request's diff at the current head and writes only the summary, the walkthrough and the merge danger. It writes no findings and no verdict, and the host posts no review and opens no check run.
- **It becomes the stored summary.** It replaces the summary, walkthrough and merge danger in `reviewed` and drops the "Since" section, which the new summary covers. `reviewed.headSha` stays the head of the last review, so the next incremental review still diffs from what was reviewed. The merge danger is replaced outright, as a full review's is, rather than kept at the stricter door. With no `reviewed` record, `summary` only rewrites the comment, since a record would make the next review incremental from a head nobody reviewed.
- **The verdict line stays the last review's.** Its verdict and counts stay as they stand, a later "Approved at `abc1234`" included. When the summary describes a newer head than the last review, the verdict names its own head: `**Head:** def5678 · **Verdict:** Changes requested at abc1234 · 🔴 1 blocking · …`. With no review yet, it reads `**Verdict:** Not reviewed yet`, with no counts.
- **Its own Pi session.** The summary never waits behind a review or resets one, and its diff stays out of the root session's transcript, which chat answers read. It runs while a review is in flight.
- **It writes only for an unchanged head.** When the model answers, the host reads the head again. If it moved, nothing is written, and the reply says so and asks for a new `summary`; the new head's review rewrites the comment anyway. A review that posts after a summary builds on it as on any stored summary. A summary that lands after a review of the same head replaces that review's summary and drops its "Since" section.
- **One at a time.** A `summary` while another runs is skipped, with a reply.

### `pause`

- **It stops what andabot does on its own:** the reviews that `pull_request` `opened`, `reopened`, `ready_for_review` and `synchronize` start, each skip logged as `review.skip` with reason `paused`, and the approval evaluation after thread and check events, which already waits on `paused` (#25).
- **Whatever a person asks for still runs:** `review`, `full review`, `summary`, `resolve`, and chat and thread answers. A review requested while paused is a normal review, and its own event can approve.
- **A review already running finishes and posts,** its own event included.
- **The evaluation never approves while paused** (decided after the builder check), whatever triggered it, as #25 built it. Only a review's own event can approve during a pause. So `resolve` resolves the threads but leaves approval to `resume`, and a review whose approval waits for the checks gets that approval only after `resume`, even when the checks pass during the pause. `resume`'s evaluation lets through what the pause held up.
- **The summary comment says so at once.** `pause` adds a line under the comment's header: "⏸️ Paused by @user: pushes don't start reviews. `@andabot resume` to resume." Every summary comment written while paused keeps it, and `resume` takes it out. With no summary comment yet, `pause` creates one with the header, the head and that line, in the form of today's comment for a review that didn't complete.
- **Who paused is kept** beside the flag, which stays the `true` that #25's evaluation reads.
- **No check run while paused.** The line and the reply say it, and andabot's check isn't a required one.

### `resume`

- It clears the flag and takes the line out of the summary comment.
- **A head with no review yet**, one that is neither the reviewed head nor has a `posted:<sha>` record, is reviewed as a push would review it: incrementally from the last reviewed head, which covers everything pushed during the pause. A draft isn't reviewed, as a push to a draft isn't.
- **A head already reviewed** gets the approval evaluation, with a new trigger `resume`, so an approval the pause held up can go through.
- **A catch-up review with nothing new to review evaluates too** *(builder's call, after the builder check)*. Pushes that add no line to the diff, such as a merge from the base branch, end the catch-up review as "No changes to review", which today never evaluates: just after a push, CI may not have created its first run yet (#46). Here the thread and check evaluations that arrived during the pause were dropped, so without one an approval the pause held up would wait for some later event. The pushes happened during the pause, so CI has most likely started; the window left, a push in the seconds before `resume`, is the kind #25 accepted.
- **When not paused,** it replies "Not paused." and does nothing else.

### `resolve`

- **In the conversation,** it resolves every one of andabot's open threads, blocking and outdated ones included, through GraphQL `resolveReviewThread`. The threads are read live, as a review reads them; #24 never stored `bot_threads`.
- **As a reply in one of andabot's threads,** it resolves that thread only.
- **As a reply in anyone else's thread,** it resolves nothing and replies that andabot resolves only its own threads.
- **No reply goes on each thread.** The one confirmation carries the count.
- **Then it runs the approval evaluation,** with a new trigger `resolve`. GitHub reports andabot's own resolutions as sent by a bot, which the router ignores, so nothing else would evaluate. While paused, the evaluation waits, and `resume` evaluates again.
- **A held-back finding stands.** A blocking finding the last review couldn't post inline has no thread, so `resolve` leaves it, and it holds approval until a push or `full review` judges it again.

### Confirmations

Each new command replies where it was written, in the conversation or in the thread, as `help` does:

- `pause`: "Paused: pushes won't start reviews until `@andabot resume`.", or "Already paused."
- `resume`: "Resumed: reviewing `def5678`.", or "Resumed: `def5678` is reviewed already."
- `resolve`: "Resolved 3 of my threads.", with a count of any that failed, then what approval does next: "Approved `def5678`.", or why it still waits, in plain words. A held-back finding comes with how to clear it: "my last review holds back 1 blocking finding that isn't in a thread; push a fix or ask for a `full review`." While paused: "Approval waits until `@andabot resume`." With the request-changes workflow off, approval goes unmentioned.
- `summary`: "Updated the summary for `def5678`.", linked to the comment, or why it didn't: the head moved, another summary is running, or the model gave nothing usable.

### Help

`helpText` lists all seven commands, one line each. Only users with write access can run any command, as today.

### The live check

When the branch passes `pnpm check` and review, the writer deploys it from a temporary worktree, after asking Andrew just before, since other sessions share the production Worker. After about 8 minutes, once `review.start` logs `staleBuild: false`, the writer checks on a throwaway pull request:

- `pause`, then a push, starts no review;
- `resume` reviews the current head;
- `resolve` resolves the bot's threads and re-evaluates approval;
- `summary` rewrites the summary comment without posting a review.

Then the writer closes the pull request unmerged, deletes its branch, puts plain `main` back the same way, and posts the results with their log lines on #27.

## How *(builder's call unless noted)*

### Parsing and dispatch

- `Command` gains `{ kind: "summary" }`, `{ kind: "resolve" }`, `{ kind: "pause" }` and `{ kind: "resume" }`. `commandInThread` parses commands before it treats a reply as a question, so all four work in a thread.
- `comment()` already looks the thread up and checks write access. It hands `resolve` that thread, and each handler replies through `respond()`.
- A command on a closed pull request: `summary` and `resume` reply that it's closed and do nothing more, as a review skips a closed pull request; `pause` and `resolve` act as on an open one.

### The pause gate

A review from a `pull_request` event carries no `requestedBy`, while one from a command or a check's re-run does. A pure function of the incoming review and the flag decides at the top of `review()`: an automatic review of a paused pull request is skipped and logged as `review.skip` with reason `paused`. `resume`'s review carries the author, and the flag is cleared before it starts anyway. An explicit field saying where the review came from would do as well as `requestedBy`.

### State

- **`paused`**: `true` while paused, as #25's evaluation reads it. Absent means not paused.
- **`pausedBy`**: the login that paused, for the summary's line. A key of its own leaves #25's read unchanged.
- **`reviewed`**: `summary` replaces `summary`, `walkthrough` and `merge_danger` and deletes `since`. `headSha`, `baseRef`, `mode` and `at` stay.
- **`summarizing`**: the summary in flight, with its delivery id, operation id and start time.
- **The verdict line's source.** The line comes from stored records, not from the comment's text: a failed review's summary comment has no verdict, and the records outlive it. `last_review` gains the verdict the review's summary showed and its severity counts, so "Approval waits for the checks", stored today only as a `COMMENT`, renders as itself again, and the evaluation's approval carries the counts over. A `last_review` written before this ships has neither, so its line falls back on the event alone, with no counts. A pull request last reviewed before `last_review` existed reads `**Verdict:** Not recorded`.

### The summary run

1. **Single flight.** A `summary` that finds a live `summarizing` record is skipped with a reply. A record is live while Pi lists its operation, or within a grace after it starts, as `pending` is (#16), so a run killed by eviction doesn't block the next one for good.
2. **Inputs.** The pull request, read fresh, with its head noted, then its changed files and linked issues, read as a review reads them.
3. **The session.** A session of its own, from `harness.sessions.create()`. Pi creates it "configured like the root", and the root carries the review skill as its instructions, so the summary run sets its own instructions, the model with `setModel`, and `REVIEW_THINKING_LEVEL`.
4. **The prompt** carries the pull request's data, its whole diff, and the rules for the three parts: the review skill's rules for the summary (what the code shows, each linked issue's omitted requirements in the issue's words, no claim that it builds or passes), a walkthrough row for every changed file but generated and lock files, and the merge danger by the review skill's `references/merge-danger.md`.
5. **The answer is JSON.** Every request of the run carries a `json_schema` `response_format` for a `SummarySubmission` of `summary`, `walkthrough` and `merge_danger`, through the provider wrapper that holds the resubmit prompt to `ReviewSubmission` today. TypeBox parses it. An answer that doesn't parse ends the run: nothing is written, the reply says the model gave nothing usable, and `summary.failed` is logged. There is no retry.
6. **No posting from the summary session.** The registry's tools are installed for every session, and `submitReview` checks only that the root session's running operation is the review in flight. A `submit_review` call from the summary session while a review runs would pass that check and post as the review. So `submit_review` posts only for a call from the root conversation, which pi-durable's `ToolExecutionApi.conversationId` names, unless pi-durable can give the summary session no tools at all.
7. **Write.** Read the head again. If it moved, reply and log `summary.superseded`. Otherwise update `reviewed` if it exists, render and write the summary comment, reply with its link, and log `summary.posted`.

The model's walkthrough rows replace the stored ones, and a changed file the model left without a row keeps its stored row. Whether two Pi sessions of one object run at the same time is for the plan to confirm. If pi-durable runs them one after another, a summary waits behind a running review, which is acceptable as long as it stays out of the review's session.

### The summary comment

Every render of the summary comment, by a review, a failed review, a summary run, `pause` or `resume`, carries the paused line while `paused` is set. `pause` and `resume` edit the comment in place instead of rebuilding it: they add or remove that one line, marked so it can be found, and leave the rest as it stands. A failed edit is logged and leaves the flag as set.

### `resolve`

- **Which threads.** From the conversation, `openBotThreads` over the live `reviewThreads`. From a thread, the looked-up thread, if it is andabot's and unresolved. One already resolved gets "Already resolved."
- `resolveThreads` resolves them, best effort, and each failure is logged.
- **The evaluation counts what it just resolved.** It reads the threads again right after the mutations. So that a list GitHub hasn't updated yet can't hold approval back, the threads `resolve` just resolved count as resolved whatever the list says, as a review's own resolutions do in `openBlockingAfter`.
- `evaluateApproval` returns its outcome, approved or the reason it waits, so the reply can say what approval does next.

### `resume`

It clears `paused` and `pausedBy` and takes the line out, then reads the pull request fresh. A head with no review yet, on an open pull request that isn't a draft, goes to `review()` with `full: false` and the author as `requestedBy`. A review of that head already running is turned away by the single flight, and the reply says it's running. A reviewed head goes to `evaluateApproval("resume")`.

`review()` tells `resume` how it ended, so `resume` evaluates only where nothing else will:

- **No changes to review:** `resume` evaluates.
- **Posted:** the review's own rule applies. It evaluates unless it approved or posted a blocking finding, whose new thread GitHub's list may not show yet.
- **Turned away by a review in flight:** that review evaluates when it ends, now unpaused.
- **Failed or replaced:** nothing is evaluated, since the head has no review to approve.

### Approval triggers

`ApprovalTrigger` gains `resolve` and `resume`, beside `review` and the webhook triggers. The list in `docs/design.md` of when the evaluation runs gains both.

### Logs

`command.received` already logs each command's kind. New: `review.skip` with reason `paused`, one event each for pausing, resuming and resolving (with the author, and for `resolve` the counts and where it was typed), and `summary.posted`, `summary.superseded`, `summary.failed` and a `summary.skip` for a summary already running.

### `docs/design.md`

The commands section describes each command as decided above; the state list gains `pausedBy`, `summarizing` and `last_review`'s new fields; the evaluation's triggers gain `resolve` and `resume`; and the summary comment's description gains the paused line and the summary run.

## Constraints

- **`CLAUDE.md`:** no comments of any kind, no type assertions but `as const`, TypeBox at every boundary (the `SummarySubmission` answer, `pausedBy`, `summarizing`, the extended `last_review`), complexity at most 10 per function, the anti-slop rules, no `vi.mock`. Design reasons go in `docs/design.md`.
- **Where the code goes.** The pure decisions live outside `src/pull-request.ts`: the pause gate, which threads `resolve` takes, the verdict line, the paused line, the reply texts and the `reviewed` update. That file is 1,341 lines already and grows only by the handlers that apply them.
- **Fit with the existing code:** #16's single flight, #24's live thread reading and `resolveThreads`, #25's `evaluateApproval` and `paused`, and #26's thread lookup in `comment()`.
- **Permissions.** None new. Pull requests write covers resolving threads and editing comments.
- **Shared production.** Other sessions deploy the same Worker, so the live check deploys only after asking Andrew.

## Tests

Unit tests, in the existing suite:

- parsing each of the seven commands, in the conversation and in a thread, and near misses such as "pause please" staying questions;
- the help text listing all seven;
- the pause gate: an automatic review of a paused pull request skipped, and a requested review, or any review of an unpaused one, run;
- `resolve`'s threads: all of andabot's open threads from the conversation, only the thread it's typed in when that thread is andabot's and open, and none in anyone else's;
- the verdict line: the same head, a newer head, the evaluation's approval, an approval waiting for the checks, no review, and an old `last_review`;
- the paused line: added, kept on a new render, removed, and created with the comment when there is none;
- the `reviewed` update after a summary: summary, walkthrough and merge danger replaced, `since` dropped, the head kept, and a missing row kept from the stored walkthrough;
- the `SummarySubmission` schema, and the provider wrapper setting its `response_format` on the summary run's requests only;
- the reply texts for each outcome, approval's waits included, `paused` among them;
- whether `resume` evaluates after each way its review can end;
- `submit_review` refusing a call from outside the root conversation, if that's the guard.

## Done when (from #27)

- Unit tests cover parsing for each command and the pause gate on the review path.
- On a throwaway pull request:
  - `pause`, then a push, starts no review;
  - `resume` reviews the current head;
  - `resolve` resolves the bot's threads;
  - `summary` rewrites the summary comment without posting a review.

## Left to the builder

- The wording of the replies, the help lines and the paused line, within what's decided above.
- Storage key and log event names.
- Whether the summary session lives on and is reset before each run, or is new each run.
- Whether the summary rules become a `summary` skill bundled beside `review` and `answer`, which changes the skills fingerprint, or stay in the prompt.
- How the summary comment's footer attributes a summary run's model.
