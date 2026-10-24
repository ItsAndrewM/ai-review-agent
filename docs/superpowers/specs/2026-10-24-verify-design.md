# Verify pass (#31): design

Agreed with Andrew in a grill-me on 24 Oct 2026. The questions are numbered Q1 to Q10 below; anything marked _builder's call_ or _my call_ is open to the plan.

## Why

A review is one pass: the model's findings are validated and posted with no second look. `docs/design.md`'s pipeline puts a verify step between draft and post, and its first open question names verify as the place to settle severity.

#31's audit of all 146 andabot findings (21 Oct, recorded on #31) found:

- **Fixtures:** no false positives, so #9 can't measure what verify adds.
- **Real pull requests:** 10 of 58 findings were false.
  - gpt-oss had the only false blocking finding.
  - GLM had 6 false findings out of about 51, none blocking. Most stopped short of a function in another file.
- **Severity:** about 19 were wrong. Two crossed the blocking line, which decides whether a review requests changes or approves:
  - #9's harmless missing `await` was graded blocking 11 times;
  - #49's real defect was graded a suggestion.

#31 was deferred behind #28 (`.andabot.yaml`) and #30 (repository search). Both have shipped, and #30's `grep` and `tree` give a verifier the cross-file reach the audit asked for.

## Goal and the bar (Q1)

- **Main target:** severity at the blocking line.
- **Second target:** dropping false findings.
- **Hard rule:** verify never drops or demotes a true blocking finding.

Verify ships on only if its default model, scored on the replay set (Q9):

1. fixes the blocking-line severity errors: it demotes #9's missing `await` and promotes #49's defect;
2. drops at least half of the real false findings in the set;
3. drops or demotes no true blocking finding.

Otherwise it ships off, with an empty `VERIFY_MODEL`.

## Decided behaviour

### What verify may change (Q2)

For each finding it receives, verify returns:
- keep or drop;
- a severity: `blocking`, `suggestion` or `nitpick`, in either direction;
- a one-line reason.

It never rewords a finding, edits its suggestion, changes its `basis_kind` or `basis`, or adds a finding.

The host's basis rules still apply to the severity verify returns: a `standard` or `test` finding can't be blocking. _My call:_ a promotion those rules forbid is ignored, the finding keeps its draft severity, and the verdict is logged as capped. Rejecting such a finding as unfounded would drop one that verify meant to keep.

### Which findings go through verify (Q3)

- **In:** every accepted `blocking` finding and `suggestion` in the submission about to post.
- **Also in:** every blocking finding rejected for its anchor that still holds approval back. The review's body names it and it makes the review request changes, so a false one blocks the pull request all the same.
  - Dropping or demoting such a finding stops it holding approval back.
  - A demoted one is then left out like any other rejected non-blocking finding.
- **Out:**
  - nitpicks;
  - open threads;
  - the model's `addressed_threads` claims;
  - findings rejected for their basis, which hold nothing back already.

Verify judges only the submission that would post: after the one round in which rejections go back to the model, on both the tool path and the JSON-as-text path.

_My call:_ the push's delta rules then apply to the verified severity. `applyDeltaPolicy` makes two exceptions for blocking findings only:
- in an incremental review, a blocking finding may sit on a line the push didn't change;
- a blocking finding on the line of a non-blocking open thread isn't a duplicate.

A finding that got in only through one of those exceptions is left out once verify demotes it, as a non-blocking finding in that place would be. The Verify section lists it as demoted and left out, with the reason. Refusing the demotion would post as blocking a finding verify judged non-blocking, which works against Q1's main target.

### The verify model and its cost (Q4)

- `VERIFY_MODEL` sets the default verify model, and `.andabot.yaml`'s `model.verify` overrides it (Q8).
- GLM-5.3 Flash and Kimi K2.7 Code are both scored on the replay set. GLM becomes the default if it clears the bar.
- If only Kimi clears it, Andrew sees Kimi's measured cost per review and per day before it goes live.

For scale: a GLM review costs about 500 neurons, and Workers AI's free 10,000 a day cover 15–28 reviews. Kimi costs $0.95 per million input tokens and $4.00 per million output, against GLM's $0.15 and $0.50.

### What verify sees, and what it can look up (Q5)

Each finding arrives with:
- its title, body, severity, `basis_kind`, `basis`, path, lines, side and quote;
- the cited lines with about 40 lines either side, read at the head, or at the base for a `LEFT`-side finding;
- that file's patch;
- the linked issue's text, for a `spec` finding.

Verify can call `read_file`, `grep` and `tree`, at most 10 times in the whole pass. It gets no dump of the repository's standards: it reads one with `read_file` when a finding cites it.

