# Sandbox tier (phase 3): design

Agreed with Andrew in a grill-me on 28 Oct 2026, after the phase was broken into #131 to #135. The questions are numbered Q1 to Q7 below; anything marked _builder's call_ is open to the plan.

## Why

`docs/design.md` gives phase 3 three lines: a Container per review run, started from the PR object under the Durable Object scheduling policy, outbound HTTP intercepted so it reaches only GitHub, a one-minute alarm while a check runs, a 30-minute inactivity timeout, and lint, typecheck and tests on the head with the tail fed to verify. The sentence paraphrases Cloudflare's [coding agent runner](https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/), where the agent runs inside the container and needs a model gateway; andabot's model calls stay in the Worker, so the sandbox needs no model host.

Nothing of it exists. The repository's CI already runs `pnpm check` on every pull request, and andabot already waits on those check runs for approval, so a sandbox that ran the same suite would duplicate CI at container prices.

## Purpose (Q1)

The sandbox gives the review what CI can't:

- **Targeted runs the model picks**, such as one test file or one package, so a finding can be confirmed in seconds instead of inferred.
- **Checks for a repository with no CI.**

The full suite stays CI's job. Verify's use of the results waits on #129 (Q7).

## The tool (Q2)

`run_check(name, paths?)`: `name` is `lint`, `typecheck` or `test`, and `paths` is a list of repository paths the host validates against the checkout (not against the diff, since the test for a changed function lives elsewhere) and against a safe pattern (no shell metacharacters, no `..`) before they fill a template. The model never writes a shell string.

The commands come from a `checks` map in `.andabot.yaml` at the base commit, each a template with a `{paths}` slot:

```yaml
checks:
  lint: "pnpm oxlint {paths}"
  typecheck: "pnpm tsc --noEmit"
  test: "pnpm vitest run {paths}"
```

