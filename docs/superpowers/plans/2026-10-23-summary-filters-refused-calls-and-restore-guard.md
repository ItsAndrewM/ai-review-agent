# Summary filters, refused calls and the restore guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three small follow-ups slice 3's final review left: the `summary` command applies `path_filters` (#78), a `submit_review` call the host refuses is logged (#83), and the context cache write and the catalog restore are tied to the review in flight (#79).

**Architecture:** Each fix is a small change in the Durable Object (`src/pull-request.ts`) with its decision in a pure module that `pnpm test` covers: the summary's file selection reuses `reviewableFiles`, the summary footer reuses the review's config note, the refusal log reuses `submitStanding`'s kinds, and `restoredCatalog` gains a guard argument. One live check on a fixture covers the summary's wiring; the design doc is the pin for the two wiring-only changes.

**Tech Stack:** TypeScript on Cloudflare Workers, Durable Objects, Pi Durable 1.3.0, TypeBox, vitest, oxlint/oxfmt.

**Spec:** issues #78, #83 and #79 on `ItsAndrewM/ai-review-agent`, and `docs/design.md` ("Commands and chat" for `summary`, "Skills" for the context cache and the restore, "Configuration" for `path_filters`).

## Global Constraints

- `CLAUDE.md`: no comments of any kind; no type assertions except `as const`; complexity at most 10 per function; no `unknown`/`object` parameters or returns, no `typeof`, no `vi.mock`; the reason for a thing lives in a name, a test title or `docs/design.md`.
- `pnpm check` (oxlint, `oxfmt --check`, both `tsc` configs, vitest) passes on every commit; `pnpm format` before committing.
- Log fields are strings, numbers, booleans or undefined (`LogFields` in `src/log.ts`); every new event or field is named in `docs/design.md`.
- Anything read from the repository comes from the pull request's base commit: the summary reads `.andabot.yaml` through `repositoryConfig(pr)`, never from the head.
- Tests against the Durable Object itself are out of scope (phase 2 of the design); object wiring is reviewed by reading and proven by the live check.

## Review Focus

- A `summary` on a repository whose `.andabot.yaml` is invalid or unreadable: the defaults apply and the comment's footer carries the same `_.andabot.yaml was ignored: …_` note a review shows (Task 1, `renderSummaryRun` test).
- `path_filters` that leave out every changed file: the summary writes nothing, replies that the filters leave nothing to summarize, and logs `summary.skip` with `reason: path_filters` (Task 1, `summaryReply` test).
- A `submit_review` call refused because the head moved: the event names both heads (Task 2, read in review).
- A restart while a review is pending whose `context:` record was swept by a replaced review at another base: the rebuild installs nothing and logs why, rather than the other base's catalog (Task 3, `restoredCatalog` test).
- A review replaced during its context load: it writes no `context:` record and sweeps none (Task 3, read in review).

---

### Task 1: The summary applies `path_filters` and carries the config note (#78)

**Files:**
- Modify: `src/pull-request.ts` (`runSummary`, `postSummary`, `startSummary` around lines 1497-1660)
- Modify: `src/review/render.ts` (`SummaryRunInput`, `renderSummaryRun` around lines 95-117)
- Modify: `src/review/summary.ts` (`SummaryOutcome`, `summaryReply`)
- Modify: `docs/design.md` (the `summary` paragraphs under "Commands and chat", the `path_filters` bullet under "Configuration"), `docs/setup.md` (the `reviews.path_filters` row, section 6)
- Test: `test/summary.test.ts`

**Interfaces:**
- Consumes: `reviewableFiles(files, patterns)` and `everyFileFiltered(files, patterns)` from `src/github/diff.ts`; `repositoryConfig(pr): Promise<ConfigRead>` (`ConfigRead` has `config`, `error`, `present`); `configStatus(read)` from `src/repository/config.ts`; `configNoteLines(error)` in `src/review/render.ts` (module-private today; keep it so and call it from `renderSummaryRun`).
- Produces: `SummaryRunInput.configError?: string | undefined`; `SummaryOutcome` gains `{ kind: "filtered" }`; `summary.posted` logs `files`, `filesFiltered` and `config`.

