# Setting up andabot

What Andrew does once, and what the Worker needs from it.

## 1. Register the GitHub App

At <https://github.com/settings/apps/new> (or under an organization's settings):

| Field | Value |
| --- | --- |
| GitHub App name | `andabot` (people will tag `@andabot`; fall back to `andabot-review` if taken) |
| Homepage URL | this repository |
| Webhook | Active, URL `https://<worker>.workers.dev/webhook`, a secret you generate |
| Repository permissions | Pull requests: Read and write · Contents: Read-only · Issues: Read and write · Metadata: Read-only |
| Subscribe to events | Pull request · Issue comment · Pull request review comment · Pull request review thread · Check suite |
| Where can it be installed | Only on this account |

The webhook URL can be filled in after the first deploy. After creating the App:

1. Note the **App ID** on the App's page.
2. **Generate a private key**. GitHub downloads a `.pem` in PKCS#1 form (`BEGIN RSA PRIVATE KEY`); the Worker accepts that as is.
3. **Install** the App on the repositories it should review.

GitHub's "Code review limits" setting on a repository can block an App from submitting approving or request-changes reviews. If reviews come back as plain comments, check that setting.

## 2. Deploy the Worker

```sh
pnpm install
pnpm check                      # typecheck and unit tests
pnpm exec wrangler login        # once per machine
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm exec wrangler secret put GITHUB_PRIVATE_KEY   # paste the whole PEM, newlines included
pnpm deploy
```

Then set the App's webhook URL to `https://andabot.<account>.workers.dev/webhook` and deliver a test ping from the App's **Advanced** tab. A `ping` answers `200 {"ignored":"event ping"}`; a bad secret answers `401`.

Variables in `wrangler.jsonc`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOT_LOGIN` | `andabot` | The App's login without `[bot]`. Must match the App name. |
| `REVIEW_MODEL` | `@cf/moonshotai/kimi-k2.7-code` | Workers AI model. Needs a paid billing method on the account. |
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
3. The object fetches the PR and its files, and prompts the Pi session with the diff.
4. The model reads what it needs with `read_file`, then calls `submit_review`.
5. The host validates each finding against the diff, edits the summary comment in place, and submits one review with inline comments. Blocking findings make it a request-changes review; a clean approve verdict makes it an approval.

`@andabot review`, `@andabot full review` and `@andabot help` work in PR comments from anyone with write access. Any other text after the mention is answered as a question about the PR.
