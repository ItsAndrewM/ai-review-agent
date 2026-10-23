# Base-move carryover and the activation log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two small follow-ups on the repository context: when a pull request's base moves, carry over from the old base's record every body whose blob is unchanged instead of refetching everything (#80), and log which repository skill a review activated, not only that `activate_skill` was called (#100).

**Architecture:** The carryover is a pure seeding step in `contextAt`: a new base's context starts with the bodies of a donor record (the one other `context:` record the object holds) for every listed blob whose sha the donor also holds, so only changed and missing bodies spend loads. The activation log is one more wrapper on the catalog's `activate_skill` tool, beside the existing content-to-output wrapper, that reports the skill's name to a callback the object supplies; the object logs `skills.activated` and lists the names in `review.transcript`.

**Tech Stack:** TypeScript on Cloudflare Workers, Durable Objects, Pi Durable 1.3.0, the Agents SDK 0.28.1 skills catalog, TypeBox, vitest, oxlint/oxfmt.

**Spec:** issues #80 and #100 on `ItsAndrewM/ai-review-agent`; `docs/design.md` ("Skills": the context cache paragraph and the catalog paragraph).

## Global Constraints

- `CLAUDE.md`: no comments of any kind; no type assertions except `as const`; complexity at most 10 per function; no `unknown`/`object` parameters or returns, no `typeof`, no `vi.mock`; the reason for a thing lives in a name, a test title or `docs/design.md`.
- `pnpm check` passes on every commit; `pnpm format` before committing.
- Log fields are strings, numbers, booleans or undefined; every new event or field is named in `docs/design.md`.
- Anything read from the repository comes from the pull request's base commit; a carried-over body is the body of the same blob sha, so it is the base's content by construction.
- Tests against the Durable Object itself are out of scope; object wiring is reviewed by reading and proven by the live check.

## Review Focus

