# Closing Keywords Implementation Plan (slice 8: #127)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every summary comment says which issues the merge closes, warns when the description's wording won't do what it says, and refreshes that block when the description or the base changes.

**Architecture:** A pure parser (`src/review/closes.ts`) follows the rules GitHub's probe showed; a pure block renderer and an in-place rewrite live beside it; the object computes the block from the pull request at every summary write and on a new `edited` delivery.

**Tech Stack:** TypeScript on Cloudflare Workers, TypeBox, vitest, oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-10-29-reviews-that-hold-up-design.md`, section "Slice 8, #127" with its "Calls made after the builder check".

## Global Constraints

- `pnpm check` green after every task; `pnpm format` before each commit.
- `CLAUDE.md`: no comments, no `as` but `as const`, TypeBox + `Value.Check` at boundaries, complexity ≤ 10, anti-slop rules, never a disable comment.
- The spec parser `linkedIssueNumbers` is not changed.
- Copy fixed by the spec: `<!-- andabot:closes -->` and `<!-- andabot:closes-end -->`; `<sub>Merging closes #80 and #6 (from the description).</sub>`; `⚠️ #100 follows "and" after a keyword, so merging won't close it. Repeat the keyword for each issue: "Closes #80, closes #100".`; `⚠️ "won't close #6" still closes #6 on merge: GitHub ignores the "won't". Name it without a keyword to leave it open, such as "Part of #6".`; `<sub>Merging into \`staging\` closes no issue: GitHub closes them only on a merge into \`main\`.</sub>`.
- Probe facts (PR #201): linked — plain, colon, uppercase, bold, blockquote, full issue URL, `owner/repo#n`, negated, the first reference of a list; not linked — a later list reference, inline code, fenced code, HTML comment, no whitespace after the keyword, a keyword inside a word.

## Review Focus

1. A keyword inside inline code, a fence or an HTML comment neither closes nor warns, including a fence with a language tag and an unclosed HTML comment.
2. "Closes #1 and #2. Closes #2." closes both with no warning; "Closes #1, #2 and #3" warns once per later reference.
3. A same-repository `owner/repo#n` or URL collapses to `#n`, and a duplicate is listed once.
4. The in-place rewrite replaces only the text between the markers, leaves a comment without markers untouched, and returns "unchanged" when the block is the same.
5. An `edited` delivery for a closed pull request, one without a summary comment, or a title-only edit does nothing.

---

### Task 1: the parser

**Files:** Create `src/review/closes.ts`, `test/closes.test.ts`.

**Interfaces — Produces:**
- `export interface IssueRef { repo: string | undefined; number: number }` (`repo` set only for another repository).
- `export interface Closes { closes: IssueRef[]; listed: ListedRef[]; negated: NegatedClose[] }`, `ListedRef = { ref: IssueRef; separator: string; keyword: string; first: IssueRef }`, `NegatedClose = { ref: IssueRef; phrase: string; negation: string }` (`phrase` the negation through the reference as written, e.g. "won't close #6").
- `export function closesOf(body: string | null, repo: string): Closes`.
- `export function refText(ref: IssueRef): string` → `#80` or `octo/repo#100`.

- [ ] **Step 1: Failing tests** (`test/closes.test.ts`): each of the nine keywords, uppercase, a colon; `#n`; `octo/repo#100` for another repo; `ItsAndrewM/ai-review-agent#120` and `https://github.com/ItsAndrewM/ai-review-agent/issues/121` collapse to `#120`/`#121` when `repo` is `ItsAndrewM/ai-review-agent`; "Closes #140 and #138" closes #140 with #138 listed after "and"; "Fixes #1, #2 and #3" lists #2 (",") and #3 ("and"); "&" and "or" separators; "fixes#119" and "prefixes #115" close nothing; `` `Fixes #133` ``, a ```` ``` ```` fence (with and without a language tag) and `<!-- Closes #131 -->` close nothing; "> Fixes #125" and "**Closes #118**" close; "Merging won't close #124", "will not fix #4", "doesn't resolve #8" are negated, "This doesn't fix the flake; closes #5" is not, "not now, maybe later, we close #7" (negation four words back) is not; "Closes #1 and #2. Closes #2." closes #1 and #2 with nothing listed; a duplicate close is listed once; `null` body closes nothing.
- [ ] **Step 2: Run** `pnpm vitest run test/closes.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Strip HTML comments, fenced blocks and inline code spans (replace each with spaces so offsets stay), then match `(?<![\p{L}\p{N}_])(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?![\p{L}\p{N}_]):?\s+(<reference>)` case-insensitive with Unicode; `<reference>` = `https://github.com/<owner>/<repo>/issues/<n>` | `<owner>/<repo>#<n>` | `#<n>`; after each reference, repeatedly match `\s*(,\s*and|,|and|&|or)\s+(<reference>)` for listed ones; a negation is one of the three words before the keyword (no `.!?;` or newline between) equal to not/never/without, "no longer", or ending in "n't"/"n’t". Listed refs that are closed elsewhere drop from `listed`.
- [ ] **Step 4: Run** — Expected: PASS; `pnpm check` green.
- [ ] **Step 5: Commit** `git commit -m "Read what a description's closing keywords close, as GitHub does"`.

### Task 2: the block and its in-place rewrite

**Files:** Modify `src/review/closes.ts`, `src/github/client.ts:18` (`base.repo.default_branch: Type.Optional(Type.String())`); Test `test/closes.test.ts`, `test/client.test.ts` if it parses a pull request.

**Interfaces — Produces:**
- `export function closesBlock(closes: Closes, base: string, defaultBranch: string | undefined): string[]` → the marker-wrapped lines (always the two markers).
- `export function closesBlockOf(pr: PullRequestInfo): string[]` → `closesBlock(closesOf(pr.body, pr.base.repo.full_name), pr.base.ref, pr.base.repo.default_branch)`.
- `export function withClosesBlock(body: string, block: readonly string[]): string | undefined` → the body with the text between the markers replaced, or `undefined` when the body has no markers or the block is unchanged.

- [ ] **Step 1: Failing tests:** the block for one close; for closes with a listed and a negated warning (warnings first, then the `<sub>` line; another repo's ref as `octo/repo#100`; "and" joining the last two, commas before); for no keyword (markers only); off the default branch with a keyword (the one `<sub>` line, no warnings) and without one (markers only); `default_branch` absent treated as the default; `withClosesBlock` replacing, returning `undefined` without markers and when unchanged; `PullRequestInfo` parses with and without `default_branch`.
- [ ] **Step 2: Run** `pnpm vitest run test/closes.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** with `plural`-free copy as the Global Constraints fix it; the suggestion in the "and" warning is `"<Keyword> #a, <keyword> #b"` built from the first keyword as written and each reference of the run.
- [ ] **Step 4: Run** — PASS; `pnpm check` green.
- [ ] **Step 5: Commit** `git commit -m "Render the close block and rewrite it in place"`.

### Task 3: every summary comment carries the block

**Files:** Modify `src/review/render.ts` (`renderSummaryComment`, `renderSummaryRun`, `renderUnpostedSummary` gain `closes: readonly string[]`, placed at the top of the footer; for the unposted render, after the note); `src/pull-request.ts` (every call passes `closesBlockOf(pr)`; the four `renderUnpostedSummary` calls, the review's post, the `summary` run); Test `test/findings.test.ts`, `test/summary.test.ts`.

- [ ] **Step 1: Failing tests:** each of the three renders contains the given block lines in place (the review's after the walkthrough sections and before "Reviewed by"; the summary run's before "Summarized by"; the unposted one after the note).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `pnpm check`.
- [ ] **Step 5: Commit** `git commit -m "Put the close block in every summary comment"`.

### Task 4: an edited description or base refreshes the block

**Files:** Modify `src/route.ts` (`WebhookPayload.changes: Type.Optional(Type.Object({ body: Type.Optional(Type.Object({})), base: Type.Optional(Type.Object({})) }))`; `pull_request` `edited` with `changes.body` or `changes.base` → `{ kind: "edited", key, deliveryId }`), `src/review/delivery.ts` (`StoredIncoming` gains the kind), `src/pull-request.ts` (`handle` case `edited` → `refreshCloses`: skip unless the pull request is open and a summary comment exists; read the pull request fresh, the comment, `withClosesBlock(body, closesBlockOf(pr))`; update when defined; log `closes.refreshed` with `number`, `closes`, `listed`, `negated`, `changed`); Test `test/route.test.ts`, `test/delivery.test.ts`.

- [ ] **Step 1: Failing tests:** `edited` with `changes.body` and with `changes.base` routes `{ kind: "edited" }` (no 👀); title-only `edited` is ignored; a bot sender's body edit is still ignored by the existing bot rule (assert the current behaviour); `StoredIncoming` accepts the new kind.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `pnpm check`.
- [ ] **Step 5: Commit** `git commit -m "Refresh the close block when the description or the base changes"`.

### Task 5: docs

**Files:** `docs/design.md` (the summary footer's close block, the warnings and the off-default line; the events list gains `edited` with a body or base change; beside the spec's linked-issue paragraph, that the close list is separate and display-only and skips code and HTML comments as GitHub does; a pull request with no summary comment gets no warning).
- [ ] **Step 1:** Edit; `pnpm format`; `pnpm check`. **Step 2:** Commit `git commit -m "Describe the close block and the edit that refreshes it"`.

### Task 6: after merge and deploy (Andrew)

- [ ] A fixture from `main-with-checks` with "Closes #X and #Y" and "won't close #Z": the off-default line; an edit to the description changes the block with no new review. The first real pull request into `main` shows the close list. Results on #127.
