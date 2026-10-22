# Repository search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the review model `grep` and `tree` over every text file at the pull request's head, through a tarball snapshot loaded into the object's SQLite on first use.

**Architecture:** A streaming tar reader turns GitHub's tarball of the head sha into text files kept as SQLite rows, and a gap fill brings back what `export-ignore` left out. Pure search functions answer `grep` and `tree` over a `SnapshotFiles` interface. The pull request object loads the snapshot lazily, counts the calls, and drops it when the review or answer ends.

**Tech Stack:** TypeScript on Workers and Durable Objects (SQLite), Pi Durable tools (`defineTool`), TypeBox, `minimatch`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-repository-search-design.md`

## Global Constraints

- Lint (`CLAUDE.md`): no comments of any kind, no type assertions except `as const`, complexity ≤ 10 per function, no `unknown` or `object` parameters or returns, no `typeof` checks, no `vi.mock`. Parse every GitHub response and stored JSON with TypeBox and `Value.Check`.
- A file is kept when it is a regular file of at most 1,048,576 bytes with no NUL byte in its first 8,192 bytes; an LFS pointer starts with `version https://git-lfs.github.com/spec/v1`.
- Snapshot cap: 50,000 files or 400 MB (419,430,400 bytes) of text. Gap fill: at most 500 files, GraphQL batches of 50.
- `grep`: at most 100 matches and 12,000 characters per answer, each line cut at 300 characters; a pattern over 500 characters or with a nested quantifier is refused.
- `tree`: at most 500 entries, depth 2 by default.
- At most 40 `grep` and `tree` calls together per review or answer.
- Unavailable answer, verbatim: `Repository search is unavailable for this review: <reason>. Use read_file.`
- `limits.cpu_ms` in `wrangler.jsonc`: 120000.
- `pnpm check` must pass at every commit. Run `pnpm format` before committing.

## Review Focus

1. **A pattern that isn't valid regex**, such as `answerPrompt(`: the model means the literal text. It should be searched literally, not refused (Task 4).
2. **Glob forms**: `*.ts` should match at any depth, as the model expects from ripgrep, and `src/**/*.ts` only under `src/` (Task 4).
3. **Paths written `./src/` or `src/`**: these should mean `src` (Task 4).
4. **Minified or CRLF files**: a one-line 900 KB bundle is cut at 300 characters per line, and a trailing `\r` is not shown (Task 4).
5. **A push mid-review**: `read_file` and `grep` must read the same sha, the head under review, never a newer one (Task 6).

---

### Task 1: Streaming tar reader

**Files:**
- Create: `src/repository/tar.ts`
- Test: `test/tar.test.ts` (with a `tarOf(entries)` helper in the test file that writes ustar headers, pax `x`/`g` records and GNU `L` records)

**Interfaces:**
- Produces: `export interface TarFile { path: string; size: number; body: Uint8Array | undefined }`, and `export function readTar(stream: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<TarFile>`. It yields regular files only (typeflag `0` or NUL), with the first path segment (`owner-repo-sha/`) stripped. `body` is set only when `size <= maxBytes`; larger files are skipped without buffering.

- [ ] **Step 1: Write the failing tests**
  - `yields regular files with the leading directory stripped`: an archive with `o-r-abc/` (dir) and `o-r-abc/src/a.ts` → `[{ path: "src/a.ts", size: 3, body: "abc" bytes }]`.
  - `joins the ustar prefix field`: prefix `o-r-abc/deep/dir`, name `file.ts` → path `deep/dir/file.ts`.
  - `takes a long path from a pax x record`, and `from a GNU L record`: both → a 150-character path, unchanged.
  - `ignores pax g records and symlinks`: a `g` record and a typeflag `2` entry yield nothing.
  - `leaves out the body past maxBytes`: maxBytes 4, a 10-byte file → `{ size: 10, body: undefined }`, and the next file still parses.
  - `parses an archive split at every byte boundary`: the same archive fed in chunks of 1, 7, 511, 512 and 513 bytes gives identical output.
  - `stops at the zero blocks`: two zero blocks then garbage → no error, no extra entries.
