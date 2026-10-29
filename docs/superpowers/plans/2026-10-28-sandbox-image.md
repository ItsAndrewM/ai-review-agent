# Sandbox image and container object (#131) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A container image and a `ReviewSandbox` Durable Object the PR object can start, run one command in with a timeout, read the tail of, and destroy, with its network closed except to `github.com` and the npm registry.

**Architecture:** `ReviewSandbox` is a Durable Object class of its own on the runtime's `ctx.container`, under the `durable_object` scheduling policy, so the object picks the image and the instance when it starts. An `Outbound` `WorkerEntrypoint` is the only way out of the container: the object attaches it to every HTTP and HTTPS request with the installation token as its props, and a pure policy module decides each request. Commands run under a wrapper that puts them in their own process group and writes their output and exit code to files, so a timeout can kill the group and the result is read with one more command. Nothing calls the object yet; a signed probe route, on only when `SANDBOX_PROBE` is `true`, drives it for the live check.

**Tech Stack:** TypeScript on Cloudflare Workers, Durable Objects with `ctx.container` (wrangler 4.151.1, `scheduling_policy: "durable_object"`), `WorkerEntrypoint` props, TypeBox, vitest, oxlint/oxfmt, Docker for `wrangler deploy` and `wrangler dev`.

**Spec:** `docs/superpowers/specs/2026-10-28-sandbox-design.md`, section "Slice 1, #131".

## Global Constraints

- `CLAUDE.md`: no comments of any kind (a `wrangler.jsonc` comment is the one exception); no type assertions except `as const`; complexity at most 10 per function; no `unknown` or `object` parameters or returns, no `typeof`, no `vi.mock`; the reason for a thing lives in a name, a test title or `docs/design.md`.
- `pnpm check` passes on every commit (it regenerates `worker-configuration.d.ts` with `wrangler types`, which needs no Docker); `pnpm format` before committing.
- Log fields are strings, numbers, booleans or undefined; every new event or field is named in `docs/design.md`.
- The allowlist is exactly `github.com` and `registry.npmjs.org`, HTTPS only; the token goes only to `github.com`, as `Basic` with the user `x-access-token`, the form GitHub documents for installation tokens on git over HTTPS.
- The instance is `standard-1`, `enableInternet` is `false`, the inactivity timeout is 30 minutes.
- The tail is 8 KiB by default and 50 KiB at most, Pi Durable's tool-result cap.
- No `@cloudflare/sandbox`; `migrations` stays, with `ReviewSandbox` as tag `v2`.

## Review Focus

- A request the container makes with its own `Authorization` header to `github.com`: the handler replaces it with the token's, never forwards both (Task 1 test).
- A request to an allowed host over plain HTTP: refused, since the token would travel unencrypted (Task 1 test).
- A command whose output is binary or cut mid-character: the tail still decodes, with replacement characters rather than a thrown error (Task 2 test).
- A timeout after the command already exited: the result reads as `exited` with its code, not `timeout` (Task 2 test, `runOutcome` with an exit code present wins).
- A `start` on an object whose container is already running, after an object restart: the timeout and the interception are set again rather than skipped (Task 3, read in review; the live check restarts nothing, so this stays a reading item).

---

### Task 1: The outbound policy, as a pure module

**Files:**
- Create: `src/sandbox/policy.ts`
- Test: `test/sandbox-policy.test.ts`

**Interfaces:**
- Produces:

```ts
export const ALLOWED_HOSTS = ["github.com", "registry.npmjs.org"] as const
export const TOKEN_HOST = "github.com"
export type OutboundDecision =
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "forward"; readonly authorization: string | undefined }
export function decideOutbound(url: URL, token: string | undefined): OutboundDecision
export function forwardedHeaders(sent: Headers, authorization: string | undefined): Headers
```

- `decideOutbound`: `url.protocol !== "https:"` refuses with `` `${url.hostname} is reachable only over HTTPS` ``; a hostname outside `ALLOWED_HOSTS` refuses with `` `${url.hostname} is not reachable from this sandbox` ``; `TOKEN_HOST` with a token forwards with `` `Basic ${btoa(`x-access-token:${token}`)}` ``; anything else allowed forwards with `authorization` undefined. HTTPS is checked before the host, so a plain-HTTP request to an unknown host says HTTPS.
- `forwardedHeaders`: a copy of `sent` with `authorization` deleted, then set when `authorization` is defined.

- [ ] **Step 1: Write the failing tests**

