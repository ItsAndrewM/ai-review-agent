# andabot

A self-hosted pull request reviewer in the shape of CodeRabbit, on Cloudflare.

A Worker receives GitHub webhooks and hands each pull request to its own Durable Object. Inside it, [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) runs the agent loop through the Agents SDK's `PiHarness`, with Workers AI models. The model reads the diff and the files it needs, then hands back a structured review; the host validates every finding against the diff before posting the summary comment and the review.

- `docs/design.md`: the design and the build phases.
- `docs/setup.md`: registering the GitHub App and deploying.

```sh
pnpm install
pnpm check     # lint, typecheck and unit tests
pnpm run deploy
```

Status: phases 1 and 2 are done, and phase 3, the sandbox tier, hasn't started. Phase 2 shipped the review procedure as skills, the spec axis, repository context (instruction files, `.andabot.yaml` and repository skills), full review on open and incremental review on push, the approval state machine, repository search, the review's cost in the summary, the commands `@andabot review`, `full review`, `summary`, `resolve`, `pause`, `resume` and `help`, and questions in PR comments. The verify pass (#31), a second model pass that keeps or drops blocking findings and suggestions and sets their severity before a review posts, is built but off: neither model passed the [replay bar](https://github.com/ItsAndrewM/ai-review-agent/issues/31#issuecomment-6389469628), so `VERIFY_MODEL` stays empty. Once a passing model is set, a repository's `.andabot.yaml` can name its own with `model.verify` or opt out with `reviews.verify: false`; `docs/setup.md` lists the settings.