- [ ] **Step 2: Run `pnpm vitest run test/tar.test.ts`**. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `readTar`** with a small chunk queue (`take(n)`, `skip(n)`, `length`). Split header parsing, pax and GNU name handling, and body skipping into separate functions to stay under complexity 10. Sizes are octal; a header of all zeros is skipped.
- [ ] **Step 4: Run the tests**. Expected: PASS.
- [ ] **Step 5: Commit**: `Read GitHub's tarball as a stream of files, skipping large ones without buffering (#30)`.

### Task 2: GitHub client: tarball, tree listing, blob texts

**Files:**
- Modify: `src/github/client.ts`
- Test: `test/client-snapshot.test.ts`

**Interfaces:**
- Produces:
  - `downloadTarball(ref: RepoRef, sha: string): Promise<ReadableStream<Uint8Array>>`: `GET /repos/{owner}/{repo}/tarball/{sha}`. It throws `GitHub tarball <status>` when the response isn't OK or has no body. `fetch` follows the redirect.
  - `export interface ListedEntry { path: string; type: "blob" | "tree" | "commit"; mode: string; size: number | undefined }`, `export interface TreeListing { entries: readonly ListedEntry[]; truncated: boolean }`, and `getTreeListing(ref: RepoRef, sha: string): Promise<TreeListing>`: the recursive trees call, keeping `commit` entries (submodules) as well. `getTree` is unchanged.
  - `export interface BlobText { path: string; text: string | undefined }` and `getBlobTexts(ref: RepoRef, sha: string, paths: readonly string[]): Promise<BlobText[]>`: one GraphQL query per 50 paths, aliased `f0…f49`, each `object(expression: $e<i>) { ... on Blob { text isBinary isTruncated } }` with `$e<i> = "<sha>:<path>"`. `text` is `undefined` when the object is null, binary or truncated.

- [ ] **Step 1: Write the failing tests** against a fake `fetchImpl`, as in `test/tools.test.ts`:
  - `downloads the tarball of a sha`: requests `…/repos/o/r/tarball/abc`, and the returned stream reads `"tar"`.
  - `throws on a failed tarball`: 404 → rejects with `GitHub tarball 404`.
  - `lists blobs, trees and submodules with modes and sizes`: a listing with modes `100644`, `120000`, `160000` and `040000` → four entries; the `size` of the tree is `undefined`.
  - `reads blob texts in batches of 50`: 120 paths → 3 POSTs to `/graphql`. Variables `e0` is `"abc:p0"`. A binary, truncated or null object gives `text: undefined`.
- [ ] **Step 2: Run `pnpm vitest run test/client-snapshot.test.ts`**. Expected: FAIL.
- [ ] **Step 3: Implement the three methods**, with TypeBox schemas for the listing and for the GraphQL `repository` record (`Type.Record(Type.String(), Type.Union([Type.Null(), Blob]))`).
- [ ] **Step 4: Run the tests**. Expected: PASS.
- [ ] **Step 5: Commit**: `Read a head's tarball, full tree listing and blob texts from GitHub (#30)`.

### Task 3: Snapshot storage

**Files:**
- Create: `src/repository/snapshot.ts` (constants, classification, record schema, the `SnapshotFiles` interface and an in-memory implementation)
- Create: `src/repository/sql-snapshot.ts` (the SQLite implementation)
- Test: `test/snapshot.test.ts`

