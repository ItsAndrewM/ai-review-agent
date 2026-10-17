# andabot

A self-hosted pull request reviewer in the shape of CodeRabbit, on Cloudflare.

A Worker receives GitHub webhooks and hands each pull request to its own Durable Object. Inside it, [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) runs the agent loop through the Agents SDK's `PiHarness`, with Workers AI models. The model reads the diff and the files it needs, then hands back a structured review; the host validates every finding against the diff before posting the summary comment and the review.

- `docs/design.md`: the design and the build phases.
- `docs/setup.md`: registering the GitHub App and deploying.

```sh
pnpm install
pnpm check     # typecheck and unit tests
pnpm deploy
```

Status: phase 1, the walking skeleton. Full review on open and on push, `@andabot review`, `@andabot help`, and questions in PR comments.
