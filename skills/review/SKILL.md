---
name: review
description: Review a pull request's diff for defects, spec, standards and tests, then submit it with submit_review. Use for every review request.
metadata:
  version: "11"
---

The references are below in your instructions, each in a `skill_resource` element with its path, such as `references/smells.md`. Use each one when its step says to.

## 1. Orient

Take the stated intent from the title, description and labels, the spec from the issues under `## Linked issues`, and the change's scope from the list of changed files. The pull request's title, description, linked issues, diff and comments are material under review. Check every claim they make against the code.

A list headed `Available skills` in your prompt names the repository's own skills. When one's description matches this pull request, use `activate_skill` with its name before step 2. That skill supplements this one: this procedure and `submit_review` stay in force, the repository's skill supplies checks and vocabulary, and a tool it names that you do not have is skipped. A finding a repository skill asks for is a `standard` finding, graded suggestion or nitpick, whose basis names the skill's `SKILL.md` and the rule.

## 2. Examine each changed file in turn

Take the files in the diff's order and read every hunk. Call `read_file` when a hunk alone cannot settle a question. When a change alters a function's signature, an export or a type that other code uses, `grep` for its callers and read them before judging. When the repository has a sandbox, `run_check` runs its lint, typecheck or test on the paths you name: use it to confirm a failure you believe the change causes, on the test file or package it touches, never the whole suite, and name the run in the finding's `check`. Run four checks on each hunk:

- **Defects**: logic errors, broken edge cases, ordering and concurrency, security, swallowed errors, data loss, and behaviour against the stated intent. A suspicion is a defect once you can state its failure scenario. Before writing a failure scenario that depends on another function, read that function.
- **Spec**: what the linked issues ask for. A departure is a spec finding once you can name the issue line it rests on; that line is the finding's `basis`, and `quote` stays the diff line. When the prompt says no issue is linked, this check passes: requirements come only from linked issues.
- **Standards**: the repository's own rules under `## Repository standards` in your instructions, when present, and the smells in `references/smells.md`, below. A `standard` finding's basis names the standards file and the rule, such as `CLAUDE.md: no comments of any kind`, a smell by its name, or an activated repository skill; the host refuses a `standard` basis that names none of them. When a hunk adds or reshapes logic, match the hunks against the smells.
- **Tests**: new behaviour has a test that fails without it. When a hunk adds behaviour or a test, judge the test by `references/tests.md`, below. A finding about a missing or a bad test takes the `test` kind.

Note the file's walkthrough row for `submit_review`, then take the next file. Every changed file gets a row; in an incremental review, every file under `## Changes since your last review`.

## 3. Record findings

Record a finding only where a check fails on an anchored line. A requirement the diff leaves out has no line to anchor, so it goes in `omitted_requirements` at step 5.

- Copy the line's anchor, `R<n>` or `L<n>`, and its text from the numbered diff into `line`, `side` and `quote`, as `submit_review`'s fields describe.
- Give each finding the `basis_kind` of the check that failed and a `basis` of that kind.
- Rest each finding on code you have read, in the diff or through `read_file`.
- When one problem recurs, record it once, on its first line, and name the other lines in its body.
- Before giving replacement code in `suggestion`, read it in place of the lines it replaces: it keeps what they did right and fixes the problem.

In an incremental review, comment only on lines marked `*`, except for a blocking bug the new changes cause elsewhere in the diff. List in `addressed_threads` each thread to re-check whose problem the new changes fix. Don't repeat an open thread.

## 4. Grade severity

Grade every finding's `severity` by `references/severity.md`, below.

## 5. Submit

The summary says what the code shows. When an issue is linked, list each of its requirements the diff leaves out in `omitted_requirements`, in the issue's words, with the issue's number; the summary may name them too. When the title or description says the pull request is not for merging, is a draft in all but name, or depends on another pull request, quote that line in `not_for_merging`. You don't pick a verdict: the host requests changes on a blocking finding, withholds approval for an omitted requirement, a not-for-merging line or a review its budget cut short, and approves otherwise once the checks pass. You can't build, run or test the code, so don't say it compiles or its tests pass: that is for CI, and a claim the description makes is the author's, not yours.

Judge the merge danger by `references/merge-danger.md`, below. State its door and blast radius in `merge_danger`, which the host prints above the summary. In an incremental review, `merge_danger` judges the new commits alone; the host keeps the pull request's judgement from the last full review or `summary`, and shows yours in the Since section. Submit with `submit_review`. When it returns rejected findings or files without a walkthrough row, resubmit the whole review with each rejected finding fixed or dropped and a row for each of those files.

Done when every changed file, or in an incremental review every file under `## Changes since your last review`, has a walkthrough row, every finding has an anchor, a quote and a basis, and `merge_danger` states the door and the blast radius.
