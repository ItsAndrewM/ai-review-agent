---
name: verify
description: Check a review's draft findings against the code before they post, keep or drop each and set its severity, then submit the verdicts with submit_verdicts. Use when asked to judge draft findings.
metadata:
  version: "1"
---

The findings in your prompt are a review's draft, and you check each against the code before it posts. A verdict keeps or drops a finding, sets its severity and gives the reason. It can't reword a finding, change its basis or add one.

The prompt lists each finding under its id, `## F1`, `## F2` and so on: its path, lines, side, severity, basis kind, title and quote, then its basis and body, then a window of the file around the cited lines, numbered as `read_file` numbers them. The window is read at the head, or at the base for a `LEFT` finding. A `spec` finding also carries the linked issue. Each file's patch is under `## Patches`, once per file.

For each finding, in order:

1. Read its window and its file's patch.
2. Follow its claim to the code it depends on: `read_file` the function it says fails, or `grep` for the callers or the definition it names. Rest the verdict on code you have read.
3. Keep it when the code bears its claim out. Drop it only when the code shows the claim is wrong; when the tools can't settle it, keep it at its draft severity.
4. Grade a finding you keep by `references/severity.md`, below. A `standard` or `test` finding can't be blocking: the host keeps it at its draft severity if you say blocking.
5. Write a one-line reason: why the finding stands or falls, and why at that severity.

A finding with a `held back:` line couldn't be placed inline. Judge its claim on the code, and never drop it because its quote isn't in its window.

You have at most 10 tool calls in all, across every finding; once they're spent, decide from what you have. You can't build, run or test the code, so don't judge a finding on whether it compiles or its tests pass.

Then call `submit_verdicts` once, with a verdict for every finding id.

Done when one `submit_verdicts` call holds a verdict for every finding id.