**Interfaces:**
- Produces, in `snapshot.ts`:
  - `MAX_FILE_BYTES = 1_048_576`, `MAX_SNAPSHOT_FILES = 50_000`, `MAX_SNAPSHOT_BYTES = 419_430_400`, `MAX_GAP_FILL = 500`.
  - `export type LeftOutReason = "too_large" | "binary" | "lfs" | "submodule" | "symlink" | "gap_cap" | "snapshot_cap" | "unlisted"`, and `export interface LeftOut { path: string; reason: LeftOutReason }`.
  - `export function classify(body: Uint8Array): "text" | "binary" | "lfs"`.
  - `export const SnapshotRecord = Type.Object({ sha: Type.String(), files: Type.Integer(), bytes: Type.Integer(), gapFilled: Type.Integer(), leftOut: Type.Record(Type.String(), Type.Integer()), capped: Type.Boolean(), treeTruncated: Type.Boolean() })`, where `leftOut` counts the paths per `LeftOutReason`, and `type SnapshotRecord`.
  - `export interface SnapshotFiles { begin(sha: string): void; add(files: readonly { path: string; content: string }[]): void; leaveOut(entries: readonly LeftOut[]): void; finish(record: SnapshotRecord): void; record(): SnapshotRecord | undefined; read(path: string): string | undefined; reasonFor(path: string): LeftOutReason | undefined; files(): Iterable<{ path: string; content: string }>; leftOut(): Iterable<LeftOut>; has(path: string): boolean; drop(): boolean }`.
  - `begin` clears everything. `record()` returns `undefined` until `finish`. `drop()` returns whether there was anything to drop.
  - `export class MemorySnapshotFiles implements SnapshotFiles`.
- Produces, in `sql-snapshot.ts`: `export class SqlSnapshotFiles implements SnapshotFiles`, with `constructor(sql: SqlStorage)`. It uses tables `snapshot_files (path TEXT PRIMARY KEY, content TEXT)`, `snapshot_left_out (path TEXT PRIMARY KEY, reason TEXT)` and `snapshot_meta (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT)`, created with `IF NOT EXISTS`. A meta row that fails `Value.Check` reads as `undefined`.

- [ ] **Step 1: Write the failing tests** (on `MemorySnapshotFiles`, plus the classification):
  - `classify` → `"text"` for `"export const a = 1\n"`; `"binary"` for a NUL at byte 100; `"text"` for a NUL at byte 9,000; `"lfs"` for the pointer prefix.
  - `a snapshot reads back its files and left-out reasons`.
  - `record is undefined until finish, and after begin`.
  - `drop reports whether there was anything`: `true`, then `false`.
- [ ] **Step 2: Run `pnpm vitest run test/snapshot.test.ts`**. Expected: FAIL.
- [ ] **Step 3: Implement both classes.** `SqlSnapshotFiles` is exercised by the live checks only (no SQLite in Node tests). Keep its methods one statement each where possible, and parse the meta JSON with `Value.Check`.
- [ ] **Step 4: Run the tests**. Expected: PASS.
- [ ] **Step 5: Commit**: `Keep a head's text files as a snapshot in the object's SQLite (#30)`.

### Task 4: Search over a snapshot

**Files:**
- Create: `src/repository/search.ts`
- Test: `test/search.test.ts`

**Interfaces:**
- Consumes: `SnapshotFiles` and `MemorySnapshotFiles` (Task 3).
- Produces: `MAX_MATCHES = 100`, `MAX_GREP_CHARS = 12_000`, `MAX_LINE_CHARS = 300`, `MAX_PATTERN_CHARS = 500`, `MAX_TREE_ENTRIES = 500`, `DEFAULT_TREE_DEPTH = 2`, `MAX_SEARCH_CALLS = 40`, plus:
  - `export function patternProblem(pattern: string): string | undefined`, giving the refusal reason;
  - `export function grep(files: SnapshotFiles, query: { pattern: string; glob?: string; path?: string }): string`;
  - `export function tree(files: SnapshotFiles, path?: string, depth?: number): string`.

- [ ] **Step 1: Write the failing tests**
  - `grep` returns `src/a.ts:12: <line>` lines in path order.
  - `grep` filters by `path` and by `glob`; `*.ts` matches `src/deep/a.ts` (`matchBase`), and `src/**/*.ts` doesn't match `test/a.ts`.
  - `grep` normalises the path: `./src/` and `src` give the same result.
  - `grep` stops at 100 matches and adds `… 37 more matches in 4 files not shown.`; it cuts the answer at 12,000 characters with the same kind of note.
  - `grep` cuts a line at 300 characters and drops a trailing `\r`.
  - `grep` searches a pattern that doesn't compile, such as `answerPrompt(`, as literal text.
  - `grep` lists the left-out paths under the searched path: `Not searched: 2 files left out of the snapshot (too_large: dist/app.js; binary: logo.png).`
  - `grep` with no match says `No match for /x/ in 12 files.`, plus that left-out note when there are left-out paths.
  - `patternProblem` refuses 501 characters, `(a+)+`, `(a*)*` and `(\w+\s?)+`, and accepts `foo(bar)+` and `a+b+`.
  - `tree` lists to depth 2 by default, with directories ending in `/`, and marks left-out paths `(left out: binary)`. It stops at 500 entries with a note.