A command without the slot ignores paths. With no map, the host falls back to runners it recognises in `package.json` at the base: vitest, jest, oxlint, eslint and tsc. (#133)

## Trust (Q3)

Every pull request runs checks, bounded by caps rather than by who opened it:

- no secret enters the container: the installation token lives in the outbound handler;
- egress is an allowlist: `github.com` and `registry.npmjs.org`, over HTTPS only, nothing on any port but 80 and 443 (`codeload.github.com` was in the first draft, but the checkout is a git fetch, which `github.com` serves);
- installs run with lifecycle scripts off;
- each check has a timeout, each review a sandbox budget.

Gating on `author_association` would keep the tier off where a second pair of eyes matters most.

## Caps (Q4)

- Instance `standard-1`: half a vCPU, 4 GiB, 8 GB disk. `basic`'s 1 GiB is tight for tsc plus vitest, and its 4 GB disk leaves little after this repository's 475 MB install.
- `SANDBOX_CHECK_TIMEOUT`: 5 minutes per check.
- `MAX_SANDBOX_SECONDS`: 15 minutes of wall time per review across checkout, install and checks.
- At most 3 containers running at once.

Cost at `standard-1` rates (vCPU $0.000020/s, memory $0.0000025/GiB-s, disk $0.00000007/GB-s): about half a cent for a review that installs and runs one check, two cents for a hostile review that spends its whole budget. The Workers Paid allowance (375 vCPU-minutes and 25 GiB-hours a month) covers roughly 90 such reviews before billing; memory is the binding allowance.

**Found while building #131:** under the `durable_object` scheduling policy wrangler rejects `max_instances`, `instance_type` and the rollout settings; the instance type goes to `ctx.container.start()`, and the cap of 3 has to be a lease the host hands out, with an expiry so a crashed review frees its slot. The lease belongs with the lifetime in #132.

## Start (Q5)

Lazily, on the first `run_check` call, as the snapshot loads on the first `grep` or `tree` through `SnapshotRuns.access`. Most reviews never ask for a check, so an eager install on every review, docs-only ones included, would be waste. The first call waits two to three minutes for the install inside the tool call, which Pi Durable allows (no tool timeout; its own `bash` tool has none) and the object stays alive for. If #135's measurement shows the model calling on most reviews, start eagerly behind the same interface. (#132)

## Verdict (Q6)

A check result is evidence the model cites. The host never writes a finding from a check, and andabot's own check run never goes red because a test failed. A `defect` finding may carry a check reference (name, paths, exit code), validated against the review's cached runs, so the summary can link the finding to the run it rests on. The basis rules stand: a `test` finding can't be blocking, so a change that breaks a test is a `defect` with the run as its failure scenario. The summary gets a Checks line listing what ran and how it ended; a failing run nobody cites is listed and nothing more. (#133, #134)

## Verify (Q7)

Deferred to #129. Verify ships off and no model has cleared the replay bar, so check evidence in its prompt could only be measured by replay, where no check ever ran. When a model passes, verify should get the cached runs: a `## Checks` section and `run_check` beside its three tools, answering from the cache.

## Settled by numbers and code rather than asked

- **Container lifetime.** A `standard-1` instance idling for its 30-minute timeout costs about 18 installs, so the review that started the sandbox destroys it when it ends, superseded included. The timeout stays as a backstop.
- **Container identity.** One `ReviewSandbox` Durable Object per pull request, a class of its own, separate from `PullRequest`, so its restarts and its lease apply to it alone.
- **Checkout.** A shallow fetch of `refs/pull/N/head` at the review's head sha from the base repository, so a fork's head and a private repository both work with the installation token the outbound handler adds.
- **No `@cloudflare/sandbox`.** The design's package table pins it at 1.0.1 for the Containers tier, but the runtime's `ctx.container.exec(cmd, options)` returns an `ExecProcess` whose `output()` gives stdout, stderr and the exit code, and `Files` from that package only streams files through a shim the image would have to carry. The tier uses the runtime API alone; the package is not added and the table row goes.
- **`migrations` stays.** wrangler's `exports` field and `migrations` are mutually exclusive, and `PullRequest` is declared through `migrations`, so `ReviewSandbox` joins as migration `v2` and the container entry links by `class_name`.

## Slice 1, #131: image, container object, outbound policy

### Image

`container/Dockerfile`, with `build_context` set to `./container` so the 475 MB `node_modules` never enters the build context:

- `FROM node:22-bookworm-slim`, Node 22 as CI runs;
- `apt-get install --no-install-recommends ca-certificates git`, since the checkout is a git fetch;
- `npm install --global pnpm@10.0.0`, the version `package.json`'s `packageManager` pins;
- `WORKDIR /workspace`, `CMD ["sleep", "infinity"]`.

No shim, no Claude Code, no ripgrep: the model's `grep` runs against the snapshot in the object, not in the container.

### Configuration

```jsonc
"containers": [{
  "class_name": "ReviewSandbox",
  "scheduling_policy": "durable_object",
  "images": { "review": { "dockerfile": "./container/Dockerfile", "build_context": "./container" } },
}],
"durable_objects": { "bindings": [..., { "name": "REVIEW_SANDBOX", "class_name": "ReviewSandbox" }] },
"migrations": [{ "tag": "v1", ... }, { "tag": "v2", "new_sqlite_classes": ["ReviewSandbox"] }],
```

The Worker's entry exports `ReviewSandbox` and `Outbound`, the latter so `ctx.exports.Outbound` is typed and reachable.

### Outbound policy

`src/sandbox/policy.ts` decides, as a pure function of the request's URL, the allowlist and whether a token is held:

- not HTTPS: refuse, "reachable only over HTTPS";
- host not in the allowlist: refuse, "not reachable from this sandbox";
- `github.com` with a token: forward with `Authorization: Basic <x-access-token:token>` set, the form GitHub documents for installation tokens on git over HTTPS, and any `Authorization` the container sent dropped;
- any other allowed host: forward as sent.

`src/sandbox/outbound.ts` is the `WorkerEntrypoint<Env, OutboundProps>` that applies it: its props carry the token, and `ReviewSandbox` attaches it with `interceptAllOutboundHttp` and `interceptOutboundHttps("*", ...)`, as the guide does. The container trusts the interception CA through the environment of every command it runs: `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE` and `SSL_CERT_FILE` at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`.

### The object

`src/sandbox/review-sandbox.ts`, `ReviewSandbox extends DurableObject<Env>`, reached over RPC:

- `start(token)`: starts the container from `images.review` as `standard-1` with `enableInternet: false`, attaches the outbound entrypoint with the token as its props, sets the 30-minute inactivity timeout, and logs `sandbox.start`. A running container gets the timeout and the interception again, since neither survives an object restart. A failure destroys the container and throws, so the next start is clean.
- `run(command, options)`: runs `command` (an argv array, never a shell string) in `cwd` with the trust environment and `options.env`, under a wrapper that puts it in its own process group and writes its output to files, so a timeout can kill the group and the result can be read after the object restarts; waits up to `timeoutMs`, then kills the group. Returns `{ outcome: "exited", exitCode, tail }` or `{ outcome: "timeout", tail }`, with `tail` the last `tailBytes` of combined output (8 KiB by default, 50 KiB at most) and whether it was cut. Logs `sandbox.run` with the command's first word, the outcome, the exit code, the milliseconds and the bytes of output.
- `running()`: whether the container is up.
- `destroy()`: stops the container at once and logs `sandbox.destroy`.

`start` and `run` are the whole surface #132 needs; the alarm, the checkout, the install and the lease are #132's.

### The probe

Nothing calls the object until #133, so the live check needs a way to drive it by hand: `POST /sandbox-probe`, on only while the Worker var `SANDBOX_PROBE` is `true`, signed with the webhook secret like a delivery, taking a pull request key, an action (`run` or `destroy`), and for a run the argv, `cwd`, `timeoutMs` and `tailBytes`. It mints the installation token, starts the sandbox with it, runs the command and answers the outcome. It goes once `run_check` exercises the sandbox.

### Tests

Pure modules, no container: the policy's decisions (allowed host, other host, HTTP, the token on `github.com` only, a container-sent `Authorization` dropped), the wrapper script's shape, the tail's cut and its note, the outcome from an exit code or a timeout. The object itself is checked live, as `PullRequest` is.

### Docs

`docs/setup.md`: `pnpm run deploy` needs Docker running, since `wrangler deploy` builds the image; CI is unchanged. `docs/design.md`: the package table row, the execution tiers' phase 3 sentence, and the sandbox events. The README status line waits for the slice that turns the tier on.

## Slice 2, #132: checkout, install, lifetime, lease

What #131's live check settled is carried in: the kill signal's form, a PID 1 that reaps, a token minted for the sandbox alone with `contents: read` on the reviewed repository, redirects handed back to the container, and `max_instances` being unavailable under the `durable_object` policy.

### Access

`SandboxRuns`, beside `SnapshotRuns`, is the host's view of the sandbox for one pull request: `start()` and `end()` bracket a review as the snapshot's do, and `access()` is what `run_check` (#133) calls. On the first call it takes a lease, mints the scoped token, starts the container, checks out the head and installs, and answers `ready` with the sandbox stub and the repository directory; a later call answers from memory; a failure answers `unavailable` with its reason for the rest of the review (`head`, `lease`, `start`, `checkout`, `install`), whether the step reported a failure or threw, and a spent budget answers `spent`. The runs count the reviews active on the object, as the snapshot's do: a replaced review's end destroys nothing while its replacement is active, a `closed` event destroys only when no review is active, and a call for a head other than the one prepared ends the old sandbox first. The tier is off when the Worker var `SANDBOX` isn't `true` or the base's `.andabot.yaml` sets `reviews.sandbox: false`.

### Checkout and install

The checkout fetches the head commit by its sha, shallow, into `/workspace/repo`: GitHub serves a reachable commit by sha, which covers a fork's head through the base repository without naming a ref that may have moved since the review started. The script fails if `HEAD` after checkout isn't the sha. The working tree is capped at 512 MiB (`du -sk` after the fetch); over the cap, the sandbox is destroyed and the review goes on without it.

The install detects the package manager from the lockfile in the checkout: `pnpm-lock.yaml` runs `pnpm install --frozen-lockfile --ignore-scripts`, `package-lock.json` runs `npm ci --ignore-scripts`. A repository with no lockfile gets no install and the checks run against what is there. _Builder's call:_ `yarn.lock` is treated as no install, since the image carries pnpm and npm only; a repository on yarn is a follow-up with the image change it needs. Checkout and install each get a timeout of 5 minutes, and all of it counts against the review's sandbox budget.

### Lifetime and lease

The review that started the sandbox destroys it in the same `finally` that ends the snapshot run, and a closed pull request destroys it too. A newer head that replaces a review ends through the same path when the replaced review exits. On the container object, every `run` sets a one-minute alarm that reschedules itself while a run is in flight and clears when none is, so a container doing work is never idle to the platform.

`SandboxLeases` is one Durable Object instance, named `leases`, that caps the running sandboxes at three across every pull request: `acquire(holder, ttlMs)` grants a slot when fewer than three live leases exist, dropping expired ones first, and `release(holder)` frees it. The ttl is the sandbox budget plus a two-minute grace, so a review that dies holding a lease frees its slot on its own. The decisions are a pure module; the object stores the map.

### Budget

`MAX_SANDBOX_SECONDS`, 900 by default, parsed as the other vars are: wall time since the sandbox's first call. Past it, `access()` answers `spent`, which `run_check` turns into its answer that the sandbox budget is spent.

### Probe

The probe gains `prepare`, which drives `SandboxRuns.access()` on the pull request object, so the live check exercises the real path: the lease, the scoped token, the checkout and the install, with their timings in the logs. The review that follows a push then destroys the sandbox at its end, which is the lifetime's live evidence.

### Logs

`sandbox.checkout` (`number`, `sha`, `kib`, `ms`), `sandbox.install` (`number`, `manager`, `exitCode`, `ms`), `sandbox.failed` (`number`, `step`, `reason`), `sandbox.unavailable` (`number`, `reason`), `sandbox.spent` (`number`, `seconds`, `budget`), and `sandbox.destroy` gains `number` and `seconds`. `review.done` gains `sandboxSeconds` when the sandbox ran.

## Slice 3, #133: `run_check(name, paths)`

The tool the model calls, on top of slice 2's `SandboxRuns.access()`.

### The tool

`run_check(name, paths?)` is offered to the review's root session beside `grep` and `tree`, `replay: "unsafe"`. `name` is `lint`, `typecheck` or `test`. `paths` is an optional list of repository paths; each must match `^[A-Za-z0-9_@+./-]+$`, hold no `..` segment and not start with `/` or `-`, and must exist in the checkout, which one `test -e` run confirms before the command runs. The tool answers in text: the command's exit code and the last 8 KiB of its combined output, cut and marked when longer; `timeout` after `SANDBOX_CHECK_TIMEOUT` (300,000 ms by default); and a sentence when the sandbox is `off`, `spent` or `unavailable`, with the reason, so the model goes on without it.

_Ruling:_ the tool is offered whether or not the tier is on, since the extension's tool list is fixed per object and the preamble can't read the base config; an `off` answer costs one call. The preamble names `run_check` beside the other tools.

### Commands

A `checks` map in `.andabot.yaml`, read at the base commit, gives each name a template with a `{paths}` slot, as the spec's Q2 says; the template is split on whitespace into argv and the slot becomes the paths, each its own argument, so the model's paths are never shell text. A template without the slot ignores paths. With no entry for the name, the host reads `package.json` at the base and picks a runner it knows, run through the manager slice 2 detected (`pnpm exec` or `npx --no-install`): `lint` → `oxlint {paths}` or `eslint {paths}`; `typecheck` → `tsc --noEmit`; `test` → `vitest run {paths}` or `jest {paths}`. A name with neither answers that the repository has no such check. Every check runs in `/workspace/repo` with `NO_COLOR=1`, `FORCE_COLOR=0` and `CI=1`, so the tail is plain text.

### Runs

A run is cached per head, name and paths for the length of the review: a repeated call answers the stored result and logs `check.cached`. One check runs at a time on a pull request. Each run counts against the sandbox budget through `access()`'s clock, and the review's neuron budget blocks the tool as it blocks every other past the budget.

### The finding's reference

A finding may carry `check: { name, paths?, exit_code }`. `validateFindings` takes the keys of the review's runs and rejects, as unfounded, a finding whose reference names a run that didn't happen or an exit code it didn't have, so a `defect` finding that rests on a failing test names a run that is on record. The summary's use of the reference is #134.

### Logs

`check.run` (`number`, `name`, `paths`, `outcome`, `exitCode`, `ms`, `bytes`, `cut`), `check.cached` (`number`, `name`, `paths`), `check.refused` (`number`, `name`, `reason`: `off`, `spent`, `unavailable`, `no_command`, `bad_path`, `missing_path`).

### Access order

`access()` answers from its memo before it asks whether the tier is on, since the second live-checked `prepare` spent 6.7 s in that check; the tier is read once per preparation.

## Slice 4, #134: the Checks line and the cost line

What the reader of a review sees of the sandbox. Verify's half stays deferred to #129.

### The summary comment

A `Checks` line under the walkthrough, after the dropped-findings line and before the Verify section, from what the review's `SandboxRuns` and its run cache hold when the review posts:

- no line at all when the review never asked for the sandbox, since with the tier off by default a `none` would sit on every review everywhere (ruled in the build; `none` is what a review that asked and ran nothing shows);
- `**Checks:** off` when the tier was off for the repository or the Worker;
- `**Checks:** unavailable (install failed)` when preparation failed, with the step;
- `**Checks:** spent` when the budget was spent before any run;
- otherwise one entry per run, in the order they ran: `test on \`test/x.test.ts\`: passed in 3.1s`, `lint: failed (exit 1) in 2.1s`, `typecheck: timed out after 300s`; a run with no paths names only the check.

Each failed or timed-out run gets a collapsed `<details>` block headed `test on test/x.test.ts, exit 1` holding its tail, cut to its last 2,000 characters and fenced; at most five such blocks are embedded, the first five failures, and a line counts the rest, so the reader sees what the model saw without the comment growing past GitHub's 65,536-character limit.

A finding that carries a `check` reference renders one more line in its inline comment, after the basis: `_Check: test on \`test/x.test.ts\` exited 1_`, so the thread shows the run the finding rests on.

### The cost line

The footer's cost line gains the sandbox's wall time when the review asked for the sandbox: ` · sandbox 2m 14s ($0.0028)`, priced at the `standard-1` rates the spec's Q4 records (half a vCPU at $0.000020 per vCPU-second, 4 GiB at $0.0000025 per GiB-second, 8 GB disk at $0.00000007 per GB-second: $0.00002056 a second), the seconds from `SandboxRuns.seconds()` at post time. The Workers Paid plan's monthly allowance (375 vCPU-minutes, 25 GiB-hours) is noted in `docs/setup.md` beside the var. `review.done` gains `sandboxUsd` beside `sandboxSeconds`.

### The record

`posted:<sha>` gains `sandboxSeconds` and `checks`, the runs as `{ name, paths, outcome, exitCode, ms, tail }`, so a later re-render of the same head (a run that finds the head posted) and the logs agree with the comment, and so #135's measurement can read the runs from the record.

### Logs

`review.done` gains `sandboxUsd` and `checks` (the count of runs). No new events.

## Slice 5, #135: the measurement, the abuse ceiling and the default

Measured on 29 Oct 2026 on build 44c8aedb (main 0139fec with `--var SANDBOX:true`), on three fixture pull requests from the base `main-with-checks`, which adds `.andabot.yaml` with `checks.typecheck: pnpm typecheck` (this repository's typecheck needs `wrangler types` first, seen on #133's live check) and a test pinning the zero parts of the duration text: #142 (a refactor that drops those parts, a test failure the diff doesn't show), #143 (a widened return type whose one caller needs a number, a type error outside the diff) and #144 (docs only). The tables are on #135; `docs/design.md` carries the summary and the ceiling.

### Rulings

- **`SANDBOX` defaults to `true`.** GLM-5.3 Flash found both plants with the tier off, so the sandbox's value is the evidence, not the catch: with the tier on it ran the one test file and the typecheck, cited the runs, and spent $0.002 to $0.003 of container time a review, with the model's spend in the same range as before (337 against 430 neurons on #142, 949 against 646 on #143). The docs-only review never asked for the sandbox either way.
- **Every pull request runs checks**, a stranger's included, as Q3 ruled; the bound is the caps. One review spends at most about 1,200 s of `standard-1` ($0.025), or $0.037 if it dies and the 30-minute backstop ends the container (#140); three leases across pull requests cap the account at $0.22 an hour. The included 25 GiB-hours cover 22,500 s a month, which the earlier "roughly 90 such reviews" in `docs/setup.md` overstated: 25 full budgets, or about 300 reviews like #142's.
- **The lazy start stays** (Q3). `run_check` was called on 2 of 3 reviews, the two with a suspected failure; the install is 38 s of #142's 77-second sandbox, which an eager start would spend on every review.
- **Targeted runs, not the suite**, recorded in `docs/design.md` as the reason: CI already runs `pnpm check` on every pull request and andabot waits on it for approval.

### Seen and left

- #143's finding quoted the TS2322 line in its basis but set no `check`, so no `_Check:` line rendered; the reference is optional and nothing was rejected.
- The Checks line shows the paths the model named for `typecheck` although the template has no `{paths}` slot and the command ignored them.
- The install took 38 s in production against 16 s in #132's local live check.
- Kimi K2.7 Code's run (build 3ba59b79, 19:25Z, Andrew ran the deploy): same recall as GLM, a matching `check` on both findings, no false positive on #144, but every check it could run on each code change (three each, a typecheck of #142 included), so 244 s and 255 s of sandbox time against GLM's 77 s and 141 s, still half a cent beside Kimi's $0.036 and $0.125 of model cost. #143 ended at 11,401 neurons with `budgetBlocked: 0`: the budget was passed on the last call, so there was nothing to stop.
- `oxlint` 1.88.0 panics in the container (`crates/oxc_allocator/src/pool/fixed_size.rs:112:67: called Result::unwrap() on an Err value: ()`, then `SIGABRT`) on `pnpm exec oxlint <paths>`, both times Kimi ran `lint`. The `lint` check is unusable on this repository in the sandbox until that is understood; neither review cited the crash as a defect. Follow-up issue filed from #135.

## Slice 6, #140: the sandbox's state survives an object restart

### Why

`SandboxRuns` (slice 2) and the `run_check` cache (slice 3) live in the pull request object's memory. A review's tool calls run inside one live object, so a restart mid-review is rare, but a redeploy, an eviction or an exception restarts the object while Pi Durable carries the review's operation on: the next `run_check` lands on a fresh instance that remembers nothing. Today that instance prepares again (a second lease call, a second checkout and install in the container that is still up), its `end()` finds nothing to destroy, so the container runs to its 30-minute inactivity timeout and the lease to its ttl, and a finding's `check` reference is rejected as unfounded because the cache that would vouch for it is gone. #133's live check saw the shape of it through the probe when `wrangler dev` evicted the object between two requests. #135's ceiling counts the leak: a review that dies this way pays the backstop, $0.037 instead of $0.025, and holds one of the three leases for up to 17 minutes.

### The record

`SandboxRuns` keeps what a restart must not lose in one record the host stores for it: the head (`number`, `key`, `sha`), `started` (the wall clock at the first call, which the budget is measured from), `leased` and `running` (what the earlier instance took and started), the settled answer when there is one (`ready` with the manager, or `unavailable` with the step), and the check runs, each as the `posted:<sha>` record keeps them plus `cut`, since the model's answer and the summary's block are rebuilt from the stored run. The record is written at each step that changes what a teardown would have to undo (the head read, the lease, the start, the settled answer) and after each check run, and deleted when the teardown finishes. The host gives `SandboxRuns` two more calls, `load()` and `save(record | undefined)`, which the pull request object answers from its storage under the key `sandbox`.

_Builder's call:_ the issue puts the record under `pending`; it lives beside it instead. `pending` is rewritten whole when a review starts and deleted by the replacement path before the replacing review runs, which is exactly when a restarted object needs the old record to tear the old head's container down, and the sandbox outlives a replaced review while its replacement is active. The two records are tied by behaviour rather than by nesting: every path that releases a review's `pending` also asks the runs to drop an idle sandbox.

### Restore

Every call on `SandboxRuns` begins by restoring once per instance: if memory holds no head and a record is stored, the record becomes the memory. A restored `ready` answer carries the sandbox stub the host hands out for the pull request, so the next `run_check` runs in the checkout the earlier instance made, with no second lease, start, checkout or install; the restored `started` keeps the budget's clock where it was; the restored runs answer repeated calls from the cache and vouch for `check` references at submission. `seconds()`, `status()` and the check cache become asynchronous so that a restarted object's posting path reads the restored state too. The restore logs `sandbox.restored` with `number`, `sha`, `kind` (`ready` or `unavailable`), `checks` and `seconds`.

A restored record whose head is not the pull request's current head is torn down as a new head's is today, through `#forgetOtherHead` on the next access, and by the next `end()` or `dropIdle()` otherwise.

### A lost container

A stored `running` says the earlier instance started the container, not that it is still up: the platform may have stopped it, and locally `wrangler dev` stops it with the dev server. So a restore of a `ready` record asks the sandbox object whether its container is running (`running()`, which the object already has, joins `SandboxCalls`). When it isn't, the restore logs `sandbox.lost` (`number`, `sha`, `seconds`), releases the lease the record says it holds, keeps the record with its flags cleared (the head and the clock stay, so a second restart still finds them) and prepares afresh on the next access, with the budget's clock kept from the stored `started`, so a review never pays twice for a sandbox and a crash never extends what a pull request can spend.

### Teardown after a restart

The paths that end a review on a restarted object run without `runReview`'s `finally`: the resumed operation posts through `submit_review` and `endOwnRun` releases the `pending`; a review the harness no longer runs is replaced as `dead` by the next delivery for the same head, and one for a newer head is replaced as `superseded`, both of which delete the `pending` in `clearFlight`. `endOwnRun` and `releasePending`, after they release the `pending`, call `dropIdle("review_end")`; `clearFlight` calls `dropIdle("new_head")` for a superseded review only. On a live object the review is still active and `dropIdle` does nothing, since the review's own `end()` follows; on a restarted object nothing is active, the restore brings the record back, and the teardown destroys and unleases what the earlier instance started, logging `sandbox.destroy` as it does today. A `closed` event on a restarted object does the same through the existing `dropIdle("closed")`.

_Builder's call:_ a `dead` replacement is always at the same head, so the replacing review inherits the sandbox: its first `run_check` restores the record, keeps the clock and runs in the checkout the dead review made, which is the lost-container rule's reason again, that a crash never buys a pull request a second budget. Its check cache starts empty as every review's does (`start()` clears the runs), so the new review's evidence is its own.

_Builder's call:_ a resumed operation that ends without `submit_review` has no path above: nothing on the object fires when a harness operation finishes, so on a restarted object the `pending` and the record would sit until a push or a close, which for an abandoned pull request is never. So the runs schedule a Lifecycle job, `sandbox.drop`, when a preparation starts or a record is restored, due at `started` plus the budget plus the lease grace, and cancel it in the teardown; the job calls `dropIdle("review_end")`, which ends what nobody else will; while a review is active on a live object it does nothing and the job comes back two minutes later, since a review that outlives the bound and then dies with its object would otherwise have no bound but the inactivity backstop, and the review's own `end()` cancels it. That makes the host's bound on a dead review's container the lease's bound, `MAX_SANDBOX_SECONDS` plus two minutes, in place of the 30-minute inactivity backstop, which stays as the last resort.

_Builder's call:_ `run_check` after the review's `pending` is released answers a refusal, `ended` ("the review has been posted; nothing more runs"), rather than preparing a sandbox nothing will end: on a restarted object the post-review teardown has run, and on a live one the review is over. The probe's `check`, which has no `pending`, is exempt. The model is told to stop after `submit_review`, so the refusal is a guard, not a path a review takes.

### The probe

The probe gains an `end` action that asks the pull request object to drop an idle sandbox, so the live check can run the teardown through the runs rather than destroying the container directly: `prepare`, restart or evict the object, `check` (one `sandbox.restored`, no second `sandbox.start`, `sandbox.checkout` or `sandbox.install`), then `end` (one `sandbox.destroy`), and the lost-container case the same way after the dev server restarts (`sandbox.lost`, then a fresh preparation).

### Tests

Unit tests on `SandboxRuns` with a stored record in the fake host: `end()` on a fresh instance destroys and unleases; `dropIdle()` does too; `access()` on a fresh instance answers `ready` from the record without a second preparation and keeps the clock; a record for another head is torn down first and the current head prepared afresh; a record for the same head is inherited by a review that starts on a fresh instance, with its runs cleared; a record whose container is no longer running is dropped, its lease released, and the head prepared afresh; the check cache answers a stored run and `knownChecksOf` sees it; a record that doesn't parse is ignored; the drop job is scheduled at the budget plus the grace when a preparation starts and when a record is restored, cancelled by the teardown, and drops nothing while a review is active. The `ended` refusal has its text and its standing tested where the other refusals are. The pull request object's paths are covered by the existing tool and flight tests where they decide, and by the live check for the rest.

### Logs

`sandbox.restored` (`number`, `sha`, `kind`, `checks`, `seconds`), `sandbox.lost` (`number`, `sha`, `seconds`), and `check.refused` gains the reason `ended`. No change to the others.
