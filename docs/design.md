# andabot: design

`andabot` is a self-hosted pull request reviewer in the shape of CodeRabbit: it reviews every PR on its own, answers when tagged, posts a summary and inline findings with suggestions, requests changes when it finds something, and approves once its findings are resolved. It runs on Cloudflare: a Worker receives GitHub webhooks and hands each PR to its own Durable Object, where Pi Durable runs the agent loop.

Status: phase 1, the walking skeleton, is built, deployed and reviewing this repository's pull requests (#1), and `pnpm check` runs on every pull request in GitHub Actions (#3). Next: #2 measures review quality.

## Decisions so far

| Question | Decision | Why |
| --- | --- | --- |
| Agent harness | Pi Durable through the Agents SDK's `PiHarness` | Every turn, tool call and piece of state is committed before it is shown; idempotent submissions by request id; hooks before and after tool calls; survives eviction. Smallest loop of the three options. |
| Approval policy | Request changes on actionable findings, approve when they are resolved | CodeRabbit's request-changes workflow, which is the feature worth keeping. |
| Plan | Workers Paid, since 17 Oct 2026 | Unlocks Workers AI's paid models, such as Kimi K2.7 Code, and Containers for the sandbox tier. Reviews still run on gpt-oss-120b until #2 compares models. |
| Repos | Andrew's own repos, public and private, through one GitHub App named `andabot` | An App's approval counts toward required reviews like a person's. The default Actions token's does not without an org setting. |
| State | One Durable Object per pull request | Memory per PR for chat follow-ups, the approval state machine and incremental review live where the PR does. |

Both `PiHarness` and Pi Durable are beta. APIs will move, so every package is pinned and upgrades are deliberate.

## Architecture