- [ ] **Step 2: Run `pnpm vitest run test/search.test.ts`**. Expected: FAIL.
- [ ] **Step 3: Implement**, using `Minimatch` with `{ dot: true, matchBase: true }` as `src/repository/instructions.ts` does. A nested quantifier is a group ending in `+`, `*` or `{` whose body itself contains `+` or `*`. Test each file with the regex once before splitting it into lines.
- [ ] **Step 4: Run the tests**. Expected: PASS.
- [ ] **Step 5: Commit**: `Answer grep and tree over a snapshot, with caps and notes for what was left out (#30)`.

### Task 5: Loading a snapshot

**Files:**
- Create: `src/repository/load-snapshot.ts`
- Test: `test/load-snapshot.test.ts` (reuses the `tarOf` helper; move it to `test/tar-archive.ts` in this task)

**Interfaces:**
- Consumes: `readTar` (Task 1), `TreeListing` and `BlobText` (Task 2), `SnapshotFiles`, `classify`, and the constants (Task 3).
- Produces:
  - `export interface SnapshotSource { tarball(sha: string): Promise<ReadableStream<Uint8Array>>; listing(sha: string): Promise<TreeListing>; blobs(sha: string, paths: readonly string[]): Promise<BlobText[]> }`;
  - `export class SnapshotUnavailable extends Error { constructor(readonly step: "tarball" | "tree", cause: string) }`;
  - `export async function loadSnapshot(source: SnapshotSource, files: SnapshotFiles, sha: string): Promise<SnapshotRecord>`.

- [ ] **Step 1: Write the failing tests**, with a fake `SnapshotSource`:
  - `keeps text files and records binary, LFS and large ones` → record counts by reason.
  - `fills the gap from the tree`: the tree has `tests/a.test.ts`, which the tarball lacks → fetched through `blobs`, `gapFilled: 1`.
  - `marks symlinks and submodules from the tree`: modes `120000` and `160000` → `symlink`, `submodule`.
  - `caps the gap fill at 500`: 600 missing → 500 asked for in one `blobs` call, and 100 left out as `gap_cap`.
  - `stops at the snapshot cap`: with the file cap lowered through a parameter, later files are `snapshot_cap`, and `capped: true`.
  - `retries a failed tarball once`: the first stream errors mid-way, the second succeeds → one complete snapshot with no duplicates.
  - `throws SnapshotUnavailable("tarball")` after two failures, and `("tree")` when the listing fails.
  - `notes a truncated tree`: `treeTruncated: true`, with no gap fill attempted for paths it couldn't list.
- [ ] **Step 2: Run `pnpm vitest run test/load-snapshot.test.ts`**. Expected: FAIL.
- [ ] **Step 3: Implement.** The order is `files.begin(sha)`, then the tarball pass (adding rows in batches of 200), then the listing, then the gap fill, then `files.finish(record)`. Caps come from an optional `limits` parameter that defaults to the Task 3 constants.
- [ ] **Step 4: Run the tests**. Expected: PASS.
- [ ] **Step 5: Commit**: `Load a head's snapshot from the tarball, and fill what export-ignore left out from the tree (#30)`.

### Task 6: The tools

**Files:**
- Modify: `src/review/tools.ts`
- Modify: `test/tools.test.ts`