```ts
describe("decideOutbound", () => {
  it("forwards github.com with the installation token as Basic x-access-token", ...)
    // decideOutbound(new URL("https://github.com/o/r.git/info/refs"), "tok") equals { kind: "forward", authorization: `Basic ${btoa("x-access-token:tok")}` }
  it("forwards github.com without a token when none is held", ...)      // authorization undefined
  it("forwards the npm registry without a token", ...)                   // https://registry.npmjs.org/vitest → authorization undefined, even with a token
  it("refuses a host off the allowlist", ...)                            // https://example.com/ → { kind: "refuse", reason: "example.com is not reachable from this sandbox" }
  it("refuses plain HTTP to an allowed host, since the token would travel unencrypted", ...) // http://github.com/ → reason "github.com is reachable only over HTTPS"
  it("refuses plain HTTP before it looks at the host", ...)             // http://example.com/ → the HTTPS reason
  it("matches the host exactly, so a subdomain of github.com is off the allowlist", ...) // https://api.github.com/ → refuse
})
describe("forwardedHeaders", () => {
  it("replaces an authorization the container sent with the token's", ...) // sent has authorization "Bearer leaked" → result has only the Basic one
  it("drops an authorization the container sent when no token is held", ...) // result has no authorization
  it("keeps the other headers", ...)                                          // accept, user-agent kept
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/sandbox-policy.test.ts`
Expected: FAIL, the module doesn't exist.

- [ ] **Step 3: Implement `src/sandbox/policy.ts`** with the interfaces above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/sandbox-policy.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
pnpm format && git add src/sandbox/policy.ts test/sandbox-policy.test.ts
git commit -m "Decide what a sandbox may reach: github.com with the token, the npm registry, nothing else"
```

### Task 2: The run wrapper and its result, as a pure module

**Files:**
- Create: `src/sandbox/run.ts`
- Test: `test/sandbox-run.test.ts`

**Interfaces:**
- Produces:

```ts
export const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt"
export const TRUST_ENV = { NODE_EXTRA_CA_CERTS: CA_PATH, GIT_SSL_CAINFO: CA_PATH, CURL_CA_BUNDLE: CA_PATH, SSL_CERT_FILE: CA_PATH } as const
export const DEFAULT_TAIL_BYTES = 8 * 1024
export const MAX_TAIL_BYTES = 50 * 1024
export const RUNS_DIR = "/workspace/runs"
export function runDir(id: string): string                                   // `${RUNS_DIR}/${id}`
export function runArgv(dir: string, command: readonly string[]): string[]   // ["/bin/sh", "-c", RUN_SCRIPT, "andabot-run", dir, ...command]
export function killArgv(dir: string): string[]                              // ["/bin/sh", "-c", KILL_SCRIPT, "andabot-kill", dir]
export function resultArgv(dir: string, tailBytes: number): string[]         // ["/bin/sh", "-c", RESULT_SCRIPT, "andabot-result", dir, String(tailBytes)]
export function removeArgv(dir: string): string[]                            // ["rm", "-rf", dir]
export function tailBytesOf(requested: number | undefined): number           // DEFAULT when undefined or not a positive safe integer, else min(requested, MAX)
export type RunOutcome =
  | { readonly outcome: "exited"; readonly exitCode: number; readonly tail: string; readonly cut: boolean }
  | { readonly outcome: "timeout"; readonly tail: string; readonly cut: boolean }
