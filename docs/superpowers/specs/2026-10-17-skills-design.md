# Skills for andabot: design

Status: decided in a grilling session on 17 Oct 2026; section D (slice 3) decided on 21 Oct 2026. The implementation plans follow from this document.

## Why

PR #1 is the symptom. Four heads of a near-identical 6,000-line diff, all on gpt-oss-120b, got 0, 0, 3 and 0 findings. The three were style-level, one suggestion was tautological (it signed a MAC and verified the same MAC), all three were labelled "suggestion" where the prompt's own rubric says "nitpick", and all three sat on the wrong line (#4). #2 adds the model comparison, which adds a second source of variance.

The part we can pin is the procedure. Today it is a 20-line system prompt with no completion criterion, no per-file loop, no requirement that a finding say why it is one, and a severity rubric the model misapplies. Skills turn that procedure into versioned text the host activates, identical whichever model runs, and the host validates the parts of a review that can be validated: anchors and quotes from #4, plus basis, coverage and merge danger from this. Judgement stays the model's; the planted-bug run measures it.

The bot reviews one person's own pull requests. Nothing here defends against a hostile author.

## Done means

#2's planted-bug pull request, reviewed by the current build as the baseline and again after each slice, on gpt-oss-120b and Kimi K2.7 Code. Compared per run: defects caught and at what severity, false positives, findings the host dropped, model calls, tokens and wall time, all recorded in #2. The summary footer's skill fingerprint and model id tie each run to what produced it.

## Goals

1. The review procedure is a bundled Agent Skill, host-activated, with a completion criterion the host enforces.
2. Every finding carries a basis the host validates: a defect states a failure scenario, a standards finding cites the rule or the named smell, a spec finding quotes the linked issue.
3. The spec axis exists: the host fetches linked issues and offers a tool for others.
4. Every review records which skills, fingerprint and model produced it, in the summary footer and in logs.
5. The system prompt shrinks to identity and tool etiquette. Each rule lives in one place.
6. Repository-provided skills and instruction files from the reviewed repository, read at the base commit, as section D decides (slice 3).

## Non-goals

- Skill scripts. They need a Worker Loader and the runner is Think-only today.
- The verify pass as a second session. Phase 2; the planted-bug run decides whether it comes next. The layout leaves a `verify` skill slot.
- The bot writing to the reviewed repository (learnings, out-of-scope records). It proposes text in comments at most.
- The Agents Vite plugin. The build stays wrangler-only.
- `.andabot.yaml`'s `model` section, which waits for the verify pass (#31). The file's review settings and its `path_instructions` are section D's.
- Author identity checks. A single user runs the bot on their own repositories.

## Anti-goals

