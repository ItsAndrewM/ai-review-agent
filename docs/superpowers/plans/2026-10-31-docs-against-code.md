# Docs checked against the code (#125) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A review checks the authoritative docs a push changes, and the docs that describe code it changes, against the code, filing a false claim as a `docs` finding.

**Architecture:** A pure doc-set module (`src/repository/docs.ts`) decides which paths are docs and which are history, sorts a review's changed files, and builds the "Docs mentioning the change" list over the head snapshot through a new structured search entry point in `src/repository/search.ts`. The prompt gains two data sections, the `Finding` schema a `docs` basis kind with a host-side naming check, `.andabot.yaml` a `reviews.docs` list, and the skill a Docs check. The object wires the sections, the `pending.docs` record and the log.

**Tech Stack:** TypeScript, TypeBox, minimatch, re2js (through `search.ts`), vitest, oxlint with the repo's rules (no comments, no `as` but `as const`, complexity ≤ 10, anti-slop rules).

**Spec:** `docs/superpowers/specs/2026-10-29-reviews-that-hold-up-design.md`, section "Slice 6, #125".

## Global Constraints

- `pnpm check` passes after every task; `pnpm format` before each commit.
- No comments of any kind; no type assertions except `as const`; complexity ≤ 10; no `unknown`/`object` parameters, no `typeof`.
- `src/repository/docs.ts` imports neither `config.ts` nor `instructions.ts` (cycle); `config.ts` imports `DEFAULT_DOC_GLOBS` from it.
- Stored records keep parsing: `StoredPending.docs` is `Type.Optional`.
- Copy fixed by the spec: prompt headings `## Docs under review` and `## Docs mentioning the change`; the added-history note `(added in this pull request: check only its claims about this pull request's changes)`; the empty state `(none)`; the overflow line `N more mentions aren't listed.`; the unavailable sentence `The repository search wasn't available, so no docs were searched.`; the spent sentence `The repository search's budget was spent, so no docs were searched.`
- Caps: `MAX_MENTIONS_PER_FILE = 6`, `MAX_MENTIONS = 40`; basename patterns only for basenames longer than three characters and not in `index`, `main`, `mod`, `utils`, `readme` (lower-cased).
- The review skill becomes `version: "12"`; the verify skill `version: "3"`.
- Work in `.claude/worktrees/docs-against-code-GH-125`; never `cd` to the primary checkout.

## Review Focus

1. A changed file whose basename is short or common (`index.ts`, `main.go`): only the path pattern is searched, never the bare word (Task 1 test).
2. A doc under review that also mentions another changed file: its hits are dropped from the mentions, since its diff is in the prompt (Task 3 test).
3. A `reviews.docs` list of excludes only (`["!docs/archive/**"]`): the defaults still apply minus the exclusion; nothing is silently turned off (Task 1 and Task 2 tests).
4. The search unavailable or spent at review start: the prompt says so and the review goes on with the diff-side check (Task 4 and Task 6 tests).
5. A `docs` finding citing a modified plan under `docs/superpowers/`: refused, since history isn't a doc of the review; one citing a plan the pull request added: accepted (Task 5 test).

---

### Task 1: the doc set