_My call:_ verify's `grep` and `tree` calls also count toward the 40 calls that a review and the questions answered during it share, since verify runs inside the review.

### Where it runs (my call, confirmed by a spike before the plan commits to it)

- **Placement:** in `postReview`, between validating the final submission and publishing it.
- **Session:** its own Pi session, like `summary`'s, configured with the verify skill and the three tools.
- **Operation id:** `<review operationId>:verify`, so `ownsOperation` counts it as the review's. The single flight then counts it toward the review's liveness, and a newer head aborts it with the review.
- **Output:** through a `submit_verdicts` tool, validated with TypeBox, since forced JSON and tools don't mix. A JSON-as-text answer is accepted as the review's text fallback is.
- **Batching:** one batched call for all findings. The batch size, and splitting a very large batch, are the _builder's call_.
- **Single flight:** `harness.pending()` and `harness.abort()` default to the root session. So the single flight's liveness check, and the abort when a newer head arrives, must name the verify session explicitly.
- **After verify:** verify can take minutes, so before it publishes, the review checks again that the head hasn't moved and that it still owns `pending`. If either has changed, it posts nothing, as a review that loses its head does today.

**The spike:** a tool call in the root conversation waiting on a prompt in another session must neither deadlock nor break Pi's replay after a restart. If it does, verify moves after the root conversation ends. Then `submit_review` stores the validated submission, and the host verifies and publishes after `harness.prompt` returns.

### Failure and slowness (Q6)

- **No time cap** while verify is working: a slow verify runs to the end.
- **Verify has failed when:**
  - the model call errors or times out after Pi's own retries;
  - its answer has no usable verdicts;
  - it passes a 15-minute backstop.
- **On failure:** it retries once, as a fresh attempt. If the retry also fails, the review posts the draft's findings as drafted, marked unverified: a footer line says "not verified" and why, the check run's title says so, and `verify.failed` is logged.
- **Partial answers:** a verdict for each finding it covered applies, and the rest post as drafted. A verdict for a finding it wasn't given is ignored and logged.

### What the pull request shows (Q7)

- **Inline comments** show the final, verified severity, with no note about what changed.
- **The summary comment** gets a collapsed "Verify" section listing each dropped finding (path, line, title and reason) and each severity change (old → new, with the reason).
  - _My call:_ the section is left out when verify changed nothing, since the footer already shows that it ran.
  - Findings a partial answer didn't cover are listed there as not judged.
- **The footer** names both models, as in "Reviewed by `@cf/zai-org/glm-5.3-flash` · verified by `@cf/moonshotai/kimi-k2.7-code`", or carries the unverified line.
  - The cost line includes verify's tokens and spend. `pi.usage` already sums every conversation.
  - _My call:_ verify's model calls count in the footer's calls.
- **Logs:**
  - `verify.start`: the findings, the model and the attempt;
  - `verify.verdict`, one per finding: the finding, keep or drop, severity from → to, capped, and the reason;
  - `verify.done`: counts kept, dropped, promoted, demoted and capped, plus milliseconds, calls and spend;
  - `verify.failed`: the reason and the attempt.

### The event

The review's event is chosen from the verified findings, held-back ones included. A finding verify promotes to blocking makes the review request changes, as `chooseReviewEvent` already does.

Approving after verify needs one change (Andrew, after the builder check). Today the model answers `request_changes` whenever it has a blocking finding, and `chooseReviewEvent` approves only an `approve` verdict. So a review whose blocking findings verify dropped or demoted would post as a plain comment. Its `last_review` would keep `request_changes`, and the approval evaluation would wait as `review_stands` until the next push.

So when verify leaves no blocking finding, accepted or held back, a `request_changes` verdict is treated as `approve`:
- the review approves if the checks pass, or says "Approval waits for the checks";
- `last_review` records the verdict as `approve`, so the evaluation lifts it once the checks pass.

A `comment` verdict stays a comment. This matches the approval design's rules: resolving the blockers lifts a request for changes whatever verdict the model gave, and a review that only commented never becomes an approval.

### Settings (Q8)

- **`VERIFY_MODEL`** in `wrangler.jsonc` `vars` is the default verify model. Left empty, verify is off everywhere, whatever a repository's `.andabot.yaml` says: it is the global off switch. This also keeps a repository from turning on a model before Andrew has seen its cost (Q4).
- **`.andabot.yaml`:**
  - `model.verify` names the model for one repository while verify is on, overriding the variable;
  - `reviews.verify` (boolean, default `true`) set to `false` turns verify off for that repository;
  - `model.draft` stays accepted and ignored.