**Interfaces:**
- Consumes: `grep`, `tree`, `patternProblem` and `MAX_SEARCH_CALLS` (Task 4); `SnapshotFiles` (Task 3).
- Produces:
  - `ReviewHost` gains `repositorySearch(tool: "grep" | "tree"): Promise<SearchAccess>` and `loadedSnapshot(): SnapshotFiles | undefined`, where `export type SearchAccess = { kind: "ready"; files: SnapshotFiles } | { kind: "unavailable"; reason: string } | { kind: "spent" }`.
  - The tools are, in this order: `read_file`, `list_changed_files`, `get_issue`, `grep`, `tree`, `submit_review`.
  - `grep` takes `{ pattern: string; glob?: string; path?: string }` and `tree` takes `{ path?: string; depth?: integer }`. Both are `replay: "safe"`.

- [ ] **Step 1: Write the failing tests**
  - Update `offers the model … tools` to the six names above.
  - `grep answers from the snapshot`, using a host whose `repositorySearch` returns `ready` with a `MemorySnapshotFiles`.
  - `grep says search is unavailable`: `{ kind: "unavailable", reason: "the tarball failed: 502" }` gives exactly `Repository search is unavailable for this review: the tarball failed: 502. Use read_file.`
  - `grep says the budget is spent`: `Search budget spent: 40 grep and tree calls this review. Use read_file.`
  - `grep refuses a bad pattern` with the `patternProblem` reason, without calling `repositorySearch`, so the refusal uses no budget.
  - `read_file reads the head from a loaded snapshot`: no fetch is made.
  - `read_file reads the head from the API when the snapshot is for another sha` (Review Focus 5), and when the snapshot left that path out.
  - `read_file at base ignores the snapshot`.
- [ ] **Step 2: Run `pnpm vitest run test/tools.test.ts`**. Expected: FAIL.
- [ ] **Step 3: Implement.** `read_file` uses `host.loadedSnapshot()` only when its `record()?.sha` equals the `pr.head.sha` it would read, and the path is in it.
- [ ] **Step 4: Run the tests**. Expected: PASS.
- [ ] **Step 5: Commit**: `Give the model grep and tree, and read the head from the snapshot when it's loaded (#30)`.

### Task 7: The object: load, count, drop, log

**Files:**
- Modify: `src/pull-request.ts`, `wrangler.jsonc`

**Interfaces:**
- Consumes: `loadSnapshot`, `SnapshotSource` and `SnapshotUnavailable` (Task 5); `SqlSnapshotFiles` (Task 3); the Task 2 client methods; `SearchAccess` (Task 6).
- Produces: `PullRequest.repositorySearch(tool)` and `PullRequest.loadedSnapshot()`, implementing `ReviewHost`.

- [ ] **Step 1: Implement.**
  - `#snapshot = new SqlSnapshotFiles(this.ctx.storage.sql)`, created lazily. `#loading: Promise<SearchAccess> | undefined` shares one load between parallel tool calls. `#searchFailure: string | undefined` and `#searchCalls = { grep: 0, tree: 0 }` reset when the snapshot is dropped.
  - `repositorySearch(tool)` does the following, in order:
    1. If the calls so far reach `MAX_SEARCH_CALLS`, return `spent`.
    2. Count the call.
    3. If a failure is remembered, return `unavailable`.
    4. If `record()?.sha` equals `(await this.pullRequest()).head.sha`, return `ready`.
    5. Otherwise load, through a `SnapshotSource` built on `github()` and `key()`.
    - It logs `snapshot.loaded` with `{ number, head, files, bytes, leftOut, gapFilled, capped, treeTruncated, ms }`.
    - On `SnapshotUnavailable` or any error, it logs `snapshot.failed` with `{ number, head, step, error }` and remembers the reason.
  - `#dropSnapshot(reason: "review_end" | "answer_end")` calls `drop()`, logs `snapshot.dropped` with `{ number, reason }` when it returned `true`, and resets the counters. Call it in a `finally` around the body of `runReview` and of `answer`. A later tool call reloads it lazily, which is harmless.
  - `review.done` adds `greps` and `trees`, read before the drop.
  - In `wrangler.jsonc`, add `"limits": { "cpu_ms": 120000 }`, with the file's usual short comment saying a vscode-size snapshot load took 8.2 s of CPU and a grep up to 0.6 s.
