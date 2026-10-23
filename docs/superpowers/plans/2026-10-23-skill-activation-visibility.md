# Skill activation visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a repository skill's activation visible in the logs and harder for a literal-minded model to miss (#81): log the tools the review offers after the catalog is installed, name the catalog's tools in the preamble when they are offered, align the review skill's activation sentence with the catalog's own words (skill version 9), and measure on a fixture whose planted defect only the repository's skill can find.

**Architecture:** The preamble is a Pi prompt section whose `render` receives the request's `agent.tools`, so it can name `activate_skill` and `read_skill_resource` only when they are offered; a new `review.tools` event logged right after `configureReview` installs the catalog says which tools the session offers; the skill text changes in `skills/review/SKILL.md` alone (its fingerprint follows). The fixture adds a third skill to the `main-with-skills` base and a feature branch whose defect no built-in smell covers.

**Tech Stack:** TypeScript on Cloudflare Workers, Durable Objects, Pi Durable 1.3.0, the Agents SDK 0.28.1 skills catalog, vitest, oxlint/oxfmt.

**Spec:** issue #81 on `ItsAndrewM/ai-review-agent`; `docs/design.md` ("Skills", the preamble and the catalog); `docs/superpowers/specs/2026-10-17-skills-design.md` section D (repository skills, measurement).

## Global Constraints

- `CLAUDE.md`: no comments of any kind; no type assertions except `as const`; complexity at most 10 per function; no `unknown`/`object` parameters or returns, no `typeof`, no `vi.mock`; the reason for a thing lives in a name, a test title or `docs/design.md`.
- `pnpm check` passes on every commit; `pnpm format` before committing.
- Log fields are strings, numbers, booleans or undefined; every new event or field is named in `docs/design.md`.
- The review skill's text is the measured artifact: any change bumps `metadata.version` (8 → 9) and Andrew reads the new sentence on the pull request before it ships; the bundled fingerprint follows the text on its own.
- Tests against the Durable Object itself are out of scope; object wiring is reviewed by reading and proven by the live check.

## Review Focus

