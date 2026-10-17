# ai-review-agent: design

A self-hosted pull request reviewer in the shape of CodeRabbit: it reviews every PR on its own, answers when tagged, posts a summary and inline findings with suggestions, requests changes when it finds something, and approves once its findings are resolved. It runs on Cloudflare: a Worker receives GitHub webhooks and hands each PR to its own Durable Object, where Pi Durable runs the agent loop.

Status: design, 17 Oct 2026. Nothing is built yet.

## Decisions so far

| Question | Decision | Why |
| --- | --- | --- |
| Agent harness | Pi Durable through the Agents SDK's `PiHarness` | Every turn, tool call and piece of state is committed before it is shown; idempotent submissions by request id; hooks before and after tool calls; survives eviction. Smallest loop of the three options. |
| Approval policy | Request changes on actionable findings, approve when they are resolved | CodeRabbit's request-changes workflow, which is the feature worth keeping. |
| Plan | Workers Paid (already in place) | Unlocks Containers for a real checkout with lint and tests, and the paid Workers AI coding models. |
| Repos | Andrew's own repos, public and private, through one GitHub App | An App's approval counts toward required reviews like a person's. The default Actions token's does not without an org setting. |
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
| `check_suite` / `check_run` | completed | re-evaluate approval |

App permissions: Pull requests write, Contents read, Issues write, Checks write (optional, for a "review" check run), Metadata read.

### PullRequest Durable Object

State in its SQLite, beside Pi's `pi_` tables:

- `reviewed_head`: the head SHA of the last completed review, and the base SHA it was diffed against.
- `summary_comment_id`: the one issue comment that is edited in place on every push.
- `bot_threads`: review comment ids the bot opened, with the finding each carries and whether it is resolved.
- `last_review`: the review id and event (`REQUEST_CHANGES`, `COMMENT`, `APPROVE`) the bot last submitted.
- `config`: the parsed `.ai-review.yaml` from the PR head, refreshed on each push.
- `paused`: set by `pause`, cleared by `resume`.

Methods, each an idempotent Pi submission:

- `onPush(head, delivery)`: full review on first sight, incremental review (`compare reviewed_head...head`) after that.
- `onCommand(comment, delivery)`: `review`, `full review`, `summary`, `resolve`, `pause`, `resume`, `help`, else a chat turn.
- `onThreadResolved`, `onChecksCompleted`: run the approval evaluation, no model call.

The object is addressed only through the router. It has no public HTTP surface.

### Pi harness inside the object

Following Cloudflare's `examples/next/harnesses/pi`: `createAI({ binding: env.AI })` as the Pi AI provider, `createRegistry()` with one extension for the system prompt and tools, `Harness.open(storage, { models, registry, settings })` in the `PiHarness` factory, `Lifecycle.install(this).use(this.harness)`.

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

Posting is not a model tool. The model fills a structured findings document, defined with Pi Durable's `defineDoc`, and host code validates each finding against the diff hunks before anything reaches GitHub: the path must be in the PR, the line must be in a hunk on the right side, severity must be one of the known values, and a suggestion must be a replacement for the lines it names. A finding that fails validation is dropped and logged. This is the same shape the Agents docs recommend: the model proposes, your code decides.

A `beforeTool` hook enforces budgets: a cap on files read per review, on bytes per read, and on total model tokens per review, with the review ending in a shorter summary rather than a failed run.

### Review pipeline

1. Gather: changed files, patches, PR body, the repo's config file, and the instruction files the repo already keeps for agents (`CLAUDE.md`, `AGENTS.md`, `REVIEW.md`) as path-scoped guidance.
2. Draft: one pass over the diff, in chunks sized to the model's context, producing candidate findings and a per-file walkthrough.
3. Verify: a second pass takes each candidate with the exact lines it cites and the surrounding file, and keeps it only if the problem is real on those lines. This is what makes cheaper models usable; unverifiable findings are the noise people leave CodeRabbit over.
4. Post: edit the summary comment in place, submit one review with the inline comments, and set the review event from the approval policy below.
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

`@<bot-login> <command>` in an issue comment or review comment. Commands: `review`, `full review`, `summary`, `resolve`, `pause`, `resume`, `help`. Anything else is a chat turn in the PR's Pi session, which already holds the review transcript, so "why is this a problem?" on a thread works without re-reading the PR. Replies to a review comment go back on that thread.

Only users with write access to the repo can issue commands; the router checks the commenter's permission before forwarding.

### Configuration file

`.ai-review.yaml` at the PR head, optional:

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

Workers AI through the Pi AI provider, with AI Gateway for anything else. On Workers Paid the whole catalog is available, and spend above the free 10,000 neurons a day is billed per model.

| Role | First choice | Fallback | Why |
| --- | --- | --- | --- |
| Draft findings and walkthrough | `@cf/zai-org/glm-5.3-flash` | `@cf/zai-org/glm-4.7-flash` | Cheap per token, long context, good enough for candidates |
| Verify findings, chat replies | `@cf/moonshotai/kimi-k2.7-code` | `@cf/openai/gpt-oss-120b` | Code-tuned, stronger reasoning, called on a small input |
| Emergency fallback | OpenRouter `:free` models via AI Gateway | | 50 requests a day without a card; models rotate, so never primary |

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

## Phases

1. **Walking skeleton.** GitHub App, router Worker, PR object with `PiHarness`, API-only tools, full review on open, summary comment and one review with inline comments, `review` and `help` commands. Deployed and reviewing this repo's own PRs.
2. **CodeRabbit parity.** Approval state machine, config file, path instructions, incremental review, remaining commands, chat turns, workspace clone with grep, verify pass, cost in the summary.
3. **Sandbox tier.** Container image, lint, typecheck and tests on the head, results into the verify pass.
4. **Extras.** Sequence diagram, docstrings, unit test generation, a check run that mirrors the review state.

## Open questions

- Bot identity: the App's login is what people tag, so the App name is the command prefix. Pick it before phase 1.
- Where the config file lives when the PR head doesn't have one: default branch, then built-in defaults.
- Whether to open a check run per review so the review state shows in the merge box, or rely on the review event alone.
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
