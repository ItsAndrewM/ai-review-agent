# Skills for andabot: design

Status: decided in a grilling session on 17 Oct 2026. Open points for the deferred slice are marked provisional. The implementation plan follows from this document.

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
6. Deferred: repo-provided skills and instruction files from the reviewed repository, read at the base commit and offered through the catalog.

## Non-goals

- Skill scripts. They need a Worker Loader and the runner is Think-only today.
- The verify pass as a second session. Phase 2; the planted-bug run decides whether it comes next. The layout leaves a `verify` skill slot.
- The bot writing to the reviewed repository (learnings, out-of-scope records). It proposes text in comments at most.
- The Agents Vite plugin. The build stays wrangler-only.
- The `.andabot.yaml` config file. It is phase 2 work in `docs/design.md`; its `path_instructions` join the Standards sources when it exists.
- Author identity checks. A single user runs the bot on their own repositories.

## Anti-goals

- Skill text that competes with the diff. Budget: the review skill body stays under 120 lines. Until slice 3, the four references render inline after the skill (section C, #19), trading the on-demand budget for a tool set gpt-oss posts with.
- A rule stated twice. Anchoring rules already live in the `submit_review` schema; the skill points at them.
- Rules a linter could enforce. Those wait for the sandbox tier.
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

> Done when every changed file has a walkthrough row, every finding has an anchor, a quote and a basis, and `merge_danger` states the door and the blast radius.

Its steps, in outline: orient on the title, description and linked issues, treating all three as data about the change; examine each changed file in turn, reading the file when a hunk cannot settle a question; record findings with their basis, copying the anchor and quote from the numbered patch; grade severity by `references/severity.md`; submit. The Standards sources are `references/smells.md` and, later, the repository's instruction files, with "the repo overrides" and "every smell is a judgement call" kept from the upstream skill. The Spec source is the linked issue (section E). Anchoring is described once, in the schema.

Andrew reads and approves the skill texts before they are wired in. That read is the first task of the plan.

### B. Loading and bundling

- `wrangler.jsonc` gains `rules: [{ type: "Text", globs: ["**/*.md"], fallthrough: true }]`, and a `declare module "*.md"` joins the type declarations.
- `src/review/bundled-skills.ts` imports each `SKILL.md` and reference as a string and lists them explicitly. `src/review/skills.ts` parses the frontmatter with `yaml` and TypeBox and builds the `SkillManifest`, and its `manifestSource` builds the `SkillSource`, because the SDK's `agents/skills` module cannot load in vitest or the Worker bundle: it imports `ai`, `@cloudflare/codemode`, `just-bash` and `cloudflare:workers`. Only types come from it. Fingerprint: SHA-256 over every file's bytes, computed once per isolate with WebCrypto. Resources are plain text, no scripts.
- A unit test asserts every skill parses, names are spec-valid, resources resolve, and the fingerprint changes when a file changes.

### C. Activation

- **Host-activated, for the review.** Before each review, after `reset()`, the host calls `configure({ instructions })` on the root conversation (reached with `pi()` then `root()`) with the review skill rendered the way `activate_skill` renders it: `<skill_content name version>`, the body, the resource list. A stable system section for the run. Prepending the skill to the user turn was rejected for the review: the system section is cache-stable within a run and keeps the user turn as pure input.
- **Carried in the turn, for answers.** A question's prompt carries the answer skill in the user turn and leaves `instructions` alone. The review owns `instructions`; a question posted mid-review would otherwise swap the review's system section at its next model request, since `configure()` applies immediately while the question itself queues until the review ends. The answer skill is short, and the review transcript stays in the root session for "why is this a problem?".
- **Catalog.** `skills([builtin])` and its two tools, `activate_skill` and `read_skill_resource`, are not installed until slice 3 brings repo-provided skills (section D). Until then the review skill's four references render inline after the skill body, each in the `<skill_resource>` wrapper `read_skill_resource` returns, and the model has only `read_file`, `list_changed_files` and `submit_review`, the tools gpt-oss-120b posted with on every run before slice 1. Offered the catalog's tools, it printed its first `read_skill_resource` call as raw Harmony text, then its whole `submit_review` call, and never posted a review of #9 (#19).

### D. Repository context (deferred, provisional)

Scheduled when a second repository uses the bot. Provisional decisions, to revisit then:

- `GitHubSkillSource(client, repo, baseSha)`: lists `.github/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md` with one recursive trees call at the base commit, loads bodies and resources on demand through the contents API, refuses `..` in paths, and reports the tree SHA of those directories as its fingerprint, cached in the object's storage. The `agents.skills` extension is reinstalled per review with `[builtin, repo]`, built-in first, so a repo skill named `review` is shadowed with a logged warning.
- Instruction files at the base commit: `CLAUDE.md`, `AGENTS.md`, `CODING_STANDARDS.md`, `CONTRIBUTING.md`, `REVIEW.md`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` filtered by `applyTo` against the changed files, then `path_instructions` once `.andabot.yaml` exists. Rendered after the skill as "Repository standards", capped at 12,000 characters with a note naming what was cut.
- Trust: base commit only, for skills, instruction files and the config file alike. `docs/design.md` currently reads `.andabot.yaml` from the head; it changes to match when the config lands.
- A repository's own review skill, such as the two-axis `code-review` that `install-code-review-skill` puts in `.github/skills`, supplements the built-in rubric: the review skill states that its procedure and `submit_review` stay in force, a repository skill supplies checks and vocabulary, and a tool it names that the bot lacks is skipped.

### E. Spec axis

- The host parses linked issues from the body (`Closes #n`, `Fixes #n`, `Resolves #n`, bare `#n`) and the branch name (`GH-n`, a trailing `#n`), fetches up to three with a new `getIssue` parsed by TypeBox, and renders title and body, capped, under "Linked issues" in the review prompt, marked as data like the description.
- A read-only `get_issue(number)` tool, `replay: "safe"`, for issues the model meets in commits or comments.
- The skill: a spec finding quotes the issue line it rests on. With no linked issue the summary says "No linked issue; reviewed against the description only." Requirements are never inferred from the code.

### F. Anchors, findings and the submit loop

#12 delivered #4's anchors; slice 2 adds the rest.

Shipped in #12:

- `renderPatches` numbers every patch line with the anchor the review API takes: new-file line and `RIGHT` for added and context lines, old-file line and `LEFT` for deleted ones. The model copies an anchor instead of counting.
- `Finding` gains `quote`, the exact text of the anchored line. The host compares it with the patch line at that side and number; on a mismatch it moves the finding to the one line in the same file whose text matches, and rejects it when none or several match.
- A suggestion posts only on a verified anchor range and is capped at 60,000 characters; a rendered comment is capped at 65,536, GitHub's limit.
- Every rejection goes back to the model once, as one tool result listing every rejected finding with its reason.
- Approval gate: APPROVE only when the verdict is approve, no accepted finding is blocking, and no blocking finding was rejected on the final submission. A mis-anchored blocking finding holds the review at REQUEST_CHANGES. Rejected suggestions and nitpicks do not stand in the way.

Left for slice 2:

- `Finding` gains `basis_kind` (`defect`, `spec`, `standard` or `test`) and `basis`: for a defect, the failure scenario as input or state, what the anchored line does, what was expected; for spec, the quoted issue line; for standard, the file and rule or the smell's name; for test, the new behaviour without a test, or a test that does not verify the behaviour it names. Both fields flat, for small models.
- `basis` must be non-empty. A `standard` or `test` finding cannot be `blocking`.
- `ReviewSubmission` gains `merge_danger`: `door` (`one-way` or `two-way`) and `blast_radius`, one line. Required.
- Every changed file not filtered as generated has a walkthrough row. Missing rows are returned with the other rejections. If the second submission still misses files, nothing posts: the summary comment says the review did not complete and names the files, and the run is logged as `review.incomplete`.

Rendering: a finding's comment ends with `_Basis: …_`; the summary gets a "Merge danger" line under the verdict.

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
4. **Slice 3: repository context.** Deferred; section D holds the provisional decisions.

One issue per slice. This spec is committed on slice 1's branch.

### K. Left to the builder

Exact skill wording within the rules above, subject to Andrew's read; the cap values; how `tsc` sees the `.md` imports; the exact footer text; which generated-file filter the coverage check reuses.
