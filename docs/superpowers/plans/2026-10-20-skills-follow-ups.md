# Skills follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Close the four decisions left open by the review of #41 (issue #47): the spec comes from closing keywords and the branch key, merge danger carries across incremental reviews, the skill says which files need rows in an incremental review, and a quote that carries the diff's marker still matches.

**Architecture:** Four small changes on the host's existing seams: the linked-issue parser, `validateFindings` and the approval gate, the reviewed record and `nextReviewed`, `anchorByQuote`, and the skill text. No new modules.

**Tech Stack:** TypeScript on Cloudflare Workers, TypeBox, vitest, oxlint with the repository's rules.

**Spec:** `docs/superpowers/specs/2026-10-17-skills-design.md` sections E and F, amended in this plan's one task, and `docs/superpowers/specs/2026-10-19-incremental-review-design.md` for the reviewed record.

## Global Constraints

- `CLAUDE.md` rules: no comments in code; every stored or fetched value parsed with a TypeBox schema and `Value.Check`; no type assertions except `as const`; complexity at most 10 per function; no `vi.mock`; no `unknown` parameters or returns except a caught error's `cause`; no `typeof`; no `...(cond ? {...} : {})`.
- The review skill body stays under 120 lines; references render inline below the skill.
- PR descriptions say `Closes #47` and that merging deploys nothing; `pnpm run deploy` deploys by hand.

## Review Focus

- A pull request whose body mentions `#n` in passing and whose branch carries `GH-m`: only `m` is the spec.
- A pull request with no linked issue whose model writes a blocking `spec` finding: the finding is rejected, returned once, and does not hold approval back.
- An incremental review after a full review that judged a one-way door: the summary keeps the one-way door.
- A stored reviewed record from before this change, without merge danger: the summary shows the push's judgement and nothing throws.
- A quote copied as `+ const x = 1` or `R12 + const x = 1` for a line whose text is `const x = 1`: the finding anchors without relocation.

---

### Task 1: The four follow-ups

One task, one pull request. The brief in the plan's workspace carries the exact values; this plan records the decisions.

- The spec is read from closing keywords in the body and the branch's `GH-n` or trailing `.n` key; bare `#n` mentions count only when neither exists.
- A `spec` finding on a pull request with no linked issue is rejected with a reason that offers the defect kind; a finding rejected for its basis never holds approval back.
- `ReviewedRecord` stores `merge_danger`; `nextReviewed` keeps the stricter door across an incremental review; the summary after an incremental review renders the record's merge danger.
- The skill, at version 4, says a row is needed for every changed file, or in an incremental review for every file under `## Changes since your last review`, in step 2 and in the completion criterion.
- `anchorByQuote` also matches a quote that carries a leading diff marker or anchor token, trying the quote as written first.
