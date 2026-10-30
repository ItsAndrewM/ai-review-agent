# Setting up andabot

What Andrew does once, and what the Worker needs from it.

## 1. Register the GitHub App

`scripts/register-app.mjs` registers the App from a [manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), so GitHub generates the webhook secret and the private key and hands them back to the script. Nothing is typed into a form or downloaded.

```sh
node scripts/register-app.mjs ~/andabot-app.json            # then open http://localhost:8790/ signed in to GitHub
```

Confirm on GitHub's page (it may ask for sudo mode first). The script writes the App's id, slug, private key and webhook secret to the output file with mode 600; keep it somewhere private, or delete it once the secrets are in the Worker. GitHub can generate a new key at any time.

The manifest registers, and the script's arguments can change: the name `andabot` (fall back to `andabot-review` if taken, and set `BOT_LOGIN` to match), the webhook URL `https://andabot.dinocode.workers.dev/webhook`, and the homepage. It asks for these permissions and events:

| | |
| --- | --- |
| Repository permissions | Pull requests: Read and write · Contents: Read and write · Issues: Read and write · Checks: Read and write · Metadata: Read-only |
| Events | Pull request · Issue comment · Pull request review · Pull request review comment · Pull request review thread · Check suite · Check run |
| Where it can be installed | Only on this account |

Checks: Read and write lets the App create the review check run and receive the `check_run` and `check_suite` events. Contents: Read and write lets it resolve the review threads a push fixed. GitHub lets only the pull request's author or someone with write access resolve a conversation, and for an App that means Contents write; Pull requests write isn't enough. That permission is broader than the one call: an installation token with it can change the repository's files and branches. The Worker uses it only to resolve threads, so install the App only on repositories it reviews, and treat its private key and tokens as write credentials. The sandbox tier never holds that token: the token its outbound handler adds to `github.com` requests is minted for the sandbox alone, read-only on the reviewed repository's contents, so code running in a sandbox can fetch but not push.

To change an App that is already registered, set the permission on its Permissions & events page, then accept the request on the installation page (Settings, Applications, Installed GitHub Apps, andabot). Until it is accepted, those calls answer 403 "Resource not accessible by integration". The Worker logs a failed check call as `check.failed` and a failed resolve as `review.resolve_failed`, and otherwise ignores both. The installation token is cached per pull request object for up to an hour, so a pull request opened before the change can lack the permission for that long, and a new pull request is unaffected. A new event, such as Pull request review, is a box under Subscribe to events on the same page.

Then **install** the App on the repositories it should review, at `https://github.com/apps/andabot/installations/new`. It is installed on `ai-review-agent` only, for now.

GitHub's "Code review limits" setting on a repository can block an App from submitting approving or request-changes reviews. If reviews come back as plain comments, check that setting.

## 2. Deploy the Worker

```sh
pnpm install
pnpm check                      # lint, typecheck and unit tests
pnpm exec wrangler login        # once per machine
pnpm run deploy                 # `pnpm run`, since pnpm has a built-in `deploy` command
scripts/set-secrets.sh ~/andabot-app.json
```

`pnpm run deploy` and `pnpm dev` need Docker running: wrangler builds `container/Dockerfile`, the sandbox tier's image (#131), and uploads it with the Worker. CI needs none, since `pnpm check` builds no image.

The Worker is at `https://andabot.dinocode.workers.dev`. `GET /health` answers `{"name":"andabot","ok":true}`; a webhook with a bad signature answers `401`, and a signed `ping` answers `200 {"ignored":"no installation or repository"}`. The App's **Advanced** tab lists every delivery and can redeliver one.

