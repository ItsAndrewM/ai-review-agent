# Phase 5: hardening

Written 1 Nov 2026. Phase 4 (`2026-10-29-reviews-that-hold-up-design.md`) shipped its eight slices; only #129 is left, and it waits on a verify model that clears the replay bar. Milestone "Phase 5: hardening" holds #177 to #190, found in the 30 Oct 2026 production-readiness review. One slice per issue, in the order Andrew picks; each slice adds its section here with the rulings made while building.

## Slice 1, #189: a sweep reviews heads whose webhook never came

### Why

#118 retries a delivery when a GitHub call fails, but only a delivery that arrived. A webhook GitHub never sends, or sends hours late as on 21 Oct 2026, leaves the push with no review, no check run and nothing that notices. Phase 4's goal, nothing an author does goes unanswered, needs something that looks for the gap instead of waiting to be told: a sweep over open pull requests that hands each unreviewed head to its object.

### Andrew's rulings (grill, 1 Nov 2026)

- **Detection:** the object remembers the heads it has decided on, reviewed or skipped, and answers a repeat sweep without calling GitHub. A draft, a paused pull request or one `.andabot.yaml` skips is therefore not re-checked against GitHub every 15 minutes. A later push or command still reviews as normal.
- **Stuck reviews:** a review in progress past 30 minutes goes to its object; if nothing is running there, the review restarts once, under the same check run. If a review the sweep restarted is found stuck again, its check run is completed as `neutral` with a note that `@andabot review` retries.
- **Scope:** heads only. A dropped `issue_comment` or review-reply webhook (a mention, a reply on andabot's thread) is a follow-up issue, not this slice.
- **Cap:** none until #186. Every missed head found in a sweep is reviewed in that sweep. This departs from the issue, which asks for a per-sweep cap and a test that pins it; #186's daily spend cap is where the limit goes.
- **Live check:** after merge and deploy, Andrew unticks "Active" on the App's webhook, a push lands on a fixture pull request, the sweep reviews it within one sweep (`sweep.found` in Workers Logs), and Andrew ticks Active again.
- **Visibility:** a review the sweep started says so in one footer line of that run's summary comment and check run, and in no later run.
- **Reviews that ended without posting** (after the builder check): left alone. A review that failed, ended unposted, was abandoned by #118 or hit a final error already shows the author a failed check run with `@andabot review` as the way back. The sweep is for webhooks that never came, not reviews that ran.
- **Heads andabot could never see** (after the builder check): reviewed. A pull request open before the App was installed, or before its repository was added, looks to the sweep exactly like one whose `opened` webhook was dropped, and both get a review. The footer therefore states only what is known to be true (below). The cost is a one-time burst when the App is added to a repository.

### The sweep

A Cron Trigger, `*/15 * * * *` in `wrangler.jsonc` (`triggers.crons`), runs a `scheduled` handler beside `fetch` in `src/index.ts`. It lives in its own module, `src/sweep.ts`, and does this:

1. Mints an App JWT (`createAppJwt` with `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY`) and lists the App's installations, `GET /app/installations`, every page.
2. For each installation, fetches an installation token (`fetchInstallationToken`) and lists its repositories, `GET /installation/repositories`, every page.
3. For each repository, lists open pull requests, `GET /repos/{owner}/{repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`, reading pages until a pull request's `updated_at` is more than a day old. Drafts stay in the list, because a repository can turn on draft reviews (`reviews.drafts`), and the object decides. A pull request updated less than 5 minutes ago is left for the next sweep, since its webhook may still be on the way.
4. For each pull request, hands its object (`PULL_REQUEST.getByName(objectName(key))`) a sweep incoming, described below, through a new RPC method `sweep(incoming, version): Promise<SweepOutcome>`. `accept` can't serve: it answers `"accepted"` and runs the review under `waitUntil`. `sweep` makes its decision, answers it, and runs any review it starts under `waitUntil` as `accept` does. It stores the incoming under `delivery:<id>:review` first, so #118's retry covers a sweep review as it covers a webhook.

Each response crossing the boundary is parsed with a TypeBox schema and `Value.Check`, as the client's are. The sweep is a function of a GitHub reader and an object handle, both passed in, so tests drive it with a fake GitHub and a fake object through those real interfaces (no `vi.mock`).

_Builder's call:_ the sweep doesn't read GitHub check runs. Andrew's answer to the detection question said "every open head with no andabot check run", but the object already knows each head's state better than a check run does: posted (`posted:<sha>`), decided (the new decided record: skipped for settings, or a review that ended without posting), in flight (`pending` plus whether the harness is running its operation), or unknown. Asking the object costs no GitHub request, where reading check runs costs one per pull request per sweep. A check run left `in_progress` with no `pending` behind it, which only a failed completion PATCH could leave, is out of reach of this design. #118's retry already covers that PATCH. Cost if wrong: a stuck run of that kind stays stuck until the next push.

_Builder's call:_ the one-day window bounds how many objects one sweep wakes. A push whose webhook was dropped is caught by the next sweep, so the window only matters if the cron itself was down for a day.

_Builder's call:_ the 5-minute floor. Without it, a sweep that ticks seconds after a push races the push's own webhook; the floor makes that rare, and the object's flight rules settle what's left, as they do between two webhooks today.

### The sweep incoming

The sweep sends a `review` incoming with delivery id `sweep:<sha>`, `full: false`, no `requestedBy`, and a new optional field `sweep` holding the listing's facts: `{ draft, baseRef, title }`. Its trigger is `push`, so every `.andabot.yaml` skip rule applies as it does to a webhook push. `StoredIncoming` in `src/review/delivery.ts` gains the field; the webhook route never sets it. The object returns what it did as a `SweepOutcome`: `reviewed`, `restarted`, `gave_up`, or `known` with the reason it already had.

### What the object does with a sweep incoming

The sweep incoming goes through the same `review()` path as a webhook push, plus a fast path that runs before `freshPullRequest`, so a known head costs no GitHub request:

- **Paused:** skipped as today (this check already runs before any GitHub read).
- **Posted:** `posted:<sha>` exists. The object answers `known: already_reviewed`. Unlike a webhook push it doesn't re-evaluate approval: check-suite webhooks drive approval, and this slice covers heads only.
- **Decided:** a new storage key `decided` holds `{ headSha, reason, facts }`, where `facts` is `{ draft, baseRef, title }` when the exit had the pull request in hand, and absent when it didn't (#118's abandon holds only the pending). A head with no stored facts matches on its sha alone. It's written in three cases. One is when `review()` skips a head for a settings reason (`auto`, `draft`, `base_branch`, `title_keyword`, `path_filters`). Another is when a review of the head ends without posting: `failed` (`reportFailedReview`, the final-error catch, #118's `#abandonReview`), `unposted` (`reportUnpostedReview`) or `unchanged` (`skipUnchanged`). The third is when the sweep gives up on the head. Every exit that releases the `pending` without writing `posted:<sha>` writes `decided`, except `headMoved`, whose new head the sweep reaches on its own. `@andabot full review` deletes `posted:<sha>` and `decided` for its head before it runs, and if that review then ends without posting, its exit writes `decided` again. A sweep incoming whose head and facts match it is answered `known: <reason>`. A mismatch in the facts goes through the full path again: a draft marked ready for review whose `ready_for_review` webhook was also dropped is reviewed, not held by its old skip. A change to `.andabot.yaml` alone doesn't re-open a decided head; the next push applies it.
- **In flight:** a `pending` for this head that is running, or that started less than 30 minutes ago, is answered `known: in_progress`. Before 30 minutes, the webhook path and #118's retries are still in charge.
- **Dead:** a `pending` for this head, started 30 minutes ago or more, with nothing running. If the pending has no `sweepRestarted` mark, the object restarts the review under the pending's own check run and sets `sweepRestarted: true` (a new optional field on `StoredPending`). It answers `restarted`. Unlike the webhook's `replace … dead` path, this doesn't fail the old run and open a new one. The restart runs under a fresh operation id, `review:sweep:<sha>:restart`, with a new pending delivery id to match. Pi Durable treats a request id it has seen as the same submission, so reusing the dead operation's id could replay its old result instead of reviewing. If the pending is already marked, the object completes its check run as `neutral` (title "Review didn't finish", text "The review of `<short sha>` stopped twice without finishing. Comment `@andabot review` to try again."), releases the pending, writes `decided` with reason `gave_up`, and answers `gave_up`.
- **Unknown:** anything else is a head the object never saw. The incoming goes through `review()` exactly as a webhook push does: `freshPullRequest`, head checks, config, flight. The object answers `reviewed`, or `known: <reason>` when that path skips it. A late webhook for the same head that arrives after the review posted finds `posted:<sha>` and skips. One that arrives while the sweep's review is still in flight skips only while an operation is listed or the 2-minute grace holds. Otherwise its new delivery id replaces the sweep's run as dead, failing that run and opening its own. That is the same race two webhooks for one head have today. The 5-minute floor makes it rare, and this slice leaves it as it is.

