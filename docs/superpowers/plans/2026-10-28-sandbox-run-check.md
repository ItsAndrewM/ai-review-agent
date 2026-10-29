# run_check (#133) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the review a `run_check(name, paths?)` tool that runs a repository's lint, typecheck or test command on named paths in the sandbox and answers the exit code and the tail, with a `checks` map in `.andabot.yaml`, a `package.json` fallback, a per-head cache, and a finding field that references a run.

**Architecture:** `src/sandbox/checks.ts` holds every decision as pure functions: path validation, the template or fallback to argv, the environment, the cache key, the existence probe and the tool's text. `PullRequest` implements `ReviewHost.runCheck` with those functions over `SandboxRuns.access()`, a per-review cache and a one-at-a-time queue; `tools.ts` defines the tool and the preamble names it; `validateFindings` takes the run keys.

**Tech Stack:** TypeScript on Cloudflare Workers, TypeBox, vitest, oxlint/oxfmt; slice 2's `SandboxRuns`, `ReviewSandbox.run`.

**Spec:** `docs/superpowers/specs/2026-10-28-sandbox-design.md`, section "Slice 3, #133".

## Global Constraints

- `CLAUDE.md`: no comments; no type assertions except `as const`; complexity at most 10; no `unknown`/`object` parameters or returns, no `typeof`, no `vi.mock`.
- `pnpm check` passes on every commit; `pnpm format` before committing.
- Names: `lint`, `typecheck`, `test`. Path pattern `^[A-Za-z0-9_@+./-]+$`, no `..` segment, no leading `/` or `-`, at most 512 characters, at most 20 paths. Timeout `SANDBOX_CHECK_TIMEOUT` default 300,000 ms. Tail 8 KiB. Environment `NO_COLOR=1`, `FORCE_COLOR=0`, `CI=1`. Working directory `/workspace/repo`.
- Every new log event and field is named in `docs/design.md`.

## Review Focus

- A path with a space or a shell metacharacter: refused before anything runs (Task 2 test).
- A template whose `{paths}` slot is glued to other text, such as `--files={paths}`: treated as no slot (the token must stand alone), so paths are ignored rather than mangled (Task 2 test).
- Two `run_check` calls in one tool round: the second waits for the first (Task 4, read in review; the queue is a promise chain).
- A finding whose `check.exit_code` differs from the run's: rejected as unfounded (Task 3 test).
- `package.json` at the base unreadable or not JSON: the fallback yields no command and the tool says so (Task 2 test on the parser; Task 4 read).

---

### Task 1: The `checks` map in `.andabot.yaml`

**Files:** Modify `src/repository/config.ts`, `test/config.test.ts`, `docs/setup.md` (section 6 row), `docs/design.md` (the YAML example).

**Interfaces:**
```ts
export const CheckTemplates = Type.Object({ lint: Type.Optional(Type.String({ minLength: 1 })), typecheck: …, test: … }, { additionalProperties: false })
export type CheckTemplates = Static<typeof CheckTemplates>
// AndabotConfig and AndabotConfigFile gain `checks: Type.Optional(CheckTemplates)`; DEFAULT_CONFIG has none.
```

- [ ] **Step 1: Failing tests**: a full file with `checks: { lint, typecheck, test }` parses them; a `checks` entry with an unknown name or an empty string is invalid (the defaults apply, with the error); `DEFAULT_CONFIG.checks` is undefined.
- [ ] **Step 2: Run** `pnpm vitest run test/config.test.ts` → FAIL. **Step 3: Implement and document.** **Step 4: Run** `pnpm check` → PASS. **Step 5: Commit** `Read a checks map from .andabot.yaml`.

### Task 2: The check decisions, as a pure module

**Files:** Create `src/sandbox/checks.ts`; test `test/sandbox-checks.test.ts`.

