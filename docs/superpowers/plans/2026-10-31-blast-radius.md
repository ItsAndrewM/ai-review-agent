# Blast radius across a narrowing push (#124) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An incremental review's merge danger describes the push alone and shows in the Since section; the pull request's own door and blast radius keep the last whole judgement, escalating to one-way with the push's radius only when the push is one-way.

**Architecture:** One pure merge rule, `mergeDangerAfterPush`, replaces `stricterMergeDanger` in `src/review/incremental.ts`; `SinceSection` gains the push's `merge_danger`; `sinceLines` in `src/review/render.ts` prints it; the incremental prompt and the review skill tell the model to judge the new commits alone. No change to the object, the full review, `summary` or the stored PR-level field.

**Tech Stack:** TypeScript, TypeBox, vitest, oxlint with the repo's rules (no comments, no `as` but `as const`, complexity ≤ 10).

**Spec:** `docs/superpowers/specs/2026-10-29-reviews-that-hold-up-design.md`, section "Slice 5, #124".

## Global Constraints

- `pnpm check` passes after every task; `pnpm format` before each commit.
- No comments of any kind; no type assertions except `as const`; complexity ≤ 10.
- Stored records must still parse: `SinceSection.merge_danger` is `Type.Optional`.
- Copy fixed by the spec: the Since section line is `This push: <door> door · <blast radius>` (blast radius through `oneLine`), placed between the push's summary and the Files line; the prompt sentence is `Judge \`merge_danger\` for these commits alone, not for the whole pull request; the summary comment keeps the pull request's.`
- The review skill becomes `version: "11"` (main has 10 since #191).
- Work in `.claude/worktrees/blast-radius-GH-124`; never `cd` to the primary checkout.

## Review Focus

1. A `since` record stored before this slice (no `merge_danger`): the Since section renders without a push line (Task 2 test).
2. A retried publish re-running `nextReviewed` on a record it already escalated: one-way previous with a one-way push keeps the previous, so no radius flip (Task 1 test).
3. Two one-way doors with different radii: the stored radius stays (Task 1 test).
4. A fresh or full review: `merge_danger` stored and shown is the submission's, unchanged (Task 1 existing test keeps passing).
5. A `summary` after an incremental review: `summarizedRecord` drops `since`, so the push line disappears with it (existing behaviour; Task 2 test asserts the renderer takes the line only from `since`).

---

### Task 1: the merge rule and the record

**Files:**
- Modify: `src/review/incremental.ts` (`SinceSection`, `nextReviewed`, replace `stricterMergeDanger`)
- Test: `test/incremental.test.ts` (`stricterMergeDanger` block → `mergeDangerAfterPush`, `nextReviewed` block, `ReviewedRecord` block)

**Interfaces:**
- Produces: `export function mergeDangerAfterPush(previous: MergeDangerInput | undefined, push: MergeDangerInput): MergeDangerInput`; `SinceSection.merge_danger?: MergeDangerInput`; `nextReviewed` on an incremental review sets `merge_danger: mergeDangerAfterPush(previous.merge_danger, submission.merge_danger)` and `since.merge_danger: submission.merge_danger`.

- [ ] **Step 1: Write the failing tests**

Replace the `describe("stricterMergeDanger")` block (test/incremental.test.ts:776-795) with:

```ts
describe("mergeDangerAfterPush", () => {
  const later = { door: "two-way", blast_radius: "the cart page" } satisfies MergeDangerInput
  const laterOneWay = { door: "one-way", blast_radius: "the ledger" } satisfies MergeDangerInput
  it("keeps the stored judgement when both doors are two-way, whether the push narrows or widens the radius", () => {
    expect(mergeDangerAfterPush(twoWay, later)).toEqual(twoWay)
    expect(mergeDangerAfterPush(twoWay, { door: "two-way", blast_radius: "docs only" })).toEqual(twoWay)
  })
  it("keeps a one-way judgement across a two-way push and across another one-way push", () => {
    expect(mergeDangerAfterPush(oneWay, twoWay)).toEqual(oneWay)
    expect(mergeDangerAfterPush(oneWay, laterOneWay)).toEqual(oneWay)
  })
  it("escalates a two-way judgement to the push's one-way door and radius", () => {
    expect(mergeDangerAfterPush(twoWay, laterOneWay)).toEqual(laterOneWay)
  })
  it("takes the push's judgement when there is no previous one", () => {
    expect(mergeDangerAfterPush(undefined, twoWay)).toEqual(twoWay)
    expect(mergeDangerAfterPush(undefined, oneWay)).toEqual(oneWay)
  })
})
```

In the `nextReviewed` block: the test at line 890 expects `since` to carry `merge_danger: twoWay` (the submission's); add `it("keeps the stored blast radius and puts the push's own judgement in the since section when both doors are two-way")` with `pushed = { ...submission, merge_danger: { door: "two-way", blast_radius: "docs only" } }` expecting `merge_danger` to equal `twoWay` and `since?.merge_danger` to equal the push's; the test at line 911 ("takes the push's one-way door…") keeps passing. In the `ReviewedRecord` block: `since` with and without `merge_danger` parses, and `since.merge_danger: { door: "sideways" }` fails.

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run test/incremental.test.ts`; FAIL (`mergeDangerAfterPush` not exported).