- A review of a repository without skills: the preamble names no catalog tool, and `review.tools` lists the six built-in tools alone (Task 2 test; Task 1 helper test).
- A catalog install that fails (`skills.restore_failed`-style error inside `installCatalog`): `review.tools` must say what is offered, not what was meant (Task 1: read the registry after the install, never the plan).
- The summary session: unchanged, it selects no extensions and offers no tool, so nothing here reaches it (read in review).
- A question answered after a review: the catalog stays installed, and the preamble for that request names the catalog tools (Task 2: the sentence depends on the request's tools, not on a review flag).
- gpt-oss on the skill-only fixture: either it activates the skill (the fix worked) or it posts without the finding (a model habit, recorded as such); both outcomes close #81 with the record (Task 5).

---

### Task 1: Log the tools the review offers, after the catalog is installed

**Files:**
- Modify: `src/pull-request.ts` (`runReview` around line 1049, right after `await this.configureReview(repository)`; `configureReview` at 1178)
- Modify: `src/repository/skills.ts` (a pure helper beside `skillsStartFields`)
- Modify: `docs/design.md` (the "Skills" paragraph that lists `review.start`'s `repoSkills` fields)
- Test: `test/repository-skills.test.ts`

**Interfaces:**
- Consumes: `this.registry.snapshot().installed()` (the installed extensions in registry order, each with `name` and `tools?: ToolRegistration[]`; a tool's `callers` lists who may call it, default both); `this.#catalog` (the installed catalog extension or undefined).
- Produces:

```ts
export function offeredToolNames(installed: readonly Extension[]): string[]
```
  the names of every installed extension's tools the model may call (a tool whose `callers` lacks `"model"` is left out), in registry order; and the event `review.tools` with `{ number, head, tools: offeredToolNames(...).join(" "), catalog: this.#catalog !== undefined }`.

- [ ] **Step 1: Write the failing test** in `test/repository-skills.test.ts`:

```ts
describe("offeredToolNames", () => {
  it("lists every installed extension's model-callable tools in registry order, leaving out a tool only tools may call", () => {
    const review = defineExtension({ name: "andabot", tools: [tool("read_file"), tool("submit_review")] })
    const catalog = defineExtension({ name: "agents.skills", tools: [tool("activate_skill"), tool("read_skill_resource")] })
    const internal = defineExtension({ name: "internal", tools: [defineTool({ ...toolInput("hidden"), callers: ["tools"] })] })
    expect(offeredToolNames([review, internal, catalog])).toEqual(["read_file", "submit_review", "activate_skill", "read_skill_resource"])
    expect(offeredToolNames([])).toEqual([])
  })
})
```

Build `tool(name)` and `toolInput(name)` as small local helpers around `defineTool` with a `Type.Object({})` parameter schema and an `execute` returning `{ output: [] }`, matching the file's existing `defineTool` calls. Check `callers` is the field name pi-durable's `ToolRegistration` uses (`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts` around line 258) and adapt.

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm exec vitest run test/repository-skills.test.ts`
Expected: FAIL (`offeredToolNames` is not exported).

- [ ] **Step 3: Implement**

- `src/repository/skills.ts`: `offeredToolNames` as in Interfaces.
- `src/pull-request.ts`: in `runReview`, right after `await this.configureReview(repository)` and before the second `replaced` check, `log("review.tools", { number: pr.number, head: shortSha(pr.head.sha), tools: offeredToolNames([...this.registry.snapshot().installed()]).join(" "), catalog: this.#catalog !== undefined })`. Read pi-durable's `resolveAgent` (`node_modules/@earendil-works/pi-durable/dist/harness/agent.js`, around line 164) to confirm that a session with no `extensions` setting offers every installed extension's tools, and say so in the report; if it selects only some, log those.
- `docs/design.md`: in the "Skills" paragraph, after the sentence that lists `review.start`'s `repoSkills`, `repoSkillsFingerprint` and `skillLoadsSkipped`: "`review.tools`, logged once the catalog is installed, names the tools the review's session offers the model (`tools`, space-separated, in registry order) and whether the catalog is among them (`catalog`), so the record shows what the model could call rather than what the review meant to install (#81)."

- [ ] **Step 4: Run the checks**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pull-request.ts src/repository/skills.ts test/repository-skills.test.ts docs/design.md
git commit -m "Log the tools a review offers once the catalog is installed, so the record shows what the model could call"
```

---

### Task 2: The preamble names the catalog's tools when they are offered

**Files:**
- Modify: `src/review/prompt.ts` (`systemPrompt` at line 34)
- Modify: `src/review/tools.ts` (the `sections` entry at line 128)
- Modify: `docs/design.md` (the "Skills" paragraph's sentence on the root session's tools, and the "Prompt" or preamble sentence if one names the tool list)
- Test: `test/prompt.test.ts` (`describe("systemPrompt")` at line 230)

**Interfaces:**
- Consumes: `PromptSection.render(input, context)` receives `input.agent.tools`, the tools the request offers, each with a `name` (`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts` lines 285-290 and 397-411).
- Produces: `systemPrompt(botLogin: string, offered: readonly string[]): string`.

- [ ] **Step 1: Write the failing tests** in `test/prompt.test.ts`, adapting the existing two `systemPrompt` tests to the new second argument (`SIX = ["read_file", "grep", "tree", "list_changed_files", "get_issue", "submit_review"]`):

```ts
it("names activate_skill and read_skill_resource only when the request offers them, pointing at the Available skills list", () => {
  const withCatalog = systemPrompt("andabot", [...SIX, "activate_skill", "read_skill_resource"])
  expect(withCatalog).toContain(
    "activate_skill opens one of the repository's own skills, listed under Available skills, and read_skill_resource reads one of that skill's files.",
  )
  expect(systemPrompt("andabot", SIX)).not.toContain("activate_skill")
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run test/prompt.test.ts`
Expected: FAIL (one argument).

- [ ] **Step 3: Implement**

- `src/review/prompt.ts`: `systemPrompt(botLogin, offered)` keeps today's text and, when `offered` includes `"activate_skill"`, appends to the `Tools:` paragraph the sentence the test quotes, exactly.
- `src/review/tools.ts`: `render: (input) => systemPrompt(host.botLogin(), input.agent.tools.map((tool) => tool.name))`.
- `docs/design.md`: where the "Skills" paragraph says the root session's tools are the six built-in ones (line 126 region; check the current wording after #88 added `grep` and `tree`), add: "When the catalog is installed, the preamble's tool list also names `activate_skill` and `read_skill_resource`, pointing at the `Available skills` list the catalog renders, since a model that reads only the tool list never saw them (#81)."

- [ ] **Step 4: Run the checks**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review/prompt.ts src/review/tools.ts test/prompt.test.ts docs/design.md
git commit -m "Name the catalog's tools in the preamble when the request offers them"
```

---

### Task 3: Skill version 9 says what the catalog says

**Files:**
- Modify: `skills/review/SKILL.md` (frontmatter `metadata.version`, the activation paragraph in step 1, line 14)
- Modify: `test/skills.test.ts` (whatever pins the version), `docs/design.md` (the sentence that quotes the skill's activation rule, if any), `docs/superpowers/specs/2026-10-17-skills-design.md` (section D's "Supplementing, not replacing" bullet)

**Interfaces:** none; the bundled fingerprint follows the text.

- [ ] **Step 1: Replace the paragraph** that begins "When your instructions list repository skills" with, verbatim:

> A list headed `Available skills` in your prompt names the repository's own skills. When one's description matches this pull request, use `activate_skill` with its name before step 2. That skill supplements this one: this procedure and `submit_review` stay in force, the repository's skill supplies checks and vocabulary, and a tool it names that you do not have is skipped. A finding a repository skill asks for is a `standard` finding, graded suggestion or nitpick, whose basis names the skill's `SKILL.md` and the rule.

Bump `metadata.version` to `"9"`. Keep the body under 120 lines.

- [ ] **Step 2: Run the checks**, fixing any test that pins the version or the old sentence.

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Docs.** In the spec's "Supplementing, not replacing" bullet, add that the sentence uses the catalog's own words (`Available skills`, "use `activate_skill` with its name") since version 9. In `docs/design.md`, if a sentence quotes the old wording, update it.

- [ ] **Step 4: Commit**

```bash
git add skills/review/SKILL.md test/skills.test.ts docs/design.md docs/superpowers/specs/2026-10-17-skills-design.md
git commit -m "Say in the review skill what the catalog says: a matching skill under Available skills is activated by name before step 2 (version 9)"
```

---

### Task 4: A fixture whose defect only the repository's skill can find

**Files:** none in this repository's working tree; everything goes through GitHub's Git Data API (`gh api repos/ItsAndrewM/ai-review-agent/git/{blobs,trees,commits,refs}` with `--input`), as `/private/tmp/claude-501/-Users-andamonium-Developer-experimental-huckleberry-clone/e8d56275-e95f-4234-8be8-9a0615cec339/scratchpad/plant-filters-fixture.sh` shows.

- [ ] **Step 1: Add the skill to the base.** A new commit on `main-with-skills` (currently `fc71cfc`, which carries `.github/skills/code-review` and `.github/skills/no-tmp-names`) adds `.github/skills/readonly-parameters/SKILL.md`:

```markdown
---
name: readonly-parameters
description: "Flag an array parameter typed as mutable when the function never changes it; use when reviewing TypeScript changes that add or change function signatures."
---

A function that takes an array it does not change types that parameter `readonly T[]`, so a caller's array passes without a copy and the signature says the function leaves it alone.

Check each function, method or arrow the diff introduces or changes whose parameter is typed as an array, written `T[]` or `Array<T>`. A parameter the body changes, through `push`, `pop`, `splice`, `sort`, `reverse` or an index assignment, is not a match.

Report each match as a `standard` finding anchored on the line that declares the parameter. Grade it a suggestion or a nitpick, because a blocking `standard` finding is rejected. Its basis names this skill's `SKILL.md` and the rule, as in `readonly-parameters/SKILL.md: an array parameter the function never changes is typed readonly`.

Suggest the `readonly` form. Leave alone a parameter the diff did not introduce or change.
```

- [ ] **Step 2: Plant the defect.** A branch `chore/shorten-a-list-of-shas-in-one-place` from the new base with one commit: `src/sha.ts` gains `export function shortShas(shas: string[]): string[] { return shas.map(shortSha) }`, and one existing call site on that base that shortens two or more shas in a row (search `src/` at `main-with-skills` for `shortSha(` calls on neighbouring lines; `src/review/render.ts` or `src/pull-request.ts` has one) is rewritten to call it. No identifier containing `tmp`, no comment, no assertion, no other smell. The parameter's mutable type is the only defect. Keep the diff under 20 lines.

- [ ] **Step 3: Open the pull request** against `main-with-skills`, titled "Shorten a list of shas in one place", body "Pulls the repeated shortening of two shas into one helper. Merging deploys nothing." with no closing keyword. Record the answer key in `/private/tmp/claude-501/-Users-andamonium-Developer-experimental-huckleberry-clone/e8d56275-e95f-4234-8be8-9a0615cec339/scratchpad/readonly-fixture-answer-key.md`: the path and line of `shas: string[]`, the expected basis `readonly-parameters/SKILL.md`, the expected `activate_skill` call, and that `code-review` and `no-tmp-names` must not be activated for this diff (their descriptions don't match).

---

### Task 5: Finish: pull request, deploy, measure, record

- [ ] **Step 1: Pull request.** Push the branch; `gh pr create --base main` with a body that names the three changes and asks Andrew to read skill version 9's paragraph (quote it); the body closes #81 by keyword only if the measurement below is recorded first, otherwise the record closes it.
- [ ] **Step 2: Measure before merging, on the branch build.** Announce a window to the peer sessions; deploy the branch from this worktree; wait for the fixture's object to settle (a fresh pull request has none, so the opening review runs on the branch build at once); then `@andabot full review` on the fixture for each model: the default GLM-5.3 Flash, then `--var REVIEW_MODEL:@cf/openai/gpt-oss-120b`, then `--var REVIEW_MODEL:@cf/moonshotai/kimi-k2.7-code`, each a deploy of the same branch. For each run read `review.tools` (the eight tools, `catalog: true`), `review.transcript` (`activate_skill:1` or none), the posted review (the `standard` finding with the `readonly-parameters/SKILL.md` basis, and no finding from `no-tmp-names` or `code-review`), the footer's `repo@<8>`. Record each run on #2 as the earlier fixture records are written, and the totals on #81. Redeploy plain main afterwards and tell the peers the version.
- [ ] **Step 3: Close.** Close the fixture unmerged; keep its branches. After Andrew merges, deploy main, verify a `review.tools` event on the new build, and note the result in `docs/design.md`'s catalog sentence (the gpt-oss outcome on this fixture) in a follow-up commit if it changes what the sentence says.
