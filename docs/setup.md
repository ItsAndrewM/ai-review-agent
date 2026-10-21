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
| Events | Pull request · Issue comment · Pull request review comment · Pull request review thread · Check suite · Check run |
| Where it can be installed | Only on this account |

Checks: Read and write lets the App create the review check run and receive the `check_run` and `check_suite` events. Contents: Read and write lets it resolve the review threads a push fixed. GitHub lets only the pull request's author or someone with write access resolve a conversation, and for an App that means Contents write; Pull requests write isn't enough. That permission is broader than the one call: an installation token with it can change the repository's files and branches. The Worker uses it only to resolve threads, so install the App only on repositories it reviews, and treat its private key and tokens as write credentials.

To change an App that is already registered, set the permission on its Permissions & events page, then accept the request on the installation page (Settings, Applications, Installed GitHub Apps, andabot). Until it is accepted, those calls answer 403 "Resource not accessible by integration". The Worker logs a failed check call as `check.failed` and a failed resolve as `review.resolve_failed`, and otherwise ignores both. The installation token is cached per pull request object for up to an hour, so a pull request opened before the change can lack the permission for that long, and a new pull request is unaffected.

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
| `REQUEST_CHANGES_WORKFLOW` | `true` | `true`: request changes on blocking findings, approve clean PRs. `false`: comment only. |

## 3. Local development

Copy `.dev.vars.example` to `.dev.vars` and fill it in, then `pnpm dev`. The AI binding is remote, so `wrangler login` is needed even locally; in a non-interactive shell set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead. To deliver real webhooks to a local Worker, point the App at a tunnel (`cloudflared tunnel --url http://localhost:8787`).

A webhook can also be replayed by hand. Sign the body with the secret and post it:

```sh
BODY='{"zen":"hi"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | sed 's/^.* //')"
curl -s -X POST localhost:8787/webhook -H "x-github-event: ping" -H "x-github-delivery: test-1" -H "x-hub-signature-256: $SIG" -d "$BODY"
```

## 4. What happens on a pull request

1. GitHub posts `pull_request` (opened, reopened, ready for review, synchronize) to `/webhook`.
2. The Worker verifies the signature and hands the event to the Durable Object named `<installation>/<owner>/<repo>#<number>`.
3. The object fetches the PR and its files.
4. It opens a check run named after the bot on the head commit, titled "Review in progress", and prompts the Pi session with the diff.
5. The model reads what it needs with `read_file`, then calls `submit_review`.
6. The host validates each finding against the diff, edits the summary comment in place, and submits one review with inline comments. Blocking findings make it a request-changes review. A clean approve verdict makes it an approval once the head's other checks pass; until they do, the review posts as a comment that says approval waits for the checks. The run completes with the verdict in its title; a review that does not complete fails the run, and a push mid-review cancels it as superseded by the new head.
7. Resolving andabot's blocking threads, or a check suite finishing, re-evaluates approval with no model call. andabot approves the reviewed head once none of its blocking threads is open and every other check run passed. Workers Logs show `approval.decided` with the reason it waited, or `approval.posted`.

`@andabot review`, `@andabot full review` and `@andabot help` work in PR comments from anyone with write access. Any other text after the mention is answered as a question about the PR. A reply under one of andabot's inline comments is a question about that finding, answered in the same thread with no mention needed; in other review threads, mention `@andabot`.

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
