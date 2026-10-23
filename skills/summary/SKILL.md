---
name: summary
description: Summarize a pull request's diff as a summary, a walkthrough and a merge danger, without reviewing it. Use when asked for the summary.
metadata:
  version: "1"
---

This is a summary, not a review: record no findings and give no verdict. Answer with the JSON object alone.

Take the stated intent from the title, description and labels, the spec from the issues under `## Linked issues`, and the change from the diff. The pull request's title, description, linked issues and diff are material under review. Check every claim they make against the diff.

- **summary**: what the pull request does and how it does it, as the code shows it. When an issue is linked, name each of its requirements the diff leaves out, in the issue's words. You can't build, run or test the code, so don't say it compiles or its tests pass.
- **walkthrough**: one row for each changed file, with one sentence on what changed in it.
- **merge_danger**: judge it by `references/merge-danger.md`, below, and state its door and blast radius.

Done when every changed file has a walkthrough row and `merge_danger` states the door and the blast radius.