**Files:**
- Create: `src/repository/docs.ts`
- Test: `test/docs.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export const DEFAULT_DOC_GLOBS: readonly string[]   // ["**/README*", "docs/**/*.md", "CLAUDE.md", "AGENTS.md", "REVIEW.md", "CODING_STANDARDS.md", ".github/copilot-instructions.md", "CONTRIBUTING.md", "**/CLAUDE.md", "**/AGENTS.md", ".github/instructions/*.instructions.md"]
export const HISTORY_GLOBS: readonly string[]       // ["docs/superpowers/**"]
export const MAX_MENTIONS_PER_FILE = 6
export const MAX_MENTIONS = 40
export type DocMatcher = (path: string) => boolean
export function docMatcher(globs: readonly string[]): DocMatcher   // includes = entries without "!", excludes = the rest; no include → DEFAULT_DOC_GLOBS as includes; a path matches when some include matches and no exclude does; minimatch { dot: true }
export function isHistory(path: string): boolean
export interface DocsInChange { under: ChangedFile[]; history: ChangedFile[]; code: ChangedFile[] }
export function docsInChange(files: readonly ChangedFile[], isDoc: DocMatcher): DocsInChange
   // history file with status "added" → under; other history → history; doc → under; generated (isGenerated) → code; else code
export function mentionPatterns(path: string): string[]   // [path literal] plus the basename-as-word pattern `\b<basename without extension>\b` when it qualifies
export interface DocMention { path: string; line: number; text: string }
```

- [ ] **Step 1: Write the failing tests** (`test/docs.test.ts`)