- A base move where a file's content changed between the bases: its body is loaded afresh, never carried (Task 1 test).
- A base move where the old record holds a file remembered as missing (the empty body): nothing to carry, since a missing file has no blob in either listing (Task 1 test).
- Several `context:` records on disk (an older build's leftovers): no donor is chosen, and the load proceeds as today (Task 1, object wiring, read in review).
- An `activate_skill` call whose arguments carry no name (a malformed call): nothing is reported and the SDK's own answer is returned (Task 2 test).
- A question answered after a review activates a skill: the activation is logged with the pull request's number and no review head (Task 2, read in review).

---

### Task 1: Carry a base's unchanged bodies over a base move (#80)

**Files:**
- Modify: `src/repository/context.ts` (`contextAt` around line 105, `loadRepositoryContext` at 140)
- Modify: `src/pull-request.ts` (`loadedContext` and `cachedContext` around lines 905-925)
- Modify: `docs/design.md` (the "Skills" paragraph sentence that says a new base replaces the record and loads everything again, citing #80)
- Test: `test/context.test.ts` (`describe("loadRepositoryContext")` at line 206)

**Interfaces:**
- Consumes: `StoredRepositoryContext` (`baseSha`, `tree.entries[]` with `path`, `sha`, `size`, `files: Record<path, body>`); `GitHubClient.getTree`; `Value.Check`.
- Produces:

```ts
export function carriedBodies(entries: readonly TreeEntry[], donor: RepositoryContext | undefined): Record<string, string>
export async function loadRepositoryContext(github, ref, baseSha, changed, unreadable, cached?: RepositoryContext, donor?: RepositoryContext): Promise<RepositoryContext>
```
  `carriedBodies` returns, for every entry whose path the donor's `files` holds with a body and whose sha equals the donor's entry sha for that path, that body; an entry absent from the donor's listing, one whose sha differs, and a donor body that is the missing marker (`""`) carry nothing.

- [ ] **Step 1: Write the failing tests** in `test/context.test.ts`, using the file's `contextOf`/`blob`-style fixtures (read the existing `loadRepositoryContext` tests first and mirror their fakes):

```ts
it("seeds a new base's context with the donor's bodies for the blobs it still lists unchanged, so a base move loads only what changed", async () => {
  // donor at base A: CLAUDE.md sha "c1" body "rules", AGENTS.md sha "a1" body "agents"
  // new base B lists CLAUDE.md sha "c1" and AGENTS.md sha "a2"
  // expect: CLAUDE.md carried without a GitHub read, AGENTS.md read once, files holds both
})

it("carries nothing for a file the donor remembered as missing or no longer lists, and nothing without a donor", async () => {
  // donor body "" for REVIEW.md -> not carried, loaded again; a path only in the new tree -> loaded; donor undefined -> today's behaviour
})

it("carriedBodies keeps a body only for the same path with the same blob sha", () => {
  // pure: same path+sha kept, changed sha dropped, path missing from the new listing dropped, "" dropped
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run test/context.test.ts`
Expected: FAIL (`carriedBodies` is not exported; the donor parameter is ignored).

- [ ] **Step 3: Implement**

- `src/repository/context.ts`: `carriedBodies` as in Interfaces (build a `Map` of the donor's entries by path to compare shas; keep complexity under 10). `contextAt(github, ref, baseSha, cached, donor)` returns `{ baseSha, tree, files: carriedBodies(entries, donor) }` for a new base; `loadRepositoryContext` gains the `donor?` parameter and passes it through.
- `src/pull-request.ts`: beside `cachedContext(baseSha)`, add `donorContext(baseSha)` that lists `context:` records, and when exactly one record other than the current base's parses with `StoredRepositoryContext`, returns it (several records, or none, give undefined). `loadedContext` passes `await this.donorContext(baseSha)` as the donor when `cached` is undefined. The existing sweep in `cacheContext` still deletes the donor once the new record is written.
- `docs/design.md`: replace the #80 caveat ("a new base replaces the record, so a base move loads everything again, unchanged blobs included (#80)") with: "a new base starts from the one other record the object holds, carrying over every body whose blob sha the new listing still shows, so a base move loads only the changed and the missing bodies; with several leftover records it carries nothing."

- [ ] **Step 4: Run the checks**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repository/context.ts src/pull-request.ts test/context.test.ts docs/design.md
git commit -m "Carry a base's unchanged bodies over when the pull request's base moves, so only the changed and the missing bodies spend loads"
```

---

### Task 2: Log which skill a review activated (#100)

**Files:**
- Modify: `src/repository/skills.ts` (`withContentAsOutput`, `toolWithOutput`, `installCatalog` around lines 395-441)
- Modify: `src/pull-request.ts` (`configureReview` and `restoreCatalog`, their `installCatalog` calls; `runReview`'s reset of per-review counters; `logTranscript`)
- Modify: `docs/design.md` (the catalog paragraph in "Skills"; the `review.transcript` list)
- Test: `test/repository-skills.test.ts` (the "the output channel" describe around line 779 and the `installCatalog` describe)

**Interfaces:**
- Consumes: the SDK's `activate_skill` tool takes `{ name }` (its `parameters` schema is an object with `name` as a union of the listed skill names); `withOutputFromContent`'s generic argument shape (`Args extends ExecuteArgs`).
- Produces:

```ts
export type ReportActivation = (name: string) => void | Promise<void>
export const ACTIVATION_ARGS = Type.Object({ name: Type.String() })
export const withActivationReport = <Args extends ExecuteArgs>(execute: (...args: Args) => Promise<ToolExecutionResult | ContentOnlyResult>, report: ReportActivation) => async (...args: Args): Promise<ToolExecutionResult | ContentOnlyResult>
export function withContentAsOutput(extension: Extension, report: ReportActivation): Extension
export async function installCatalog(registry, installed, sources, build, report: ReportActivation): Promise<Extension | undefined>
```
  `withActivationReport` awaits `report(name)` when `Value.Check(ACTIVATION_ARGS, args[0])` holds, then runs `execute`; `withContentAsOutput` applies it to the tool named `activate_skill` only, inside the content wrapper. The object logs `skills.activated` with `{ number, head, name }` (`head` from the pending review when one exists) and appends the name to a per-review list that `review.transcript` logs as `activated` (space-separated, in call order, empty string when none), reset where `#refusedCalls` is reset.

- [ ] **Step 1: Write the failing tests** in `test/repository-skills.test.ts`:

```ts
it("reports the activated skill's name before running the activation, and reports nothing for a call without a name", async () => {
  const names: string[] = []
  const wrapped = withActivationReport(async () => ({ output: [] }), (name) => { names.push(name) })
  await wrapped({ name: "lint" })
  await wrapped({})
  expect(names).toEqual(["lint"])
})

it("wraps activate_skill with the activation report and leaves read_skill_resource with the content wrapper alone", () => {
  // withContentAsOutput(extension, report): both tools' execute differ from the originals; a direct call through
  // withActivationReport is the unit above; here assert names and that installCatalog threads the report (its build result's activate_skill is wrapped)
})
```

Adapt the existing `installCatalog` tests to the new fifth argument (`() => {}`).

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run test/repository-skills.test.ts`
Expected: FAIL (`withActivationReport` is not exported; arity).

- [ ] **Step 3: Implement**

- `src/repository/skills.ts` as in Interfaces; `toolWithOutput(tool, report)` applies `withActivationReport` when `tool.name === ACTIVATE_SKILL_TOOL` (import the constant from `src/review/prompt.ts`), always inside `withOutputFromContent`.
- `src/pull-request.ts`: a private `#activated: string[]` reset at the start of `runReview` beside `#refusedCalls`; a private `reportActivation(name)` that pushes the name and logs `skills.activated` `{ number: await this.storedNumber(), head: pending head short sha or undefined, name }`; both `installCatalog` calls pass it; `logTranscript` adds `activated: this.#activated.join(" ")`.
- `docs/design.md`: in the catalog paragraph, after the content-to-output sentence: "The same wrapper reports each `activate_skill` call's skill name, which the object logs as `skills.activated` with the pull request's number and the review's head, and `review.transcript` lists the names in call order under `activated`, so an activation that posts no finding can be told from an over-activation of another skill (#100)." Add `activated` to the `review.transcript` list near line 97.

- [ ] **Step 4: Run the checks**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repository/skills.ts src/pull-request.ts test/repository-skills.test.ts docs/design.md
git commit -m "Log which repository skill a review activated, per call and in the transcript"
```

---

### Task 3: Finish: pull request, deploy, one fixture run

- [ ] **Step 1: Pull request.** Push the branch; `gh pr create --base main` with a body that names both changes; it closes #80 and #100 by keyword.
- [ ] **Step 2: Live check on the branch build.** Announce a window; deploy the branch (default GLM); wait for the fixture's object to settle; `@andabot full review` on fixture #97; expect `skills.activated` events naming the skill(s) GLM activated and `review.transcript` carrying `activated`. Record on #2 and #100 (this also tells which skill GLM's earlier double activation was, if it repeats). The base-move carryover has no live check: its decision is unit-tested and the wiring is read in review. Redeploy plain main after; tell the peers the version.
- [ ] **Step 3: After Andrew merges**, deploy main, verify one `review.tools`/`review.transcript` on the new build, close the fixture pull request unmerged if one was opened.