- [ ] **Step 2: Run `pnpm check`**. Expected: PASS (typecheck confirms `PullRequest` still satisfies `ReviewHost`).
- [ ] **Step 3: Commit**: `Load the snapshot on the first search, share one load, and drop it when the review or answer ends (#30)`.

### Task 8: Skill, prompt and docs

**Files:**
- Modify: `skills/review/SKILL.md` (version `"7"`), `src/review/prompt.ts` (`systemPrompt`), `test/skills.test.ts`, `test/prompt.test.ts`, `docs/design.md`

- [ ] **Step 1: Update the tests:** `test/skills.test.ts` expects version `"7"`, and `test/prompt.test.ts` expects the system prompt's tool line to name `grep` and `tree`. Run them. Expected: FAIL.
- [ ] **Step 2: Edit the skill.**
  - In the step that reads hunks, replace the `read_file` sentence with: "Call `read_file` when a hunk alone cannot settle a question. When a change alters a function's signature, an export or a type that other code uses, `grep` for its callers and read them before judging."
  - Under **Defects** add: "Before writing a failure scenario that depends on another function, read that function."
  - Bump the version to `"7"`.
- [ ] **Step 3: Edit `systemPrompt`'s tool line** to add: "grep searches the head's files by regular expression; tree lists its directories".
- [ ] **Step 4: Edit `docs/design.md`.**
  - In the architecture sketch, line 30, the tools become `pr, diff, read_file, tree, grep`.
  - In the tools table, `read_file` reads from "`GET /contents?ref=`, or the head's snapshot when loaded". `tree` and `grep` become "the head's snapshot". Drop the `@cloudflare/computer` wording.
  - Tier 2 in "Execution tiers" becomes the tarball snapshot. Summarise the spec's loading, gap-fill, cap and drop rules in the doc's prose style, and point to the spec.
  - Add a `## Repository search` paragraph after the skills paragraph, naming the tools and the 40-call budget.
- [ ] **Step 5: Run `pnpm check`**. Expected: PASS.
- [ ] **Step 6: Commit**: `Teach the review skill to grep for callers, and document repository search (#30)`.

### Task 9: Live check on this repository

- [ ] **Step 1:** Ask the peer sessions (`ListAgents`; `ai-review-agent-8a` and `-be` on 22 Oct) for a deploy window. Deploy the branch from this worktree with `pnpm wrangler deploy`, recording the version id it replaces for rollback.
- [ ] **Step 2:** Open a throwaway PR, not a draft. Its branch changes `answerPrompt`'s signature in `src/review/prompt.ts` (add a required parameter) without updating its caller in `src/pull-request.ts`. The PR body says it's a throwaway for #30.
- [ ] **Step 3:** Capture the Workers logs, as in the `live-check-logs` memory. Expect `snapshot.loaded` (files ≈ 120), at least one `grep` (`review.done` `greps` ≥ 1), and a blocking finding naming the caller in `src/pull-request.ts`. Record the footer's cost, and compare it with the last comparable review's.
- [ ] **Step 4:** Close the PR unmerged and delete its branch. Roll back to the recorded version, or deploy main, and tell the peers the window is closed.

### Task 10: Live check on a private, large repository (needs Andrew)

- [ ] **Step 1:** Create a private repository `ItsAndrewM/andabot-search-fixture` holding facebook/react at a pinned commit (record the sha). Add `.gitattributes` with `fixtures/** export-ignore`, plus a file `fixtures/needle.txt` containing `andabot-needle-30`. Ask Andrew to install the andabot App on it.
- [ ] **Step 2:** In the same deploy window as Task 9, or a new one, open a PR there whose diff asks a question best answered by search, such as renaming a function used elsewhere. Comment `@andabot where is andabot-needle-30?` on it.
- [ ] **Step 3:** Expect the following:
  - `snapshot.loaded` with no `snapshot.failed`, which shows the installation-token tarball works on a private repo.
  - `gapFilled` ≥ 1.
  - The answer naming `fixtures/needle.txt`.
  - The load's CPU, from the tail, under 5 s.
- [ ] **Step 4:** Record the numbers on #30, and keep the repository for later re-checks.
