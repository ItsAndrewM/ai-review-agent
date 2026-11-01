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
