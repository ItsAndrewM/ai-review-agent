# andabot: design

`andabot` is a self-hosted pull request reviewer in the shape of CodeRabbit: it reviews every PR on its own, answers when tagged, posts a summary and inline findings with suggestions, requests changes when it finds something, and approves once its findings are resolved. It runs on Cloudflare: a Worker receives GitHub webhooks and hands each PR to its own Durable Object, where Pi Durable runs the agent loop.

Status: phase 1, the walking skeleton, is built, deployed and reviewing this repository's pull requests (#1), and `pnpm check` runs on every pull request in GitHub Actions (#3). Next: #2 measures review quality.

## Decisions so far

| Question | Decision | Why |
| --- | --- | --- |
| Agent harness | Pi Durable through the Agents SDK's `PiHarness` | Every turn, tool call and piece of state is committed before it is shown; idempotent submissions by request id; hooks before and after tool calls; survives eviction. Smallest loop of the three options. |
| Approval policy | Request changes on actionable findings, approve when they are resolved | CodeRabbit's request-changes workflow, which is the feature worth keeping. |
| Plan | Workers Paid, since 17 Oct 2026 | Unlocks Workers AI's paid models, such as Kimi K2.7 Code, and Containers for the sandbox tier. Reviews run on GLM-5.3 Flash since #2 compared models on 19 Oct 2026. |
| Repos | Andrew's own repos, public and private, through one GitHub App named `andabot` | An App's approval counts toward required reviews like a person's. The default Actions token's does not without an org setting. |
| State | One Durable Object per pull request | Memory per PR for chat follow-ups, the approval state machine and incremental review live where the PR does. |

Both `PiHarness` and Pi Durable are beta. APIs will move, so every package is pinned and upgrades are deliberate.

## Architecture

```
GitHub ──webhook──▶ Worker (router)
                      │  verify X-Hub-Signature-256
                      │  forward X-GitHub-Delivery; Pi dedupes by request id
                      │  installation token cache
                      ▼
            PullRequest Durable Object  (one per installation/repo#number)
            ├─ SQLite: reviewed head, summary comment id, bot threads, config
            ├─ PiHarness ─ Pi Durable session (transcript, tasks, inbox)
            │     tools: pr, diff, read_file, tree, search, workspace grep
            │     hooks: validate findings against diff hunks before posting
            ├─ Workspace (@cloudflare/computer): shallow clone in SQLite, grep/find
            └─ Sandbox (Containers, later): lint, typecheck, tests on the head
                      │
                      ▼
            GitHub REST: reviews, review comments, issue comments, checks
```

### Router Worker

- Verifies the webhook HMAC with the App's webhook secret. Rejects anything else.
- Uses the delivery id (`X-GitHub-Delivery`) as the Pi submission's `requestId`, so a GitHub redelivery cannot post twice.
- Mints and caches the installation token: App JWT (RS256 over WebCrypto) → `POST /app/installations/{id}/access_tokens`, cached for ~55 minutes in the PR object or a small KV.
- Routes by event to `env.PR.getByName(`${installationId}/${owner}/${repo}#${number}`)`.

Events the App subscribes to:

| Event | Action | Handler |
| --- | --- | --- |
| `pull_request` | opened, synchronize, reopened, ready_for_review | review (incremental on synchronize) |
| `pull_request` | closed | archive: stop alarms, keep transcript |
| `issue_comment` | created, on a PR | command or chat turn |
| `pull_request_review_comment` | created | reply in thread, with file and line context |
| `pull_request_review_thread` | resolved, unresolved | re-evaluate approval; ignored on a draft or when a bot sent it, so andabot's own resolutions are left to the review that made them |
| `check_run` / `check_suite` | rerequested | full review of each listed pull request; dormant, since GitHub shows no Re-run on andabot's runs (#8) |
| `check_suite` | requested | ignored: the pull request event starts the review |
| `check_suite` | completed | re-evaluate approval for each listed pull request, skipping andabot's own suite; routed even when a bot sent it, since GitHub Actions' suites arrive from `github-actions[bot]` |
| `check_run` | completed | ignored: its suite's completion follows |

App permissions: Pull requests write, Contents read, Issues write, Checks write (the review check run), Metadata read.

### PullRequest Durable Object

State in its SQLite, beside Pi's `pi_` tables:

- `reviewed`: the head of the last review, the base branch's name, the mode it ran in, the last full review's summary and walkthrough, and the merge danger the summary shows, which an incremental review updates to the stricter door, with a `since` section from the latest incremental one. The next push diffs against that head, and a different base branch (a retargeted pull request) means a full review.
- `summary_comment_id`: the one issue comment that is edited in place on every push.
- `finding:<commentId>`: the severity, title and quoted line of each inline comment the bot posted. Thread state isn't stored. Whether a thread is resolved or outdated, and where it sits now, is read live from GitHub on each review, so a thread a person resolved is always seen as resolved. These records only supply what GitHub doesn't: the quote to catch a repeat, and the severity that gates approval.
- `scope`: the plan of the review in flight. It holds the mode, the range, the marked lines of each covered file, every one of the bot's open threads with its handle, and the threads to re-check. `submitReview` applies it to the submission, so a review is validated against what its prompt showed.
- `last_review`, stored as `lastReview`: the id, event (`REQUEST_CHANGES`, `COMMENT`, `APPROVE`) and head of the review the bot last submitted, the approval evaluation's own approvals included, with the model's verdict and the count of blocking findings the review couldn't post inline. The approval evaluation reads it.
- `config`: the parsed `.andabot.yaml` from the PR head, refreshed on each push.
- `paused`: set by `pause`, cleared by `resume` (#27). The approval evaluation reads it.
- `pending`: the review in flight, with its head, delivery id, operation id, start time and check run id, the model and skill fingerprint that attribute it, the numbers of the linked issues its prompt carried, and whether its rejected findings, duplicates and missing walkthrough rows have gone back to the model; one per object, because reviews are single-flight.

Methods, each an idempotent Pi submission:

- `onPush(head, delivery)`: full review on first sight, incremental review (`compare reviewed...head`) after that.
- `onCommand(comment, delivery)`: `review`, `full review`, `summary`, `resolve`, `pause`, `resume`, `help`, else a chat turn.
- `evaluateApproval(trigger)`: after a thread is resolved or unresolved, after a check suite finishes, and after a review that doesn't approve. It makes no model call, so it is no Pi submission.

Reviews are single-flight per pull request. A newer head aborts the running review and cancels its check run as superseded. A request for a head whose review is still running is skipped. A pending review the harness no longer lists is dead: its run is failed and the new review proceeds. A record whose start time is under two minutes old counts as live. The grace bounds only the host's work while none of the review's operations is listed: before its first prompt is submitted, between that prompt and the retry, and after each. So the record is written before the first prompt, and its start time restarts when each prompt returns and again before the retry. The replacer deletes the record, aborts the replaced review's operations, and only then completes its run, from the id it read before the delete, so the replaced review's exits find the record gone and touch nothing. A review replaced before its prompt never prompts, and the run it opened is cancelled as superseded, or as replaced when the newer review is of the same head. A `submit_review` call posts only from a running operation the record names, and the host posts a review the model wrote as text only while the record still names its delivery.

The object is addressed only through the router. It has no public HTTP surface.

After a deploy, Cloudflare moves the Worker and its Durable Objects to the new build eventually, so for seconds to minutes a new Worker can call an object still running the previous build, with that build's model and logic. The Worker passes its version with each event: `review.start` logs `staleBuild` and `callerBuild`, and `review.failed` logs `staleBuild`, so a failure during a rollout can be traced to it. The next event, or `@andabot review`, runs on the new build. When Pi resumes an interrupted review on the new build, the summary footer and the `posted:<sha>` record still take the model and skill fingerprint from `pending`, where `review()` stored those of the build that started it. The footer's linked issues come from `pending` too, where the run recorded the issues its prompt was built with. A linked issue that cannot be read (a 410 for a deleted issue, a 5xx) is skipped and logged as `review.issue_unreadable`, so optional context never fails a review.

### Pi harness inside the object

Following Cloudflare's `examples/next/harnesses/pi`: `createAI({ binding: env.AI })` as the Pi AI provider, `createRegistry()` with one extension for the system prompt and tools, `Harness.open(storage, { models, registry, settings })` in the `PiHarness` factory, `Lifecycle.install(this).use(this.harness)`.

Pi applies the harness's `defaults` only when it creates a session, so every run sets the configured model with `setModel` before it prompts, and sets `REVIEW_THINKING_LEVEL` along with the review skill's instructions. After each prompt the host logs `review.transcript`: the tool calls by name, the model's turns and its output tokens, counted from the session's transcript since the reset. A retry's counts include the first run's. On #23 a review approved in 19 s with nothing to show whether it read past the diff (#34). Each review starts with `session().reset()`, so earlier reviews and their large prompts don't pile up in the context or overflow it.

Phase 1 takes the review through a `submit_review` tool, whose arguments host code validates and posts, but nothing holds the model to calling it: on #5, gpt-oss-120b wrote those arguments as its final message instead (#6). So when a review run ends without a posted review, the host reads that message. A `ReviewSubmission` written as JSON, bare or in a `json` code fence, goes to `submitReview`, which validates and posts it as if the tool had been called. Anything else, or a submission `submitReview` refuses, gets one more prompt in the same session to call `submit_review`. A plain request leaves the model free to answer it in prose again, and on #16 gpt-oss-120b answered "Review submitted." without the call (#18). Forcing the call with `tool_choice` doesn't hold on Workers AI: its vLLM front end accepts a named or `required` choice and then ignores it for gpt-oss, which answered a prompt forbidding tools in prose every time. A `json_schema` `response_format` does hold, even with tools in the request. So the model's requests in that prompt carry `ReviewSubmission` as their `response_format`, through pi-ai's `samplingParams` since pi-ai doesn't model it, until the transcript has the model's answer. The retry then ends in a `submit_review` call or the review as JSON, and the host posts JSON it ends in the way it posts the first run's. Held to JSON and pressed to confirm, gpt-oss-120b wrote "Review submitted." as the summary of an approval with no walkthrough and no findings, which would have posted an approval nobody made. So `ReviewSubmission` needs at least one walkthrough entry: the host refuses that empty shell, and under the constraint the model wrote out its review instead. The retry is the model's last turn, so rejections in the JSON it ends in have no one to go back to: that review posts with the failing findings dropped, as a second submission would. A retry's JSON with walkthrough rows missing ends the review as incomplete, as a second submission does. When the first run gave the host nothing to check, because it ended in prose or in JSON that didn't fit `ReviewSubmission`, the resubmit prompt names the files that need rows. If the host still refuses that review, the summary gives the reason. If the head moves meanwhile, nothing more is asked or posted, since the review of the new head takes over. Otherwise, when nothing is posted, the summary says so and why, and keeps prose as its note. JSON never reaches the comment: text holding a JSON object counts as JSON, and what doesn't fit `ReviewSubmission` goes to the log as `review.unfit_json`. `review.done` logs `source` as `tool`, `text`, `retry` or `retry_text`, so Workers Logs shows how often the model skips the tool, which feeds #2's choice of model.

Findings are anchored by copying, not counting (#4). On #1 the model counted lines down from each hunk header, miscounted over new files a few hundred lines long, and all three comments landed on the wrong line with committable suggestions that would have broken the build. So every patch line in the prompt starts with the anchor GitHub's review API takes, `R12` for line 12 of the new file or `L10` for line 10 of the old one, and every finding quotes the text of its line. `validateFindings` compares the quote with the patch line at that side and number. A quote that carries the anchor, the diff's own marker for that side (`+` on the RIGHT, `-` on the LEFT) or an incremental review's star is compared again without them, and kept without them, because GLM-5.3 Flash sometimes copies the marker (#45). The quote as written is tried first, so a line whose own text starts like a marker still matches itself, and a quote whose readings match different lines is rejected rather than moved. On a mismatch it moves the finding to the one line on the same side of the same file whose text matches, dropping any range and that range's suggestion, since only the quoted line is verified; it rejects the finding when no line or several match. A line outside the diff is rejected rather than moved, since its number and quote most likely came from `read_file`, and a short line such as `}` would match some unrelated line of the diff. A range must lie wholly inside the diff, a suggestion is at most 60,000 characters, and a rendered comment at most 65,536, GitHub's limit, because one comment GitHub refuses fails the whole review.

A suggestion replaces the anchored lines whole, indentation included, and the model writes it like a code block in prose: on #9 every suggestion lost its line's indentation, and one restoring a deleted guard replaced the line after the deletion instead of going above it, which would not have compiled (#14). So when a suggestion is less indented than the lines it replaces, the host moves its common indentation to theirs, keeping its relative indentation; a suggestion indented further is left alone, since that may be deliberate. Then the suggestion must leave each kind of bracket, `()`, `[]` and `{}`, as balanced as the lines it replaces. When it doesn't, committing it would unbalance the file, so the host drops the suggestion and posts the finding without it, since the comment still explains the fix.

The first submission with a rejected finding, a duplicate of an open thread, or a changed file other than a generated or lock file that has no walkthrough row, is not posted: every rejection, every duplicate and every file without a row go back to the model together, once, as the tool's result or in the prompt that asks again. An `incremental` review needs rows only for the files it covers, and none when it only re-checks threads, since the summary keeps the stored rows of the other files. The next submission posts with whatever still fails dropped, unless files still have no row: then nothing is posted, `review.incomplete` is logged, the check run fails, and the summary comment says the review did not complete and names the files, ten at most and then a count of the rest. A blocking finding that stands rejected holds approval back: the review requests changes, and its body names the finding. A finding rejected for its basis holds nothing back, since it is unfounded rather than unposted: one with a blank basis, a `standard` or `test` finding graded blocking, or a `spec` finding on a pull request with no linked issue, which is rejected with the suggestion to make it a `defect` with its failure scenario if the code is wrong on its own terms. The basis is checked before the anchor, so a finding that is wrong in both ways is unfounded. `review.findings` logs the mode and the accepted, relocated, rejected and duplicate counts of every submission, how many suggestions were dropped, and how many walkthrough rows are missing (`missingRows`).

Tools offered to the model, all read only and `replay: "safe"`:

| Tool | Backed by |
| --- | --- |
| `get_pr` | PR metadata, title, body, labels, base and head |
| `list_changed_files` | `GET /pulls/{n}/files`, with per-file patch |
| `get_diff` | compare API for incremental ranges, `.diff` media type |
| `read_file(path, ref)` | `GET /contents?ref=` or the workspace clone |
| `get_issue(number)` | `GET /issues/{n}`: title, state and full body |
| `tree(path)` | git trees API or the workspace |
| `grep(pattern, glob)` | `@cloudflare/computer` workspace over a shallow clone in SQLite |
| `run_check(name)` | phase 3: Sandbox runs lint, typecheck or tests, returns the tail |

Posting is not a model tool. The model fills a structured findings document, defined with Pi Durable's `defineDoc`, and host code validates each finding against the diff hunks before anything reaches GitHub: the path must be in the PR, the line must be in a hunk on the right side and hold the text the finding quotes, severity must be one of the known values, and a suggestion must be a replacement for the lines it names. A finding that fails validation goes back to the model once, then is dropped and logged. This is the same shape the Agents docs recommend: the model proposes, your code decides.

A `beforeTool` hook enforces budgets: a cap on files read per review, on bytes per read, and on total model tokens per review, with the review ending in a shorter summary rather than a failed run.

### Skills

The review procedure, with its severity rubric and references, and the rules for answering a question are Agent Skills under `skills/`, bundled into the Worker as text and fingerprinted together with SHA-256; the logs and each posted review's record carry that fingerprint beside the model id, and the summary footer shows its first eight characters as `review@…`. Before each review, after `reset()`, the host renders the review skill and its four references into the root conversation's `instructions`, and a question carries the answer skill in its own message instead, since `configure()` takes effect at once and would swap the instructions of a review still running. The Agents SDK's skills catalog, with `activate_skill` and `read_skill_resource`, waits for repo-provided skills in slice 3: offered those two tools, gpt-oss-120b printed its calls as raw text and never posted (#19), so the model gets neither, and its tools are `read_file`, `list_changed_files`, `get_issue` and `submit_review`. `docs/superpowers/specs/2026-10-17-skills-design.md` holds the design, the reasons behind it and the order of work.

The spec is the issues a pull request links, up to three: the closing keywords in its body (`Closes #n`, `Fixes #n`, `Resolves #n`), then its branch's `GH-n` keys, then a trailing `.n` on the branch name whose dot follows a non-digit, so a version such as `v1.2` is no key. A bare `#n` in the body counts only when none of those exists, since a pull request that mentions `#2` in passing hasn't made it the spec. With no linked issue the prompt says so and a `spec` finding is rejected, because requirements are never inferred from the code.

`renderActivatedSkill` mirrors the private `renderSkillContent` in the Agents SDK's `agents/harness/pi`, and `renderSkillWithResources` wraps each reference as its `read_skill_resource` does, so re-check both against the SDK on every `agents` bump.

### Review pipeline

1. Gather: changed files, patches, PR body, the repo's config file, and the instruction files the repo already keeps for agents (`CLAUDE.md`, `AGENTS.md`, `REVIEW.md`) as path-scoped guidance.
2. Draft: one pass over the diff, in chunks sized to the model's context, producing candidate findings and a per-file walkthrough.
3. Verify: a second pass takes each candidate with the exact lines it cites and the surrounding file, and keeps it only if the problem is real on those lines. This is what makes cheaper models usable; unverifiable findings are the noise people leave CodeRabbit over.
4. Post: edit the summary comment in place, submit one review with the inline comments, set the review event from the approval policy below, where an approval waits for the head's other checks to pass, and complete the check run, in progress since step 1, with the verdict in its title. A review that does not complete fails it.
5. Record: `reviewed`, a `finding:<commentId>` per inline comment, the review id.

Reviews follow CodeRabbit's model (#24). A push reviews only what changed since the last review. A push never repeats an open thread, and it resolves the threads it fixed. `full review` starts over. Each review runs in one of three modes, chosen before the prompt:

- **`fresh`**, on `@andabot full review`, is the whole pull request as before: no thread lists, no duplicate check and no resolving. Its event follows this review's findings and andabot's open blocking threads, which it reads for that alone, so a full review never approves past one (#25).
- **`full`**, on a push with no `reviewed` record, a retargeted base, a failed compare, or any compare status but `ahead` or `identical`, is the whole pull request too, but it never repeats an open thread. `diverged` and `behind` mean rewritten history. The first push to each pull request after this shipped is `full`, so it doesn't repost every existing finding.
- **`incremental`** reviews what changed since the last review. It covers the pull request's files whose own changed lines the compare `reviewed...head` also changed, so a merge from the base branch drags nothing in.

In `incremental` mode, the prompt shows the pull request's own numbered patch for each covered file, with the lines that changed since the last review starred after their anchors (`R12*`). A file with a thread to re-check but no starred line gets the compare's patch instead, unnumbered, under "New changes outside the diff", so the model can see that the push deleted or reverted the flagged code. It lists the other files by name only. A file the push changed without a starred line is listed as "changed since the last review, with no line to comment on" rather than "unchanged", and the walkthrough keeps any row the model writes for it. Such a file may be binary, too large for GitHub to diff, or one whose new changes all left the diff (#45). Those rows stay optional, so the coverage check never ends a review over a binary file.

- **Why marked lines are the PR's own.** Comments anchor to the pull request's diff, not to the compare's, so marking that diff's lines keeps every anchor one GitHub accepts. RIGHT lines are marked by number, since both diffs number the head the same way, and only the pull request's own `+` lines are marked: a context line the compare added is the base's change, merged in. LEFT lines are marked by text, since their old-file numbers differ.
- **What a finding may anchor to.** A finding must sit on a marked line, except a blocking one: a bug the push causes in code it didn't edit, such as a caller of a changed function, still gets an inline comment if its line is in the diff.
- **When there's nothing to review.** When no line is marked and no thread is due a re-check, there is no model call. The check run completes as "No changes to review since `abc1234`". A push whose changes all left the diff, such as deleting a line the pull request added, has nothing to comment on, so it is reviewed only through the threads it touched.
- **An unchanged head.** `identical`, a head already reviewed, takes the same path, so a redelivered push isn't fully reviewed again.

Both `incremental` and `full` reviews fetch the bot's open threads from GitHub's GraphQL `reviewThreads` and list them for the model in two groups, with handles (`T1`, `T2`, …):

- **The threads to re-check.** In `full` mode, these are the threads GitHub marks outdated. In `incremental` mode, they are the threads on a marked line, and the outdated threads whose quoted line the push added or deleted in that file. For a thread with no stored quote, any change to its file counts. Deleting the flagged line, the most common fix, re-checks its thread. Threads the push didn't touch are left alone.
- **The other open threads** are listed so the model doesn't repeat them.
- **Duplicates.** A finding is set aside as a duplicate when it sits on an open thread's line, or quotes the code of an outdated one (whose line GitHub no longer reports). A thread that isn't outdated still has its line, so a common line such as `}` elsewhere in the file is no repeat. The check runs against every open thread, listed or not. A blocking finding on the line of a thread that isn't blocking still posts, since that thread doesn't gate approval. Like other rejections a duplicate goes back to the model once, but it doesn't hold approval back, since the open thread already does.
- **The cap.** The lists hold at most 30 threads, newest first, with the threads to re-check ahead of the rest. A note counts the threads left out.

The model names the threads it fixed in `addressed_threads`. Only the bot's own unresolved threads are touched:

- **Before the review is chosen,** the host resolves each named thread with `resolveReviewThread`, best effort, like the check-run calls. The event then counts only the threads that resolved.
- **After the review posts,** it replies "Fixed in `def5678`." on each one that resolved. A publish retried after a failed `createReview` resolves again, which is harmless, but never replies twice.
- **Approval.** Such a review never approves while one of the bot's blocking threads stays open, counting every open thread, not only those listed. If the threads couldn't be read, it never approves at all. Neither does it when a pull request has more than the 500 threads the query pages through, since an incomplete count could miss a blocker.

The summary comment keeps the last full review's summary and walkthrough. An incremental review replaces the walkthrough rows of the files it covered and adds a "Since `abc1234`" section. The merge danger under the verdict carries across too: it shows the stricter door of the stored judgement and the push's, the push's when they are equal, so a push that judges a two-way door doesn't soften a one-way one. The review's body says what it covered: "Incremental review of `abc1234..def5678`: 3 files; 2 threads resolved." or "Full review.". `review.start` logs `mode`, `since`, `covered` and `recheck`; `review.resolved` and `review.skip` (`no_new_changes`) say what happened.

### Approval state machine

`evaluateApproval` decides whether to approve the current head without a push (#25). It runs when a thread is resolved or unresolved, when a check suite other than andabot's finishes, and after a posted review that didn't approve, except one that just posted a blocking finding, whose thread is certainly open and may not show in GitHub's list yet. It makes no model call. `decideApproval` in `src/review/approval.ts` is a pure function of what the object reads live, and it waits for the first of these that holds:

1. `workflow_off`: `REQUEST_CHANGES_WORKFLOW` isn't `true`.
2. `paused`.
3. `not_open`: the pull request is closed, merged or a draft.
4. `review_in_flight`: a review is pending. It evaluates when it ends.
5. `not_reviewed`: the head isn't the reviewed head.
6. `no_record`: there is no `last_review`, as on a pull request last reviewed before this shipped.
7. `approved`: the last review is an approval, of this head or an earlier one, so a push with nothing new to review brings no second approval.
8. `review_stands`: the last review held back a blocking finding it couldn't post inline, which no one can resolve, or only commented without an `approve` verdict. Re-evaluation lifts a request for changes, whatever verdict the model gave, and an approval held back only by unreadable threads or unfinished checks. It never turns a review that only commented into an approval.
9. `threads_unknown`: the threads couldn't be read, or there are more than the 500 the query pages through.
10. `blocking_threads`: one of andabot's blocking threads is open.
11. `checks_unknown`, `checks_failing` and `checks_pending`: the head's check runs other than andabot's couldn't be read, one completed with a conclusion other than success, neutral or skipped, or one hasn't completed.

Otherwise the object re-fetches the head and, if it hasn't moved, submits `APPROVE` on it with a short body, records it as `last_review`, and rewrites the summary comment's verdict to "Approved at `def5678`". The check run keeps the review's title. A later failing check or a reopened thread doesn't revoke the approval, and the next review of a new head decides again. A thread event and a check event can arrive together, so an in-memory mark per head keeps the second from approving too.

A review's own approval waits for the checks as well. When `chooseReviewEvent` would approve, the host reads the head's check runs first. Unless they pass, the review posts as a comment, its summary and check run say "Approval waits for the checks", and the evaluation approves once they pass, since that review's `last_review` keeps the model's `approve` verdict. A clean head whose checks finish after its review gets two reviews: the comment, then the approval.

A head with no check runs besides andabot's passes, so a repository without CI can be approved. Just after a push that is a race, because CI hasn't created its first run yet (on #46 it appeared 9 s after the push), so a push with nothing new to review doesn't evaluate, and CI's suite completion does later. The window that's left is accepted: a thread resolved within seconds of such a push, or a review that ends before CI creates its first run, can approve a head whose CI then fails.

Rules copied from CodeRabbit's workflow: approve only when the latest commit has a completed review, every blocking bot thread is resolved, no check fails, and the head is unchanged at the moment of approval. An optional finding never blocks; only findings marked blocking open threads that gate approval. Only check runs count, not commit statuses, and a fork's check events can't be routed, since GitHub sends them with no pull request. Branch protection keeps one human approval required regardless, and GitHub's "code review limits" setting must allow the App to submit approving reviews.

The evaluation logs `approval.decided` with its trigger, the head and the reason it waited, `approval.posted` with the review id, and `approval.checks_failed`, `approval.summary_failed` and `approval.failed` when a read or a write fails.

### Commands and chat

`@andabot <command>` in an issue comment or review comment. The App's login is `andabot[bot]`; GitHub resolves the mention `@andabot` to it. Commands: `review`, `full review`, `summary`, `resolve`, `pause`, `resume`, `help`. Anything else is a chat turn in the PR's Pi session, which already holds the review transcript, so "why is this a problem?" on a thread works without re-reading the PR. Replies to a review comment go back on that thread.

Only users with write access to the repo can issue commands; the router checks the commenter's permission before forwarding.

### Configuration file

`.andabot.yaml` at the PR head, optional:

```yaml
reviews:
  auto: true
  drafts: false
  base_branches: ["main"]
  ignore_title_keywords: ["WIP"]
  request_changes_workflow: true
  path_instructions:
    - path: "apps/worker/**"
      instructions: "Receipts must stay decodable for 24 hours after a deploy."
  path_filters: ["!pnpm-lock.yaml", "!**/*.snap"]
model:
  draft: "@cf/zai-org/glm-5.3-flash"
  verify: "@cf/moonshotai/kimi-k2.7-code"
```

## Models

Workers AI through the Pi AI provider, with AI Gateway for anything else. The account is on Workers Paid, so the whole catalog is available. The first 10,000 neurons a day are free, and spend above that is billed per model.

| Role | First choice | Fallback | Why |
| --- | --- | --- | --- |
| Review, one pass (phase 1, live) | `@cf/zai-org/glm-5.3-flash` | | On #2 it caught all five of #9's planted defects with no false positive and posted through the tool, for under a cent a review. gpt-oss-120b caught 4 or 5 and skipped the tool on #18 and #19, Gemma 4 26B caught 4 and leaned on the text fallback, and Qwen3.8-27B's stream died mid-review. No model has caught #38's defect yet |
| Draft findings and walkthrough (phase 2) | `@cf/zai-org/glm-5.3-flash` | `@cf/zai-org/glm-4.7-flash` | Cheap per token, long context, good enough for candidates |
| Verify findings, chat replies (phase 2) | `@cf/moonshotai/kimi-k2.7-code` | `@cf/openai/gpt-oss-120b` | Code-tuned, stronger reasoning, called on a small input |
| Emergency fallback | OpenRouter `:free` models via AI Gateway | | 50 requests a day without a card; models rotate, so never primary |

Every request must carry an output limit. The Agents SDK's Cloudflare provider (agents 0.28.1) sends `max_tokens` only when the caller passes one, Pi Durable never does, and Workers AI then stops at 256 output tokens, before a reasoning model reaches its tool call. `PiHarness` keeps only a model's provider and id, so options given to `ai(id, options)` never reach a request, and the limit has to come from the registry's provider. `src/models.ts` wraps it to ask for `MAX_OUTPUT_TOKENS` output tokens, or fewer when the model's catalog maximum or the room left in its context is smaller. The var defaults to 16,000, since gpt-oss reasons before it calls a tool, and is raised on deploy for larger pull requests. The catalog maximum alone is no limit: for GLM-5.3 Flash and DeepSeek V4 it is the whole 1M context window, and for Qwen3.8-27B and Kimi K2.7 Code, 262,144.

The Pi AI provider's `fallback` option gives a chain per model, but only on a model the registry's provider lists with that option; passed to the harness through `ai(id, { fallback })`, it is dropped like any other option. Costs are tracked per conversation in Pi's `pi.usage` document, so the summary comment can print what the review cost.

## Execution tiers for repo access

1. **API only.** PR files and patches, file contents at a ref, trees, code search. Enough for diff review. Phase 1.
2. **Workspace clone, no container.** `@cloudflare/computer` keeps a filesystem in the object's SQLite and clones with isomorphic-git in the host, so `grep` and `find` across a shallow clone work without a container. Phase 2.
3. **Sandbox.** A Container per review run, started from the PR object with the Durable Object scheduling policy, outbound HTTP intercepted so it reaches only `github.com` and the model gateway, a one-minute alarm that keeps it alive while a check runs, and a 30-minute inactivity timeout. Runs lint, typecheck and the test suite on the head and feeds the tail to the verify pass. Phase 3.

## Package pins (as of 17 Oct 2026)

| Package | Version | Role |
| --- | --- | --- |
| `agents` | 0.28.1 | `PiHarness`, `Lifecycle`, `agents/models/pi-ai` |
| `@earendil-works/pi-durable` | 1.3.0 | the harness |
| `@earendil-works/pi-ai` | 1.3.0 | model provider interface |
| `@earendil-works/chord` | 1.3.0 | contexts and documents, peer of pi-durable |
| `@cloudflare/computer` | ^0.5.1 | SQLite workspace with git |
| `@cloudflare/sandbox` | 1.0.1 | Containers tier |
| `wrangler` | 4.151.1 | |
| `@octokit/webhooks-methods` | 6.0.0 | HMAC verification (WebCrypto) |
| `@octokit/auth-app` | 8.3.1 | App JWT and installation tokens, or a hand-rolled RS256 if the dependency is heavy on Workers |

## Tests

`pnpm test` runs unit tests of the pure modules in Node, whose WebCrypto is the one the Worker uses, and `test/lint` checks that every folder gets the lint rules. Tests against the Durable Object itself are phase 2.

## Phases

1. **Walking skeleton.** GitHub App, router Worker, PR object with `PiHarness`, API-only tools, full review on open, summary comment and one review with inline comments, `review` and `help` commands. Deployed and reviewing this repo's own PRs.
2. **CodeRabbit parity.** Approval state machine, config file, path instructions, incremental review, remaining commands, chat turns, workspace clone with grep, verify pass, cost in the summary. It opens with the skills work, each step measured on #2's planted-bug pull request with gpt-oss-120b and Kimi K2.7 Code:
   - **Baseline.** The planted-bug pull request reviewed on the phase 1 build, with the results recorded in #2.
   - **Slice 1: the review procedure as skills.** The review and answer skills, bundled and activated by the host; a system prompt of identity and tools; the model and the skill fingerprint in the summary footer, the logs and the posted review's record (#11).
   - **Slice 2: basis, coverage and the spec axis.** Basis, merge danger, walkthrough coverage, the submit loop's outcome type and linked issues, on top of the anchors #12 shipped for #4.
3. **Sandbox tier.** Container image, lint, typecheck and tests on the head, results into the verify pass.
4. **Extras.** Sequence diagram, docstrings, unit test generation.

## Open questions

- Where the config file lives when the PR head doesn't have one: default branch, then built-in defaults.
- How to mark findings as blocking versus optional in a way the model follows reliably; the verify pass is the place to decide severity, not the draft.
- Review of very large PRs: a cap on files reviewed with an explicit "skipped" list in the summary, or chunked sub-sessions through Pi's subagents.

## References

- Cloudflare Pi harness: https://developers.cloudflare.com/agents/harnesses/pi/
- Pi harness example: https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi
- Pi Durable README: https://github.com/earendil-works/pi/tree/main/packages/durable
- Pi AI provider for Workers AI and AI Gateway: https://developers.cloudflare.com/agents/models/pi-ai/
- Agents SDK Lifecycle: https://github.com/cloudflare/agents/blob/main/docs/agents/lifecycle.md
- `@cloudflare/computer`: https://github.com/cloudflare/computer
- Sandbox SDK coding agent runner: https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/
- Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- CodeRabbit request-changes workflow: https://docs.coderabbit.ai/pr-reviews/request-changes-workflow
- CodeRabbit commands: https://docs.coderabbit.ai/reference/review-commands
- OpenCode harness on Cloudflare, the alternative not taken: https://developers.cloudflare.com/agents/harnesses/opencode/