- _My call:_
  - `model` keeps accepting any mapping, with `verify` checked as a string when present;
  - a model id the registry doesn't have is a verify failure (reason `no_model`), not a config error.
- **The default ships on** with the model that cleared the bar under Q4's rule, or off if neither did.

### Measurement (Q9)

The replay harness is a script outside the Worker, not part of `pnpm check`:
- **Input:** each labelled finding as recorded on GitHub: path, line, body, severity, basis and the head it was made on.
- **Run:** it builds verify's input with the Worker's own code. It runs the verify model on Workers AI with `read_file`, `grep` and `tree` served from a checkout of that head.
- **Scoring:** each verdict against its label.
- **Repeats:** each model runs 3 times. The results go on #31, and Q4's rule picks the default.
- **Thinking level:** verify runs at production's, `REVIEW_THINKING_LEVEL`. It isn't measured.

**Scoring the 3 runs (Andrew, after the builder check):**
- **The hard rule holds in every run:** one run that drops or demotes a true blocking finding fails that model.
- **The other targets count per finding by majority, 2 runs of 3:**
  - an instance of #9's `await` is fixed if it is demoted or dropped, since either way it stops blocking;
  - #49's defect must be promoted to blocking;
  - a should-drop finding counts only if it is dropped, since a demoted one still posts.

**The labelled set:**
- **Should drop:** the audit's false findings on real pull requests.
  - _Named:_ #49's 4330021512, 4330057699 and 4330057723; #23's 4318356095 and 4318503063 (gpt-oss, the false blocking one); #59's 4331431933; #66's 4341994189; #1's 4303528101 (gpt-oss).
  - _My call:_ the other 2 of the audit's 10 weren't recorded by id. The builder may find them by re-grading the real-PR findings; otherwise the bar's "at least half" applies to the 8 named, so 4.
- **Should demote:** several of the 11 instances of #9's missing `await`, at `src/pull-request.ts:179` on #9's head.
- **Should promote:** #49's 4329887730.
- **Must keep, never demoted if blocking:**
  - #9's planted defects as GLM found them;
  - #54's spec findings;
  - at least 10 true findings from real pull requests. _My call:_ prefer ones a later commit fixed, which is evidence they were real.

### Done when (Q10)

1. **Unit tests cover:**
   - keep, drop, promote and demote;
   - the basis rule capping a promotion;
   - nitpicks not being sent;
   - held-back blocking findings sent, and dropping or demoting one releasing approval;
   - a missing or unknown verdict;
   - an error retried once, then the unverified fallback;
   - the 15-minute backstop;
   - the settings: an empty `VERIFY_MODEL` means off everywhere, even with `model.verify` set; `model.verify` overrides a non-empty `VERIFY_MODEL`; and `reviews.verify: false` means off;
   - a demoted finding that only got in because it was blocking being left out;
   - a head that moved during verify posting nothing;
   - the event chosen from verified findings, including a `request_changes` verdict treated as `approve`, and recorded so, once verify leaves no blocking finding, and a `comment` verdict staying a comment;
   - the summary's Verify section, both models in the footer, and the unverified line and check-run title.
2. **The replay harness** runs GLM and Kimi 3 times each against the bar. The results go on #31, and the default follows Q4's rule.
3. **A live check on a throwaway pull request, in an agreed production window:**
   - a verified review, showing both models in the footer, the Verify section when something changed, verify's spend in the cost line, and `verify.verdict` lines;
   - the failure path, forced by a branch deploy whose `VERIFY_MODEL` names a model that doesn't exist: it should retry, then post unverified with the footer line and the check run's title;
   - `reviews.verify: false` in the fixture's `.andabot.yaml`, which should skip verify.
4. **Docs:** a verify section in `docs/design.md` (pipeline, models table, `.andabot.yaml`), plus the new settings in `docs/setup.md` and the README.

## Left to the builder

- **Copy and schemas:** the verify skill's text, as a bundled `skills/verify/SKILL.md` that reuses the review skill's `references/severity.md`; the prompt; the `submit_verdicts` schema and how findings are identified in it; the exact copy of the Verify section, the footer and the check-run title, within the content decided above.
- **Layout and size:** the module layout, for example `src/review/verify.ts` for the pure parts; the batch size; how far each finding's context window reaches beyond about 40 lines when a function is longer.
- **The harness:** where it lives, how it gets Workers AI credentials, and how it serves the tools from a checkout.

## Out of scope

- Choosing the review's model per repository (`model.draft`).
- Verifying `addressed_threads` claims or open threads.
- Rewording, fixing or adding findings.
- Verifying chat answers or `summary`.
- Phase 3's sandbox results feeding verify.
