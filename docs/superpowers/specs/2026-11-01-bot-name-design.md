# The bot's name from BOT_LOGIN, and a staging deploy (#177)

Phase 5: hardening. This is its own file so it doesn't collide with `2026-11-01-hardening-design.md`, which the #189 session is writing at the same time. Fold it in once both have merged.

## Why

andabot should be able to run as a second, differently named deploy: a staging bot beside production, or a copy someone else runs under their own App (GameSheet's `gamesheetbot`, see the org pilot decisions). `BOT_LOGIN` already sets the login and the mention the commands answer to, but some names are still fixed. With fixed markers, two deploys reviewing one pull request edit each other's summary comment. #182 (deploy from CI) expects #177 to bring the staging deploy it deploys to first.

## Goals

- Every name a person, a repository or GitHub sees comes from `BOT_LOGIN`.
- `BOT_LOGIN=andabot` produces exactly today's strings, so existing summary comments, pauses, closes blocks and `.andabot.yaml` files keep working with no migration.
- A committed `staging` deploy, `andabot-staging`, that reviews only when tagged.

## Non-goals

- Durable Object class names, log event names (`review.done` and the rest) and Pi extension names (`"andabot"` in `src/review/tools.ts`, `VERIFY_EXTENSION`). They are internal ids, the extension names may be in stored conversation state, and the logs stay queryable across deploys by one name.
- Renaming the `AndabotConfig` type or other identifiers in code.
- Deploying from CI and alerts (#182).
- `tools/recall` keeps its own `BOT_LOGIN = "andabot"`: it replays andabot's history.

## Anti-goals

- Any change in andabot's output for `BOT_LOGIN=andabot`, beyond the skill wording noted below. A changed marker would orphan every summary comment already posted.
- A staging bot that reviews every pull request on this repository next to production.

## Decisions (Andrew, 1 Nov 2026)

1. **Config file: own file only.** A deploy reads `.<BOT_LOGIN>.yaml` and nothing else. No fallback to `.andabot.yaml`. A copy gets a clean namespace, and staging can try a config before production takes it.
2. **Build staging now**, as part of #177: a `staging` environment in `wrangler.jsonc` and a registered `andabot-staging` App. The live check runs both bots on one fixture pull request, and #182 deploys to staging next.
3. **Staging reviews only when tagged, by a deploy-level var.** A new var `AUTO_REVIEW` (`"true"` in production, `"false"` in staging) is the default for `reviews.auto` when a repository's file doesn't set it. Staging is then quiet on every base, including fixture bases, stacked branches, bases cut before any file existed, and a config read that fails. It reviews after `@andabot-staging review`. A repository's `reviews.auto` still wins when set. No `.andabot-staging.yaml` is committed. (Andrew chose this after the builder check found that a committed file leaks on bases without it.)
4. **The other bot's check run is just another check.** `src/review/approval.ts` keeps skipping only the deploy's own check runs. When staging is tagged and its check fails or hangs, production waits, and the reverse. No list of sibling bots.

## What derives from the login

For a login `L`, with `andabot` giving today's values:

| What | Where today | Derived |
| --- | --- | --- |
| Config file | `CONFIG_FILE` in `src/repository/config.ts`, and every message that names it (`commands.ts`, `pause.ts`, `render.ts`, `resolve.ts`, `summary.ts`, `instructions.ts`, `basis.ts`, `sandbox/checks.ts`, the `list_files` tool description) | `.L.yaml` |
| Summary marker | `SUMMARY_MARKER`, `render.ts` | `<!-- L:summary -->` |
| Paused marker | `PAUSED_MARKER`, `pause.ts` | `<!-- L:paused -->` |
| Closes block | `CLOSES_START`, `CLOSES_END`, `closes.ts` | `<!-- L:closes -->`, `<!-- L:closes-end -->` |
| Budget refusal marker | `BUDGET_REFUSAL_MARKER`, `prompt.ts`, read in `models.ts` | `L:review-budget-refused` |
| Thread prompt | `prompt.ts:338`, "The thread is andabot's ..." | `L` |
| Abandon reply | `pull-request.ts:795`, "`@andabot review` to retry" | `@L review` |
| `user-agent` | `github/client.ts`, `github/app-auth.ts` | `L` |
| Sandbox script `$0` | `sandbox/run.ts`, `checkout.ts`, `checks.ts` | `L-run`, `L-kill`, `L-checkout` and so on |
| `console.warn` prefixes | `pull-request.ts` | `L:` |

The closes block isn't in the issue's list; it is a marker of the same kind and two deploys would rewrite each other's block without it.

`docs/setup.md` and `docs/design.md` explain the file as `.<BOT_LOGIN>.yaml` (`.andabot.yaml` for andabot), and `docs/setup.md` gains a staging section.

## Staging

- `env.staging` in `wrangler.jsonc`: Worker `andabot-staging`, at `https://andabot-staging.dinocode.workers.dev`. Its own Durable Objects, migrations and container, with `BOT_LOGIN: "andabot-staging"` and `AUTO_REVIEW: "false"`. Every other var matches production's.
- Wrangler doesn't inherit `vars` (or the bindings) into an environment, so they are written out twice. A test pins that staging's vars equal the top-level ones except `BOT_LOGIN` and `AUTO_REVIEW`, so the two can't drift apart unnoticed. The comments stay on the top-level copy only.
- `AUTO_REVIEW` is read where the config's defaults apply: an unset `reviews.auto`, a missing file, and an invalid or unreadable file all take it. `docs/setup.md` lists it, and the `reviews.auto` row's default becomes "unset: the Worker's `AUTO_REVIEW`".
- The App: `node scripts/register-app.mjs` with the name `andabot-staging` and the staging webhook URL, the same permissions and events as andabot, installed on `ai-review-agent` only. Andrew runs it, since it needs his browser, and puts the three secrets on the staging Worker.
- Shared with production: the Cloudflare account, so Workers AI neurons and the account's container limits. The lease cap of three containers is per deploy, so the two together can run six. Staging only reviews when tagged (decision 3), so this stays small.
- Staging is deployed by hand (`wrangler deploy --env staging`) until #182.

## Done when

- A test pins that `andabot` produces today's filename, markers, user-agent and script names, and that another login produces its own.
- The staging test in the Staging section passes.
- A test pins that `AUTO_REVIEW=false` makes an unset `reviews.auto`, a missing file and an invalid file all skip automatic reviews, and that a file's `reviews.auto: true` still wins.
- Live, before merge: staging runs the branch, production stays on `main`. On a fixture pull request from a base without any config file, andabot reviews on open and staging doesn't. `@andabot-staging review` makes staging review too, and each edits only its own summary comment through a later push and an `@andabot-staging summary`.
- Live, after merge and the production deploy: the first push to an open pull request that already has a summary comment edits that comment in place, which shows `andabot`'s markers didn't change.

## Left to the builder

- How the derived names reach the modules that hold constants today: a names object built once from `BOT_LOGIN`, functions of the login, or something else. Pure modules shouldn't read `env`.
- The test layout, and whether the tests that pin `andabot-*` script names change.

## My calls, for Andrew to check

- **Skill wording.** `skills/answer/SKILL.md` says "andabot's own threads". Bundled skills are static markdown, so it becomes "your own threads" rather than a template. That changes andabot's prompt by those words, and the answer skill's version goes up. The recall benchmark bundles the answer skill too (`tools/recall/prompt.ts`), so its skill fingerprint may change, but the review skill's text it grades doesn't. Rendering skills from the login would keep the prompt byte-identical, but it changes how skills are bundled, which is more than #177 needs.
- **Production stays on `main` until merge.** Staging runs the branch for the live check. andabot's unchanged strings rest on the unit test before merge, and on the first edited summary comment after the deploy.
- Pi extension names and `VERIFY_EXTENSION` stay as they are (Non-goals).
- The closes block markers are included.
- Staging's vars mirror production's, with `SANDBOX` on, and a test keeps them in step.
- This spec is its own file, not a section of the hardening spec.