- [ ] **Step 1: Write the failing tests** in `test/summary.test.ts`:

```ts
it("ends with the config note when .andabot.yaml was ignored, so a summary says what the review would", () => {
  const text = renderSummaryRun({ ...RUN, configError: "invalid YAML: bad indent" })
  expect(text.endsWith("_.andabot.yaml was ignored: `invalid YAML: bad indent`; the defaults applied._")).toBe(true)
  expect(renderSummaryRun(RUN)).not.toContain("was ignored")
})

it("says the filters leave nothing to summarize", () => {
  expect(summaryReply({ kind: "filtered" }, "andabot")).toBe(
    "`path_filters` in `.andabot.yaml` leave out every changed file, so there's nothing to summarize.",
  )
})
```

Use the file's existing `SummaryRunInput` fixture for `RUN` (the describe `renderSummaryRun` builds one at line 223; reuse its name) and match the exact note format `configNoteLines` renders (`CONFIG_FILE` in a code span, the error in a code span, `; the defaults applied.`), checking the existing review test for the note's text.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run test/summary.test.ts`
Expected: FAIL (`configError` unknown; `filtered` not a `SummaryOutcome`).

- [ ] **Step 3: Implement**

- `src/review/summary.ts`: add `{ kind: "filtered" }` to `SummaryOutcome`; `summaryReply` returns the sentence above for it.
- `src/review/render.ts`: add `configError?: string | undefined` to `SummaryRunInput`; `renderSummaryRun` appends `...configNoteLines(input.configError)` after `commandsLine`, as `renderReview`'s footer does.
- `src/pull-request.ts`:
  - `runSummary(pr, run)`: read `const read = await this.repositoryConfig(pr)` and list the files, then `const files = reviewableFiles(all, read.config.reviews.path_filters)`. When `everyFileFiltered(all, read.config.reviews.path_filters)` (and `all.length > 0`), log `summary.skip` with `{ reason: "path_filters", head, number, config: configStatus(read) }` and return `{ kind: "filtered" }` before prompting. Pass `files` (the reviewable ones) to `askForSummary` and `postSummary`, and `read.error` to `postSummary`.
  - `postSummary` takes `configError: string | undefined` and passes it to `renderSummaryRun`; `summary.posted` logs `files: all.length`, `filesFiltered: all.length - files.length`, `config: configStatus(read)`.
  - Keep each function at complexity 10 or less; split `runSummary` by what it decides if needed (`summaryFiles(pr)` returning `{ read, all, files }` is one shape).
- `docs/design.md`: in the `summary` paragraph, "its whole diff, `path_filters` not yet applied (#78)" becomes "the diff the base's `path_filters` leave in, as a review's prompt has it"; say that filters leaving out every changed file make `summary` reply that nothing is left to summarize and log `summary.skip` with `path_filters`; say the footer carries the config note when the file was ignored; add `files`, `filesFiltered` and `config` to what `summary.posted` logs. In the `path_filters` bullet, say the summary applies them too.
- `docs/setup.md`: the `reviews.path_filters` row drops "`@andabot summary` still reads it (#78)" and says a summary applies them as a review does.

- [ ] **Step 4: Run the tests**

Run: `pnpm check`
Expected: PASS, with the two new tests green.

- [ ] **Step 5: Commit**

```bash
git add src/pull-request.ts src/review/render.ts src/review/summary.ts test/summary.test.ts docs/design.md docs/setup.md
git commit -m "Apply the base's path_filters to a summary, carry the config note in its footer, and say when they leave nothing to summarize"
```

---

### Task 2: Log a `submit_review` call the host refuses (#83)

**Files:**
- Modify: `src/pull-request.ts` (`submitReview` and `postReview`, lines 395-430)
- Modify: `docs/design.md` (the "Review pipeline" sentence that lists `review.findings`, `review.incomplete` and the submit loop's events; the "Logs" list if there is one)

**Interfaces:**
- Consumes: `submitStanding(...)` from `src/review/flight.ts` returning `{ kind: "post" | "no_review" | "not_in_flight" }`; `readPending()`, `pendingFor(deliveryId)`, `key()` on the object; `log` from `src/log.ts`; `shortSha`.
- Produces: the event `review.refused` with fields `number`, `reason` (`"no_review" | "not_in_flight" | "head_moved" | "posted_already"`), `head` (the pending review's head, short, when there is one), `delivery` (the pending review's delivery id, when there is one), and for `head_moved` also `was` and `now` (both short).

- [ ] **Step 1: No unit test.** The refusal paths live in the object, whose tests are out of scope; the design doc's sentence and the live check's logs are the pin. Say so in the report.

- [ ] **Step 2: Implement**

- In `submitReview`, when `standing.kind` is `no_review` or `not_in_flight`, log `review.refused` with `reason: standing.kind`, `number: (await this.key()).number`, and `head`/`delivery` from the pending record when one exists, before returning the refusal text.
- In `postReview`: a `pendingFor` miss logs `reason: "not_in_flight"`; a moved head logs `reason: "head_moved"` with `was: shortSha(pending.headSha)` and `now: shortSha(pr.head.sha)`; an already posted head logs `reason: "posted_already"` with `head`.
- One small private method `logRefusal(reason, pending, extra?)` keeps the four call sites to one line each; keep complexity at 10 or less.
- `docs/design.md`: add one sentence beside the submit loop's events: "A call the host refuses before validating it, because no review is pending, the caller isn't the review in flight, the head moved or the head is already posted, logs `review.refused` with the reason, and for a moved head both heads, so a transcript with two `submit_review` calls and one `review.findings` can be explained afterwards (#83)."

- [ ] **Step 3: Run the checks**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/pull-request.ts docs/design.md
git commit -m "Log a submit_review call the host refuses before validating it, with the reason and the heads"
```

