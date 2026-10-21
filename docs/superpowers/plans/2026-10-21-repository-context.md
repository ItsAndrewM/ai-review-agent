# Repository context (slice 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the reviewer the repository's own instruction files scoped to the changed paths (#29), the optional `.andabot.yaml` with its settings and `path_instructions` (#28), and repository-provided skills, all read at the pull request's base commit.

**Architecture:** A `src/repository/` folder holds pure functions over a tree listing from one recursive trees call at the base commit: instruction-file discovery and ordering, the standards renderer with its cap, the config schema and reader, and the skill source. The Durable Object fetches the tree and the bodies once per base sha, caches them in storage, and appends a `## Repository standards` section (and, depending on the catalog ruling, `## Repository skills`) to the instructions it already builds from the bundled skill. The router stays config-free; the object applies the settings and logs each skip.

**Tech Stack:** TypeScript on Cloudflare Workers with `nodejs_compat`, Pi Durable 1.3.0, TypeBox 1.3.27, `yaml` 2.9.1, `minimatch` 10.0.3 (new, pinned), vitest, oxlint with the repository's rules.

**Spec:** `docs/superpowers/specs/2026-10-17-skills-design.md`, section D as decided on 21 Oct 2026, with sections A to C and E to K for what exists. Issues #29 and #28 carry the done-when lines.

## Global Constraints