- [ ] **Step 3: Implement**

`SinceSection` gains `merge_danger: Type.Optional(MergeDanger)`. `mergeDangerAfterPush`: `previous === undefined → push`; `previous.door === "two-way" && push.door === "one-way" → push`; else `previous`. `nextReviewed`'s incremental branch uses it and adds `merge_danger: submission.merge_danger` to `since`. Delete `stricterMergeDanger`.

- [ ] **Step 4: `pnpm check`** — PASS.

- [ ] **Step 5: Commit** — `git add src/review/incremental.ts test/incremental.test.ts && git commit -m "Keep the pull request's merge danger across a push, and store the push's own in the since section"`

---

### Task 2: the Since section's push line

**Files:**
- Modify: `src/review/render.ts` (`sinceLines`)
- Test: `test/findings.test.ts` (`renderSummaryComment` since tests at ~1084-1120)

**Interfaces:**
- Consumes: `SinceSection.merge_danger` from Task 1.

- [ ] **Step 1: Write the failing test**

In "adds a section for what changed since the last full review", pass `since: { …, merge_danger: { door: "two-way", blast_radius: "docs | only" } }` and expect

```
### Since `abc1234`

Fixed the total.

This push: two-way door · docs \| only.

Files: `a.ts`, `b.ts`. Resolved 1 thread(s).
```

Add `it("prints no push line for a since section stored before the push judged itself")` with the old `since` and `expect(text).not.toContain("This push:")`.

- [ ] **Step 2: Run to see it fail** — `pnpm vitest run test/findings.test.ts`; FAIL.

- [ ] **Step 3: Implement** — `sinceLines` inserts `"", \`This push: ${door} door · ${oneLine(blast_radius)}.\`` after the summary when `since.merge_danger` is set.

- [ ] **Step 4: `pnpm check`** — PASS.

- [ ] **Step 5: Commit** — `git add src/review/render.ts test/findings.test.ts && git commit -m "Show the push's own merge danger in the since section"`

---

### Task 3: the prompt, the skill and the design doc

**Files:**
- Modify: `src/review/prompt.ts:75` (the incremental request sentence)
- Modify: `skills/review/SKILL.md` (step 5, `version: "11"`)
- Modify: `docs/design.md` (the `reviewed` entry at line 68 and the summary-comment paragraph at line 189)
- Test: `test/prompt.test.ts`, `test/skills.test.ts:35`

- [ ] **Step 1: Write the failing tests**

`test/prompt.test.ts`: the incremental prompt `text` contains `Judge \`merge_danger\` for these commits alone, not for the whole pull request; the summary comment keeps the pull request's.` before the data block, and `fullPrompt`'s text does not contain `for these commits alone`. `test/skills.test.ts:35` → `"11"`.

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run test/prompt.test.ts test/skills.test.ts`; FAIL.

- [ ] **Step 3: Implement**

- `prompt.ts`: append the sentence to the incremental request line, after `${MATERIAL_NOTE}`.
- `SKILL.md` step 5, after "which the host prints above the summary.": `In an incremental review, \`merge_danger\` judges the new commits alone; the host keeps the pull request's judgement from the last full review or \`summary\`, and shows yours in the Since section.` Version `"11"`.
- `docs/design.md` line 68: replace "and the merge danger the summary shows, which an incremental review updates to the stricter door" with "and the merge danger the summary shows for the whole pull request, which an incremental review keeps, escalating it to one-way with the push's blast radius when the push is one-way, while `since` carries the push's own judgement". Line 189: replace the two "stricter door" sentences with: "The merge danger under the verdict is the pull request's, from the last full review or `summary`: a push's judgement describes the new commits alone and is shown in the Since section as "This push: two-way door · docs only."; the pull request's line changes only when a one-way push escalates a two-way door, and then it takes the push's radius (#124)."

- [ ] **Step 4: `pnpm check` and `pnpm format`** — PASS.

- [ ] **Step 5: Commit** — `git add src/review/prompt.ts skills/review/SKILL.md docs/design.md test/prompt.test.ts test/skills.test.ts && git commit -m "Ask an incremental review to judge the push alone, and describe the kept merge danger"`