```
GitHub ──webhook──▶ Worker (router)
                      │  verify X-Hub-Signature-256
                      │  dedupe on X-GitHub-Delivery
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
| `pull_request_review_thread` | resolved, unresolved | re-evaluate approval |
| `check_run` / `check_suite` | rerequested | full review of each listed pull request |
| `check_suite` | requested | ignored: the pull request event starts the review |
| `check_suite` / `check_run` | completed | re-evaluate approval (skipping andabot's own suite) |

App permissions: Pull requests write, Contents read, Issues write, Checks write (the review check run), Metadata read.

### PullRequest Durable Object

State in its SQLite, beside Pi's `pi_` tables:

- `reviewed_head`: the head SHA of the last completed review, and the base SHA it was diffed against.
- `summary_comment_id`: the one issue comment that is edited in place on every push.
- `bot_threads`: review comment ids the bot opened, with the finding each carries and whether it is resolved.
- `last_review`: the review id and event (`REQUEST_CHANGES`, `COMMENT`, `APPROVE`) the bot last submitted.
- `config`: the parsed `.andabot.yaml` from the PR head, refreshed on each push.
- `paused`: set by `pause`, cleared by `resume`.
- `pending`: the review in flight, with its head, delivery id, operation id, start time and check run id, the model and skill fingerprint that attribute it, and whether its rejected findings have gone back to the model; one per object, because reviews are single-flight.

Methods, each an idempotent Pi submission:

- `onPush(head, delivery)`: full review on first sight, incremental review (`compare reviewed_head...head`) after that.
- `onCommand(comment, delivery)`: `review`, `full review`, `summary`, `resolve`, `pause`, `resume`, `help`, else a chat turn.
- `onThreadResolved`, `onChecksCompleted`: run the approval evaluation, no model call.

Reviews are single-flight per pull request. A newer head aborts the running review and cancels its check run as superseded. A request for a head whose review is still running is skipped. A pending review the harness no longer lists is dead: its run is failed and the new review proceeds. A record whose start time is under two minutes old counts as live. The grace bounds only the host's work while none of the review's operations is listed: before its first prompt is submitted, between that prompt and the retry, and after each. So the record is written before the first prompt, and its start time restarts when each prompt returns and again before the retry. The replacer deletes the record, aborts the replaced review's operations, and only then completes its run, from the id it read before the delete, so the replaced review's exits find the record gone and touch nothing. A review replaced before its prompt never prompts, and the run it opened is cancelled as superseded, or as replaced when the newer review is of the same head. A `submit_review` call posts only from a running operation the record names, and the host posts a review the model wrote as text only while the record still names its delivery.

The object is addressed only through the router. It has no public HTTP surface.

After a deploy, Cloudflare moves the Worker and its Durable Objects to the new build eventually, so for seconds to minutes a new Worker can call an object still running the previous build, with that build's model and logic. The Worker passes its version with each event: `review.start` logs `staleBuild` and `callerBuild`, and `review.failed` logs `staleBuild`, so a failure during a rollout can be traced to it. The next event, or `@andabot review`, runs on the new build. When Pi resumes an interrupted review on the new build, the summary footer and the `posted:<sha>` record still take the model and skill fingerprint from `pending`, where `review()` stored those of the build that started it.

### Pi harness inside the object

Following Cloudflare's `examples/next/harnesses/pi`: `createAI({ binding: env.AI })` as the Pi AI provider, `createRegistry()` with one extension for the system prompt and tools, `Harness.open(storage, { models, registry, settings })` in the `PiHarness` factory, `Lifecycle.install(this).use(this.harness)`.

Pi applies the harness's `defaults` only when it creates a session, so every run sets the configured model with `setModel` before it prompts. Each review starts with `session().reset()`, so earlier reviews and their large prompts don't pile up in the context or overflow it.

Phase 1 takes the review through a `submit_review` tool, whose arguments host code validates and posts, but nothing holds the model to calling it: on #5, gpt-oss-120b wrote those arguments as its final message instead (#6). So when a review run ends without a posted review, the host reads that message. A `ReviewSubmission` written as JSON, bare or in a `json` code fence, goes to `submitReview`, which validates and posts it as if the tool had been called. Anything else, or a submission `submitReview` refuses, gets one more prompt in the same session to call `submit_review`, and only what that run submits through the tool is posted. If the head moves meanwhile, nothing more is asked or posted, since the review of the new head takes over. Otherwise, when nothing is posted, the summary says so and why, and keeps prose as its note. JSON never reaches the comment: text holding a JSON object counts as JSON, and what doesn't fit `ReviewSubmission` goes to the log as `review.unfit_json`. `review.done` logs `source` as `tool`, `text` or `retry`, so Workers Logs shows how often the model skips the tool, which feeds #2's choice of model.

Findings are anchored by copying, not counting (#4). On #1 the model counted lines down from each hunk header, miscounted over new files a few hundred lines long, and all three comments landed on the wrong line with committable suggestions that would have broken the build. So every patch line in the prompt starts with the anchor GitHub's review API takes, `R12` for line 12 of the new file or `L10` for line 10 of the old one, and every finding quotes the text of its line. `validateFindings` compares the quote with the patch line at that side and number. On a mismatch it moves the finding to the one line on the same side of the same file whose text matches, dropping any range and that range's suggestion, since only the quoted line is verified; it rejects the finding when no line or several match. A line outside the diff is rejected rather than moved, since its number and quote most likely came from `read_file`, and a short line such as `}` would match some unrelated line of the diff. A range must lie wholly inside the diff, a suggestion is at most 60,000 characters, and a rendered comment at most 65,536, GitHub's limit, because one comment GitHub refuses fails the whole review.

A suggestion replaces the anchored lines whole, indentation included, and the model writes it like a code block in prose: on #9 every suggestion lost its line's indentation, and one restoring a deleted guard replaced the line after the deletion instead of going above it, which would not have compiled (#14). So when a suggestion is less indented than the lines it replaces, the host moves its common indentation to theirs, keeping its relative indentation; a suggestion indented further is left alone, since that may be deliberate. Then the suggestion must leave each kind of bracket, `()`, `[]` and `{}`, as balanced as the lines it replaces. When it doesn't, committing it would unbalance the file, so the host drops the suggestion and posts the finding without it, since the comment still explains the fix.

The first submission with any rejected finding is not posted: every rejection goes back to the model once, as the tool's result or in the prompt that asks again, and the next submission posts with whatever still fails dropped. A blocking finding that stands rejected still holds approval back: the review requests changes, and its body names the finding. `review.findings` logs the accepted, relocated and rejected counts of every submission, and how many suggestions were dropped.

Tools offered to the model, all read only and `replay: "safe"`:

| Tool | Backed by |
| --- | --- |
| `get_pr` | PR metadata, title, body, labels, base and head |
| `list_changed_files` | `GET /pulls/{n}/files`, with per-file patch |
| `get_diff` | compare API for incremental ranges, `.diff` media type |
| `read_file(path, ref)` | `GET /contents?ref=` or the workspace clone |
| `tree(path)` | git trees API or the workspace |
| `grep(pattern, glob)` | `@cloudflare/computer` workspace over a shallow clone in SQLite |
| `run_check(name)` | phase 3: Sandbox runs lint, typecheck or tests, returns the tail |

Posting is not a model tool. The model fills a structured findings document, defined with Pi Durable's `defineDoc`, and host code validates each finding against the diff hunks before anything reaches GitHub: the path must be in the PR, the line must be in a hunk on the right side and hold the text the finding quotes, severity must be one of the known values, and a suggestion must be a replacement for the lines it names. A finding that fails validation goes back to the model once, then is dropped and logged. This is the same shape the Agents docs recommend: the model proposes, your code decides.

A `beforeTool` hook enforces budgets: a cap on files read per review, on bytes per read, and on total model tokens per review, with the review ending in a shorter summary rather than a failed run.

### Skills

The review procedure, with its severity rubric and references, and the rules for answering a question are Agent Skills under `skills/`, bundled into the Worker as text and fingerprinted together with SHA-256; the logs and each posted review's record carry that fingerprint beside the model id, and the summary footer shows its first eight characters as `review@…`. Before each review, after `reset()`, the host renders the review skill and its four references into the root conversation's `instructions`, and a question carries the answer skill in its own message instead, since `configure()` takes effect at once and would swap the instructions of a review still running. The Agents SDK's skills catalog, with `activate_skill` and `read_skill_resource`, waits for repo-provided skills in slice 3: offered those two tools, gpt-oss-120b printed its calls as raw text and never posted (#19), so the model keeps `read_file`, `list_changed_files` and `submit_review`. `docs/superpowers/specs/2026-10-17-skills-design.md` holds the design, the reasons behind it and the order of work.

`renderActivatedSkill` mirrors the private `renderSkillContent` in the Agents SDK's `agents/harness/pi`, and `renderSkillWithResources` wraps each reference as its `read_skill_resource` does, so re-check both against the SDK on every `agents` bump.

### Review pipeline

1. Gather: changed files, patches, PR body, the repo's config file, and the instruction files the repo already keeps for agents (`CLAUDE.md`, `AGENTS.md`, `REVIEW.md`) as path-scoped guidance.
2. Draft: one pass over the diff, in chunks sized to the model's context, producing candidate findings and a per-file walkthrough.
3. Verify: a second pass takes each candidate with the exact lines it cites and the surrounding file, and keeps it only if the problem is real on those lines. This is what makes cheaper models usable; unverifiable findings are the noise people leave CodeRabbit over.
4. Post: edit the summary comment in place, submit one review with the inline comments, set the review event from the approval policy below, and complete the check run, in progress since step 1, with the verdict in its title. A review that does not complete fails it.
5. Record: `reviewed_head`, thread ids, the review id.

Incremental review on `synchronize` diffs only `reviewed_head...head`, re-checks whether the bot's open threads still apply to the new head (a thread whose lines were changed is replied to and resolved), and posts a short delta to the summary.

### Approval state machine

Evaluated after every review, thread resolution and check completion:

```
if paused                             → do nothing
if head ≠ reviewed_head               → wait for the review of the current head
if bot has unresolved threads         → REQUEST_CHANGES stands
if required checks not all passing    → wait
re-fetch head; if it moved            → wait
else                                  → APPROVE, once per head
```

Rules copied from CodeRabbit's workflow: approve only when the latest commit has a completed review, every bot thread is resolved, no pre-merge check fails, and the head is unchanged at the moment of approval. An optional finding never blocks; only findings marked blocking open threads that gate approval. Branch protection keeps one human approval required regardless, and GitHub's "code review limits" setting must allow the App to submit approving reviews.

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
| Review, one pass (phase 1, live) | `@cf/openai/gpt-oss-120b` | | Reliable tool calls; #2 compares it with `@cf/moonshotai/kimi-k2.7-code` |
| Draft findings and walkthrough (phase 2) | `@cf/zai-org/glm-5.3-flash` | `@cf/zai-org/glm-4.7-flash` | Cheap per token, long context, good enough for candidates |
| Verify findings, chat replies (phase 2) | `@cf/moonshotai/kimi-k2.7-code` | `@cf/openai/gpt-oss-120b` | Code-tuned, stronger reasoning, called on a small input |
| Emergency fallback | OpenRouter `:free` models via AI Gateway | | 50 requests a day without a card; models rotate, so never primary |

Every request must carry an output limit. The Agents SDK's Cloudflare provider (agents 0.28.1) sends `max_tokens` only when the caller passes one, Pi Durable never does, and Workers AI then stops at 256 output tokens, before a reasoning model reaches its tool call. `src/models.ts` supplies the model's limit, as pi-ai's own adapters do. A review asks for up to 16,000 output tokens, since gpt-oss reasons before it calls a tool.

The Pi AI provider's `fallback` option gives a chain per model. Costs are tracked per conversation in Pi's `pi.usage` document, so the summary comment can print what the review cost.

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