export function parseResult(output: Uint8Array, tailBytes: number): RunOutcome
```

- `RUN_SCRIPT` (`$1` is the dir, the rest the command): makes the dir, then runs the command through `setsid sh -c '…'` so it leads its own process group, with the group leader's pid written to `$dir/pid` before `exec`, combined stdout and stderr appended to `$dir/output`, and the exit status written to `$dir/exit-code.tmp` then renamed to `$dir/exit-code`, so a partial value is never read. The guide's script is the model: `dir=$1; shift; mkdir -p "$dir"; setsid sh -c 'echo "$$" >"$0/pid"; exec "$@"' "$dir" "$@" >"$dir/output" 2>&1; echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`.
- `KILL_SCRIPT`: reads the pid and sends `TERM` to the group: `read -r pid <"$1/pid" && kill -TERM -- "-$pid"`; exits 0 when the pid file is missing, since the command may not have started.
- `RESULT_SCRIPT`: prints three parts separated by newlines: the exit code or `none` (`cat "$1/exit-code" 2>/dev/null || echo none`), the output's size in bytes (`stat -c %s "$1/output" 2>/dev/null || echo 0`), then `tail -c "$2" "$1/output" 2>/dev/null`.
- `parseResult` reads the first two lines as text from the bytes, decodes the rest with `TextDecoder` (replacement characters for a cut character, never a throw), and returns `exited` when the first line is a whole number, `timeout` when it is `none`; `cut` is `size > tailBytes`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("runArgv", () => {
  it("runs the command under the wrapper with the dir first", ...)   // runArgv("/workspace/runs/a", ["node", "--version"]) → ["/bin/sh", "-c", <script>, "andabot-run", "/workspace/runs/a", "node", "--version"]
  it("puts the command in its own process group and records the exit code atomically", ...) // the script contains "setsid", "exit-code.tmp" and "mv"
})
describe("tailBytesOf", () => {
  it("defaults to 8 KiB", ...)                 // undefined → 8192
  it("caps at Pi Durable's 50 KiB tool-result cap", ...) // 100_000 → 51_200
  it("ignores a non-positive or fractional request", ...) // 0, -1, 1.5 → 8192
})
describe("parseResult", () => {
  it("reads an exit code, the size and the tail", ...)      // bytes of "0\n5\nhello" with tailBytes 8192 → { outcome: "exited", exitCode: 0, tail: "hello", cut: false }
  it("marks the tail cut when the output is larger than the tail", ...) // "1\n20000\nend" tailBytes 8192 → exited 1, cut true
  it("reads a missing exit code as a timeout", ...)          // "none\n3\nabc" → { outcome: "timeout", tail: "abc", cut: false }
  it("decodes a tail cut mid-character with a replacement character rather than throwing", ...) // bytes "0\n4\n" + the last two bytes of "é€" → tail contains "�"
  it("reads an empty output", ...)                           // "0\n0\n" → exited 0, tail "", cut false
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/sandbox-run.test.ts`
Expected: FAIL, the module doesn't exist.

- [ ] **Step 3: Implement `src/sandbox/run.ts`** with the interfaces above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/sandbox-run.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
pnpm format && git add src/sandbox/run.ts test/sandbox-run.test.ts
git commit -m "Wrap a sandbox command so its group can be killed and its exit code and tail read back"
```

### Task 3: The image, the object, the outbound entrypoint and the configuration

**Files:**
- Create: `container/Dockerfile`, `src/sandbox/outbound.ts`, `src/sandbox/review-sandbox.ts`
- Modify: `src/index.ts` (exports), `wrangler.jsonc` (containers, binding, migration)
- Test: `pnpm check` (typecheck through the regenerated `worker-configuration.d.ts`)

**Interfaces:**
- Consumes: Task 1's `decideOutbound` and `forwardedHeaders`; Task 2's argv builders, `TRUST_ENV`, `tailBytesOf`, `parseResult`, `RunOutcome`.
- Produces:

```ts
// src/sandbox/outbound.ts
export interface OutboundProps { readonly token: string | undefined }
export class Outbound extends WorkerEntrypoint<Env, OutboundProps> { fetch(request: Request): Promise<Response> }

// src/sandbox/review-sandbox.ts
export const SANDBOX_INSTANCE = "standard-1"
export const INACTIVITY_TIMEOUT_MS = 30 * 60_000
export interface RunOptions { readonly cwd: string; readonly env?: Record<string, string>; readonly timeoutMs: number; readonly tailBytes?: number }
export class ReviewSandbox extends DurableObject<Env> {
  start(token: string | undefined): Promise<void>
  run(command: readonly string[], options: RunOptions): Promise<RunOutcome>
  running(): boolean
  destroy(): Promise<void>
}
```

- `Outbound.fetch`: `decideOutbound(new URL(request.url), this.ctx.props.token)`; a refusal answers `403` with the reason and a newline; a forward calls `fetch(new Request(request, { headers: forwardedHeaders(request.headers, authorization) }))`.
- `ReviewSandbox`: the constructor throws `No container is configured` when `ctx.container` is undefined. `start`: when not running, `container.start({ image: container.images.review, instance: SANDBOX_INSTANCE, enableInternet: false })`; then, running or not, `interceptAllOutboundHttp(outbound)`, `interceptOutboundHttps("*", outbound)` with `outbound = this.ctx.exports.Outbound({ props: { token } })`, and `setInactivityTimeout(INACTIVITY_TIMEOUT_MS)`; a throw in that block destroys the container and rethrows; logs `sandbox.start` with `ms` and `started` (whether this call started the container). `run`: `dir = runDir(crypto.randomUUID())`; exec `runArgv(dir, command)` with `{ cwd, env: { ...TRUST_ENV, ...options.env }, stdout: "ignore", stderr: "ignore" }`; race `process.exitCode` against a timer of `timeoutMs`; on the timer, exec `killArgv(dir)` and await its `output()`; then exec `resultArgv(dir, tailBytes)`, `parseResult` its `stdout`, exec `removeArgv(dir)`, and log `sandbox.run` with `command` (the first word), `outcome`, `exitCode`, `ms`, `bytes` (the tail's length) and `cut`. `destroy`: `container.destroy()` and log `sandbox.destroy`. Keep each method's complexity under 10 by splitting the timed wait and the result read into private methods.
- `container/Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git \
	&& rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.0.0