**Interfaces:**
```ts
export const CHECK_NAMES = ["lint", "typecheck", "test"] as const
export type CheckName = (typeof CHECK_NAMES)[number]
export const DEFAULT_CHECK_TIMEOUT_MS = 300_000
export const MAX_CHECK_PATHS = 20
export const CHECK_ENV = { NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" } as const
export function checkTimeoutOf(value: string | undefined): number
export function pathProblem(paths: readonly string[]): string | undefined   // the first bad path's reason, or too many
export function argvFromTemplate(template: string, paths: readonly string[]): string[]   // whitespace split; a standalone {paths} token becomes the paths
export function fallbackArgv(name: CheckName, manager: Manager, packageJson: string | undefined, paths: readonly string[]): string[] | undefined
export function checkKey(sha: string, name: CheckName, paths: readonly string[]): string   // `${sha}:${name}:${paths.join(" ")}`
export function existsArgv(paths: readonly string[]): string[]      // ["/bin/sh", "-c", EXISTS_SCRIPT, "andabot-exists", ...paths]
export function missingPath(outcome: RunOutcome): string | undefined  // the path the script printed, when it exited 1
export interface CheckRun { readonly name: CheckName; readonly paths: readonly string[]; readonly outcome: RunOutcome; readonly ms: number }
export function checkText(run: CheckRun): string
export function refusalText(name: CheckName, reason: CheckRefusal): string
export type CheckRefusal = { kind: "off" } | { kind: "spent"; seconds: number; budget: number } | { kind: "unavailable"; reason: string } | { kind: "no_command" } | { kind: "bad_path"; problem: string } | { kind: "missing_path"; path: string }
```
- `fallbackArgv` parses `packageJson` (undefined or unparsable → undefined), looks in `devDependencies` then `dependencies`: `lint` → `oxlint` else `eslint`; `typecheck` → `typescript` → `tsc --noEmit`; `test` → `vitest` → `vitest run`, else `jest`. The runner prefix is `["pnpm", "exec"]` for `pnpm`, `["npx", "--no-install"]` otherwise. Paths are appended for lint and test.
- `EXISTS_SCRIPT`: `cd /workspace/repo || exit 2; for p; do [ -e "$p" ] || { echo "$p"; exit 1; }; done`.
- `checkText`: `` `${name} exited ${exitCode} in ${seconds}s` `` or `` `${name} timed out after ${seconds}s` ``, then a blank line and the tail, then `(output cut to its last 8 KiB)` when cut; an empty tail says `(no output)`.

- [ ] **Step 1: Failing tests** for each function, including the Review Focus cases. **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `Decide a check's command, paths, environment and text as pure functions`.

### Task 3: The finding's check reference

**Files:** Modify `src/review/findings.ts`, `src/pull-request.ts:699` (pass the keys), `test/findings.test.ts`.

**Interfaces:**
```ts
// FindingInput gains: check: Type.Optional(Type.Object({ name: Type.Union(CHECK_NAMES literals), paths: Type.Optional(Type.Array(Type.String())), exit_code: Type.Integer() }, { additionalProperties: false, description: "The run_check call this finding rests on, as it answered." }))
export function validateFindings(findings, commentable, hasLinkedIssues, knownChecks: ReadonlyMap<string, number>): ValidatedReview  // key → exit code
```
- A finding with `check` whose `checkKey(sha…)` isn't in `knownChecks`, or whose `exit_code` differs, is rejected as unfounded with `check names a run that didn't happen: run_check first and copy its answer`. The caller builds the map from the review's cache with the head's sha; the key omits the sha on the finding side, so `validateFindings` receives keys as `${name}:${paths.join(" ")}`.

- [ ] **Step 1: Failing tests**: accepted when the run is known with that exit code; rejected unfounded when unknown; rejected when the exit code differs; a finding without `check` unaffected. **Step 2: Run** → FAIL. **Step 3: Implement** (update every caller of `validateFindings` in src and test with an empty map). **Step 4: Run** `pnpm check` → PASS. **Step 5: Commit** `Let a finding name the check run it rests on, and refuse one that didn't happen`.

