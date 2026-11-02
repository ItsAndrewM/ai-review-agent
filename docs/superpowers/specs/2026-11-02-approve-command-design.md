# Approve on request: `@andabot approve` (#212)

Written 2 Nov 2026. Part of Phase 5 (milestone "Phase 5: hardening"). This is a separate file so it doesn't collide with `2026-11-01-hardening-design.md`; fold it in later.

## Why

andabot's approval follows only andabot's own judgment. It is withheld while one of its blocking threads is open, or when its review gave reasons not to approve. #211 was held that way over an account setting only Andrew could make. A person who has read the findings and disagrees has no way to say so, short of merging past andabot. CodeRabbit's `@coderabbitai approve` is that way out. Its docs say it "resolves CodeRabbit's review threads and submits CodeRabbit's approval". It needs `reviews.auto_approvals.enabled`, and authors may use it only with `allow_author_approval`.

## Andrew's rulings (grill, 2 Nov 2026)

- **Q1, what it overrides:** andabot's own judgment only. That means its open blocking threads (`blocking_threads`, `threads_unknown`) and a review that stands (`review_stands`: requested changes, withheld reasons, held-back findings).
  - It still waits for the head's other checks, and approves the moment they pass, as today.
  - It refuses when:
    - the workflow is off;
    - the pull request is closed or a draft;
    - andabot is paused.
- **Q2, who:** anyone with write access (as every command), except the pull request's author. A repository allows authors with `reviews.approve.allow_author: true`. This repository sets it.
- **Q3, lifetime:** the head it was typed on. A new push gets a normal review, which can request changes again.
- **Q4, unreviewed head:** refused. If the current head has no posted review, or its review is running, the reply says to type approve once the review posts. Nothing is stored.
- **Q5, threads:** left open. `@andabot resolve` closes them.
- **Q6, default:** on wherever andabot approves. A repository turns it off with `reviews.approve.enabled: false`.
- **Q7, sequencing:** a new issue (#212), built on main beside #211.

## The command

`approve` joins the command table (`src/commands.ts`): `@andabot approve` → `{ kind: "approve" }`. It is listed in `help`.

The object's `approveOnRequest(call)`:

1. Reads the pull request (`freshPullRequest`), the repository config (`repositoryConfig`), pause, `pending`, `reviewed`, `lastReview` and the workflow, as `approvalState` does.
2. Decides with a pure function, `approveStep` (`src/review/approve.ts`), checked in this order:
   - `thread`: typed in a review thread;
   - `disabled`: `reviews.approve.enabled` is false;
   - `author`: the commenter is the pull request's author and `allow_author` is false;
   - `workflow_off`;
   - `not_open`: closed or a draft;
   - `paused`;
   - `review_running`: a `pending` exists;
   - `not_reviewed`: `reviewed.headSha` isn't the head, or no `lastReview` is for the head;
   - `approved`: the last review is an `APPROVE` of the head;
   - else `override`.
3. On `override`, it stores `approvalOverride: { head, by, at }`, logs `command.approve` (`author`, `head`, `step`) and calls `evaluateApproval("approve", …)`.
4. It replies with `approveReply(step or outcome)`:
   - **approved:** "Approved `abc1234` on your request. My open threads stay open; `@andabot resolve` closes them."
   - **checks pending:** "I'll approve `abc1234` once the other checks pass."
   - **checks failing:** "I'll approve `abc1234` once the failing checks pass."
   - **each refusal:** one line saying why, and what to do instead where there is something.

## The decision

`ApprovalState` gains `override: boolean`, true when a stored `approvalOverride.head` equals the head. `decideApproval` keeps `pullRequestWait` (workflow, paused, open, review in flight, reviewed head) and the checks. With `override` true it skips `recordWait`'s `review_stands` and `liveStateWait`'s thread waits; it still answers `no_record` with no review and `approved` when already approved. So the trigger the checks raise (`checks_completed`, the re-check jobs) approves an overridden head when its checks pass, with no new code path.

`ApprovalTrigger` gains `"approve"`.

## What the author sees

- **The approving review's body:** "Approved at `abc1234` on request by @who, past my open blocking threads and the reasons my review gave. A human review is still required to merge." The usual body is kept when nothing was overridden, which means the evaluation would have approved anyway.
- **The summary's verdict line:** "Approved at `abc1234` on request by @who".
- **The check run's title:** "Approved on request by @who".
- **The reply** as above.

## Config

`Reviews` gains `approve: { enabled: boolean, allow_author: boolean }`, default `{ enabled: true, allow_author: false }`. In the file it is a partial object, merged key by key over the default, so `approve: { allow_author: true }` keeps `enabled: true`. This repository gets a `.andabot.yaml` with `reviews.approve.allow_author: true`; it takes effect on bases that hold the file.

## Logs

- `command.approve` (`author`, `head`, `step`).
- `approval.posted` gains `override: <who>` when the approval overrode anything.

## Non-goals

- Resolving andabot's threads (Q5).
- Approving past failing checks, an unreviewed head or a running review.
- An override that outlives its head (Q3).
- Dismissing earlier `REQUEST_CHANGES` reviews. GitHub counts the latest review per reviewer, so the approval supersedes them.

## Constraints

- No model call, so the daily cap (#186) doesn't apply.
- The repository's lint rules.

## Done when

- Tests pin:
  - `approveStep` for every refusal and the override, including the author rule both ways;
  - `decideApproval` with `override`: approves past blocking threads and a standing review, still waits for pending or failing checks, an unreviewed head and a running review, and ignores an override for another head;
  - the config's nested merge;
  - the command parse, help line and reply copy;
  - the body, verdict and check-run wording.
- `docs/setup.md` and `docs/design.md` describe it.
- A live check on staging approves a fixture past a blocking finding.

## Rulings while building and after the review

Built inline from the plan, reviewed whole-branch on opus ("with fixes": no Critical, three Important, nine Minor), and live-checked on staging (fixture #213, base `main-with-approve`).

- **`approve` is required in `AndabotConfig`.** So a config cached before it reads as a miss and is read again, as with `reviews.verify`.
- **Any review that starts clears the override.** A `full review` of the same head can't then be approved past findings nobody saw.
- **`overridesJudgment` decides the wording** (tested). Only an approval the override let through says "on request by".
- **A failed evaluation gets its own reply**, asking for the command again.
- **Q4 narrowed after the review:** a head counts as reviewed when `reviewed.headSha` is the head and a `lastReview` exists, even if that review was of an earlier head. A review that found nothing new (GitHub's Update branch, a merge from the base) moves `reviewed` but not `lastReview`, and would otherwise leave `approve` refused for good. That head has no findings the requester hasn't seen, so Q4's intent holds.
- **Worded replies for every wait.** A head that moved, or a review that started, says the approve lapsed. An approval already posting says so. Unread checks say it will look again.
- **`approve` schedules the re-checks** (20 s, 1 min, 5 min) on a pending or unread check, like a check suite's evaluation, so a stale read can't strand it (#74, #87).
- **CodeRabbit on #214:**
  - The approval record stores `requestedBy`, so a later `summary` keeps "on request by".
  - An approval on request of an unverified review keeps "(unverified)".
  - The help line says the approval holds for the head until the next review.
- **Deferred minors:**
  - The "approved" reply mentions open threads even when none were open.
  - The body names both reasons when only one applied.
  - An unreadable config is reported as "workflow off".
  - An invalid config falls back to defaults, which re-enables `approve`.
  - The override isn't tied to the review id, which is safe under the object's input gates.
  - The override is read twice per evaluation.