WORKDIR /workspace
CMD ["sleep", "infinity"]
```

- `wrangler.jsonc`: a `containers` array with `class_name: "ReviewSandbox"`, `scheduling_policy: "durable_object"`, `images: { review: { dockerfile: "./container/Dockerfile", build_context: "./container" } }`, with a comment saying the build context keeps `node_modules` out of the image build and that the instance and cap live in code because the policy rejects them here; a second `durable_objects` binding `{ name: "REVIEW_SANDBOX", class_name: "ReviewSandbox" }`; a migration `{ tag: "v2", new_sqlite_classes: ["ReviewSandbox"] }`.
- `src/index.ts`: `export { ReviewSandbox } from "./sandbox/review-sandbox.ts"` and `export { Outbound } from "./sandbox/outbound.ts"`.

- [ ] **Step 1: Write the Dockerfile, the configuration and the two classes**

- [ ] **Step 2: Run the check**

Run: `pnpm check`
Expected: PASS. `wrangler types` now declares `REVIEW_SANDBOX` on `Env` and `ReviewSandbox` among `durableNamespaces`; `this.ctx.exports.Outbound({ props })` typechecks against `LoopbackServiceStub`. Lint passes with no comment outside `wrangler.jsonc` and no assertion.

- [ ] **Step 3: Commit**

```bash
pnpm format && git add container/Dockerfile src/sandbox/outbound.ts src/sandbox/review-sandbox.ts src/index.ts wrangler.jsonc
git commit -m "Add the sandbox image and a ReviewSandbox object that starts, runs and stops a container"
```

### Task 4: A signed probe route, for the live check only

**Files:**
- Create: `src/sandbox/probe.ts`
- Modify: `src/index.ts` (route), `wrangler.jsonc` (`SANDBOX_PROBE` var)
- Test: `test/sandbox-probe.test.ts`

**Interfaces:**
- Consumes: `verifyWebhookSignature` from `src/github/webhook.ts`; `createAppJwt` and `fetchInstallationToken` from `src/github/app-auth.ts`; `objectName` from `src/route.ts`; `PullRequestKey` from `src/records.ts`; Task 3's `ReviewSandbox`.
- Produces:

```ts
export const ProbeRequest = Type.Object({
  key: PullRequestKey,
  action: Type.Union([Type.Literal("run"), Type.Literal("destroy")]),
  command: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  cwd: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  tailBytes: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false })