- `CLAUDE.md` rules: no comments in code (a reason goes in a name, a test title or `docs/design.md`); every GitHub response and stored value parsed with a TypeBox schema and `Value.Check`; no type assertions except `as const`; complexity at most 10 per function; no `vi.mock`, so a dependency is replaced through a real interface; no `unknown` parameters or returns except a caught error's `cause`; no `typeof`; no `...(cond ? {...} : {})`.
- `@earendil-works/pi-durable` stays 1.3.0 and `agents` stays 0.28.1. New dependency: `minimatch` `10.0.3`, pinned exactly, typed by itself.
- Everything a repository supplies is read at the base commit: the tree, instruction files, `.andabot.yaml`, skills.
- The review skill body stays under 120 lines; each skill text change bumps `metadata.version` and waits for Andrew's read before its PR merges.
- Caps: the standards section and the inline skills section are each capped at 12,000 characters, whole entries dropped from the end, a closing note naming what was cut.
- Branches: `feature/<title>.GH-<issue>`. PR descriptions say `Closes #<n>` and that merging deploys nothing; `pnpm run deploy` deploys by hand. Three pull requests: Part A (#29), Part B (#28), Part C (repository skills, its own issue).
- Fixtures are never merged; answer keys and run records go on #2.

## Review Focus

- A changed file `apps/web/src/a.ts` with `apps/web/CLAUDE.md` and a root `CLAUDE.md`: both render, the nested one first; `apps/api/CLAUDE.md` does not.
- An `.instructions.md` whose `applyTo` is a list (`["**/*.ts", "**/*.tsx"]`) matches a `.tsx` change; one whose `applyTo` is `src/**` does not match `test/a.ts`.
- Files totalling more than 12,000 characters: the section keeps whole leading entries, drops the rest, and the note names each dropped path.
- An invalid `.andabot.yaml` (`reviews: { auto: "yes" }`): defaults apply, the summary carries the note, and the review still runs.
- `auto: false`: a push starts no review and logs `review.skip` with `reason: "auto"`; `@andabot review` still reviews.
- A repository skill directory named `review`: the built-in wins and `skills.shadowed` is logged.

---

## Part A: instruction files (#29)

### Task 1: The trees call and the glob dependency

**Files:**
- Modify: `src/github/client.ts` (new `getTree`), `package.json`, `pnpm-lock.yaml`
- Test: `test/client.test.ts`, `test/globs.test.ts` (new)

**Interfaces:**
- Produces: `TreeEntry = { path: string; type: "blob" | "tree"; sha: string }`, `RepositoryTree = { sha: string; entries: readonly TreeEntry[]; truncated: boolean }`, `GitHubClient.getTree(ref: RepoRef, sha: string): Promise<RepositoryTree>` (recursive, `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1`, parsed with a TypeBox schema, `truncated` carried through), and the dependency `minimatch`.

- [ ] **Step 1: Write the failing client test**

In `test/client.test.ts`, with the fake-fetch pattern already there:

```ts
it("getTree lists the tree recursively at a sha and keeps the truncated flag", async () => {
  // fake fetch answers GET /repos/o/r/git/trees/abc?recursive=1 with { sha: "abc", truncated: false, tree: [{ path: "CLAUDE.md", type: "blob", sha: "1" }, { path: "src", type: "tree", sha: "2" }] }
  expect(await client.getTree({ owner: "o", repo: "r" }, "abc")).toEqual({ sha: "abc", truncated: false, entries: [{ path: "CLAUDE.md", type: "blob", sha: "1" }, { path: "src", type: "tree", sha: "2" }] })
})
it("getTree rejects a response that is not a tree", …) // a body without `tree` throws with a message naming the path
```

- [ ] **Step 2: Run it, confirm it fails** (`pnpm vitest run test/client.test.ts`: `getTree is not a function`).
- [ ] **Step 3: Implement `getTree`** beside `compareCommits`, through the client's `json()`/`parse()` path with a `Tree` TypeBox schema; map `tree[]` to `entries`, keeping only `blob` and `tree` types.
- [ ] **Step 4: Add `minimatch` 10.0.3** (`pnpm add minimatch@10.0.3`) and write `test/globs.test.ts` pinning the behaviour the later tasks rely on: `minimatch("src/a.ts", "src/**")` true, `minimatch("test/a.ts", "src/**")` false, `minimatch("a/b/c.tsx", "**/*.{ts,tsx}")` true, `minimatch("CLAUDE.md", "**")` true, `minimatch(".github/x.md", "**", { dot: true })` true and `minimatch(".github/x.md", "**")` false, so the host always passes `{ dot: true }`.
- [ ] **Step 5: Run `pnpm check` and `pnpm exec wrangler deploy --dry-run --outdir /tmp/andabot-dry-run`**: both pass; the dry run proves `minimatch` bundles for Workers.
- [ ] **Step 6: Commit** `Add the recursive trees call and pin minimatch for path globs`.

### Task 2: Discovering, ordering and rendering instruction files

**Files:**
- Create: `src/repository/instructions.ts`
- Test: `test/instructions.test.ts`

**Interfaces:**
- Consumes: `TreeEntry` from Task 1, `minimatch`.
- Produces:
  - `type StandardSource = "path_instructions" | "instructions" | "nested" | "root"`
  - `interface Standard { readonly path: string; readonly text: string; readonly source: StandardSource }`
  - `instructionCandidates(entries: readonly TreeEntry[], changed: readonly string[]): string[]`: the paths to load, ordered as the spec's rendering order (matching `.github/instructions/*.instructions.md` cannot be filtered before their bodies are read, so every `.github/instructions/*.instructions.md` is a candidate and `applyToKeeps` filters them once loaded), nested `CLAUDE.md`/`AGENTS.md` for every ancestor directory of a changed file deepest first, then the root files in the spec's order; only paths present in `entries` as blobs.
  - `applyToKeeps(text: string, changed: readonly string[]): boolean`: parses a YAML frontmatter block (`---` … `---`) with `yaml`; `applyTo` absent → true; a string or a list of strings, comma-separated strings split → true when any glob matches any changed path with `{ dot: true }`; invalid frontmatter → true.
  - `frontmatterStripped(text: string): string`.
  - `orderedStandards(loaded: readonly { path: string; text: string }[], changed: readonly string[], pathInstructions: readonly { path: string; instructions: string }[]): Standard[]`: `path_instructions` entries whose glob matches a changed path first (path shown as `.andabot.yaml: <glob>`), then the loaded files in candidate order with `.instructions.md` files kept by `applyToKeeps` and their frontmatter stripped.
  - `MAX_STANDARDS_CHARS = 12_000`
  - `renderStandards(standards: readonly Standard[]): { text: string; used: string[]; cut: string[] }`: `## Repository standards` then, per entry, `### <path>` and the text; entries are added whole while the total stays at or under the cap; when any are cut, the section ends with `_Cut for length: <path>, <path>._`; with no standards at all it returns `{ text: "", used: [], cut: [] }`.

- [ ] **Step 1: Write the failing tests** in `test/instructions.test.ts`, one `it` per behaviour above, with the Review Focus cases: the nested `apps/web/CLAUDE.md` ahead of root `CLAUDE.md` and `apps/api/CLAUDE.md` absent; the list-valued `applyTo`; `src/**` not matching `test/a.ts`; the cap keeping whole leading entries and naming the cut; `.github/copilot-instructions.md` before `CONTRIBUTING.md`; a directory with both `CLAUDE.md` and `AGENTS.md` listing `CLAUDE.md` first.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Implement the module.** Keep every function under complexity 10: split the root list, the nested walk and the instructions-glob into their own functions.
- [ ] **Step 4: `pnpm check` passes.**
- [ ] **Step 5: Commit** `Discover, order and render a repository's instruction files for the review`.

### Task 3: The standards in the review, with attribution

**Files:**
- Modify: `src/pull-request.ts` (`configureReview`, the pending record and `review.start`, the summary footer input), `src/review/flight.ts` (`PendingReview.instructionFiles?: string[]`), `src/review/render.ts` (`standardsLine`), `skills/review/SKILL.md` (version 6), `test/skills.test.ts`, `test/findings.test.ts`, `docs/design.md`, `docs/superpowers/specs/2026-10-17-skills-design.md`
- Create: `src/repository/context.ts`
- Test: `test/context.test.ts`

**Interfaces:**
- Produces: `interface RepositoryContext { readonly baseSha: string; readonly tree: RepositoryTree; readonly files: Readonly<Record<string, string>> }` with a TypeBox schema `StoredRepositoryContext` for storage under `context:<baseSha>`; `loadRepositoryContext(github: GitHubClient, ref: RepoRef, baseSha: string, paths: readonly string[]): Promise<RepositoryContext>` reading each path through `getFileContent` (a missing file is skipped); `standardsFor(context, changed, pathInstructions): { text, used, cut }` composing Task 2.
- The object: in `review()`, after the linked issues, compute the candidates from the tree, load (or read the cached context for the same base sha, loading only paths not yet cached), render, keep `used` on `pending.instructionFiles`, log `instructionFiles: used.length` and `standardsCut: cut.length` in `review.start`; `configureReview()` sets `instructions` to the skill text followed by a blank line and the standards text when it is not empty.
- Footer: `<sub>Standards: CLAUDE.md, .github/instructions/ts.instructions.md</sub>` or `<sub>Standards: none</sub>` after the linked-issues line, from `renderSummaryComment`'s new `instructionFiles: readonly string[]`.
- Skill v6, step 2's Standards bullet becomes: `- **Standards**: the repository's own rules under `## Repository standards` in your instructions, when present, and the smells in `references/smells.md`, below. A `standard` finding's basis names the file and the rule. When a hunk adds or reshapes logic, match the hunks against the smells.`

- [ ] **Step 1: Write the failing tests**: `test/context.test.ts` with a fake `GitHubClient` on a fake fetch (tree, two files, one missing) asserting the context's files and that a cached context is reused for the same sha and extended for new paths; `test/findings.test.ts` pins the footer line in both forms; `test/skills.test.ts` pins version "6".
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Implement**, keeping `review()` under complexity 10 by extracting `repositoryStandards(pr, files)`.
- [ ] **Step 4: Docs**: `docs/design.md`'s pipeline step 1 and a paragraph in its Skills section on the standards and the cap; the spec's section D stays as written.
- [ ] **Step 5: `pnpm check` and the dry-run build pass.**
- [ ] **Step 6: Stop for Andrew's read of the skill's new bullet, then commit** `Render the repository's instruction files as standards for the review, scoped to the changed paths`.

### Task 4: Part A's pull request and fixture

- [ ] **Step 1: Push and open the PR** `Give the reviewer the repository's own instructions, scoped to the changed paths` with `Closes #29`; Andrew merges.
- [ ] **Step 2: The standards fixture**: an issue is not needed; a throwaway branch from main adds to `src/review/render.ts` one explanatory `//` comment and one `as string` assertion on existing lines (two `CLAUDE.md` breaches), with a PR description that reads like a real tidy-up; the answer key on #2 names the two lines and expects two `standard` findings whose basis names `CLAUDE.md`, and the footer `Standards: CLAUDE.md`.
- [ ] **Step 3: After the merge and the deploy** (announce the window to the peer sessions; wait 8 minutes): open the fixture PR, run it on GLM-5.3 Flash, gpt-oss and Kimi, record on #2, close it unmerged.

## Part B: the configuration file (#28)

### Task 5: The config schema and reader

**Files:**
- Create: `src/repository/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `AndabotConfig` TypeBox schema: `reviews: { auto: boolean (true), drafts: boolean (false), base_branches: string[] (default []: any), ignore_title_keywords: string[] ([]), request_changes_workflow: boolean | undefined (undefined: the Worker var), path_filters: string[] ([]), path_instructions: { path: string; instructions: string }[] ([]) }`, `model` accepted and ignored; `DEFAULT_CONFIG`; `parseConfig(text: string): { config: AndabotConfig; error: string | undefined }` (YAML parse errors and `Value.Check` failures both give the defaults and a one-line error naming the first problem via `Value.Errors`); `readConfig(github, ref, baseSha): Promise<{ config, error, present: boolean }>` through `getFileContent(ref, ".andabot.yaml", baseSha)`.

- [ ] **Step 1: Write the failing tests**: the defaults for a missing file; a full valid file; `reviews: { auto: "yes" }` giving the defaults with an error that names `reviews.auto`; an unknown key under `reviews` rejected; `model` keys ignored.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Commit** `Read and validate .andabot.yaml at the base commit, with defaults when it is missing or invalid`.

### Task 6: Applying the settings

**Files:**
- Modify: `src/route.ts` (forward draft pull requests instead of ignoring them), `src/pull-request.ts`, `src/github/diff.ts` (`isFiltered(path, patterns)` beside `isGenerated`; `requiresWalkthrough` and the prompt's file list take the config's filters), `src/review/render.ts` (the config note in the summary), `docs/design.md`, `docs/setup.md`
- Test: `test/route.test.ts`, `test/diff.test.ts`, `test/config.test.ts`, `test/findings.test.ts`

**Interfaces:**
- `shouldReview(config: AndabotConfig, pr: { draft: boolean; baseRef: string; title: string }, trigger: "push" | "command"): { review: true } | { review: false; reason: "auto" | "draft" | "base_branch" | "title_keyword" }`, pure, in `src/repository/config.ts`; a command always reviews.
- The object reads the config with the repository context (same base sha cache), applies `shouldReview` before planning, logs `review.skip` with the reason, uses `request_changes_workflow` over the var when set, passes `path_filters` into `isFiltered`, and gives `path_instructions` to `orderedStandards`.
- The summary note for an invalid file: `_.andabot.yaml was ignored: <error>; the defaults applied._` under the footer lines.
- `review.start` logs `config: "defaults" | "file" | "invalid"`.

- [ ] **Step 1: Write the failing tests**: `shouldReview` for each setting and for a command; `isFiltered` with `!pnpm-lock.yaml` and `!**/*.snap`; the router forwarding a draft pull request; the summary note.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Docs**: `docs/design.md`'s configuration section reads from the base commit and says why; `docs/setup.md` gets the file with every setting and its default.
- [ ] **Step 5: `pnpm check` passes.**
- [ ] **Step 6: Commit** `Apply .andabot.yaml: auto, drafts, base branches, title keywords, the request-changes workflow, path filters and path instructions`.

### Task 7: Part B's pull request

- [ ] **Step 1: Push and open the PR** `Read an optional .andabot.yaml for per-repository review settings` with `Closes #28`; Andrew merges.
- [ ] **Step 2: Live check after the deploy**: on a throwaway branch of this repository carrying `.andabot.yaml` with `auto: false` as the base, a push to a PR against it starts no review (`review.skip`, `reason: "auto"`) and `@andabot review` does; record on #28 and close.

## Part C: repository skills

### Task 8: The catalog re-test on GLM-5.3 Flash

Operational, before any skills code: on a throwaway branch, reinstall the Agents SDK catalog (`skills([builtin])` with the existing `manifestSource`, as PR #17 had it before #20 removed it), deploy with a window announced to the peer sessions, run `@andabot full review` on #54 twice on GLM, and read `review.transcript` for `activate_skill` and `read_skill_resource` calls and the posted review. Ruling recorded in the spec's section D: catalog (on demand) when both runs post a review through `submit_review` with the catalog tools called cleanly; inline otherwise. Restore plain main; close nothing; the branch is deleted.

### Task 9: The skill source and its installation

**Files:**
- Create: `src/repository/skills.ts`
- Modify: `src/pull-request.ts`, `src/review/flight.ts` (`repoSkillsFingerprint?`), `src/review/render.ts` (footer `with skills review@<8>, repo@<8>`), `docs/design.md`, the spec
- Test: `test/repository-skills.test.ts`

**Interfaces:**
- `repositorySkillFiles(entries: readonly TreeEntry[]): { name: string; dir: string; files: string[] }[]` for `.github/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`, in that order, with every blob under each skill directory as a resource; `..` segments and absolute paths refused; a skill named `review` or `answer` dropped with `skills.shadowed` logged by the caller.
- `repositorySkillFingerprint(entries): string` = SHA-256 over the sorted `path:sha` pairs of those files.
- Catalog ruling: `skillSourceFor(context)` builds a `SkillSource` through `manifestSource`, installed per review as `[builtin, repo]`. Inline ruling: `renderRepositorySkills(skills, cap = 12_000)` renders `## Repository skills` with each body under `### <name>` and the same cut note, appended after the standards; resources are listed by path for `read_file`.
- `review.start` logs `repoSkills: names`.

- [ ] Steps as in Task 2: failing tests first (discovery from a tree, the three roots' order, shadowing, `..` refusal, the fingerprint's stability, the inline cap), implement, `pnpm check`, commit `Load a repository's own skills at the base commit and offer them to the review`.

### Task 10: The supplementing rule in the skill

- [ ] Skill v7 adds to step 1: `A skill under `## Repository skills` in your instructions, or in the catalog, supplements this one: this procedure and `submit_review` stay in force, the repository's skill supplies checks and vocabulary, and a tool it names that you do not have is skipped.` (catalog or inline wording per Task 8). `test/skills.test.ts` pins "7". Stop for Andrew's read, then commit `Say that a repository's skill supplements the review skill`.

### Task 11: Part C's pull request and fixture

- [ ] **Step 1: Open an issue** `Offer a repository's own skills to the review` and the PR `Load a repository's own skills at the base commit and offer them to the review` with `Closes #<n>`; Andrew merges.
- [ ] **Step 2: Fixture**: a throwaway base branch `main-with-code-review-skill` from main adding `.github/skills/code-review/SKILL.md` vendored from `/Users/andamonium/Developer/experimental/skills` (with `CREDITS.md`), and a PR against it that changes one function in a way the vendored skill's checks call out but the built-in smells do not; answer key on #2.
- [ ] **Step 3: After the deploy**, three runs, records on #2, the PR closed unmerged, the base branch kept.

## Finish

- [ ] Delete the merged branches on origin for Parts A, B and C, and the Task 8 branch.
- [ ] `docs/design.md`'s Status line names slice 3 as shipped and the catalog ruling.