- Skill text that competes with the diff. Budget: the review skill body stays under 120 lines. Until slice 3, the four references render inline after the skill (section C, #19), trading the on-demand budget for a tool set gpt-oss posts with.
- A rule stated twice. Anchoring rules already live in the `submit_review` schema; the skill points at them.
- Enforcing a linter's rules from the baseline. The baseline smells skip what tooling enforces; a repository's own written rules are reported even when its linter enforces them, as section D decides.
- Model-chosen activation for the core procedure.

## Constraints, verified

- `@earendil-works/pi-durable` 1.3.0 and `agents` 0.28.1 stay pinned. Pi Durable has no skill concept. `skills(sources)` from `agents/harness/pi` resolves every source once at install and returns an extension with a `skills` section, `activate_skill` and `read_skill_resource`; its catalog text is fixed. `read_skill_resource` only serves skills visible in the catalog. Installing an extension of the same name replaces it; new work sees the new state.
- System prompt sections are stored as positional entries and resent only when they change. A conversation's `instructions` renders last as its own section. `configure()` is a plain commit that applies from the next model request, not queued behind a busy run.
- `accept()` returns at once and runs each event in `waitUntil`, so a comment event runs concurrently with a review in flight. Chat input queues on the root session as a follow-up and runs after the review.
- The object has no filesystem and no shell. Reads go through the contents API. The client has `getIssue`: `GET /issues/{n}`, parsed by TypeBox, `undefined` for a missing issue. Every client call fetches through the constructor's `fetchImpl`, the global `fetch` unless a test injects its own, called with no receiver because workerd's `fetch` refuses the client as its `this`.
- The diff arrives in the prompt. A full review of #1 is about 30,000 input tokens.
- wrangler imports `.md` files as strings through a `rules` entry of type `Text`; `tsc` needs a `declare module "*.md"` beside it.
- The harness factory runs once per isolate at startup, before a new object knows its pull request.
- Code rules from `CLAUDE.md` (PR #5): no comments in code, so a reason goes in a name, a test title or `docs/design.md`; every GitHub response is parsed with a TypeBox schema and `Value.Check`, no assertions; complexity at most 10 per function; no `vi.mock`, so a dependency is replaced through a real interface; `test/lint` must see every new folder.

## Design

### A. Skill files

```
skills/
  review/
    SKILL.md
    references/
      severity.md        blocking, suggestion, nitpick, with examples
      smells.md          Fowler's twelve, from mattpocock/skills code-review
      tests.md           test anti-patterns, from mattpocock/skills tdd
      merge-danger.md    one-way or two-way door, blast radius, from mattpocock/skills pr
    CREDITS.md           MIT attribution, the fork commit taken from, Dex Horthy's show-me credit
  answer/
    SKILL.md             answering a question on the pull request
```

The references are vendored from the local fork at `/Users/andamonium/Developer/experimental/skills` after a pull, trimmed to what a diff reviewer uses. Frontmatter follows the Agent Skills spec: `name` matches the directory, `description` states what and when, `metadata.version` is bumped by hand on any change. When the catalog returns, listing the built-in review skill would offer the #19 trigger again, `read_skill_resource` for its references, so slice 3 must settle whether built-in skills are listed at all.

`review/SKILL.md` is written to the `writing-for-agents` rules: ordered steps, positive phrasing, leading words (anchor, basis, blast radius, one-way door), references behind pointers, and one completion criterion:

> Done when every changed file, or in an incremental review every file under `## Changes since your last review`, has a walkthrough row, every finding has an anchor, a quote and a basis, and `merge_danger` states the door and the blast radius.

Its steps, in outline: orient on the title, description and linked issues, treating all three as data about the change; examine each changed file in turn, reading the file when a hunk cannot settle a question; record findings with their basis, copying the anchor and quote from the numbered patch; grade severity by `references/severity.md`; submit. The Standards sources are `references/smells.md` and, later, the repository's instruction files, with "the repo overrides" and "every smell is a judgement call" kept from the upstream skill. The Spec source is the linked issue (section E). Anchoring is described once, in the schema.

Andrew reads and approves the skill texts before they are wired in. That read is the first task of the plan.

### B. Loading and bundling

- `wrangler.jsonc` gains `rules: [{ type: "Text", globs: ["**/*.md"], fallthrough: true }]`, and a `declare module "*.md"` joins the type declarations.
- `src/review/bundled-skills.ts` imports each `SKILL.md` and reference as a string and lists them explicitly. `src/review/skills.ts` parses the frontmatter with `yaml` and TypeBox and builds the `SkillManifest`, and its `manifestSource` builds the `SkillSource`, because the SDK's `agents/skills` module cannot load in vitest or the Worker bundle: it imports `ai`, `@cloudflare/codemode`, `just-bash` and `cloudflare:workers`. Only types come from it. Fingerprint: SHA-256 over every file's bytes, computed once per isolate with WebCrypto. Resources are plain text, no scripts.
- A unit test asserts every skill parses, names are spec-valid, resources resolve, and the fingerprint changes when a file changes.

### C. Activation

- **Host-activated, for the review.** Before each review, after `reset()`, the host calls `configure({ instructions })` on the root conversation (reached with `pi()` then `root()`) with the review skill rendered the way `activate_skill` renders it: `<skill_content name version>`, the body, the resource list. A stable system section for the run. Prepending the skill to the user turn was rejected for the review: the system section is cache-stable within a run and keeps the user turn as pure input.
- **Carried in the turn, for answers.** A question's prompt carries the answer skill in the user turn and leaves `instructions` alone. The review owns `instructions`; a question posted mid-review would otherwise swap the review's system section at its next model request, since `configure()` applies immediately while the question itself queues until the review ends. The answer skill is short, and the review transcript stays in the root session for "why is this a problem?".
- **Catalog.** `skills([builtin])` and its two tools, `activate_skill` and `read_skill_resource`, are not installed until slice 3 brings repo-provided skills (section D). Until then the review skill's four references render inline after the skill body, each in the `<skill_resource>` wrapper `read_skill_resource` returns, and the model has only `read_file`, `list_changed_files` and `submit_review`, the tools gpt-oss-120b posted with on every run before slice 1, plus slice 2's `get_issue`. Offered the catalog's tools, it printed its first `read_skill_resource` call as raw Harmony text, then its whole `submit_review` call, and never posted a review of #9 (#19).

### D. Repository context (slice 3)

Decided on 21 Oct 2026 for issues #29 and #28 and the repository skills. Everything a repository supplies is read at the pull request's base commit, so a pull request cannot change the rules it is reviewed by, and `docs/design.md`'s configuration section changes to match.

- **Instruction files.** One recursive trees call at the base commit finds them: at the root, `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, `CODING_STANDARDS.md`, `.github/copilot-instructions.md` and `CONTRIBUTING.md`; `.github/instructions/*.instructions.md`, kept when the `applyTo` glob in its frontmatter matches a changed file and when it has none; and a nested `CLAUDE.md` or `AGENTS.md` in any directory that is an ancestor of a changed file. Bodies load through the contents API, and the listing and the bodies are cached in the object's storage by base sha. Globs are matched with `minimatch`, pinned.
- **Rendering.** They render in the instructions after the skill and its references, as `## Repository standards`, each file under a heading with its path, in this order: `path_instructions` entries whose glob matches a changed file, then matching `.github/instructions` files, then nested `CLAUDE.md` and `AGENTS.md` deepest first, then root `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, `CODING_STANDARDS.md`, `.github/copilot-instructions.md` and `CONTRIBUTING.md`. The section is capped at 12,000 characters: whole entries are dropped from the end until it fits, except that a first entry larger than the cap is truncated at the cap, and a closing note names what was cut or truncated. The review skill's standards check names the section; a `standard` finding's basis names the file and the rule. Repository rules are reported even when a linter enforces them, since the review cannot run the linter and #29 asks for exactly that; `references/smells.md`'s sentence about skipping what tooling enforces scopes to the smells. A `standard` finding stays a suggestion or a nitpick. The footer line `Standards: CLAUDE.md, .github/instructions/ts.instructions.md` (or `none`) and `review.start` (`instructionFiles`, their count) say what was used.
- **Config.** `.andabot.yaml` at the base commit, parsed with `yaml` and a TypeBox schema. A missing file gives the defaults; an invalid one gives the defaults and a summary note naming the error. Under `reviews`: `auto` (default `true`; `false` means pushes start no review and only commands do), `drafts` (default `false`: a draft waits until it is ready for review), `base_branches` (default any; a list restricts reviews to pull requests against those branches), `ignore_title_keywords` (default none; a match skips the pull request), `request_changes_workflow` (overrides the Worker var), `path_filters` (a list of `!`-prefixed minimatch globs naming paths to leave out of the review, such as `!**/*.snap`, matched with `dot: true` and joining `isGenerated`; an entry without the `!` makes the file invalid), `path_instructions` (a list of `{ path, instructions }`, each applied when its glob matches a changed file). `model.*` waits for the verify pass (#31). The router stays config-free: it forwards draft pull requests too, and the object applies the settings before planning. A title or base edit does not re-trigger a review; the next push or a command does, and a command bypasses every filter. A skipped push logs `review.skip` with the setting's name.
- **Repository skills.** `GitHubSkillSource(client, repo, baseSha)` lists `.github/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md` from the same trees call, in that order with names sorted within each and no relevance rule, loads bodies and resources through the contents API, refuses `..` and absolute paths, and reports the tree SHA of those directories as its fingerprint, shown in the footer as `repo@<8>`. Built-in skills come first, so a repository skill named `review` or `answer` is shadowed with a logged warning. How they reach the model is settled by a re-test of the Agents SDK catalog (`skills([builtin, repo])`, `activate_skill`, `read_skill_resource`) on GLM-5.3 Flash, the default model, before the skills task starts. The re-test reinstalls `skills([builtin])` as PR #17 had it, with the built-in references on demand, on a throwaway branch; it passes when two of two runs post through `submit_review` with the catalog tools called and no raw tool-call text in the transcript. If it passes, repository skills load on demand through the catalog while the built-in review skill and its references stay inline; if it does not, repository skill bodies render inline after the standards, under `## Repository skills`, capped at 12,000 characters the same way, and their resources load through `read_file`. The catalog tools are offered only when the repository has skills, and there is no per-model switch: a model that cannot use them is not the default.
- **Supplementing, not replacing.** The review skill states that a repository skill supplements the built-in rubric: the procedure and `submit_review` stay in force, a repository skill supplies checks and vocabulary, and a tool it names that the bot lacks is skipped.
- **Measurement.** Two fixtures, answer keys on #2, never merged: a pull request to this repository that adds a comment and a type assertion, expecting two `standard` findings whose basis names `CLAUDE.md`; and a pull request against a throwaway base branch that carries a `.github/skills/code-review/SKILL.md`, expecting that skill's checks in the review and `repo@<8>` in the footer.

### E. Spec axis

- The host parses linked issues in this order: closing keywords in the body (`Closes #n`, `Fixes #n`, `Resolves #n`), then the branch name's `GH-n` keys, then a trailing `.n` on the branch name whose dot follows a non-digit, so a version such as `v1.2` is no key. Bare `#n` mentions in the body count only when none of those exists, since a mention in passing does not make an issue the spec. It fetches up to three with a new `getIssue` parsed by TypeBox, and renders title and body, capped, under "Linked issues" in the review prompt, marked as data like the description.
- A read-only `get_issue(number)` tool, `replay: "safe"`, for issues the model meets in commits or comments.
- The skill: a spec finding quotes the issue line it rests on. With no linked issue the prompt says "No linked issue" and the footer shows "Linked issues: none"; the summary does not repeat it. Requirements are never inferred from the code, so the host rejects a `spec` finding on a pull request with no linked issue, with a reason that offers the `defect` kind for code that is wrong on its own terms. A requirement the diff leaves out is named in the summary, in the issue's words.

### F. Anchors, findings and the submit loop

#12 delivered #4's anchors; slice 2 adds the rest.

Shipped in #12:

- `renderPatches` numbers every patch line with the anchor the review API takes: new-file line and `RIGHT` for added and context lines, old-file line and `LEFT` for deleted ones. The model copies an anchor instead of counting.
- `Finding` gains `quote`, the exact text of the anchored line. The host compares it with the patch line at that side and number; on a mismatch it moves the finding to the one line in the same file whose text matches, and rejects it when none or several match. A quote may carry what the model copied around the text: the anchor in front of it (`R12`, or `R12*` on a starred line), the diff's marker for the line's side (`+` on the RIGHT, `-` on the LEFT) and an incremental review's `*`. The host tries the quote as written first, then without the anchor, without the marker and without both, and keeps the reading that matched as the finding's quote. A line whose own text starts like a marker therefore still matches itself, and readings that match different lines are refused rather than guessed between.
- A suggestion posts only on a verified anchor range and is capped at 60,000 characters; a rendered comment is capped at 65,536, GitHub's limit.
- Every rejection goes back to the model once, as one tool result listing every rejected finding with its reason.
- Approval gate: APPROVE only when the verdict is approve, no accepted finding is blocking, and no blocking finding was rejected on the final submission. A mis-anchored blocking finding holds the review at REQUEST_CHANGES. Rejected suggestions and nitpicks do not stand in the way, and neither does a finding rejected for its basis (a blank basis, a `standard` or `test` finding graded blocking, a `spec` finding with no linked issue): it is unfounded rather than unposted, so it never holds approval back, whatever else is wrong with it.

Left for slice 2:

- `Finding` gains `basis_kind` (`defect`, `spec`, `standard` or `test`) and `basis`: for a defect, the failure scenario as input or state, what the anchored line does, what was expected; for spec, the quoted issue line; for standard, the file and rule or the smell's name; for test, the new behaviour without a test, or a test that does not verify the behaviour it names. Both fields flat, for small models.
- `basis` must be non-empty. A `standard` or `test` finding cannot be `blocking`. A `spec` finding needs a linked issue.
- `ReviewSubmission` gains `merge_danger`: `door` (`one-way` or `two-way`) and `blast_radius`, one line. Required. The summary's "Merge danger" line follows the stored `reviewed` record, not the latest submission: a full review stores its own judgement, and an incremental review (#24), which sees only its push, stores the stricter door of the record's and the push's, the push's judgement when the doors are equal. A push that touches nothing risky therefore leaves a one-way door in place.
- Every changed file not filtered as generated has a walkthrough row. An incremental review (#24) needs rows only for the files it covers, and none when it only re-checks threads, since the summary keeps the stored rows of the other files. Missing rows are returned with the other rejections. If the second submission still misses files, nothing posts: the summary comment says the review did not complete and names the files, ten at most and then a count of the rest, and the run is logged as `review.incomplete`. A retry's JSON counts as the second submission, so rows missing from it end the review the same way; the resubmit prompt names the files that need rows when the first run gave the host nothing to check.

Rendering: a finding's comment carries `_Basis (<kind>): …_` after the body and before any suggestion block; the summary gets a "Merge danger" line under the verdict.

### G. Attribution and logs

- Summary footer: model id, `review@<fingerprint8>`, and the linked issues used.
- `review.start` logs `skillsFingerprint`, the full fingerprint, and `review.done` logs `skills` as `review@<fingerprint8>`; no log carries a skill's version. Slice 2 adds `linkedIssues` to `review.start`. The `posted:<sha>` record stores fingerprint and model.

### H. Prompt refactor

`systemPrompt()` keeps identity and tool etiquette, about ten lines; the answer rule lives only in the answer skill. Severity, procedure and the Standards and Spec rules move to the skill and its references. Anchoring stays in the schema only. Phrasing follows `writing-for-agents`: positive targets, no bans without a stated target, no sentence the model obeys by default.

### I. Tests

Unit, in the existing vitest Node suite: manifest and fingerprint; frontmatter validity; numbered patches and quote verification on an added file and a modified one; linked-issue parsing; basis and blocking rules; walkthrough completeness; the approval gate; the footer. The Durable Object path has no workerd tests today; the planted-bug pull request is the acceptance run.

### J. Order of work

All of it branches from `main` after PR #5 (lint and format) merges, so every file is written to `CLAUDE.md`'s rules from the first commit.

1. **Baseline.** Open #2's planted-bug pull request from a throwaway branch: five defects of known kind and line. Review it on the current build with gpt-oss-120b and Kimi K2.7 Code and record the results in #2. The PR stays open, unmerged, for the later runs.
2. **Slice 1: infrastructure and the review skill.** Sections A, B, C, G, H, and a "Skills" section in `docs/design.md` pointing at this spec with the phases updated. No schema change. Andrew approves the skill texts before wiring. Then `@andabot full review` on the planted PR, both models.
3. **Slice 2: basis, coverage, spec axis.** Section E and the remainder of F. #12 has merged and shipped #4's anchors: numbered patch lines, the `quote` field, the suggestion rules, every rejection returned once, and approval held back while a blocking finding stands rejected. Slice 2 builds basis, merge danger, walkthrough coverage, the submit loop's outcome type and linked issues on top of them, in one PR that closes only its own issue. Then the planted PR again, both models.
4. **Slice 3: repository context.** Section D, decided on 21 Oct 2026; Parts A to C in `docs/superpowers/plans/2026-10-21-repository-context.md`.

One issue per slice. This spec is committed on slice 1's branch.

### K. Left to the builder

Exact skill wording within the rules above, subject to Andrew's read; the cap values; how `tsc` sees the `.md` imports; the exact footer text; which generated-file filter the coverage check reuses.