export type ProbeRequest = Static<typeof ProbeRequest>
export function probeEnabled(value: string | undefined): boolean      // exactly "true"
export function parseProbe(body: string): ProbeRequest | undefined    // JSON that passes the schema, and a run has a command
export async function serveProbe(request: Request, env: Env): Promise<Response>
```

- `serveProbe`: `404` unless `probeEnabled(env.SANDBOX_PROBE)`; `405` unless `POST`; `401` unless `verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, body, x-hub-signature-256)` holds; `400` unless `parseProbe` returns a request. Then `sandbox = env.REVIEW_SANDBOX.getByName(objectName(key))`; `destroy` calls `sandbox.destroy()` and answers `{ destroyed: true }`; `run` mints a token (`createAppJwt` then `fetchInstallationToken(jwt, key.installationId)`), calls `sandbox.start(token.token)`, then `sandbox.run(command, { cwd: cwd ?? "/workspace", timeoutMs: timeoutMs ?? 60_000, tailBytes })` and answers the `RunOutcome` as JSON. Logs `sandbox.probe` with the action and the key's number.
- `src/index.ts`: `if (url.pathname === "/sandbox-probe") return serveProbe(request, env)` before the `/webhook` check.
- `wrangler.jsonc` vars: `"SANDBOX_PROBE": "false"` with a comment: the probe route that drives a sandbox by hand for #131's live check; on only when `true`, set with `wrangler deploy --var SANDBOX_PROBE:true` or in `.dev.vars`; goes once `run_check` (#133) exercises the sandbox.

- [ ] **Step 1: Write the failing tests** for the pure parts

```ts
describe("probeEnabled", () => {
  it("is on only for the exact string true", ...)   // "true" → true; "false", "TRUE", "1", undefined → false
})
describe("parseProbe", () => {
  it("accepts a run with a command", ...)
  it("accepts a destroy without one", ...)
  it("refuses a run without a command", ...)
  it("refuses a key that isn't a pull request key, and an unknown field", ...)
  it("refuses a body that isn't JSON", ...)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/sandbox-probe.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/sandbox/probe.ts`, the route and the var**

- [ ] **Step 4: Run the check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format && git add src/sandbox/probe.ts test/sandbox-probe.test.ts src/index.ts wrangler.jsonc
git commit -m "Add a signed probe route that drives a sandbox by hand while nothing else does"
```

### Task 5: Docs

**Files:**
- Modify: `docs/setup.md` (section 2 and the variables table), `docs/design.md` (package table, execution tiers, the sandbox events, the status line's phase 3 mention)

- [ ] **Step 1: `docs/setup.md`**: after the deploy block, say that `pnpm run deploy` and `pnpm dev` need Docker running, since wrangler builds `container/Dockerfile` for the sandbox tier, and that CI needs none: `pnpm check` builds no image. Add `SANDBOX_PROBE` to the variables table with its default `false` and the sentence from Task 4's comment, and a short "Probing the sandbox" paragraph with the signed `curl` (the body signed as the replay example in section 3 signs one).

- [ ] **Step 2: `docs/design.md`**: remove the `@cloudflare/sandbox` row from the package table and add a line under the table saying the tier uses the runtime's `ctx.container` API, since `exec` returns the exit code and both streams and the package's `Files` only streams files through a shim; rewrite tier 3's sentence to the spec's: a `ReviewSandbox` per pull request under the `durable_object` policy, `standard-1`, outbound HTTP and HTTPS through the `Outbound` entrypoint whose allowlist is `github.com` (with the installation token) and `registry.npmjs.org`, a 30-minute inactivity timeout as the backstop, commands run in their own process group with a timeout and the tail read back; name `sandbox.start`, `sandbox.run` (`command`, `outcome`, `exitCode`, `ms`, `bytes`, `cut`), `sandbox.destroy` and `sandbox.probe`; in the Phases list, mark #131 shipped under phase 3 with the slice list (#132 to #135) and point at the spec.

- [ ] **Step 3: Run the check and commit**

Run: `pnpm check`
Expected: PASS.

```bash
pnpm format && git add docs/setup.md docs/design.md
git commit -m "Document the sandbox tier's first slice: Docker on deploy, the probe route, the events"
```

### Task 6: Live check

Needs Docker running and either `.dev.vars` filled in (local) or a deploy with `--var SANDBOX_PROBE:true` (production); a production deploy is Andrew's call, since deploys are coordinated across sessions.

- [ ] **Step 1: Start locally**: `pnpm dev` (wrangler builds the image and applies the outbound rules through its sidecar). Or deploy: `pnpm exec wrangler deploy --var SANDBOX_PROBE:true`.

- [ ] **Step 2: Probe**, with `BODY` as a `ProbeRequest` for a throwaway pull request's key and the signature computed as section 3 of `docs/setup.md` shows:
  1. `{"action":"run","command":["node","--version"]}`: expect `{ outcome: "exited", exitCode: 0, tail: "v22…" }`; note the time of the first call (cold start plus run) and of a second.
  2. `{"action":"run","command":["node","-e","fetch('https://example.com').then(r=>console.log(r.status))"]}`: expect the tail to show `403`.
  3. `{"action":"run","command":["node","-e","fetch('https://registry.npmjs.org/vitest').then(r=>console.log(r.status))"]}`: expect `200`.
  4. `{"action":"run","command":["sleep","600"],"timeoutMs":5000}`: expect `{ outcome: "timeout" }` in about 5 s; then `{"action":"run","command":["ps","-eo","pid,args"]}`: expect no `sleep 600`.
  5. `{"action":"run","command":["sh","-c","yes | head -c 100000"],"tailBytes":1024}`: expect `cut: true` and a 1 KiB tail.
  6. `{"action":"destroy"}`: expect `{ destroyed: true }`, and `sandbox.destroy` in the logs.

- [ ] **Step 3: Record** the cold start, run and timeout timings on #131, and whether anything surprised; deploy plain `main` again if a `--var` deploy was made.