Variables in `wrangler.jsonc`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOT_LOGIN` | `andabot` | The App's login without `[bot]`. Must match the App name. |
| `REVIEW_MODEL` | `@cf/zai-org/glm-5.3-flash` | Workers AI model. GLM 5.x, the default included, Kimi K2.7 Code and DeepSeek V4 need the Workers Paid plan; gpt-oss-120b and glm-4.7-flash also run on Free. Workers AI's free 10,000 neurons a day cover about 15 to 28 reviews on GLM-5.3 Flash, as measured on #2. |
| `MAX_OUTPUT_TOKENS` | `16000` | Most output tokens one model call may ask for, reasoning included; the model's own maximum and its context still cap it. Raise it, for example with `--var MAX_OUTPUT_TOKENS:32000` on deploy, when large pull requests get cut-off reviews. Anything but a positive whole number falls back to 16,000. `review.start` logs the value in effect as `maxOutputTokens`. |
| `MAX_REVIEW_NEURONS` | `10000` | Neurons after which the model is told to submit; if it still hasn't three model requests later, the review fails. The request that crosses it and those three are spent past it. 10,000 is one day of Workers AI's free allowance. Anything but a positive whole number falls back to 10,000, and spend on a model without a price isn't counted. `review.budget_spent` and `review.budget_refused` log the two stops. |
| `SANDBOX` | `true` | The sandbox tier (#132): a review may start a container on its first `run_check` call, check out its head and install, and the container is destroyed when the review ends. On by default since #135's measurement (29 Oct 2026): GLM-5.3 Flash confirmed a planted test failure and a planted type error with `run_check` and cited the runs, for $0.002 to $0.003 of container time a review, and never asked for the sandbox on a docs-only change. `false` turns the tier off everywhere; a repository opts out with `reviews.sandbox: false` (section 6). What a pull request can cost is bounded below the table. |
| `MAX_SANDBOX_SECONDS` | `900` | Wall seconds a review may spend in its sandbox, checkout and install included; past it `run_check` answers that the sandbox budget is spent. Anything but a positive whole number falls back to 900. `sandbox.spent` is logged once per review when it happens, and `review.done` carries `sandboxSeconds`, `sandboxUsd` and `checks` when a sandbox was asked for. The summary comment's cost line shows the time and its dollars at `standard-1`'s rates, $0.00002056 a second, so a full budget costs about two cents; the Workers Paid plan includes 375 vCPU-minutes and 25 GiB-hours a month, which at half a vCPU and 4 GiB is 22,500 s of `standard-1`, 25 such reviews or about 300 reviews like #142's 77 s, memory being the binding allowance. The summary's `Checks` line lists each `run_check` run and how it ended (#134). |
| `SANDBOX_CHECK_TIMEOUT` | `300000` | Milliseconds one `run_check` command may take (#133); past it the process group is killed and the tool answers that the check timed out. Anything but a positive whole number falls back to 300,000. |
| `REQUEST_CHANGES_WORKFLOW` | `true` | `true`: request changes on blocking findings, approve clean PRs. `false`: comment only. A repository's `.andabot.yaml` overrides it with `reviews.request_changes_workflow` (section 6). |
| `VERIFY_MODEL` | empty | Workers AI model for the verify pass (#31), a second pass that keeps or drops each blocking finding and suggestion, and sets its severity, before a review posts. Empty turns verify off for every repository, whatever its `.andabot.yaml` says; it remains empty because neither model passed the [24 Oct replay](https://github.com/ItsAndrewM/ai-review-agent/issues/31#issuecomment-6389469628). Set it in `wrangler.jsonc`, or with `--var VERIFY_MODEL:<model id>` on deploy, to turn verify on after a model clears the bar; a repository's `model.verify` then overrides it and `reviews.verify: false` opts the repository out (section 6). A model id Workers AI doesn't serve fails verify, so each review posts unverified. A review that has reached `MAX_REVIEW_NEURONS` skips verify and posts unverified too, and verify's spend is in the cost line. |
| `SANDBOX_PROBE` | `false` | `true` turns on `POST /sandbox-probe`, which drives a pull request's sandbox by hand for #131's live check (section 3). The `false` in `wrangler.jsonc` is the default every deploy gets; turn it on for one deploy with `--var SANDBOX_PROBE:true`, or locally in `.dev.vars`, rather than editing the default. It goes once `run_check` (#133) uses the sandbox. |

**What a pull request can cost in the sandbox.** Every pull request runs checks, a stranger's included, bounded by caps rather than by who opened it. Its test files run, so a hostile pull request can make a test sleep (one `SANDBOX_CHECK_TIMEOUT`, 300 s), call out (the allowlist answers 403 to every host but `github.com` and `registry.npmjs.org`) or add install scripts (the install runs none). One review spends at most about 1,200 s of `standard-1`, $0.025: checkout and install each stop at five minutes, checks run one at a time under the 300-second timeout while the sandbox's wall time is under `MAX_SANDBOX_SECONDS` (900 s), and a check that starts just under the budget runs to its own timeout. A review that dies without destroying its container is ended by a drop job at the budget plus two minutes, $0.021 at most, with the 30-minute inactivity backstop ($0.037) as the last resort (#140). Across pull requests the lease caps running sandboxes at three, each lease outliving its review by at most the budget plus two minutes, so the account runs at most three containers at once, $0.22 an hour and $5.33 a day with every slot busy around the clock. Measured on 29 Oct 2026 (#135), a review that asks for the sandbox costs $0.002 to $0.003 of container time.

## 3. Local development

Copy `.dev.vars.example` to `.dev.vars` and fill it in, then `pnpm dev`. The AI binding is remote, so `wrangler login` is needed even locally; in a non-interactive shell set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead. To deliver real webhooks to a local Worker, point the App at a tunnel (`cloudflared tunnel --url http://localhost:8787`).

