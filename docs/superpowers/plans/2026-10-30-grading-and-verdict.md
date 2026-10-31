# Grading and the host-derived verdict (#121, #122) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give findings a fourth grade (`major`) with host-enforced basis pairings and a check that a `standard` basis names something real, and let the host derive the review's event from the findings and from structured reasons not to approve, shown as "Approval withheld".

**Architecture:** The grade and basis rules are pure functions in a new `src/review/basis.ts` that `validateFindings` and verify's `decide` share. The reasons are a new `src/review/reasons.ts` (types, the host's checks, the budget reason); `decideReviewVerdict` in `render.ts` replaces `chooseReviewEvent` and takes the reasons; `approval.ts` records the reasons count so re-evaluation never lifts a withheld review; the object wires the pieces in `publishReview`, `checkSubmission` and the incremental prompt. The skill, `severity.md`, the tool description and `docs/design.md` change last.

**Tech Stack:** TypeScript, TypeBox (`typebox` and `@earendil-works/pi-ai`'s `Type`), vitest, oxlint with the repo's rules (no comments, no `as` but `as const`, complexity ≤ 10, no `typeof`, no `vi.mock`).

**Spec:** `docs/superpowers/specs/2026-10-29-reviews-that-hold-up-design.md`, section "Slice 4, #121 and #122".

## Global Constraints

- `pnpm check` passes after every task (lint, typecheck, tests); `pnpm format` before each commit.
- No comments of any kind in source or tests; put the why in a name or a test title.
- No type assertions except `as const`; parse stored JSON and model output with TypeBox and `Value.Check`.
- Function complexity at most 10; split by what a function decides.
- Copy fixed by the spec, verbatim: `SEVERITY_LABEL.major` = `🟠 Major`; `VERDICT_LABEL.WITHHELD` = `Approval withheld`; the reasons heading `Not approved because:`; the review-stands note `Approval waits for my next review, since my last one withheld it; its body says why.`
- Stored records already in Durable Object storage must still parse: every new record field is `Type.Optional`.
- The review skill becomes `version: "10"`; the verify skill `version: "2"`.
- Work in the worktree `.claude/worktrees/grading-verdict-GH-121`; never `cd` to the primary checkout.

## Review Focus

1. A `standard` basis for a `path_instructions` entry (listed as `.andabot.yaml: <glob>` in `instructionFiles`): the basis names `.andabot.yaml` and must pass (Task 3 test).
2. A `not_for_merging` quote that matches the title, not the body, with different whitespace or case: it must pass (Task 4 test).
3. An old `last_review` record with `verdict: "approve"`, `shown: "COMMENT"` (threads were unknown) and no `withheld`: `awaitsApproval` must still be true (Task 5 test).
4. A request-changes review that also carries a reason: `awaitsApproval` false, so resolving the threads doesn't approve (Task 5 test).
5. A stored `SeverityCounts` without `major` from before this slice: `checkRunTitle` and the status line must render it (Task 1 tests).

---

### Task 1: the `major` grade in the schema, counts, labels and copy

**Files:**
- Modify: `src/review/findings.ts` (`Severity`, `SEVERITY_LABEL`, `countBySeverity`)
- Modify: `src/records.ts:17-23` (`SeverityCounts`)
- Modify: `src/review/render.ts` (`statusLine`, `countsLine`)
- Modify: `src/review/check.ts:84-91` (`checkRunTitle`)
- Modify: `src/review/incremental.ts:250-255` (`severityOfComment`)
- Test: `test/findings.test.ts`, `test/check.test.ts`, `test/incremental.test.ts`, `test/records.test.ts`

**Interfaces:**
- Produces: `Severity` union `blocking | major | suggestion | nitpick`; `SEVERITY_LABEL.major = "🟠 Major"`; `countBySeverity` returns `{ blocking, major, suggestion, nitpick }`; `SeverityCounts.major` optional in the schema; `checkRunTitle(event, counts: SeverityCounts)` and `statusLine` read `counts.major ?? 0`.

- [ ] **Step 1: Write the failing tests**

In `test/findings.test.ts`:

```ts
it("accepts major as a severity and no fifth grade", () => {
  expect(Value.Check(ReviewSubmission, { ...base, findings: [finding({ severity: "major" })] })).toBe(true)
  expect(Value.Check(ReviewSubmission, { ...base, findings: [finding({ severity: "critical" })] })).toBe(false)
})
it("labels a major finding 🟠 Major", () => {
  expect(toReviewComment(finding({ severity: "major" })).body).toMatch(/^\*\*🟠 Major: b changed\*\*/)
})
it("counts major findings", () => {
  expect(countBySeverity([finding({ severity: "major" }), finding({ severity: "nitpick" })])).toEqual({ blocking: 0, major: 1, suggestion: 0, nitpick: 1 })
})
```

In the `renderSummaryComment` block: the status line reads `· 🔴 1 blocking · 🟠 1 major · 🟡 0 suggestions · ⚪ 0 nitpicks`. In the `renderReviewBody` block: with one blocking and one major finding the counts line is `1 blocking finding(s) to address before approval, 1 major finding(s) worth fixing. Blocking findings are marked 🔴 and gate approval; the others don't.`

In `test/check.test.ts`: `checkRunTitle("REQUEST_CHANGES", { blocking: 1, major: 2, suggestion: 0, nitpick: 0 })` is `Changes requested: 1 blocking, 2 major`; and a stored count without `major` (`{ blocking: 0, suggestion: 1, nitpick: 0 }`) titles `Commented: 1 suggestion`.

In `test/incremental.test.ts`: a thread whose first comment starts `**🟠 Major: t**` lists as not blocking with severity major (through the existing `threadPlan`/`openBotThreads` path the file already tests for `nitpick`).

In `test/records.test.ts`: `SeverityCounts` accepts a record without `major` and one with it.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run test/findings.test.ts test/check.test.ts test/incremental.test.ts test/records.test.ts`
Expected: FAIL on the new tests (type errors count as failures under `pnpm check`; vitest will fail on the assertions).

- [ ] **Step 3: Implement**

- `Severity` gains `Type.Literal("major")` between blocking and suggestion. `SEVERITY_LABEL.major = "🟠 Major"`. `countBySeverity` starts from `{ blocking: 0, major: 0, suggestion: 0, nitpick: 0 }`.
- `SeverityCounts`: add `major: Type.Optional(Type.Integer())`.
- `statusLine`: `· 🔴 ${b} blocking · 🟠 ${counts.major ?? 0} major · 🟡 ${s} suggestions · ⚪ ${n} nitpicks`.
- `countsLine`: push `${counts.major} major finding(s) worth fixing` after blocking; the closing sentence becomes `Blocking findings are marked 🔴 and gate approval; the others don't.`
- `checkRunTitle(event: Verdict, counts: SeverityCounts)`: add `counted(major, "major")` after blocking, reading `counts.major ?? 0`; `counted(1, "major")` must give `1 major` (check `counted`'s pluralisation; `major` takes no `s`, so pass the noun as the title does for `blocking`).
- `severityOfComment`: `if (label === SEVERITY_LABEL.major) return "major"`.
- Fix the one existing test that pins the old closing sentence `the others are optional`.

- [ ] **Step 4: Run the tests, then `pnpm check`**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src test && git commit -m "Add the major grade: schema, labels, counts and the check-run title"
```

---

### Task 2: the basis pairings, shared with verify

**Files:**
- Create: `src/review/basis.ts`
- Modify: `src/review/findings.ts` (`basisProblem`, remove `exceedsBasisCap`)
- Modify: `src/review/verify.ts:162-169` (`decide`)
- Modify: `tools/verify-replay/score.ts:24`
- Modify: `skills/verify/SKILL.md` (step 4, version 2)
- Test: `test/basis.test.ts` (new), `test/findings.test.ts` (`basis` block), `test/verify.test.ts` (`applyVerdicts`)

**Interfaces:**
- Produces: `pairingProblem(finding: Pick<FindingInput, "basis_kind" | "severity">): string | undefined` in `basis.ts`. Returns `undefined` for blocking/major × defect/spec and suggestion/nitpick × standard/test; the standard/test text: `a standard or test finding cannot be blocking or major; grade it suggestion or nitpick, or give it the defect or spec basis it rests on`; the defect/spec text: `a defect or spec finding is blocking or major, since its basis says the code fails; if the code works as it stands, give it the standard or test basis it rests on`.

- [ ] **Step 1: Write the failing tests**

`test/basis.test.ts`:

```ts
describe("pairingProblem", () => {
  it("allows defect and spec at blocking or major, standard and test at suggestion or nitpick", () => {
    for (const basis_kind of ["defect", "spec"] as const)
      for (const severity of ["blocking", "major"] as const) expect(pairingProblem({ basis_kind, severity })).toBeUndefined()
    for (const basis_kind of ["standard", "test"] as const)
      for (const severity of ["suggestion", "nitpick"] as const) expect(pairingProblem({ basis_kind, severity })).toBeUndefined()
  })
  it("refuses a defect or spec finding graded suggestion or nitpick", () => { /* 4 pairs, toMatch(/is blocking or major/) */ })
  it("refuses a standard or test finding graded blocking or major", () => { /* 4 pairs, toMatch(/cannot be blocking or major/) */ })
})
```

In `test/findings.test.ts` (`basis` block): `validateFindings` rejects `finding({ basis_kind: "defect", severity: "nitpick" })` as `unfounded: true` with the defect text, and still accepts a `major` defect. In `test/verify.test.ts`: a verdict raising a `standard` suggestion to `major` lands in `report.capped` and the finding keeps `suggestion`; one lowering a `defect` blocking to `suggestion` lands in `capped` too.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run test/basis.test.ts test/findings.test.ts test/verify.test.ts`
Expected: FAIL (`pairingProblem` not exported).

- [ ] **Step 3: Implement**

- `basis.ts`: `pairingProblem` as above, with `const BLOCKS = new Set(["blocking", "major"])` and the two texts as constants.
- `findings.ts`: `basisProblem` calls `pairingProblem` where it called `exceedsBasisCap`; delete `exceedsBasisCap`.
- `verify.ts` `decide`: `pairingProblem(revised) !== undefined ? { kind: "capped", reason } : { kind: "changed", ... }`.
- `tools/verify-replay/score.ts:24`: same substitution.
- `skills/verify/SKILL.md` step 4: `Grade a finding you keep by references/severity.md, below. A standard or test finding can't be blocking or major, and a defect or spec finding can't be a suggestion or a nitpick: the host keeps it at its draft severity if you say so.` Version `"2"`.

- [ ] **Step 4: `pnpm check`** — PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src tools skills test && git commit -m "Pair basis and grade both ways, in validation and in verify"
```

---

### Task 3: a `standard` basis must name a standards file, a smell or an activated skill

**Files:**
- Modify: `src/review/basis.ts` (`SMELLS`, `StandardSources`, `standardBasisProblem`)
- Modify: `src/review/findings.ts` (`validateFindings` signature, `checkFinding`, `basisProblem`)
- Modify: `src/review/flight.ts:9-24` (`StoredPending.activated`)
- Modify: `src/pull-request.ts` (`reportActivation` ~1641, `checkSubmission` ~930)
- Test: `test/basis.test.ts`, `test/findings.test.ts`, `test/flight.test.ts`

**Interfaces:**
- Produces: `export const SMELLS: readonly string[]` (the twelve `- **Name**:` bullets of `skills/review/references/smells.md`); `export interface BasisContext { hasLinkedIssues: boolean; instructionFiles: readonly string[]; activatedSkills: readonly string[] }`; `standardBasisProblem(basis: string, context: BasisContext): string | undefined`; `validateFindings(findings, commentable, context: BasisContext, knownChecks = new Map())` (the third parameter changes from `boolean` to `BasisContext`).
- Consumes: `pairingProblem` from Task 2.

- [ ] **Step 1: Write the failing tests**

`test/basis.test.ts`:

```ts
describe("SMELLS", () => {
  it("names every smell bullet of references/smells.md and nothing else", () => {
    const text = readFileSync(new URL("../skills/review/references/smells.md", import.meta.url), "utf8")
    const bullets = [...text.matchAll(/^- \*\*([^*]+)\*\*:/gm)].map((m) => m[1])
    expect([...SMELLS]).toEqual(bullets)
  })
})
describe("standardBasisProblem", () => {
  const context = { hasLinkedIssues: false, instructionFiles: ["CLAUDE.md", ".github/instructions/lint.instructions.md", ".andabot.yaml: src/**"], activatedSkills: [] }
  it("passes a basis naming a standards file by path or basename, in any case", ...)   // "CLAUDE.md: no comments", "lint.instructions.md says", "claude.md"
  it("passes a path_instructions standard named by the config file", ...)              // ".andabot.yaml: src/** forbids default exports"
  it("passes a smell by name in any case", ...)                                        // "possible feature envy"
  it("passes an activated skill's name, and SKILL.md once a skill was activated", ...) // activatedSkills: ["react-conventions"]
  it("refuses SKILL.md when no skill was activated, and a file that isn't a standards file", ...) // "docs/design.md says", "src/pull-request.ts" → toMatch(/must name a repository standards file \(CLAUDE.md, .github\/instructions\/lint.instructions.md\)/) and /repository skill this review activated \(none was\)/
  it("offers only the smells when there are no standards files and no activation", ...) // text names "references/smells.md", no file list
})
```

`test/findings.test.ts`: replace every `validateFindings(..., true|false, ...)` call with a context (a helper `context(overrides)` returning `{ hasLinkedIssues: true, instructionFiles: ["CLAUDE.md"], activatedSkills: [] }`); add: a `standard` finding whose basis is `src/pull-request.ts: trusts the scope` is rejected `unfounded: true`; one with `CLAUDE.md: no comments of any kind` is accepted.

`test/flight.test.ts`: `StoredPending` accepts `activated: ["react-conventions"]` and a record without it.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run test/basis.test.ts test/findings.test.ts test/flight.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `SMELLS` as a literal array (`as const` is allowed) matching the markdown.
- `standardBasisProblem`: lower-case the basis once; pass when it includes any of: each instruction file lower-cased, its basename (`path.split("/").at(-1)`), and for an entry of the form `.andabot.yaml: <glob>` the text before the colon; each smell lower-cased; each activated skill name lower-cased; `skill.md` when `activatedSkills.length > 0`. Otherwise return the refusal: `a standard finding must name a repository standards file (${files or "none is listed"}), a smell from references/smells.md, or a repository skill this review activated (${names or "none was"}); if the code is wrong on its own terms, make it a defect with its failure scenario`. Keep it under complexity 10 by splitting `namesStandardsFile`, `namesSmell`, `namesSkill`.
- `findings.ts`: `basisProblem(finding, context)` adds `if (finding.basis_kind === "standard") return standardBasisProblem(finding.basis, context)` after the pairing check and before the spec check (which reads `context.hasLinkedIssues`). Thread `context` through `checkFinding` and `validateFindings`.
- `flight.ts`: `activated: Type.Optional(Type.Array(Type.String()))` on `StoredPending`.
- `pull-request.ts` `reportActivation`: after the log, read `pending`; when present, `put("pending", { ...pending, activated: [...(pending.activated ?? []), name] })`; skip when there is no pending (a question's activation).
- `checkSubmission`: build `{ hasLinkedIssues, instructionFiles: pending.instructionFiles ?? [], activatedSkills: pending.activated ?? [] }` and pass it.

- [ ] **Step 4: `pnpm check`** — PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src test && git commit -m "Refuse a standard basis that names no standards file, smell or activated skill"
```

---

### Task 4: the submission's reasons, and the model's verdict goes

**Files:**
- Create: `src/review/reasons.ts`
- Modify: `src/review/findings.ts` (`ReviewSubmission`: drop `verdict`, add `omitted_requirements`, `not_for_merging`; export `OmittedRequirement`)
- Modify: `src/review/tools.ts:195-199` (description)
- Modify: `src/review/prompt.ts:185-206` (`problemsText` gains reasons)
- Test: `test/reasons.test.ts` (new), `test/findings.test.ts`, `test/prompt.test.ts`, and every test fixture that sets `verdict:` on a submission (`test/findings.test.ts`, `test/incremental.test.ts`, `test/verify.test.ts`, `test/summary.test.ts`; the `LastReview` fixtures in `test/approval.test.ts` keep theirs, that field stays)

**Interfaces:**
- Produces, in `reasons.ts`:

```ts
export const OmittedRequirement = Type.Object({ issue: Type.Integer(), requirement: Type.String({ minLength: 1 }) })
export type OmittedRequirementInput = Static<typeof OmittedRequirement>
export type ApprovalReason =
  | { kind: "omitted_requirement"; issue: number; requirement: string }
  | { kind: "not_for_merging"; quote: string }
  | { kind: "budget_cut"; budget: number }
export interface ReasonSources { linkedIssues: readonly number[]; title: string; body: string | null | undefined }
export interface CheckedReasons { accepted: ApprovalReason[]; rejected: string[] }
export function checkReasons(submission: Pick<ReviewSubmissionInput, "omitted_requirements" | "not_for_merging">, sources: ReasonSources): CheckedReasons
export function budgetReason(budgetBlocked: number, budget: number): ApprovalReason | undefined
export function omittedIn(reasons: readonly ApprovalReason[]): OmittedRequirementInput[]
```

- `ReviewSubmission`: `omitted_requirements: Type.Optional(Type.Array(OmittedRequirement, { description: "Each requirement of a linked issue the diff leaves out, in the issue's words, with the issue's number; [] when none." }))`, `not_for_merging: Type.Optional(Type.String({ minLength: 1, description: "A line from the title or description that asks not to merge this pull request yet, quoted exactly; omit when there is none." }))`; no `verdict`.
- `problemsText(rejected, missing, reasons: readonly string[] = [])` renders a third part headed `Reasons the host couldn't check:` with one `- ` line each.

- [ ] **Step 1: Write the failing tests**

`test/reasons.test.ts`:

```ts
const sources = { linkedIssues: [121, 122], title: "Not for merging: spike", body: "Do not merge\nuntil #120 lands." }
it("accepts an omitted requirement of a linked issue", ...)                  // → accepted [{kind:"omitted_requirement", issue:121, requirement:"..."}]
it("rejects an omitted requirement of an issue that isn't linked, naming the linked ones", ...) // rejected[0] toMatch(/#7 isn't a linked issue \(linked: #121, #122\)/)
it("rejects every omitted requirement when no issue is linked", ...)         // /no issue is linked/
it("accepts a not_for_merging line found in the body or the title, whatever the whitespace or case", ...) // "do  not merge" and "NOT FOR MERGING: spike"
it("rejects a not_for_merging line found in neither", ...)                   // /not found in the title or description/
it("reads an absent omitted_requirements as none", ...)
it("adds a budget reason only when a tool call was blocked", () => {
  expect(budgetReason(0, 10_000)).toBeUndefined()
  expect(budgetReason(2, 10_000)).toEqual({ kind: "budget_cut", budget: 10_000 })
})
```

`test/findings.test.ts`: `ReviewSubmission` no longer accepts `verdict` only when `additionalProperties` forbids it; it doesn't, so instead assert `Value.Check` passes with `omitted_requirements: [{ issue: 1, requirement: "r" }]` and fails with `{ issue: 1 }`. Remove `verdict` from `base`. `parseWrittenReview` of a JSON text without `omitted_requirements` is still `submission`.

`test/prompt.test.ts`: `problemsText([], [], ["omitted requirement for #7: …"])` contains `Reasons the host couldn't check:\n- omitted requirement for #7`.

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run test/reasons.test.ts test/findings.test.ts test/prompt.test.ts`; FAIL (typecheck too: `verdict` fixtures).

- [ ] **Step 3: Implement**

- `checkReasons`: for each `omitted_requirements` entry, accept when `sources.linkedIssues.includes(issue)`; reject with `omitted requirement for #${issue}: no issue is linked to this pull request, so nothing can be omitted; drop omitted_requirements` when `linkedIssues` is empty, else `omitted requirement for #${issue}: #${issue} isn't a linked issue (linked: ${linked.map(n => "#"+n).join(", ")}); name the linked issue or drop it`. For `not_for_merging`: accept when `comparableText(title).toLowerCase()` or `comparableText(body ?? "").toLowerCase()` includes `comparableText(quote).toLowerCase()`; else reject with `not_for_merging "${quote}": not found in the title or description; quote a line from them exactly, or omit it`.
- Remove `verdict` from `ReviewSubmission`; `SummarySubmission` is unchanged.
- Tool description: `Submit the review: summary, per-file walkthrough, findings anchored to diff lines, the linked-issue requirements the diff leaves out, and a not-for-merging line when the title or description has one. The host validates every finding, decides the event from the findings and those reasons, and posts the review to GitHub. Call it once; rejected findings, reasons it couldn't check and missing walkthrough rows come back once, so correct them and call it again. A second submission with walkthrough rows still missing ends the review unposted.`
- Remove `verdict:` from every test submission fixture.
- Dropping `verdict` breaks `chooseReviewEvent`, `verdictAfterVerify` and their callers in `pull-request.ts`, which Tasks 5 and 6 replace. Run this task's tests alone (`pnpm vitest run test/reasons.test.ts test/prompt.test.ts`), then go straight on to Task 5; `pnpm check` and the commit come at the end of Task 6, covering Tasks 4 to 6 in one commit.

- [ ] **Step 4: Run this task's tests** — `pnpm vitest run test/reasons.test.ts test/prompt.test.ts`; PASS. Then Task 5.

---

### Task 5: the host derives the verdict; a withheld review stays withheld

**Files:**
- Modify: `src/review/render.ts` (`Verdict`, `VERDICT_LABEL`, `reviewEventOf`, replace `chooseReviewEvent` with `decideReviewVerdict`, `renderReviewBody` reasons block, `noFindings`)
- Modify: `src/review/approval.ts` (`LastReview.withheld`, `ReviewFacts`, `lastReviewOf`, `awaitsApproval`, `evaluatesAfterReview`, `verdictAfterChecks`)
- Modify: `src/review/resolve.ts` (`approvalNote`, `reviewStandsNote`)
- Modify: `src/review/summary.ts:101-103` (`approvedByEvaluation`)
- Modify: `src/review/verify.ts` (remove `verdictAfterVerify`, `Verified.verdict`, `verifiedReview`'s third parameter)
- Test: `test/findings.test.ts` (`chooseReviewEvent` → `decideReviewVerdict`, `renderReviewBody`), `test/approval.test.ts`, `test/resolve.test.ts`, `test/summary.test.ts`, `test/verify.test.ts` (`verdictAfterVerify` block goes)

**Interfaces:**
- Produces:

```ts
export type Verdict = ReviewEvent | "AWAITING_CHECKS" | "WITHHELD"
export interface ReviewDecisionInput {
  accepted: readonly FindingInput[]; rejected: readonly Rejected[]; workflow: boolean
  openBlocking: number | "unknown"; reasons: readonly ApprovalReason[]
}
export function decideReviewVerdict(input: ReviewDecisionInput): Verdict
export function renderReviewBody(event: Verdict, accepted, rejected, coverage?: Coverage, reasons: readonly ApprovalReason[] = []): string
// approval.ts
LastReview.withheld: Type.Optional(Type.Integer())
ReviewFacts.withheld: number            // replaces ReviewFacts.verdict
export function awaitsApproval(last: LastReview): boolean
export function evaluatesAfterReview(last: LastReview, accepted: readonly FindingInput[]): boolean
export function verdictAfterChecks(verdict: Verdict, checks: ChecksState | undefined): Verdict
// resolve.ts
export function approvalNote(outcome: ApprovalOutcome, last: Pick<LastReview, "heldBack" | "withheld"> | undefined, botLogin: string): string | undefined
```

- [ ] **Step 1: Write the failing tests**

`test/findings.test.ts`, replacing the `chooseReviewEvent` block:

```ts
describe("decideReviewVerdict", () => {
  const decide = (over: Partial<ReviewDecisionInput>) => decideReviewVerdict({ accepted: [], rejected: [], workflow: true, openBlocking: 0, reasons: [], ...over })
  it("approves nitpicks and suggestions, to wait for the checks", () => expect(decide({ accepted: [finding({ severity: "nitpick" }), finding({ severity: "major", line: 3, quote: "export { a, b };" })] })).toBe("APPROVE"))
  it("requests changes on a blocking finding, posted or held back, or an open blocking thread", ...)   // three cases → "REQUEST_CHANGES"
  it("withholds approval for an omitted requirement, a not-for-merging line or a budget cut", ...)    // each alone → "WITHHELD"
  it("requests changes over a reason when a blocking finding is there too", ...)
  it("waits for the checks when the threads couldn't be read", () => expect(decide({ openBlocking: "unknown" })).toBe("AWAITING_CHECKS"))
  it("comments when the workflow is off, whatever else holds", ...)
})
```

`renderReviewBody`: with `reasons` of all three kinds and no findings the body is

```
No findings. Approval is withheld for the reasons below; a human review is still required to merge.

Not approved because:
- #121 asks for “Unit tests cover the basis check”, and the diff leaves it out.
- The description says “Not for merging”.
- The review stopped reading early at its budget of 10,000 neurons; ask for a `full review` to review it in full.
```

and with a blocking finding plus a reason the block follows the counts line and precedes the held-back list. `VERDICT_LABEL.WITHHELD` is `Approval withheld`; `reviewEventOf("WITHHELD")` is `COMMENT`.

`test/approval.test.ts`: `awaitsApproval` — `{ event: "REQUEST_CHANGES", withheld: 1 }` false; `{ event: "COMMENT", shown: "WITHHELD" }` false; `{ event: "COMMENT", shown: "AWAITING_CHECKS" }` true; the old record `{ event: "COMMENT", shown: "COMMENT", verdict: "approve" }` true; `{ event: "COMMENT", verdict: "comment" }` false. `evaluatesAfterReview(record, accepted)`: true for an awaiting record with no blocking finding; false for a withheld record, for an approval, and for a request-changes record whose `accepted` holds a blocking finding. `lastReviewOf` carries `withheld`. `LastReview` parses a record with `withheld` and without.

`test/resolve.test.ts`: `approvalNote({ kind: "wait", reason: "review_stands" }, { heldBack: 0, withheld: 2 }, "andabot")` is `Approval waits for my next review, since my last one withheld it; its body says why.`; with `heldBack: 1` the held-back text wins.

`test/summary.test.ts`: a `last_review` with `event: "APPROVE", shown: "APPROVE"` (a review's own approval) is labelled `Approved`, not `Approved at`; the evaluation's record (no `shown`, no `verdict`) is `Approved at <sha>`.

`test/verify.test.ts`: delete the `verdictAfterVerify` block; `verifiedReview(draft, verdicts)` takes two arguments and its result has no `verdict`.

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run test/findings.test.ts test/approval.test.ts test/resolve.test.ts test/summary.test.ts test/verify.test.ts`; FAIL.

- [ ] **Step 3: Implement**

- `decideReviewVerdict`, in order: `!workflow → COMMENT`; `holdsBlocking || openBlocking > 0 → REQUEST_CHANGES` (treat `"unknown"` after blocking: `openBlocking === "unknown" → AWAITING_CHECKS`); `reasons.length > 0 → WITHHELD`; else `APPROVE`. Delete `chooseReviewEvent`.
- `renderReviewBody`: `findingsLines` then `reasonLines(reasons)` (heading + bullets, with the three texts above; the budget bullet formats `budget.toLocaleString("en-US")` and `neuron`/`neurons`), then the held-back list, then coverage. `noFindings("WITHHELD")` = `No findings. Approval is withheld for the reasons below; a human review is still required to merge.`
- `approval.ts`: `awaitsApproval`: `if (last.heldBack > 0 || (last.withheld ?? 0) > 0) return false; if (last.event === "REQUEST_CHANGES") return true; return last.event === "COMMENT" && (last.shown === "AWAITING_CHECKS" || last.verdict === "approve")`. `evaluatesAfterReview(last, accepted)` = `awaitsApproval(last) && countBySeverity(accepted).blocking === 0`. `verdictAfterChecks(verdict: Verdict, checks)`.
- `resolve.ts`: `reviewStandsNote(last)`: held back first, then withheld, then the existing comment text.
- `summary.ts`: `approvedByEvaluation(last) = last.event === "APPROVE" && last.shown === undefined && last.verdict === undefined`.
- `verify.ts`: remove `verdictAfterVerify`; `Verified` loses `verdict`; `verifiedReview(draft, verdicts)`.

- [ ] **Step 4: Run this task's tests** — `pnpm vitest run test/findings.test.ts test/approval.test.ts test/resolve.test.ts test/summary.test.ts test/verify.test.ts`; PASS. Then Task 6, whose commit covers Tasks 4 to 6.

---

### Task 6: wire the object: reasons, the record, and the incremental prompt

**Files:**
- Modify: `src/pull-request.ts` (`Publication`, `checkSubmission`, `submitReview`, `verifyAndPublish`, `verify`, `publishReview`, `reviewVerdict`, `approvalNote` caller ~2326, `promptFor` ~2959 and its caller ~1690)
- Modify: `src/review/incremental.ts` (`ReviewedRecord.omitted`, `NextReviewedInput.omitted`, `nextReviewed`)
- Modify: `src/review/prompt.ts` (`IncrementalPromptInput.omitted`, a `## Reasons to re-check` section)
- Test: `test/incremental.test.ts` (`nextReviewed`, `ReviewedRecord`), `test/prompt.test.ts`

**Interfaces:**
- Consumes: `checkReasons`, `budgetReason`, `omittedIn`, `decideReviewVerdict`, `lastReviewOf` with `withheld`, `evaluatesAfterReview(last, accepted)`, `approvalNote(outcome, last, botLogin)`.
- Produces: `ReviewedRecord.omitted: Type.Optional(Type.Array(OmittedRequirement))`; `IncrementalPromptInput.omitted: readonly OmittedRequirementInput[]`; `CheckedSubmission.reasons: CheckedReasons`.

- [ ] **Step 1: Write the failing tests**

`test/incremental.test.ts`: `nextReviewed` keeps the `omitted` list passed for this review on a full and on an incremental review; `ReviewedRecord` parses with and without `omitted`.

`test/prompt.test.ts`: `incrementalPrompt` with `omitted: [{ issue: 121, requirement: "Unit tests cover the basis check" }]` contains

```
## Reasons to re-check
- #121: Unit tests cover the basis check
List each again in omitted_requirements unless the new commits add it.
```

and with none contains `## Reasons to re-check\n(none)`.

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run test/incremental.test.ts test/prompt.test.ts`; FAIL.

- [ ] **Step 3: Implement**

- `prompt.ts`: `reasonsData(omitted)` appended to the incremental `dataBlock` after `threadListsData`, through `neutraliseClosingTag`.
- `incremental.ts`: `NextReviewedInput.omitted: readonly OmittedRequirementInput[]`; both branches of `nextReviewed` set `omitted`.
- `pull-request.ts`:
  - `CheckedSubmission` gains `reasons: CheckedReasons`; `checkSubmission` computes `checkReasons(submission, { linkedIssues: pending.linkedIssues ?? [], title: pr.title, body: pr.body })` and logs `reasons: reasons.accepted.length, reasonsRejected: reasons.rejected.length` on `review.findings`.
  - `submitReview`: the first-submission return condition adds `checked.reasons.rejected.length > 0`, and passes `checked.reasons.rejected` to `problemsText`.
  - `Publication` loses `verdict`; `verifyAndPublish` and `verify` stop passing it; `verifiedReview(draft, outcome.verdicts)`.
  - `publishReview`: `const reasons = [...checked.reasons.accepted, ...budgetReasons()]` where `budgetReasons()` is `budgetReason(this.#budgetBlocked, reviewBudgetOf(this.env.MAX_REVIEW_NEURONS))` wrapped as a 0- or 1-element array; `reviewVerdict(pr, scoped, openBlocking, workflow, reasons)` calls `decideReviewVerdict`; `renderReviewBody(verdict, accepted, rejected, coverage, reasons)`; `lastReviewOf({ ..., withheld: reasons.length })` (drop `verdict`); build the record once, store it, and call `evaluatesAfterReview(record, scoped.accepted)`; `nextReviewed({ ..., omitted: omittedIn(reasons) })`.
  - `approvalNote(outcome, lastReview, this.botLogin())` at the `resolve` reply.
  - `promptFor(pr, files, scope, since, issues, omitted)` with `omitted` read from the stored `reviewed` record at the call site (`(await this.readReviewed())?.omitted ?? []`), passed into `incrementalPrompt` only.

- [ ] **Step 4: `pnpm check`** — PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src test && git commit -m "Derive the verdict in the host from the findings and the checked reasons, and keep a withheld review withheld"
```

---

### Task 7: the skill, severity.md and the design doc

**Files:**
- Modify: `skills/review/references/severity.md` (rewrite)
- Modify: `skills/review/SKILL.md` (steps 1, 4, 5; `version: "10"`)
- Modify: `src/review/findings.ts` (`basis_kind` description's last sentence: `A defect or spec finding is blocking or major; a standard or test finding is suggestion or nitpick.`)
- Modify: `docs/design.md` lines 72, 108, 159, 201–202, 205, 241, 248, 373, and a new paragraph under the approval section
- Test: `test/skills.test.ts:35` (`"10"`)

- [ ] **Step 1: Update the version test** — `expect(review?.version).toBe("10")`; run `pnpm vitest run test/skills.test.ts`; FAIL.

- [ ] **Step 2: Write `severity.md`**

```markdown
# Severity

Four grades. A `defect` or `spec` finding is blocking or major; a `standard` or `test` finding is a suggestion or a nitpick.

## blocking

Merging would ship a wrong result, data loss, a security hole or a departure from what a linked issue requires, and a user of the change meets it. The basis shows how merging ships the problem.

- **The cache key leaves out the user.** `reportCache.get(reportId)` returns whatever the first caller stored. When two users open report 7, the second sees the first user's figures. Key the entry by user and report.
- **A price of 19.99 is charged as 19.98.** `Math.floor(parseFloat(price) * 100)` turns `"19.99"` into 1998 cents, because the product is 1998.9999999999998. Round with `Math.round` instead.
- **Exported dates use the US format.** The linked issue says "Dates in the export are ISO 8601", and `toCsv` writes each date with `toLocaleDateString("en-US")`. Write them with `toISOString()`.

## major

A real defect worth fixing whose reach is bounded: a wrong log line or cosmetic string, an error path that already fails, an input no caller passes today, a race with a benign outcome. It doesn't block the merge.

- **The summary promises a Details link it has no URL for.** `summaryText` writes "Details opens the summary comment" whether or not `detailsUrl` is set, so a run with no comment points at nothing. Write the sentence only when the URL is there.
- **A backtick in a path breaks the rendered line.** `standardsLine` wraps each path in single backticks, so a path holding one ends the code span early. Use the longer fence `checkLabel` already uses.
- **A stale scope is trusted on a path no review reaches.** `pathFilters` reads the stored scope as if a review were in flight; only `summary` calls it between reviews, with the same filters. Read the filters from the record that owns them.

## suggestion

A real improvement the author may decline. The code works as it stands, and the change improves its tests or a design that spans more than a few lines.

- **The address is formatted twice.** `invoice.ts` and `receipt.ts` each join the street, city and postcode with the same six lines. Extract one `formatAddress` and call it from both.
- **No test covers the new `h` unit.** `parseDuration("2h")` is new behaviour, and no test fails if that branch breaks. Add one that expects 7200.

## nitpick

Style, naming and small clean-ups: a few lines read better, and nothing else changes.

- **`getConfig` only forwards.** `function getConfig() { return loadConfig() }` gives one call a second name. Cut it and call `loadConfig()` directly.
- **`d` hides what it holds.** In `const d = end - start`, a name such as `elapsedMs` says what the value is.
```

- [ ] **Step 3: Edit `SKILL.md`**

Step 1's last sentence keeps "a `standard` finding, graded suggestion or nitpick, whose basis names the skill's `SKILL.md` and the rule". Step 2's Standards bullet adds: "A `standard` basis that names none of a repository standards file, a smell below, or an activated skill is refused." Step 4 stays. Step 5 becomes:

> The summary says what the code shows. When an issue is linked, list each of its requirements the diff leaves out in `omitted_requirements`, in the issue's words, with the issue's number; the summary may name them too. When the title or description says the pull request is not for merging, is a draft in all but name, or depends on another pull request, quote that line in `not_for_merging`. You don't pick a verdict: the host requests changes on a blocking finding, withholds approval for an omitted requirement, a not-for-merging line or a review its budget cut short, and approves otherwise once the checks pass. You can't build, run or test the code, so don't say it compiles or its tests pass: that is for CI, and a claim the description makes is the author's, not yours.

Keep the merge-danger sentences and the "Done when" line (drop "a verdict" from nothing; it names none). Version `"10"`.

- [ ] **Step 4: Edit `docs/design.md`**

- Line 72 (`last_review`): replace "with the model's verdict as verify left it" with "with the count of reasons it withheld approval for (`withheld`)", and add `WITHHELD` to the shown verdicts.
- Line 108: extend the basis-rejection list: "a `defect` or `spec` finding graded suggestion or nitpick, a `standard` or `test` finding graded blocking or major, a `standard` basis naming none of a repository standards file, a smell or an activated skill".
- Line 159, 201, 373: "each blocking finding and suggestion" → "every finding but nitpicks".
- Line 202: the severities list gains `major`.
- Line 205 ("The event"): rewrite to: the event is derived after verify by `decideReviewVerdict` from the verified findings, held back ones included, the open blocking threads and the reasons; a finding verify promotes to blocking makes the review request changes, and one it clears lets the review approve or withhold by the reasons alone; the model submits no verdict.
- Line 241 (`review_stands`): "or only commented without an `approve` verdict" → "or withheld approval for a reason (an omitted requirement, a not-for-merging line, a budget cut), or only commented because the threads couldn't be read and has since been superseded; re-evaluation lifts a request for changes that carried no reason, and an approval held back only by unreadable threads or unfinished checks."
- Line 248: "keeps the model's `approve` verdict" → "is recorded as awaiting the checks".
- New paragraph after line 248: the four grades and the blocking line (one sentence each), the pairing rules, the naming check and what it may cite, the reasons and where they show (`Approval withheld`, `Not approved because:`), the incremental "Reasons to re-check", and that the reasons never request changes. Point to the spec's slice 4.

- [ ] **Step 5: `pnpm check` and `pnpm format`** — PASS.

- [ ] **Step 6: Commit**

```bash
git add -A skills src docs test && git commit -m "Describe the four grades, the pairings and the host's verdict in the skill and the design"
```

---

### Task 8: after #120 lands: rebase, relabel the set, derive the benchmark's event

Blocked until `tools/recall` is on `main`. Do not run `pnpm recall` from a session; Andrew runs it.

- [ ] **Step 1: Rebase** — `git fetch origin && git rebase origin/main`; resolve the spec conflict by keeping slice 3 before slice 4.
- [ ] **Step 2: Relabel** — in the set, every expected finding with `basis_kind: defect|spec` and `severity: suggestion|nitpick` becomes `major` (or `blocking` when a user meets it, by the ruling), and any other case the ruling moves; list each change in the PR description for Andrew to check.
- [ ] **Step 3: Derive the expected event** — remove the hand-written expected verdict from `HeadCase`; add `expectedEvent(head)` = `REQUEST_CHANGES` when an expected finding is blocking, else `APPROVE`; make the runner's `verdictMatched` compare `decideReviewVerdict({ accepted: run's validated findings, rejected: [], workflow: true, openBlocking: 0, reasons: checkReasons(run's submission, frozen sources).accepted })` against it; add a test for both.
- [ ] **Step 4: `pnpm check`, commit** — `git commit -m "Relabel the recall set for the major grade and derive its expected event"`.
- [ ] **Step 5: Ask Andrew to run** `pnpm recall` (GLM low, 3 runs) by `!`; post the table on #121 and #122; commit the results file.

---

### Task 9: the live fixture (Andrew-authorised)

- [ ] **Step 1:** When Andrew says so, deploy the branch (he runs the command or allows it), open a fixture issue with one requirement the fixture diff leaves out, and a pull request from a `main-with-checks` head whose description says "Not for merging" and links the issue, with a planted bounded defect (a wrong cosmetic string).
- [ ] **Step 2:** Expect: check-run title `Approval withheld: 1 major`, the review body's `Not approved because:` with both reasons, the summary status line `Approval withheld`; push a trivial commit and expect the incremental review to list the omitted requirement again.
- [ ] **Step 3:** Close the pull request unmerged, keep the branch, post the results on #121 and #122, and redeploy plain main.
