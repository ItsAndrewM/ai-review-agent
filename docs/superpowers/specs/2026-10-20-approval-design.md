# Re-evaluating approval: design

Status: agreed with Andrew on 20 Oct 2026 for issue #25. Choices marked *(builder's call)* were made by the writer and can be changed without going back to him.

## Why

andabot decides its verdict once per review, in `chooseReviewEvent`: a blocking finding means `REQUEST_CHANGES`, a clean `approve` verdict means `APPROVE`. Suppose an author fixes a blocking finding and resolves its thread without pushing. Nothing happens, and andabot's request for changes keeps blocking the merge until a later push starts a new review. The router ignores `pull_request_review_thread` and `check_suite` `completed` today.

`docs/design.md` describes the state machine, evaluated after every review, thread resolution and check completion:

```
if paused                             → do nothing
if head ≠ reviewed_head               → wait for the review of the current head
if bot has unresolved threads         → REQUEST_CHANGES stands
if required checks not all passing    → wait
re-fetch head; if it moved            → wait
else                                  → APPROVE, once per head
```

Only threads opened by blocking findings gate approval. The rules follow CodeRabbit's request-changes workflow: approve only when the latest commit has a completed review, every blocking thread is resolved, no check fails, and the head is unchanged at the moment of approval.

## Goals

1. **Approve without a push.** Once andabot's blocking threads are resolved and the head's checks pass, andabot approves the head it reviewed.
2. **Never approve a failing or unfinished head.** Every approval andabot submits, the review's own included, waits for the head's other checks to pass.
3. **Approve once per head.** A later failing check or a reopened thread doesn't revoke an approval. The next review of a new head decides again.
4. **Keep the verdict meaningful.** Re-evaluation lifts a request for changes, or an approval the review held back only for its threads or its checks. It never turns a review that only commented into an approval.
5. **Say so in the summary.** After a later approval, the summary comment's verdict says so.

## Non-goals