A webhook can also be replayed by hand. Sign the body with the secret and post it:

```sh
BODY='{"zen":"hi"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | sed 's/^.* //')"
curl -s -X POST localhost:8787/webhook -H "x-github-event: ping" -H "x-github-delivery: test-1" -H "x-hub-signature-256: $SIG" -d "$BODY"
```

**Probing the sandbox.** With `SANDBOX_PROBE=true` in `.dev.vars` (or `--var SANDBOX_PROBE:true` on a deploy), `POST /sandbox-probe` takes a body signed the same way: a pull request key, an `action` of `run` or `destroy`, and for a run the `command` as an argv array, with optional `cwd` (default `/workspace`), `timeoutMs` (default 60,000) and `tailBytes` (default 8 KiB, 50 KiB at most). A run starts the pull request's sandbox with its installation token, runs the command and answers `{ outcome: "exited", exitCode, tail, cut }` or `{ outcome: "timeout", tail, cut }`; a destroy stops the container. A `prepare` goes through the pull request object instead, the path a review takes (#132): it takes a lease, starts the sandbox with a read-only token, checks out the head and installs, and answers `{ kind: "ready", dir, manager }`, or `off`, `spent` or `unavailable` with its reason; it needs `SANDBOX=true`. A `check` with a `name` (`lint`, `typecheck` or `test`) and optional `paths` runs `run_check` through the same object and answers its text (#133). An `end` drops the object's sandbox when no review is active, the teardown a review's end runs, and answers `{ ended: true }` (#140); restart `wrangler dev` between a `prepare` and a `check` to see the sandbox restored from storage, or lost when the dev server stopped its container. The sandbox reaches only `github.com` and `registry.npmjs.org`, over HTTPS; a `fetch` to any other host from inside answers 403.

```sh
BODY='{"key":{"installationId":1,"owner":"ItsAndrewM","repo":"ai-review-agent","number":1},"action":"run","command":["node","--version"]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | sed 's/^.* //')"
curl -s -X POST localhost:8787/sandbox-probe -H "x-hub-signature-256: $SIG" -d "$BODY"
```

