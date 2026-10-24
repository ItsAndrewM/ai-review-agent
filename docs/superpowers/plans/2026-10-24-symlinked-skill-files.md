# Symlinked skill files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the repository-skill caps and the `repo@` fingerprint from trusting a symlink's listing entry (#103): a skill file that GitHub's tree marks as a symlink (mode `120000`) is left out of the catalog, logged as `skills.capped` with `cap: symlink`.

**Architecture:** The decision lives in the pure skill planner in `src/repository/skills.ts`: a symlinked resource is not one of its skill's files, so it is never loaded, served or fingerprinted; a symlinked `SKILL.md` keeps its skill discoverable but caps it, as an oversized one is. Resolving a symlink to its target was ruled out: GitHub's JSON contents API answers a symlink with the target's size and content but the symlink's own blob sha (probed on `mattpocock/skills`, `AGENTS.md -> CLAUDE.md`), so the target's sha needs the link text and a listing of paths the record doesn't keep.

**Tech Stack:** TypeScript on Cloudflare Workers, Durable Objects, the Agents SDK 0.28.1 skills catalog, TypeBox, vitest, oxlint/oxfmt.

**Spec:** issue #103 on `ItsAndrewM/ai-review-agent`; `docs/design.md` ("Skills": the caps and the fingerprint).

## Global Constraints

- `CLAUDE.md`: no comments of any kind; no type assertions except `as const`; complexity at most 10 per function; no `unknown`/`object` parameters or returns, no `typeof`, no `vi.mock`; the reason for a thing lives in a name, a test title or `docs/design.md`.
- `pnpm check` passes on every commit; `pnpm format` before committing.
- Log fields are strings, numbers, booleans or undefined; every new value of a logged field is named in `docs/design.md`.
- An entry without a `mode` (records from before modes were kept) is a regular file.

## Review Focus

- A repository whose `.claude/skills/<name>` is a directory symlink to `.github/skills/<name>`: the listing holds one `120000` entry and no files under it, so nothing is discovered there and the real skill is offered once (Task 1 test).
- A skill whose `SKILL.md` is a symlink beside a regular skill: the regular one is still offered and the fingerprint covers only it (Task 1 test).
- A symlinked resource of an offered skill: the skill stays offered, its resource list lacks the file, and `skills.capped` counts it under `resources` (Task 1 test).
- An old record listing a symlink without a mode: treated as a regular file until a new base replaces the record, as the design doc says (Task 1 test).

---

### Task 1: Leave symlinked skill files out (#103)