_Builder's call:_ a webhook push skipped for settings also writes `decided`, so the first sweep after it doesn't re-read GitHub for that head.

### What the author sees

A review the sweep started or restarted carries one footer line in that run's summary comment and its check run: "Started by the 15-minute sweep: no webhook reached andabot for this push." for a review the sweep started (true whether GitHub dropped the webhook or the App couldn't see the repository yet), and "Restarted by the 15-minute sweep: the earlier review stopped without finishing." for a restart. The line is driven by a field on the pending, `sweep: "started" | "restarted"`, so it shows only on that run. It sits in the footer after the close lines and before "Reviewed by". A review that gave up shows only the neutral check run; the summary comment is left as it was.

### Logs

- `sweep.found`, once per head the sweep acted on, with `repo`, `number`, `head` (short sha) and `reason`: `unreviewed`, `restarted` or `gave_up`.
- `sweep.done`, once per sweep, with `installations`, `repositories`, `pulls`, `found` and `ms`. A sweep with `found: 0` is the quiet sweep the issue asks to count; Workers Logs counts them by query.
- `sweep.failed`, with the installation or repository and `errorText(cause)`, when a listing or a hand-off throws. The sweep goes on to the next installation or repository; one bad repository doesn't stop the rest.

### Non-goals

- Dropped comment, review-reply and check-suite webhooks (Andrew's scope ruling). File the comment case as a follow-up issue at merge.
- A cap on reviews started per sweep (Andrew's ruling; #186's spend cap).
- Noticing a `.andabot.yaml` change on a decided head.
- Pull requests not updated for more than a day.

### Constraints

- Cloudflare's per-invocation subrequest limit applies to the scheduled handler: each installation, repository page, pull request page and object hand-off is one subrequest. One installation with a few dozen repositories fits with room to spare. _Builder's call:_ if an installation's repository list is ever long enough to matter, a later slice can fan the sweep out per installation.
- The repository's lint rules: no comments, no type assertions, complexity at most 10, the anti-slop rules.
- `CheckRunConclusion` (`src/github/client.ts`) gains `"neutral"` for the give-up.

### Done when

- Tests pin which pull requests the sweep hands off (the one-day window, every page, every installation), the 5-minute floor, each object outcome above (posted, decided with matching and changed facts, decided by each no-post exit, in flight, dead and restarted under a fresh operation id, dead twice and given up, unknown and reviewed), the footer lines, and that a failing repository doesn't stop the sweep.
- `wrangler dev --test-scheduled` runs the handler locally against a fake GitHub (or `/__scheduled` on a local dev server).
- The live check passes: with the App's webhook inactive, a push to a fixture pull request is reviewed within one sweep, and its summary shows the "Started by the 15-minute sweep" line.

### Calls made after the builder check

- A review that ended without posting writes `decided` at each no-post exit (Andrew's ruling above); `headMoved` doesn't, since the sweep reaches the new head on its own.
- The 5-minute floor on `updated_at`.
- The footer's wording states what is known ("no webhook reached andabot"), which follows from Andrew's ruling that pre-install pull requests are reviewed.
- The restart's fresh operation id, so Pi Durable doesn't replay the dead submission.
- A new `sweep` RPC on the object that answers its decision, since `accept` answers before deciding.

### Rulings while building and after the review

Built inline from `docs/superpowers/plans/2026-11-01-sweep.md`, then reviewed whole-branch on opus (with fixes: no Critical, three Important, nine Minor).

- **The restart doesn't decide settings again.** It replays as a push, and `reviewTrigger` calls a replay with no `requestedBy` a push. So a commanded review on a draft, a "WIP" title or an `auto: false` repository would be settings-skipped on restart, and its run would stay in progress. A delivery that holds the `pending` passed the settings when it started, so `settledAtStart` skips `settingsSkip` for it. That covers #118's resumes too.
- **A stale exit doesn't write `decided`.** An exit writes `decided` only when no `pending` exists for its head, or when its own delivery holds it (`mayRecordDecided`). Otherwise an abandoned #118 rung, or a replaced run's final error, could hide a newer review of the same head from the sweep.
- **Only a settings skip keeps the facts.** `failed`, `unposted`, `unchanged` and `gave_up` match on the head alone. So a title edit doesn't re-run a review that ran, per the "left alone" ruling.
- **A restart is accounted on its own.** It drops the dead run's `rejectionsReturned`, `activated` and `usageBefore`, and takes a fresh usage baseline. So its first flawed submission gets its round of feedback, and the dead run's spend isn't charged against `MAX_REVIEW_NEURONS`.
- **A new review clears the record.** Any review that starts a new `pending` deletes `decided`, not only `full review`. So a dead `@andabot review` retry of a failed head is restarted.
- **The started line names the deploy's login.** It names `BOT_LOGIN`, as the commands line and the give-up run do.
- **`reviewed` at hand-off.** The RPC answers `reviewed` once the review is handed to `waitUntil`, since awaiting it would hold the cron. A never-seen head that `.andabot.yaml` skips is logged once as `sweep.found` `unreviewed`. After that, `decided` answers for it.
- **The check run's summary is the comment.** The posted check run's summary is the summary comment, so it carries the sweep line with no separate append.
- **Before the deploy there's no `decided`.** In the first day after the deploy, a head whose review failed, ended unposted or ended unchanged before it, and was updated that day, is reviewed once more, with the started footer. This is documented in `docs/design.md`, not coded.
- **Deferred minors:**
  - The ids `sweep:<sha>` and `review:sweep:<sha>:restart` aren't unique per attempt.
  - Unposted and failed runs don't carry the sweep line.
  - One App JWT mints every installation's token lazily.
  - Suspended installations log `sweep.failed` every sweep.
  - "For this push" is loose for a facts-changed re-review.
  - A never-seen head that settings skip counts once in `found`.
  - Every sweep rewrites `key`.

## Slice 2, #186: a daily spend cap stops new reviews

### Why

#115 caps what one review spends (`MAX_REVIEW_NEURONS`), and the sandbox is capped per review and by its lease. Nothing caps what a deploy spends in a day. Cost isn't the risk, a loop is: a webhook storm, a bot pushing every minute, a retry bug, or #189's sweep (whose own cap was left to this slice) could spend without limit, and nobody would know until the bill.

### Andrew's rulings (grill, 1 Nov 2026)

- **Q1, what stops:** every model call. Reviews (push, sweep, `@andabot review`, `full review`, a `resume` that reviews) and questions (`@andabot <anything else>`, thread replies). A refused question gets a one-line reply. `help`, `pause`, `resume` (when it doesn't review), `resolve` and `summary` keep working. Questions' spend counts toward the day.
- **Q2, sandbox:** the cap counts model neurons only. The ledger also keeps the day's sandbox seconds for the log; they never trip the cap.
- **Q3, reserve:** a starting review reserves its per-review budget, `min(MAX_REVIEW_NEURONS, MAX_DAILY_NEURONS)`, and is refused if spent + reserved would pass the cap. When it posts or fails, the reservation is swapped for its real spend. A review that dies without ending keeps its reservation until midnight UTC. The cap ÷ 10,000 also bounds how many reviews run at once.
- **Q4, default:** `MAX_DAILY_NEURONS` = `200000` ($2.20 a day, about 100 reviews and 20 at once), in production and staging.
- **Q5, scope:** each deploy keeps its own ledger and cap. The Cloudflare billing notification is the account-wide backstop.
- **Q6, after midnight:** a `daily_budget` skip isn't recorded as `decided`, so the first sweep after midnight UTC reviews the head (the new day's cap still applies). The object remembers it already showed this head's skip today and stays quiet on repeat sweeps.
- **Q7, summary:** a line edited into the existing summary, as the paused line is; a pull request with no summary gets the unposted one with that line. The check run completes `neutral`, titled "Daily review budget spent". The next review's summary has no line.
- **Q8, 80% alert:** log events now; #182 routes them. `budget.daily_warning` once a day when spent + reserved first passes 80%, `budget.daily_spent` once when the ledger first refuses a start. A comment on #182 adds both to its alert list.
- **Q9, Cloudflare billing notification:** I find the usage-based billing alert for Workers AI (and Containers, if offered) through the Cloudflare API, show Andrew the exact policy (about 1.5× the cap over a month: ~10M neurons, ~$100), and create it only on his yes. `docs/setup.md` records it.
- **Q10, live check:** staging, deployed from the branch with `wrangler deploy --env staging --var MAX_DAILY_NEURONS:10000`, on a fixture pull request: a tagged review posts; a push and a second tag get the neutral run, the summary line, `review.skip` `daily_budget` and `budget.daily_spent`; a question gets the budget reply. Staging's sweep skips (`AUTO_REVIEW` false), so the midnight pickup is pinned by tests, and the next UTC day a tag reviews again.
- **Q11, ledger down:** fail open. `budget.ledger_unreadable` (an error log), and the review or question runs uncounted.

### The ledger

A new Durable Object class, `DailySpend` (`src/budget/daily-spend.ts`, migration `v4`, binding `DAILY_SPEND`), one object per UTC day by name (`2026-11-01`). Its state is one stored record, parsed with TypeBox on read:

- `spent`: neurons settled today.
- `sandboxSeconds`: sandbox seconds settled today.
- `reservations`: holder → neurons, the holder being `<owner>/<repo>#<number>:<deliveryId>`.
- `warned`, `refused`: whether today's `budget.daily_warning` and `budget.daily_spent` have been logged.

RPC:

- `reserve(holder, neurons, cap)` → `{ granted, spent, reserved }`. Refused when `spent + reserved + neurons > cap`. Reserving a holder twice is granted without adding (a #118 retry or a resume).
- `settle(holder, neurons, sandboxSeconds)`: drops the holder's reservation and adds the real spend. Settling an unknown holder still adds the spend (a review that started under a ledger outage).
- `room(cap)` → `{ open }` for a question: open while `spent + reserved < cap`.
- `add(neurons)`: a question's spend.

The day math lives in pure functions (`src/budget/ledger.ts`) that the object calls, so tests pin them without a Durable Object: `reserveIn`, `settleIn`, `roomIn`, `crossings` (which of warn/refuse to log), and `utcDay(ms)`. The object sets an alarm eight days on that deletes its storage, so old days don't pile up.

The pending review gains `ledger: { day, holder, reserved }`. Settlement goes to the day the review started, so a review that crosses midnight is charged to the day that let it start.

### Where the object checks

In `review()`, after `headSkip` and `settingsSkip` and before `clearFlight`, so a draft, a path-filtered push or a reviewed head never touches the ledger. A resume of the review's own `pending` (`flight.kind === "resume"`) doesn't reserve again; it carries the pending's `ledger`. A sweep restart keeps the dead run's `ledger` too (`restartedPending` carries it), so its settlement swaps the dead run's reservation for the restarted run's spend, and the dead run's own spend goes uncounted.

Each exit that ends a run settles it: `releasePending` after a post, `reportFailedReview`, `reportUnpostedReview`, `skipUnchanged`, the thrown-and-released path, the sweep's give-up, a replaced run (`clearFlight`) and a superseded head (`headMoved`). One helper, `settleLedger(pending)`, reads `reviewSpend` and `#sandbox.seconds()` and calls `settle`, best-effort (`budget.ledger_unreadable` on a throw).

In `answer()`, before `setModel`: `room(cap)`; refused → reply "Today's review budget is spent, so I can't answer until midnight UTC." and log `answer.skip` reason `daily_budget`. After the prompt: `add(neuronsSince(before, after))`.

### What the author sees

- **Check run:** created and completed at once as `neutral`, title "Daily review budget spent", summary "This deploy's daily model budget is spent. `abc1234` is reviewed after midnight UTC, or comment `@andabot review` then." A repeat skip of the same head on the same day creates no second run.
- **Summary comment:** the budget line, inserted after the header like the paused line, with its own marker `<!-- <login>:budget -->`: "⏳ Today's review budget is spent: `abc1234` is reviewed after midnight UTC." Written once per head per day (`budgetSkip: { head, day }` in storage); `upsertSummary` for the next review replaces the whole body, so the line goes with it.
- **A tagged review** (`@andabot review`) also gets the reply through `skippedReviewText`: "Today's review budget is spent, so I can't review `abc1234` until midnight UTC."
- **A paused pull request** keeps its paused line; the two lines can sit together.

### Logs

- `review.skip` reason `daily_budget`, with `number`, `head`, `day`, `spent`, `reserved`, `cap`.
- `answer.skip` reason `daily_budget`.
- `budget.daily_warning` (once a day), `budget.daily_spent` (once a day), from the ledger, with `day`, `spent`, `reserved`, `cap`.
- `budget.settled`, from the ledger on each settle, with `holder`, `neurons`, `sandboxSeconds` and the day's `spent`, so Workers Logs can sum a day without the object.
- `budget.ledger_unreadable` (error), with `when`: `reserve`, `settle`, `room` or `add`.

### Non-goals

- A ledger shared between production and staging (Q5).
- Counting sandbox seconds against the cap (Q2).
- Sending the 80% alert anywhere but the log (Q8; #182).
- Refunding a dead review's reservation before midnight.

### Constraints

- `MAX_DAILY_NEURONS` is parsed like `MAX_REVIEW_NEURONS`: anything but a positive whole number falls back to the default. `test/wrangler.test.ts`'s parity check covers the staging copy.
- `CheckRunConclusion` already has `neutral` (#189).
- The repository's lint rules.

### Done when

- Tests pin the ledger (reserve, refuse at the cap, a repeated reserve, settle swapping reservation for spend, settle of an unknown holder, room, the 80% and 100% crossings logged once), the skip (neutral run, summary line, no ledger call for a settings skip, a resume not reserving twice, a repeat sweep staying quiet), a question refused and a question's spend added, the reset at midnight UTC (`utcDay` and a review settled into its start day), fail-open on a throwing ledger, and the env parsing.
- `docs/setup.md` documents `MAX_DAILY_NEURONS`, the events and the billing notification; `docs/design.md` gains the daily cap beside the per-review one.
- The staging live check (Q10) passes and #182 has the comment adding the two events.

### Calls made while planning

- One object per day by name, as the issue asks, rather than one object with a key per day: no cross-day contention, and the alarm cleans a day as a unit.
- A question needs no reservation: it's one short call, and refusing at `spent + reserved ≥ cap` keeps it under the cap but for that call.
- A question that runs while a review of the same object is open can be counted twice (once in its own `add`, once in the review's usage window). Small and only ever over; accepted.
- `budgetSkip` is a separate key, not a `decided` reason, so the sweep's `decideSweep` stays as it is.