**Measuring recall.** `pnpm recall --model @cf/zai-org/glm-5.3-flash --thinking low` replays a full review of every head in the frozen set (`tools/recall/set.json`) on Workers AI, three times each, and prints a table of which expected findings were found by majority, how many unmatched findings count as false, severity and verdict matches, and the cost a review; it needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with Workers AI permission, and stops before the call that would pass the $15 cap in `tools/recall/runs/spend.jsonl`. `--thinking` takes a level the model runs (GLM-5.3 Flash: `low`, `high`, `max`), `--runs 1` is enough while tuning a case, `--case <sha prefix>` runs one head, `--inspect` checks the set without a model call, `--prompt <sha prefix>` prints what the model would see, and `--compare <baseline.json> <run.json>` judges a run against the bar. Results land in `tools/recall/results/`, committed; after a change to `tools/recall/cases.ts`, rebuild the set with `node --experimental-strip-types tools/recall/build-set.ts` (it reads GitHub with `gh`) and `pnpm format`. The design's "Measuring recall" says what the replay keeps of production and what it leaves out.

## 4. What happens on a pull request

1. GitHub posts `pull_request` (opened, reopened, ready for review, synchronize) to `/webhook`, drafts included. A `closed` one only drops the repository snapshot the object keeps for search.
2. The Worker verifies the signature and hands the event to the Durable Object named `<installation>/<owner>/<repo>#<number>`.
3. The object fetches the PR and reads `.andabot.yaml` at its base commit (section 6). When `auto`, `drafts`, `base_branches` or a title keyword skips the push, a draft by default among them, it logs `review.skip` with the reason and stops there. When the file sets `path_filters`, it then fetches the files and checks them, and stops the same way if the filters leave out every one; otherwise it fetches the files as the review opens. At the same base commit it lists the repository's instruction files (`CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, `CODING_STANDARDS.md`, `.github/copilot-instructions.md` and `CONTRIBUTING.md` at the root, `.github/instructions/*.instructions.md` whose `applyTo` matches a changed file or that has none, and a nested `CLAUDE.md` or `AGENTS.md` above a changed file), which the review gets as its standards, and the skills under `.github/skills`, `.agents/skills` and `.claude/skills`, which the model can activate; a skill file or directory committed as a symlink is left out, since GitHub lists a symlink by its link text, so commit the files themselves.
4. It opens a check run named after the bot on the head commit, titled "Review in progress", and prompts the Pi session with the diff.
5. The model reads what it needs with `read_file`, then calls `submit_review`.
6. The host validates each finding against the diff, edits the summary comment in place, and submits one review with inline comments. Blocking findings make it a request-changes review. A clean approve verdict makes it an approval once the head's other checks pass; until they do, the review posts as a comment that says approval waits for the checks. The run completes with the verdict in its title; a review that does not complete fails the run, and a push mid-review cancels it as superseded by the new head.
7. Resolving andabot's blocking threads, or a check suite finishing, re-evaluates approval with no model call. andabot approves the reviewed head once none of its blocking threads is open and every other check run passed. Workers Logs show `approval.decided` with the reason it waited, or `approval.posted`.