**Files:**
- Modify: `src/github/client.ts` (export `isSymlink` beside `SYMLINK_MODE` at line 208)
- Modify: `src/repository/context.ts` (drop its local `isSymlink` at line 116; import the shared one)
- Modify: `src/repository/skills.ts` (`SkillCap`; `isFileOf` around line 156; `repositorySkillFingerprint` around line 181; `SkillPlan` and `planOf` around line 213; `stateOf` around line 239; `resourceCapsOf` around line 315)
- Modify: `docs/design.md` (the "Skills" caps sentences), `docs/setup.md` (step 3's skills sentence, line 68)
- Test: `test/repository-skills.test.ts`

**Interfaces:**
- Produces:

```ts
export const isSymlink = ({ mode }: Pick<TreeEntry, "mode">): boolean => mode === SYMLINK_MODE
export type SkillCap = "file" | "base" | "description" | "listing" | "symlink"
```

- [ ] **Step 1: Write the failing tests** in `test/repository-skills.test.ts`, building a symlink entry as the file's blob fixture with `mode: SYMLINK_MODE` (read how `blob(...)` and `contextOf(...)` build entries first):

```ts
it("leaves out a skill whose SKILL.md is a symlink, logging cap symlink, and still offers a regular skill beside it", async () => {
  // .github/skills/linked/SKILL.md mode 120000, .github/skills/lint/SKILL.md regular, both bodies cached
  // expect: offered names ["lint"]; capped contains { name: "linked", path: ".github/skills/linked/SKILL.md", cap: "symlink" }
})

it("leaves a symlinked resource out of its skill's files, the catalog's resource list and the fingerprint, and counts it under resources", async () => {
  // .github/skills/lint/SKILL.md regular, .github/skills/lint/rules.md regular, .github/skills/lint/extra.md mode 120000
  // expect: repositorySkillFiles(...) lint files lack extra.md; the fingerprint equals the one computed without the extra.md entry;
  // capped contains { name: "lint", path: ".github/skills/lint/SKILL.md", cap: "symlink", resources: 1 }; lint is offered
})

it("discovers nothing under a skills root that is itself a symlink, so a skill symlinked between roots is offered once", async () => {
  // .claude/skills/lint mode 120000 (one entry, no files under it), .github/skills/lint/SKILL.md regular
  // expect: offered names ["lint"], nothing shadowed, nothing capped
})

it("treats a skill file listed without a mode as a regular one, as records from before modes were kept list it", async () => {
  // .github/skills/lint/extra.md with no mode: it is one of lint's files
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run test/repository-skills.test.ts`
Expected: FAIL (`symlink` is not a cap; symlinked files are still files).

- [ ] **Step 3: Implement**

- `src/github/client.ts`: export `isSymlink` as in Interfaces; `src/repository/context.ts` imports it and drops its own.
- `src/repository/skills.ts`:
  - `SkillCap` gains `"symlink"`.
  - `isFileOf(dir, entry)`: a resource that `isSymlink` is never one of the skill's files; `SKILL.md` stays one whatever its mode, so the skill is still discovered and its state logged.
  - `repositorySkillFingerprint` leaves out symlinked entries, so `repo@` covers only content the catalog can serve.
  - `SkillPlan` gains `symlinked: ReadonlySet<string>` (the skills' `SKILL.md` paths that are symlinks) and `symlinkedResources: ReadonlyMap<string, number>` (per skill name, the resources under its directory that are symlinks); `planOf` leaves symlinked bodies out of `servable`, as it does oversized ones.
  - `stateOf` returns `{ kind: "capped", at, cap: "symlink" }` for a symlinked body, before the oversized check.
  - `resourceCapsOf` adds `leftOut("symlink", plan.symlinkedResources.get(skill.name) ?? 0)`.
  - Keep every function at complexity 10 or less.
- `docs/design.md`, in the "Skills" paragraph after "The caps read the sizes in the listing, before any fetch, and a blob the listing gives no size for is left out of the record.": "A skill file the listing marks as a symlink (mode `120000`) is left out too, since its listed size and sha are its link text's while the contents API serves its target, so neither the caps nor the fingerprint could vouch for what it serves: a symlinked `SKILL.md` leaves its skill out and a symlinked resource is left out of its skill's files, each logged as `skills.capped` with `cap: symlink` (#103). A skills directory that is itself a symlink is one entry with nothing listed under it, so nothing is discovered there. A record from before the modes were kept lists a symlink as a regular file until a new base replaces it." Name `symlink` wherever the doc lists the `cap` values.
- `docs/setup.md` step 3 (line 68): after "…which the model can activate", add "; a skill file committed as a symlink is left out, since GitHub lists a symlink by its link text, so commit the file itself".

- [ ] **Step 4: Run the checks**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/github/client.ts src/repository/context.ts src/repository/skills.ts test/repository-skills.test.ts docs/design.md docs/setup.md
git commit -m "Leave a skill file GitHub lists as a symlink out of the catalog and the fingerprint, logged with cap symlink"
```

---

### Task 2: Finish: fixture, live check, pull request

- [ ] **Step 1: Fixture.** Through the Git Data API, a base branch `main-with-symlinked-skill` from `main-with-skills` adding: `docs/linked-rules.md` (a regular file holding a skill: frontmatter `name: linked-rules`, a description, one rule) with `.github/skills/linked-rules/SKILL.md` as a `120000` blob whose content is `../../../docs/linked-rules.md`; and `docs/readonly-examples.md` (regular) with `.github/skills/readonly-parameters/examples.md` as a `120000` blob pointing at `../../../docs/readonly-examples.md`. Open a pull request from `chore/shorten-a-list-of-shas-in-one-place` against it on the branch build. Expected: `skills.capped` `{name: "linked-rules", cap: "symlink"}` and `{name: "readonly-parameters", cap: "symlink", resources: 1}`; `review.start` `repoSkills: 3`; the catalog lists `code-review`, `no-tmp-names` and `readonly-parameters` and never `linked-rules`.
- [ ] **Step 2: Pull request** closing #103; deploy plain main after the check; after Andrew merges, deploy main and verify one review.
