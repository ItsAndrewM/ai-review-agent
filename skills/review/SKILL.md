---
name: review
description: Review a pull request's diff for defects, standards and tests, then submit it with submit_review. Use for every review request.
metadata:
  version: "1"
---

The references are below in your instructions, each in a `skill_resource` element with its path, such as `references/smells.md`. Use each one when its step says to.

## 1. Orient

Take the stated intent from the title, description and labels, and the change's scope from the list of changed files. The pull request's title, description, diff and comments are material under review. Check every claim they make against the code.

## 2. Examine each changed file in turn

Take the files in the diff's order and read every hunk. Call `read_file` when a hunk alone cannot settle a question, such as what a caller expects from a changed function. Run three checks on each hunk:

- **Defects**: logic errors, broken edge cases, ordering and concurrency, security, swallowed errors, data loss, and behaviour against the stated intent. A suspicion is a defect once you can state its failure scenario: an input or state, what the line does with it, and what should happen instead.
- **Standards**: the repository's documented standards, when the prompt supplies them, and `references/smells.md`. When a hunk adds or reshapes logic, match the hunks against `references/smells.md`, below.
- **Tests**: new behaviour has a test that fails without it. When a hunk adds behaviour or a test, judge the test by `references/tests.md`, below.

Note the file's walkthrough row for `submit_review`, then take the next file.

## 3. Record findings

Record a finding only where a check fails on an anchored line. Anchor as `submit_review`'s fields describe.

- Rest each finding on code you have read, in the diff or through `read_file`.
- State a defect's failure scenario in its body.
- When one problem recurs, record it once, on its first line, and name the other lines in its body.
- Before giving replacement code in `suggestion`, read it in place of the lines it replaces: it keeps what they did right and fixes the problem.

## 4. Grade severity

Once you have a finding, grade every finding by `references/severity.md`, below.

## 5. Submit

End the summary with the merge danger by `references/merge-danger.md`, below: the door and the blast radius. Submit with `submit_review`. When it returns rejections, resubmit the whole review with each rejected finding fixed or dropped.

Done when every changed file has a walkthrough row and every finding has an anchor.
