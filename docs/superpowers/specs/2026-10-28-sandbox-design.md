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