With `VERIFY_MODEL` set (section 2), step 6 has a pass between validating the findings and posting them: the verify pass (#31), a second model pass, keeps or drops each blocking finding and suggestion and sets its severity, and the review posts from what it leaves, so a blocking finding it drops or demotes no longer makes the review request changes. The summary comment's footer names both models, and a collapsed Verify section lists what verify dropped or regraded. If verify fails twice, or the review has already spent `MAX_REVIEW_NEURONS`, the review posts as drafted, the footer says why it wasn't verified and the check run's title ends " (unverified)". Workers Logs show `verify.verdict` for each verdict and `verify.done` for the pass, `verify.attempt_failed` for each failed attempt and `verify.failed` when both fail, and `verify.skip` when the budget skipped it.

`@andabot review`, `@andabot full review`, `@andabot summary`, `@andabot resolve`, `@andabot pause`, `@andabot resume` and `@andabot help` work in PR comments from anyone with write access. Any other text after the mention is answered as a question about the PR. A reply under one of andabot's inline comments is a question about that finding, answered in the same thread with no mention needed; in other review threads, mention `@andabot`. A review's summary that mentions `@andabot` works the same way, answered in the conversation. andabot reacts 👀 to each of these before it acts, and to a pull request whose description mentions `@andabot` when it opens, though the repository's `.andabot.yaml` (section 6) can still skip that pull request's review. `@andabot review` on a head andabot already reviewed says so and points to `@andabot full review`, on a closed pull request it says there's nothing to review, and when `.andabot.yaml`'s `path_filters` leave out every changed file it says that. Workers Logs show `reaction.added`, or `reaction.failed` with GitHub's error.

`@andabot pause` stops the pushes that `.andabot.yaml` would otherwise review from starting reviews until `@andabot resume`, which reviews the head if it has no review yet, as a push would: a draft follows `reviews.drafts`, and when `auto`, `base_branches` or `ignore_title_keywords` keep pushes unreviewed, `resume` says so and leaves the review to `@andabot review`. Meanwhile the summary comment says who paused, resolved threads and finished checks approve nothing until `resume`, and the other commands keep working. `@andabot resolve` resolves andabot's open threads, or, typed in one of them, only that one, and says what approval does next, unless the repository's request-changes workflow (`.andabot.yaml`'s `request_changes_workflow`, else `REQUEST_CHANGES_WORKFLOW`) is off. `@andabot summary` rewrites the summary comment for the current head without a review. Workers Logs show `command.paused`, `command.resumed`, `command.resolved` and `summary.posted`, and a push skipped while paused as `review.skip` with reason `paused`.

## 5. Checks on pull requests

`.github/workflows/ci.yml` runs `pnpm check` on every pull request and on every push to `main`: lint, both typechecks and the unit tests, on Node 22 with the pnpm version from `package.json`. `wrangler types` reads only `wrangler.jsonc`, so the job has no Cloudflare credentials. Merging deploys nothing; deploys stay manual, as in section 2.

Require the `check` job on `main` through branch protection, so a failing pull request blocks the merge, with a bypass warning for an admin. Branch protection needs a public repository on GitHub Free, or GitHub Pro for a private one.

```sh
gh api -X PUT repos/{owner}/{repo}/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": false, "checks": [{ "context": "check" }] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

## 6. Per-repository settings: `.andabot.yaml`

A repository can keep an `.andabot.yaml` at its root. andabot reads it at the pull request's base commit, never the head, so a pull request cannot change the rules it is reviewed by: one that edits the file is reviewed under the base's version, and the edit applies once it is on the base branch. Every setting is optional, and a repository without the file gets the defaults.

| Setting | Default | Meaning |
| --- | --- | --- |
| `reviews.auto` | `true` | `false`: a push starts no review, and only a command such as `@andabot review` does. |
| `reviews.drafts` | `false` | `false`: a draft waits until it is marked ready for review. `true`: a draft is reviewed on each push like any pull request, so its review can post before its checks finish; an approval waiting on them follows once the draft is marked ready for review. |
| `reviews.base_branches` | `[]`: any base | Review only pull requests whose base branch is listed, by its exact name: `release/*` names a branch called `release/*`, not every release branch. |
| `reviews.ignore_title_keywords` | `[]` | Skip a pull request whose title contains one of these anywhere, ignoring case. `WIP` also matches `Wipe`, so `WIP:` or `[WIP]` is more precise. A blank entry matches nothing. |
| `reviews.request_changes_workflow` | unset: the Worker's `REQUEST_CHANGES_WORKFLOW` | `true` or `false` for this repository, for both the review's event and the approval that follows resolved threads and passing checks. |
| `reviews.path_filters` | `[]` | Files to leave out of the review, each a [minimatch](https://github.com/isaacs/minimatch) glob that starts with `!`. A filtered file gets no patch in the prompt, needs no walkthrough row and takes no finding, and `@andabot summary` leaves it out as a review does. When every changed file is filtered, the pull request gets no review, and `@andabot summary` replies that there's nothing to summarize. |
| `reviews.path_instructions` | `[]` | Entries of a `path` glob and its `instructions`, added to the review's standards, ahead of the repository's instruction files, when the glob matches a changed file. |
| `reviews.verify` | `true` | `false` turns the verify pass off for this repository. Verify runs only while the Worker's `VERIFY_MODEL` is set, so this changes nothing while it is empty. An invalid or unreadable file applies none of its settings, so a `false` in it is ignored while `VERIFY_MODEL` is set. |
| `reviews.sandbox` | `true` | `false` keeps this repository's reviews out of the sandbox tier (#132): no container is started and `run_check` answers that the sandbox is off. The tier runs only while the Worker's `SANDBOX` is `true`, so this changes nothing while it is `false`. |
| `model.verify` | unset: the Worker's `VERIFY_MODEL` | The Workers AI model verify uses for this repository, instead of `VERIFY_MODEL`. A non-empty string. It never turns verify on: while `VERIFY_MODEL` is empty, verify stays off. |
| `model` | none | A mapping only: `model: {}` or keys under `model:`, never `model: <name>`. Every key but `verify` is accepted and ignored, `model.draft` included. |
| `checks` | none | The commands `run_check` (#133) runs in the sandbox, under the keys `lint`, `typecheck` and `test`, each a command line split on whitespace; a standalone `{paths}` token becomes the paths the model names, one argument each, and a template without it ignores them. A key left out falls back to a runner `package.json` names (oxlint or eslint, tsc, vitest or jest); any other key, or an empty template, makes the file invalid. |

```yaml
reviews:
  drafts: true
  base_branches: ["main"]
  ignore_title_keywords: ["[WIP]"]
  path_filters:
    - "!**/*.snap"
    - "!**/pnpm-lock.yaml"
  path_instructions:
    - path: "apps/worker/**"
      instructions: "Receipts must stay decodable for 24 hours after a deploy."
```

`auto`, `drafts`, `base_branches` and `ignore_title_keywords` decide what a push does, checked in that order. A command (`@andabot review`, `@andabot full review`) bypasses all four. Editing a pull request's title or base starts no review; the next push or a command does. A skipped push logs `review.skip` with the reason `auto`, `draft`, `base_branch` or `title_keyword`, or `path_filters` when the filters leave out every changed file, and leaves the last review standing.

A skipped push also leaves andabot's earlier approval standing, over commits andabot never reviewed. If andabot's approval counts toward a required review, turn on "Dismiss stale pull request approvals when new commits are pushed" in the branch's protection rule, so a new push clears it.

What makes the file invalid, or match less than meant:

- **Every `path_filters` entry starts with `!`.** An entry without it makes the whole file invalid. Quote each one, as in `"!**/*.snap"`: unquoted, YAML reads a leading `!` as a tag and a leading `*` as an alias, and the file fails to parse or is rejected.
- **A glob without a slash matches at the root only.** `!pnpm-lock.yaml` leaves out the root lock file, and `!**/pnpm-lock.yaml` leaves out every one. Dotfiles and files under dot directories match like any other.
- **A directory needs `/**`.** `!docs` names only a file called `docs`; `!docs/**` leaves out everything under the directory.
- **Booleans are `true` and `false`.** The file is YAML 1.2, where `yes`, `no`, `on` and `off` are strings, and a string where a boolean belongs makes the file invalid.
- **A key with nothing under it is invalid.** `reviews:` with every line under it commented out reads as null, and so does a bare `model:`. Delete the key, or keep at least one setting under it.
- **An unknown key is invalid**, under `reviews` or at the top level, so a typo such as `draft: true` is reported rather than silently ignored. Under `model` it is the other way round: any key but `verify` is accepted and ignored, and `verify` must be a non-empty string.

An invalid file applies none of its settings: the review runs with the defaults, and the summary comment ends with `_.andabot.yaml was ignored: <the first problem>; the defaults applied._`, the problem set as code. It names its place in the file, as in `/reviews/auto must be boolean`; an unknown key reads as `/reviews/draft schema is false`. A file GitHub fails to serve gets the same note, the defaults for that review only, and a `config.unreadable` log. `review.start` in Workers Logs shows which applied: `config` is `missing`, `file`, `invalid` or `unreadable`.