---

### Task 3: Tie the context cache write and the catalog restore to the review in flight (#79)

**Files:**
- Modify: `src/pull-request.ts` (`repositoryContext` at line 802, `loadedContext` at 845, `restoreCatalog` at 883, the call in `runReview` at 917)
- Modify: `src/repository/skills.ts` (`restoredCatalog` at line 382, `ReportSkippedRestore`)
- Modify: `docs/design.md` (the "Skills" paragraph's restore sentence, which today carries the #79 caveat)
- Test: `test/repository-skills.test.ts` (the `restoredCatalog` describe around line 745)

**Interfaces:**
- Consumes: `ownsPending(deliveryId): Promise<boolean>`, `readPending(): Promise<PendingReview | undefined>` (`PendingReview.repoSkillsFingerprint` is the full fingerprint `repositoryRecord` stores, or undefined when no skill was offered or none is recorded yet); `repositorySkills(context)` whose `offered?.fingerprint` is the same full fingerprint.
- Produces:

```ts
export type RestoreGuard = { pending: false } | { pending: true; fingerprint: string | undefined }
export type ReportSkippedRestore = (records: number, reason: "records" | "fingerprint") => void
export async function restoredCatalog(
  builtin: SkillSource,
  contexts: readonly SkillContext[],
  records: number,
  guard: RestoreGuard,
  skipped: ReportSkippedRestore,
): Promise<readonly SkillSource[] | undefined>
```

- [ ] **Step 1: Write the failing tests** in `test/repository-skills.test.ts`, in the `restoredCatalog` describe (adapt `skipRecorder` to record `[records, reason]` pairs and the existing expectations to `reason: "records"`):

```ts
it("rebuilds the catalog while a review is pending only from the record whose fingerprint is the review's, so a resumed review never gets another base's skills", async () => {
  const { source } = await bundledSkills()
  const { report, skipped } = skipRecorder()
  const lint = await repositorySkills(LINT)
  const fingerprint = lint.offered?.fingerprint
  expect(fingerprint).toBeDefined()
  expect(await restoredCatalog(source, [LINT], 1, { pending: true, fingerprint }, report)).toHaveLength(2)
  expect(await restoredCatalog(source, [LINT], 1, { pending: true, fingerprint: "0".repeat(64) }, report)).toBeUndefined()
  expect(await restoredCatalog(source, [LINT], 1, { pending: true, fingerprint: undefined }, report)).toBeUndefined()
  expect(skipped).toEqual([[1, "fingerprint"], [1, "fingerprint"]])
})

it("rebuilds from the one record it holds when no review is pending, whatever its fingerprint", async () => {
  const { source } = await bundledSkills()
  const { report, skipped } = skipRecorder()
  expect(await restoredCatalog(source, [LINT], 1, { pending: false }, report)).toHaveLength(2)
  expect(skipped).toEqual([])
})
```

Check `LINT` is the existing one-skill context fixture of that describe and that the catalog it yields has two sources (built-in and repo); adjust the length to what `catalogFor` returns.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run test/repository-skills.test.ts`
Expected: FAIL (`restoredCatalog` takes four arguments).

- [ ] **Step 3: Implement**

- `src/repository/skills.ts`: `restoredCatalog` as in Interfaces. After choosing the single record, compute `offered = (await repositorySkills(context)).offered`; when `guard.pending` and `offered?.fingerprint !== guard.fingerprint`, call `skipped(records, "fingerprint")` and return undefined; otherwise return `catalogFor(builtin, offered)`. The records check calls `skipped(records, "records")`.
- `src/pull-request.ts`:
  - `restoreCatalog`: read `pending` and pass `pending === undefined ? { pending: false } : { pending: true, fingerprint: pending.repoSkillsFingerprint }`; the `skills.restore_skipped` log gains `reason`.
  - `loadedContext(number, baseSha, changed, deliveryId)` writes the record only when `await this.ownsPending(deliveryId)` still holds at that moment: `if (context !== undefined && context !== cached && (await this.ownsPending(deliveryId))) await this.cacheContext(context)`. Thread `run.deliveryId` from `runReview` through `repositoryContext(pr, files, pathInstructions, deliveryId)`; `runReview` is the only caller.
- `docs/design.md`: replace the #79 caveat in the "Skills" paragraph with the behavior: "The record is written only while its review still owns `pending`, so a review replaced during the load caches nothing and sweeps nothing. While a review is pending, the rebuild installs only a record whose fingerprint is the pending review's, and logs `skills.restore_skipped` with `reason: fingerprint` otherwise; with no review pending it rebuilds from the one record it holds. `skills.restore_skipped` carries `reason: records` when the count is wrong."

- [ ] **Step 4: Run the checks**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pull-request.ts src/repository/skills.ts test/repository-skills.test.ts docs/design.md
git commit -m "Write the context record only for the review that still owns pending, and restore the catalog only from the pending review's own record"
```

---

### Task 4: Finish: live check, pull request, deploy

- [ ] **Step 1: Plant the summary fixture.** Base branch `main-with-filters` from `main` adding `.andabot.yaml` with `reviews:\n  path_filters:\n    - "!docs/**"\n`; feature branch `chore/note-the-summary-filters-fixture` from it changing `docs/setup.md` (one added sentence) and `src/sha.ts` (one renamed local). Open a pull request against `main-with-filters` titled "Note the summary filters fixture", body "Two tiny edits for a fixture. Never merge." without closing keywords. Expected on the opening review: `review.start` with `files: 2`, `filesFiltered: 1`.
- [ ] **Step 2: Deploy and run the check.** Ask the peer sessions for a production window, deploy the branch from this worktree (`pnpm install --frozen-lockfile`, `pnpm check`, `pnpm run deploy`), wait for the object to settle, then comment `@andabot summary` on the fixture. Expected: the summary comment's walkthrough has the one `src/sha.ts` row, `summary.posted` logs `files: 2`, `filesFiltered: 1`, `config: file`. Then push a `.andabot.yaml` to `main-with-filters` with `path_filters: ["!**"]`, comment `@andabot summary` again: expected reply that the filters leave nothing to summarize and `summary.skip` with `path_filters`. Record both on #78. Close the fixture unmerged; delete both fixture branches.
- [ ] **Step 3: Pull request.** Push the branch; `gh pr create --base main` with a body that says what each task changed and closes #78, #83 and #79 by keyword. After Andrew merges: redeploy plain main with a window announced, verify `review.start` on the new build, and tell the peers the version.