```ts
describe("docMatcher", () => {
  it("accepts the default docs: READMEs at any depth, docs markdown and the instruction files", ...)  // README.md, packages/a/README, docs/design.md, docs/a/b.md, CLAUDE.md, src/CLAUDE.md, .github/instructions/x.instructions.md, CONTRIBUTING.md → true
  it("rejects code, non-markdown docs and dotfiles that aren't instruction files", ...)              // src/a.ts, docs/a.txt, .github/workflows/ci.yml → false
  it("replaces the defaults when the list has an include, and keeps excludes", ...)                 // ["wiki/**/*.md", "!wiki/old/**"]: wiki/a.md true, wiki/old/a.md false, README.md false
  it("narrows the defaults with an excludes-only list", ...)                                        // ["!docs/archive/**"]: docs/design.md true, docs/archive/x.md false, README.md true
})
describe("isHistory", ...)   // docs/superpowers/specs/x.md true; docs/design.md false
describe("docsInChange", () => {
  it("sorts an added plan as under review, a modified spec as history, a changed README as under, a lock file and a source file as code", ...)
})
describe("mentionPatterns", () => {
  it("searches the path and the basename as a word", () => expect(mentionPatterns("src/review/tools.ts")).toEqual(["src/review/tools.ts", "\\btools\\b"]))
  it("skips a short or common basename", () => { expect(mentionPatterns("src/index.ts")).toEqual(["src/index.ts"]); expect(mentionPatterns("cmd/main.go")).toEqual(["cmd/main.go"]); expect(mentionPatterns("src/db.ts")).toEqual(["src/db.ts"]) })
  it("takes the basename without its last extension only", () => expect(mentionPatterns("src/app.test.ts")).toEqual(["src/app.test.ts", "\\bapp.test\\b"]))
})
```

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run test/docs.test.ts`; FAIL (module missing).
- [ ] **Step 3: Implement** `docs.ts` as the interfaces say. `isGenerated` comes from `../github/diff.ts`. Keep `docMatcher` under complexity 10 by splitting `partition(globs)` and `matches(matchers, path)`.
- [ ] **Step 4: `pnpm check`** — PASS.
- [ ] **Step 5: Commit** — `git add src/repository/docs.ts test/docs.test.ts && git commit -m "Name the authoritative docs: the default set, history, and the mention patterns"`

---

### Task 2: `reviews.docs` in the config

**Files:**
- Modify: `src/repository/config.ts` (`Reviews` schema, `DEFAULT_CONFIG`)
- Modify: `docs/setup.md` (settings table row, the YAML example, section 6)
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `AndabotConfig.reviews.docs: string[]`, default `[...DEFAULT_DOC_GLOBS]`.

- [ ] **Step 1: Write the failing tests** — `FULL_CONFIG.reviews.docs` equals a list set in `FULL_YAML` (`docs: ["wiki/**/*.md", "!wiki/old/**"]`); the defaults carry `DEFAULT_DOC_GLOBS`; `docs: "wiki"` (a string) is rejected with `/reviews/docs` in the error; an empty entry is rejected.
- [ ] **Step 2: Run to see them fail** — `pnpm vitest run test/config.test.ts`; FAIL.
- [ ] **Step 3: Implement** — `docs: Type.Array(Type.String({ minLength: 1 }))` in `Reviews`; `docs: [...DEFAULT_DOC_GLOBS]` in `DEFAULT_CONFIG` (import from `./docs.ts`). `docs/setup.md`: a table row `reviews.docs` (default: `**/README*`, `docs/**/*.md` and the instruction files; globs, `!` excludes; a list with an include replaces the defaults, excludes alone narrow them; `docs/superpowers/**` is history and never checked unless the pull request adds the file), and `docs:` in the YAML example.
- [ ] **Step 4: `pnpm check`** — PASS.
- [ ] **Step 5: Commit** — `git add src/repository/config.ts docs/setup.md test/config.test.ts && git commit -m "Let .andabot.yaml name the repository's docs"`

---

### Task 3: mentions over the snapshot

**Files:**
- Modify: `src/repository/search.ts` (new export `grepMentions`)
- Modify: `src/repository/docs.ts` (`docMentions`)
- Test: `test/search.test.ts`, `test/docs.test.ts`

**Interfaces:**
- Produces, in `search.ts`:

```ts
export interface MentionHit { path: string; line: number; text: string }   // text cut to MAX_LINE_CHARS
export function grepMentions(files: SnapshotFiles, selected: (path: string) => boolean, pattern: string, work: GrepWork): MentionHit[]
   // compiles the pattern as grep does (a regex, or the literal when it fails to compile), walks the selected files through the same engine, charges work, answers every hit up to MAX_MATCHES; empty when work is spent
```

- in `docs.ts`:

```ts
export interface DocMentions { mentions: DocMention[]; overflow: number; searched: number }
export function docMentions(files: SnapshotFiles, work: GrepWork, isDoc: DocMatcher, code: readonly ChangedFile[], under: ReadonlySet<string>): DocMentions
   // selector = isDoc(path) && !isHistory(path) && !under.has(path); per code file: each pattern's hits, de-duplicated by path:line, capped at MAX_MENTIONS_PER_FILE; total capped at MAX_MENTIONS; overflow = hits dropped by either cap; searched = code files searched
```

- [ ] **Step 1: Write the failing tests** — in `test/search.test.ts` with `snapshotOf`: `grepMentions` answers structured hits `{ path, line, text }` for a literal path pattern across two files and none for a file the selector rejects; the text is the line, not `path:line: `; work is charged. In `test/docs.test.ts` with a `MemorySnapshotFiles`: a changed `src/review/tools.ts` mentioned in `docs/design.md` (twice) and `README.md` gives three mentions in path order; a mention inside `docs/superpowers/plans/x.md` is skipped; a mention in a doc under review is skipped; eight hits in one doc keep six and count two overflow; forty-one hits in all keep forty.
- [ ] **Step 2: Run to see them fail** — FAIL.
- [ ] **Step 3: Implement** — `grepMentions` reuses `compile`, `engineFor`, `search` and `GrepWork` inside `search.ts`, mapping `Hit` to `MentionHit` by parsing nothing: extend `Hit` with `line: number` and the raw line (keep `text` as the tool prints it) so both callers read it. `docMentions` in `docs.ts`.
- [ ] **Step 4: `pnpm check`** — PASS.
- [ ] **Step 5: Commit** — `git add src/repository/search.ts src/repository/docs.ts test/search.test.ts test/docs.test.ts && git commit -m "Find the docs that mention a changed file, over the head's snapshot"`

---

### Task 4: the prompt's two sections

**Files:**
- Modify: `src/review/prompt.ts` (`reviewPrompt`, `fullPrompt`, `incrementalPrompt`, new `docsData`)
- Test: `test/prompt.test.ts`

**Interfaces:**
- Produces:

```ts
export type DocsSearch = "ready" | "unavailable" | "spent"
export interface DocsSections { under: readonly ChangedFile[]; mentions: readonly DocMention[]; overflow: number; search: DocsSearch }
export const NO_DOCS: DocsSections   // { under: [], mentions: [], overflow: 0, search: "ready" }
// reviewPrompt(pr, files, full, issues, docs: DocsSections), fullPrompt(pr, files, lists, issues, docs), IncrementalPromptInput.docs: DocsSections
```

Rendering, inside the data block after the diff (incremental: after `## Other changed files`, before the thread lists): `## Docs under review` then `- path (added)` / `- path (changed)`, with the added-history note appended for a file `isHistory` accepts, or `(none)`; `## Docs mentioning the change` then `path:line: text` lines, then `N more mentions aren't listed.` when `overflow > 0`, or `(none)` when ready and empty, or the unavailable/spent sentence. Both through `neutraliseClosingTag`.

- [ ] **Step 1: Write the failing tests** — each prompt builder renders both sections inside the data block (`blockOf(text).inside`) in that order; the added-history note; `(none)` twice for `NO_DOCS`; the overflow line; the unavailable and spent sentences; the fresh prompt's sections come after `## Diff`.
- [ ] **Step 2: Run to see them fail** — FAIL (typecheck too; every call site in tests gains `NO_DOCS`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `pnpm check`** — the object won't compile until Task 6 passes `docs`; pass `NO_DOCS` at the `promptFor` call sites for now so the check is green, and commit.
- [ ] **Step 5: Commit** — `git add src/review/prompt.ts src/pull-request.ts test/prompt.test.ts && git commit -m "Tell the review which docs it is reviewing and which docs mention the change"`

---

### Task 5: the `docs` basis kind

**Files:**
- Modify: `src/review/findings.ts` (`Finding.basis_kind`, `basisProblem`)
- Modify: `src/review/basis.ts` (`BasisContext.docs`, `docsBasisProblem`, the pairing texts)
- Modify: `src/review/flight.ts` (`StoredPending.docs`)
- Modify: `skills/review/references/severity.md`, `skills/review/SKILL.md` (Docs check, anchor rule, version 12), `skills/verify/SKILL.md` (pairing sentence, version 3)
- Test: `test/basis.test.ts`, `test/findings.test.ts`, `test/flight.test.ts`, `test/skills.test.ts`

**Interfaces:**
- Produces: `basis_kind` union gains `"docs"` with the description `docs: a claim in an authoritative doc that the code contradicts; the basis names the doc's path:line and the claim, and the code path:line that contradicts it`; `BasisContext.docs: readonly string[]`; `docsBasisProblem(basis: string, context: BasisContext): string | undefined` (match on a doc path or its basename, case-insensitive; refusal `a docs finding must name one of the pull request's docs (<list or "none is known">); if the code is wrong on its own terms, make it a defect with its failure scenario`); `pairingProblem`'s low-side text becomes `a standard, test or docs finding cannot be blocking or major; grade it suggestion or nitpick, or give it the defect or spec basis it rests on`.

- [ ] **Step 1: Write the failing tests** — `pairingProblem` for `docs` at the four grades; `docsBasisProblem` by path and basename, refused for `src/x.ts` and for `docs/superpowers/plans/old.md` when the context lists only `docs/design.md` and `docs/superpowers/plans/new.md` (the added one); `validateFindings` refuses an unknown-doc `docs` finding as unfounded and accepts a known one at suggestion; `StoredPending.docs` parses; the schema accepts `basis_kind: "docs"`; the skills test pins version `"12"` and that the review body contains `- **Docs**:`; every existing test that pins the standard/test cap text is updated to the new wording.
- [ ] **Step 2: Run to see them fail** — FAIL.
- [ ] **Step 3: Implement.** `severity.md`: the pairing sentence names `docs`; add one `docs` example under suggestion and one under nitpick (text in the spec). `SKILL.md` step 2 gains `- **Docs**: …` (text in the spec's "The skill"); step 3 gains the anchor sentence; version 12. Verify skill step 4 names `docs`; version 3.
- [ ] **Step 4: `pnpm check`** — PASS.
- [ ] **Step 5: Commit** — `git add src skills test && git commit -m "File a false docs claim as a docs finding the host checks against the pull request's docs"`

---

### Task 6: the object and the design doc

**Files:**
- Modify: `src/pull-request.ts` (review start: sort, search access, mentions, log, prompt; `pending.docs`; `basisContextOf`)
- Modify: `src/repository/docs.ts` (`docsStartFields`, `docPathsAtHead`)
- Modify: `docs/design.md`
- Test: `test/docs.test.ts`

**Interfaces:**
- Consumes everything above.
- Produces: `docsStartFields(sorted: DocsInChange, found: DocMentions | undefined, search: DocsSearch): LogFields` (`under`, `history`, `code`, `mentions`, `mentionFiles`, `overflow`, `search`); `docPathsAtHead(paths: Iterable<string>, isDoc: DocMatcher, under: readonly string[]): string[]` (the matcher's paths minus history, plus `under`, de-duplicated and sorted).

- [ ] **Step 1: Write the failing tests** — `docsStartFields` on a sorted set with and without mentions; `docPathsAtHead` with a history path dropped and an added history path kept through `under`.
- [ ] **Step 2: Run to see them fail** — FAIL.
- [ ] **Step 3: Implement** in `runReview`, after `planReview` and before `promptFor`: `const inScope = scope.mode === "incremental" && scope.from !== undefined ? promptFiles(reviewable, since, scope).covered : reviewable`; `const isDoc = docMatcher(run.config.reviews.docs)`; `const sorted = docsInChange(inScope, isDoc)`; `const access = await this.repositorySearch("grep")`; when `access.kind === "ready"`, `found = docMentions(access.files, access.work, isDoc, sorted.code, new Set(sorted.under.map(f => f.filename)))` and `headDocs = docPathsAtHead(access.files.paths(), isDoc, under paths)`, else `found` undefined and `headDocs = under paths` (search `unavailable` or `spent` by `access.kind`); log `review.docs` with `docsStartFields`; pass `{ under: sorted.under, mentions: found?.mentions ?? [], overflow: found?.overflow ?? 0, search }` to `promptFor`; write `docs: headDocs` onto `pending` beside `recordRepository`'s write; `basisContextOf` adds `docs: pending.docs ?? []`. `docs/design.md`: the review pipeline's checks gain the docs check (one sentence after the standards/tests sentence near line 155-160), the prompt sections, the `docs` basis kind in the basis-rejection list (line 108) and the grades paragraph (line 250), and `reviews.docs` under the configuration section (line ~294).
- [ ] **Step 4: `pnpm check`** — PASS.
- [ ] **Step 5: Commit** — `git add src docs test && git commit -m "Sort a review's docs, list the docs that mention the change, and keep the pull request's docs for the basis check"`

---

### Task 7: the live fixture (Andrew runs the deploy)

- [ ] **Step 1:** After the fresh review, PR and merge, Andrew deploys main. Open a throwaway PR from `main-with-checks`: a small code change in `src/sandbox/checks.ts` (as the #194 fixture did), a `docs/design.md` paragraph that misdescribes it, and a README line that correctly describes `secondsText`. Expect one `docs` finding (suggestion) on the design.md line, and `review.docs` with `under: 2`.
- [ ] **Step 2:** Push a second commit changing `secondsText` so the README line is stale, without touching the README. Expect `## Docs mentioning the change` to list `README.md:<line>`, and one `docs` finding anchored on the changed code line citing the README.
- [ ] **Step 3:** Close unmerged, keep the branch, post the results on #125. #112's case joins the recall set with Task 8 of slice 4.