- Dismissing or revoking an approval.
- Commit statuses from the older Status API. Only check runs count, as #25 says.
- Check events on fork pull requests. GitHub sends them with an empty `pull_requests` list, so they can't be routed. A thread resolution on such a pull request still re-evaluates.
- The `pause`, `resume` and `resolve` commands (#27). The evaluation reads `paused`, and #27 writes it.
- Changing the check run's title after a later approval. The run stays the record of the review it ran.
- Reading branch protection's list of required checks. Every check run counts.

## Anti-goals

These would make it a failure even if it technically worked:

- Approving while one of andabot's blocking threads is open, in any review mode, or while a blocking finding the review couldn't post inline stands.
- Approving a head andabot hasn't reviewed, or one whose checks failed or are still running.
- Two approvals of one head from re-evaluation.
- A model call during the evaluation.
- andabot re-evaluating on its own check suite.

## Decided behaviour (with Andrew)

- **What re-evaluation may approve.** A head whose last review requested changes, whatever verdict the model gave, or one whose last review would have approved but couldn't read the threads or was waiting on the checks. A review that only commented stays a comment until the next review. So does an approval: a later push with nothing new to review doesn't bring a second one.
- **A clean review waits for the checks too.** A review that would approve does so only if the head's other checks already pass. Otherwise it posts as a comment that says approval waits for the checks, and the approval follows when they pass. A clean head whose checks finish after its review gets two reviews: the comment, then the approval.
- **The summary follows.** When re-evaluation approves, it rewrites the summary comment's verdict. The check run keeps the review's title.
- **No other check runs counts as passing** (decided after the builder check). A head with no check runs besides andabot's passes, so a repository without CI can be approved. Just after a push that's a race, since CI hasn't created its first run yet, so andabot doesn't evaluate after a push with nothing new to review. A small window is left and accepted: a thread resolved within seconds of such a push, or a review that finishes before CI creates its first run. On #46 the run appeared 9 s after the push, and reviews take 20 s or more.
- **Open blockers hold a fresh review too** (decided after the builder check). `@andabot full review` still starts over, and so does a check Re-run if GitHub ever offers one (#8), but their event counts andabot's open blocking threads like any other review's. The model sees no thread list and nothing is resolved. This amends #24, which had a fresh review's event follow only its own findings.

From #25:

- **Once per head, never revoked.** A later failing check or a reopened thread doesn't revoke the approval, and the next review of a new head decides again.
- **The checks.** Every check run on the head other than andabot's must be success, neutral or skipped. A run still queued or in progress counts as not passing, so approval waits for it *(builder's reading of "every completed check run")*.
- **No model call.** The decision is a pure function, and the object applies it.

## How *(builder's call unless noted)*

### Events

| Event | Action | Becomes |
| --- | --- | --- |
| `pull_request_review_thread` | `resolved`, `unresolved` | one evaluation, unless the pull request is a draft or a bot sent it |
| `check_suite` | `completed` | one evaluation per listed pull request, unless the suite is andabot's own or lists no pull request |
| `check_run` | `completed` | ignored, as today: its suite's completion follows, and evaluating on every run repeats the same reads |

- **The bot rule.** The router ignores every event a bot sends. A finished suite can come from one: GitHub Actions' deliveries name `github-actions[bot]` as the sender. So `check_suite` `completed` is routed before that rule, and andabot's own suite is recognised by `check_suite.app.slug`, which is `BOT_LOGIN`.
- **Unresolved** can only add a blocker, so it never leads to an approval. It is routed as #25 asks, and its evaluation logs the wait.
- **andabot's own resolutions** arrive from `andabot[bot]` and stay ignored. The review that resolved them evaluates when it ends.
- `Incoming` gains `{ kind: "approval", key, deliveryId, trigger }`, with `trigger` one of `thread_resolved`, `thread_unresolved` and `checks_completed`. `handle()` passes it to `evaluateApproval(trigger)`.

The App already gets both events. Workers Logs show `pull_request_review_thread` and `check_suite` deliveries on 20 Oct 2026, answered `200` as ignored, and `scripts/register-app.mjs` and `docs/setup.md` have listed the thread event since the App was registered. So #25's step 6 needs no change on GitHub. `docs/setup.md` already says GitHub's code review limits must let the App approve.

### State

- **`last_review`**: `{ reviewId, event, headSha, verdict?, heldBack, at }`, written after every review andabot submits, the evaluation's approvals included. `verdict` is the model's, and is absent on the evaluation's own approval. `heldBack` counts the rejected findings that `holdsApprovalBack` counts: blocking findings with no thread anyone can resolve, so they hold approval until the next review. Parsed with TypeBox when read.
- **The reviewed head** is `reviewed.headSha`, as #24 left it. A no-changes skip moves it to the new head without posting a review.
- **`paused`**: a boolean #27 will set. Absent means not paused.
- **Open blocking threads** are read live, the way a review reads them (#24): GraphQL `reviewThreads`, the bot's unresolved threads, each one's severity from its `finding:<commentId>` record or its comment's label.
- **Check runs** are read live: `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` with the default `filter=latest` (the latest run per name), 100 a page, at most 10 pages. More than that counts as unknown.

### The decision

A pure function in `src/review/approval.ts`. Its inputs are the workflow flag, `paused`, whether the pull request is open and not a draft, whether a review is pending, the head, the reviewed head, `last_review`, the open blocking count and the checks' state. It returns `approve`, or `wait` with the first of these reasons that holds:

1. `workflow_off`: `REQUEST_CHANGES_WORKFLOW` isn't `true`, so andabot never approves.
2. `paused`.
3. `not_open`: closed, merged, or a draft.
4. `review_in_flight`: a review is pending. It evaluates when it ends.
5. `not_reviewed`: the head isn't the reviewed head.
6. `no_record`: there is no `last_review`, as on a pull request last reviewed before this shipped. Its next review writes one.
7. `approved`: the last review is an approval, of this head or an earlier one.
8. `review_stands`: the last review held a finding back, or commented without an `approve` verdict.
9. `threads_unknown`: the threads couldn't be read, or there are more than the 500 the query pages through.
10. `blocking_threads`: one of andabot's blocking threads is open.
11. `checks_unknown`: the check runs couldn't be read.
12. `checks_failing`: a run other than andabot's completed with a conclusion other than success, neutral or skipped.
13. `checks_pending`: a run other than andabot's hasn't completed.

A last review that requested changes passes 7 and 8 whatever its verdict, since its request came from blocking findings or threads, and those are what 9 and 10 check now. The checks' state is its own pure function of the runs and the bot's login. With no runs besides andabot's, the checks pass.

### Applying it

`evaluateApproval(trigger)` on the object:

1. Fetch the pull request, read the state above, decide, and log `approval.decided` with the trigger, the head, the decision and the reason.
2. On `approve`, re-fetch the head. If it moved, log the wait as `head_moved` and stop.
3. Submit `APPROVE` on that head with a short body, such as "Approved at `def5678`: none of my blocking threads is open, and the checks pass. A human review is still required to merge."
4. Write `last_review`, then rewrite the summary comment's verdict to name the approval and its head: read the comment by its stored id, replace the verdict, and update it. A summary with no verdict, such as an unposted review's, is left alone. A failure is logged as `approval.summary_failed` and changes nothing else.
5. Log `approval.posted` with the review id.

A thread event and a check event can arrive a moment apart and evaluate at once. An in-memory mark per head, set before the re-fetch and cleared after, turns the second away, and the first reads `last_review` again before it submits. A crash loses only the mark.

A failure anywhere is logged as `approval.failed`. It never fails the review that ran the evaluation.

### The review's own event

- **The checks.** In `publishReview`, when `chooseReviewEvent` returns `APPROVE`, the host reads the head's check runs first. Unless they pass, the event becomes `COMMENT`, and the review's body, the summary's verdict and the check run's title say approval waits for the checks. That review's `last_review` keeps the model's `approve` verdict, so the evaluation approves once the checks pass.
- **A fresh review's threads.** In `fresh` mode `planReview` reads andabot's open threads too, only so that the event counts the blocking ones. The prompt has no thread lists, there are no threads to re-check, so nothing is resolved, and the duplicate check stays off.

### After every review

A posted review that isn't an approval ends with `evaluateApproval("review")`. The review counted its threads before the prompt, and an evaluation triggered while it ran waited for it, so this catches a thread resolved, or a check finished, during the review. It is skipped after a review that posted a blocking inline finding: that thread is certainly open, and GitHub's thread list may not show it yet. A no-changes skip doesn't evaluate, as decided above: CI's suite completion evaluates that head once its checks finish.

### Logs

`approval.decided` (trigger, head, decision, reason), `approval.posted` (review id), `approval.summary_failed` and `approval.failed`.

## Constraints

- **`CLAUDE.md`:** no comments, no casts, TypeBox at every boundary (the check runs response, the summary comment, the new webhook fields, `last_review`), complexity at most 10, no `vi.mock`. The client tests use the local server in `test/client.test.ts`. Design reasons go in `docs/design.md`.
- **Where the code goes.** The decision and the checks' state live in `src/review/approval.ts`, so `src/pull-request.ts` grows only by the method that applies them.
- **Fit with the existing code:** #24's thread reading and open-blocking count, #16's single flight, and `holdsApprovalBack` as #51 left it. #48 is open and touches `src/route.ts`. Whichever lands second merges.
- **Permissions.** None new. Checks write covers reading check runs, and Pull requests write covers the thread event.

## Tests

Unit tests, in the existing Node suite:

- the decision: one test per reason, and one for `approve`;
- the checks' state: andabot's run ignored, a pending run, a failing one, each passing conclusion, and no runs;
- what `last_review` lets re-evaluation approve: a request for changes with each verdict, a comment with and without an `approve` verdict, a held-back finding, and an earlier approval;
- the router: a resolved and an unresolved thread, a draft, a bot's resolution, a completed suite sent by `github-actions[bot]`, andabot's own suite, a suite with no pull request, and `check_run` `completed` still ignored;
- the client: paging the check runs, and reading the summary comment, against the local server;
- the summary's verdict rewrite;
- the review's event and body when the checks haven't passed, and a fresh review's event with an open blocking thread.

## Done when (from #25)

- Unit tests cover each branch of the decision.
- On a throwaway pull request whose checks pass, resolving the only blocking thread gets an approval from andabot without a push. A failing check makes it wait, and a push makes it wait for the new review.

## Left to the builder

- The wording of the approval, the waiting review's body and the rewritten verdict.
- The order of the two check reasons.
- The storage key names.