### Task 4: The tool, the host, the preamble, the skill, the var

**Files:** Modify `src/review/tools.ts` (tool + `ReviewHost.runCheck`), `src/review/prompt.ts` (the sentence), `src/pull-request.ts` (`runCheck`, cache, queue, `package.json` at base, pass keys to `validateFindings`), `src/sandbox/runs.ts` (`access()` memo before `enabled()`), `skills/review/SKILL.md` (when to run a check), `wrangler.jsonc` (`SANDBOX_CHECK_TIMEOUT`), `docs/setup.md`, `docs/design.md`; tests `test/tools.test.ts` (the tool's text through a fake host), `test/prompt.test.ts` (the sentence), `test/sandbox-runs.test.ts` (memo before enabled: the `enabled` fake counts calls).

- `ReviewHost.runCheck(args: RunCheckArgs, conversationId): Promise<string>`; the tool's description: "Run the repository's lint, typecheck or test command on the named paths at the pull request's head, in a sandbox, and read the exit code and the last 8 KiB of output. Name the test file or package the change touches; the whole suite is CI's job. Answers at once when the sandbox is off, spent or unavailable."
- `PullRequest.runCheck`: `pathProblem` → refusal; `#sandbox.access()` → refusal unless ready; cache hit → `check.cached` and the stored text; else queue: existence probe → `missing_path`; command from the base config's `checks` template or `fallbackArgv(name, manager, packageJsonAtBase, paths)` → `no_command`; `sandbox.run(argv, { cwd: dir, env: CHECK_ENV, timeoutMs, tailBytes: 8192 })`; store, log `check.run`, answer `checkText`. The cache is a `Map<string, CheckRun>` keyed by `checkKey(head sha, …)`, cleared when a review starts. `package.json` at the base is read with `getFileContent` once per base and kept in memory.
- Skill: in section 2, after the `grep` sentence: "When the repository has a sandbox, `run_check` runs its lint, typecheck or test on the paths you name; use it to confirm a failure you believe the change causes, on the test file or package it touches, never the whole suite, and name the run in the finding's `check`."
- `review.done` and `review.transcript` unchanged; `check.run` carries `number`, `name`, `paths`, `outcome`, `exitCode`, `ms`, `bytes`, `cut`.

- [ ] **Step 1: Failing tests** (tool text through a fake host that answers a scripted `runCheck`; the prompt sentence; the memo order). **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm check` → PASS. **Step 5: Commit** `Offer run_check to the review`.

### Task 5: Probe `check`, docs, live check

**Files:** Modify `src/sandbox/probe.ts` (`action: "check"` with `name` and `paths`, calling `PULL_REQUEST…probeCheck(key, name, paths)`), `test/sandbox-probe.test.ts`, `docs/setup.md`, `docs/design.md` (tier 3's paragraph, the events, the phases line).

- [ ] **Step 1: Failing test** (`check` parses with a name, refuses one without). **Step 2: Run** → FAIL. **Step 3: Implement and document.** **Step 4: Run** `pnpm check` → PASS. **Step 5: Commit** `Let the probe run a check through the review's path, and record slice 3`.
- [ ] **Step 6: Live check** locally under `wrangler dev` with `SANDBOX=true` and `SANDBOX_PROBE=true` against PR #136's key: `check` `test` with `["test/sandbox-policy.test.ts"]` → exited 0 with a plain-text tail; the same again → `check.cached`; `check` `lint` with no paths → the fallback command (`oxlint`) exits 0; `check` `test` with `["../etc/passwd"]` → `bad_path`; with `["test/nope.test.ts"]` → `missing_path`; `typecheck` → exited 0. Record the timings on #133. The model-driven run on a planted failure needs a production deploy with `SANDBOX=true`, which is #135's measurement.
