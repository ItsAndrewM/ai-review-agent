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

Checks: Read and write lets the App create the review check run and receive the `check_run` and `check_suite` events. Contents: Read and write lets it resolve the review threads a push fixed. GitHub lets only the pull request's author or someone with write access resolve a conversation, and for an App that means Contents write; Pull requests write isn't enough. That permission is broader than the one call: an installation token with it can change the repository's files and branches. The Worker uses it only to resolve threads, so install the App only on repositories it reviews, and treat its private key and tokens as write credentials.

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

The Worker is at `https://andabot.dinocode.workers.dev`. `GET /health` answers `{"name":"andabot","ok":true}`; a webhook with a bad signature answers `401`, and a signed `ping` answers `200 {"ignored":"no installation or repository"}`. The App's **Advanced** tab lists every delivery and can redeliver one.

Variables in `wrangler.jsonc`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOT_LOGIN` | `andabot` | The App's login without `[bot]`. Must match the App name. |
| `REVIEW_MODEL` | `@cf/zai-org/glm-5.3-flash` | Workers AI model. GLM 5.x, the default included, Kimi K2.7 Code and DeepSeek V4 need the Workers Paid plan; gpt-oss-120b and glm-4.7-flash also run on Free. Workers AI's free 10,000 neurons a day cover about 15 to 28 reviews on GLM-5.3 Flash, as measured on #2. |
| `MAX_OUTPUT_TOKENS` | `16000` | Most output tokens one model call may ask for, reasoning included; the model's own maximum and its context still cap it. Raise it, for example with `--var MAX_OUTPUT_TOKENS:32000` on deploy, when large pull requests get cut-off reviews. Anything but a positive whole number falls back to 16,000. `review.start` logs the value in effect as `maxOutputTokens`. |
| `REQUEST_CHANGES_WORKFLOW` | `true` | `true`: request changes on blocking findings, approve clean PRs. `false`: comment only. A repository's `.andabot.yaml` overrides it with `reviews.request_changes_workflow` (section 6). |

## 3. Local development

Copy `.dev.vars.example` to `.dev.vars` and fill it in, then `pnpm dev`. The AI binding is remote, so `wrangler login` is needed even locally; in a non-interactive shell set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead. To deliver real webhooks to a local Worker, point the App at a tunnel (`cloudflared tunnel --url http://localhost:8787`).

A webhook can also be replayed by hand. Sign the body with the secret and post it:

```sh
BODY='{"zen":"hi"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | sed 's/^.* //')"
curl -s -X POST localhost:8787/webhook -H "x-github-event: ping" -H "x-github-delivery: test-1" -H "x-hub-signature-256: $SIG" -d "$BODY"
```

## 4. What happens on a pull request

1. GitHub posts `pull_request` (opened, reopened, ready for review, synchronize) to `/webhook`, drafts included.
2. The Worker verifies the signature and hands the event to the Durable Object named `<installation>/<owner>/<repo>#<number>`.
3. The object fetches the PR and reads `.andabot.yaml` at its base commit (section 6). When `auto`, `drafts`, `base_branches` or a title keyword skips the push, a draft by default among them, it logs `review.skip` with the reason and stops there. When the file sets `path_filters`, it then fetches the files and checks them, and stops the same way if the filters leave out every one; otherwise it fetches the files as the review opens.
4. It opens a check run named after the bot on the head commit, titled "Review in progress", and prompts the Pi session with the diff.
5. The model reads what it needs with `read_file`, then calls `submit_review`.
6. The host validates each finding against the diff, edits the summary comment in place, and submits one review with inline comments. Blocking findings make it a request-changes review. A clean approve verdict makes it an approval once the head's other checks pass; until they do, the review posts as a comment that says approval waits for the checks. The run completes with the verdict in its title; a review that does not complete fails the run, and a push mid-review cancels it as superseded by the new head.
7. Resolving andabot's blocking threads, or a check suite finishing, re-evaluates approval with no model call. andabot approves the reviewed head once none of its blocking threads is open and every other check run passed. Workers Logs show `approval.decided` with the reason it waited, or `approval.posted`.

`@andabot review`, `@andabot full review` and `@andabot help` work in PR comments from anyone with write access. Any other text after the mention is answered as a question about the PR. A reply under one of andabot's inline comments is a question about that finding, answered in the same thread with no mention needed; in other review threads, mention `@andabot`. A review's summary that mentions `@andabot` works the same way, answered in the conversation. andabot reacts 👀 to each of these before it acts, and to a pull request whose description mentions `@andabot` when it opens, though the repository's `.andabot.yaml` (section 6) can still skip that pull request's review. `@andabot review` on a head andabot already reviewed says so and points to `@andabot full review`, on a closed pull request it says there's nothing to review, and when `.andabot.yaml`'s `path_filters` leave out every changed file it says that. Workers Logs show `reaction.added`, or `reaction.failed` with GitHub's error.

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
| `reviews.path_filters` | `[]` | Files to leave out of the review, each a [minimatch](https://github.com/isaacs/minimatch) glob that starts with `!`. A filtered file gets no patch in the prompt, needs no walkthrough row and takes no finding. When every changed file is filtered, the pull request gets no review. |
| `reviews.path_instructions` | `[]` | Entries of a `path` glob and its `instructions`, added to the review's standards, ahead of the repository's instruction files, when the glob matches a changed file. |
| `model` | none | Accepted and ignored until the verify pass (#31). It takes a mapping only: `model: {}` or keys under `model:`, never `model: <name>`. |

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
- **An unknown key is invalid**, under `reviews` or at the top level, so a typo such as `draft: true` is reported rather than silently ignored.

An invalid file applies none of its settings: the review runs with the defaults, and the summary comment ends with `_.andabot.yaml was ignored: <the first problem>; the defaults applied._`, the problem set as code. It names its place in the file, as in `/reviews/auto must be boolean`; an unknown key reads as `/reviews/draft schema is false`. A file GitHub fails to serve gets the same note, the defaults for that review only, and a `config.unreadable` log. `review.start` in Workers Logs shows which applied: `config` is `missing`, `file`, `invalid` or `unreadable`.

Andabot answers `@andabot help` with its command list.
