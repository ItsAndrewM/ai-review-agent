# andabot

A self-hosted pull request reviewer on Cloudflare: a Worker, a Durable Object per pull request, and Pi Durable as the agent loop. `docs/design.md` is the design and its phases, and `docs/setup.md` covers the GitHub App and deploying.

`pnpm check` runs lint, typecheck and tests. `pnpm format` applies the formatting (oxfmt: 120 columns, no semicolons, sorted imports).

## Lint

`oxlint.config.ts` holds the rules, and `test/lint` checks that every folder gets them and that no folder has a config of its own.

- **No comments of any kind** (`gamesheet/no-comments`). The rule exempts JSDoc (`/** */`) and any comment containing `SAFETY:`, and its own message suggests a JSDoc block, but don't turn a comment into JSDoc or a `SAFETY:` comment to get past the rule. Put the reason in a name or a test title, or, when it's about the design, in `docs/design.md`. This holds over any general advice to explain a file in a JSDoc block. `wrangler.jsonc` keeps its comments, which say why.
- **No type assertions except `as const`.** Parse what crosses a boundary (GitHub's responses, webhook payloads, stored JSON) with a TypeBox schema and `Value.Check`. A `SAFETY:` comment is only for an assertion no check can replace, and states the invariant that makes it true.
- **Complexity is at most 10 per function.** Split a function by what it decides.
- **The anti-slop rules** (`tools/oxlint/anti-slop`, vendored) ban `unknown` and `object` parameters and returns, `typeof` checks, dictionaries of `unknown`, an explicit broad type that widens a known value (keep inference or use `satisfies`), `...(cond ? {...} : {})` spreads, chained assertions, "shape" in names, and `vi.mock`: replace a dependency through a real interface instead. The one `unknown` parameter they allow is a caught error's `cause`, as in `errorText(cause)`.
- Never get past lint with a disable comment, a lower severity or a cast.

## Reviews

Automated reviewers must approve every pull request on this repository without findings.
