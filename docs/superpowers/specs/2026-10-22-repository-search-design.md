# Repository search: design

Status: agreed with Andrew on 22 Oct 2026 for issue #30. Choices marked *(builder's call)* were made by the writer and can be changed without going back to him.

## Why

The model can read a file by path (`read_file`) and list the changed files, but it can't search. To check the callers of a function whose signature changed, it has to guess where they are, so a defect outside the diff goes unseen. The audit of all 146 posted findings on 21 Oct (recorded on #31) found the same gap behind GLM's false findings: a failure scenario that stops one step short of a function in another file. On #49 it claimed a chat comment would be forced to JSON, which `answerPrompt`, one file away, rules out.

Andrew wants andabot on GameSheet's repositories once the first iteration is right. Those are private, in the `GameSheet-Inc` org, and range up to `mono` (35 MB, 3,102 files) and repositories holding 60 to 112 MB, mostly in a few large binaries. So private-repository auth and repositories of that size are in scope from the start.

## Goals

1. **Search the head.** The model gets `grep(pattern, glob)` and `tree(path)` over every text file at the commit under review, not just the diff.
2. **Any repository andabot is installed on.** Private ones through the installation token, fork pull requests, and repositories of `mono`'s size and larger.
3. **Cheap enough to run on every review.** Well inside a Durable Object's CPU limit, and nothing for a review that never searches.
4. **Say what's missing.** A file the snapshot couldn't hold is reported as such, never as "no match" or "does not exist".

## Non-goals

- Running commands: tests, linters, a type checker. That is phase 3's Sandbox tier, and a container would replace this snapshot then.
- Semantic or embedding search, or a prebuilt index. Grep is what agents use; an index would have to be rebuilt for every head.
- Searching the base commit. `read_file` with `ref: "base"` keeps using the API.
- Git history, blame or `git log` in a tool.
- Measuring review quality on GameSheet repositories. The first iteration is checked on this repository.

## Anti-goals

These would make it a failure even if it technically worked:

- A review that ends, or a Durable Object that is reset, because a snapshot or a grep ran out of CPU.
- `grep` saying "no match" for a file it never loaded, or `read_file` saying a file doesn't exist when the snapshot only skipped it.
- Snapshots piling up in storage across pull requests andabot no longer reviews.
- A review that fails because the snapshot did. Search is an aid, and the review goes on without it.

## Decided with Andrew

- **A tarball, not a clone.** #30 proposed a shallow clone with `@cloudflare/computer`. Both were measured in production on throwaway Workers on 21 and 22 Oct:

  | Repository | Clone (isomorphic-git, depth 1) | Tarball, text files only |
  | --- | --- | --- |
  | ai-review-agent, 1 MB | 0.19 s CPU | 0.03 s |
  | cloudflare/agents, 29 MB | 9.2 s | ≤ 0.9 s |
  | cloudflare/workers-sdk, 35 MB | 18.7 s | ≤ 0.9 s |
  | facebook/react, 37 MB of text | over the 30 s limit; object reset | ≤ 0.9 s |
  | microsoft/vscode, 253 MB of text | not tried | 8.2 s |

  During the build, the task review measured `.*foo.*bar` at 6.3 s on one 8.8 KB line, which is why grep runs on `re2js`, a linear-time engine, tests only a line's first 500 characters, and stops a call once the work it charges passes a budget of 750,000,000 units: a fixed cost per line, its characters, the states `re2js`'s DFA builds, a program's size per character for a `^`-anchored pattern `re2js` runs one pass at a time, and the prefilter's extra scans. The engine alone isn't enough, since `.{0,400}e.{0,400}t.{0,400}[#@]{3}` still took about 275 s over react; with the budget, the worst measured call on ASCII text would stop within about 8.6 s.

  A grep scan with no match took 70 ms of CPU on react and 619 ms on vscode. The clone downloads, inflates and stores every blob, binaries included, and no pure-JavaScript git client supports partial clone. The tarball streams past binaries and large files without storing them. It needs no dependency, where `@cloudflare/computer` with isomorphic-git and its `@platformatic/vfs` peer weighed 230 KB gzipped.
- **The research found nothing better for a Worker.** Reviewers that grep the whole repository (CodeRabbit, Copilot, Cloudflare's own) run on a real filesystem in a microVM, container or CI runner. Cloudflare Artifacts stores a repository the way this design does, as SQLite rows in a Durable Object, but imports only public repositories, can't pin a commit and has no search yet. GitHub's code search sees only the default branch. A container is the phase 3 upgrade.

## How *(builder's call unless noted)*

Two builder's calls changed what's below, as `docs/design.md` records: a pattern that doesn't compile is searched as literal text, and the answer says so, rather than refused, and the snapshot record lives in a `snapshot_meta` table beside `snapshot_files`, not in the key-value storage.

### The snapshot

A snapshot is the head commit's text files, stored in the pull request's object.

- **Loaded on first use.** The first `grep` or `tree` call of a review, or of a question, loads the snapshot of the pull request's head. A review that never searches costs nothing. Loading takes up to a few seconds of wall time, inside that tool call.
- **Only while it's used.** The snapshot is deleted when the review or the answer that loaded it ends, posted or not, so nothing stays behind for a pull request that is closed, idle or whose `closed` event never arrived. The next review or question loads it again, which costs under a second of CPU for every measured repository but vscode *(decided after the builder check)*. A load for a sha other than the stored one deletes the old rows first.
- **Storage.** A SQLite table `snapshot_files (path TEXT PRIMARY KEY, content TEXT)`, created by the object, and a `snapshot` record in the key-value storage with the head sha, counts and what was left out (below), checked with `Value.Check` when read. A record for another sha, or one that fails the check, means no snapshot. Rows are written in transactions of a few hundred.

### Loading

1. **The tarball.** `GET /repos/{owner}/{repo}/tarball/{headSha}` on the base repository with the installation token. GitHub redirects to `codeload.github.com` with a short-lived token in the URL, and `fetch` follows it. The base repository serves a fork pull request's head sha. One retry on a failed or cut-off download.
2. **Streaming.** The body goes through `DecompressionStream("gzip")` into a tar reader that handles ustar headers with their prefix field, pax `x` and `g` headers, GNU long names (`L`), and zero blocks. Each entry's leading directory (`owner-repo-sha/`) is stripped. The reader keeps a regular file of 1 MB or less with no NUL byte in its first 8 KB, and skips past everything else without buffering it.
3. **What the tarball leaves out.** A path marked `export-ignore` in `.gitattributes` is missing from GitHub's archives: `laravel/framework`'s tarball has no `tests/`, for example. So the loader reads the recursive tree at the head sha and compares it with what it kept. It fetches each missing blob of 1 MB or less through GraphQL, in aliased batches of 50 `object(expression: "sha:path") { ... on Blob { text isBinary isTruncated } }`, up to 500 files. A truncated or binary answer is skipped.
4. **The record.** It lists the paths it couldn't hold, in groups: too large, binary, LFS pointer (content starting `version https://git-lfs.github.com/spec/v1`), submodule, symlink, beyond the gap-fill cap, and a note that the tree came back truncated, so the gap fill covered only the paths it listed.

A snapshot is capped at 50,000 files or 400 MB of text. Past the cap, loading stops, and the snapshot covers only the paths loaded, with a note that names the cap. `limits.cpu_ms` in `wrangler.jsonc` rises to 300,000, the maximum, so a vscode-size load and several greps that spend their budgets can't reset the object.

### Tools

- **`grep(pattern, glob?, path?)`.** An RE2 regular expression, run on `re2js` so that no pattern can backtrack, matched line by line over the snapshot's files under `path`, optionally filtered by a glob (`minimatch`, which the repository already uses). It returns `path:line: text` lines, each cut at 300 characters, at most 100 matches and 12,000 characters, with a closing note saying how many matches and files were left out. Each call has a work budget of 750,000,000 units. A line is charged `LINE_UNITS` (16), plus its characters plus one, plus the program's size times its character classes plus one for each state the DFA builds, since wide bounded repeats such as `.{0,400}` make `re2js` rebuild states or fall off its DFA. A line on which the DFA clears its cache, and may fall back to the backtracker or NFA, is charged that state rate times the states since the clear plus its characters plus one. A `^`-anchored program `re2js` runs with OnePass is charged instead its program size per character plus one, plus `LINE_UNITS`. Both are charged, per character plus one, a unit for each of the prefilter's Aho–Corasick scans after the first and for every 16 of its plain-substring scans. A call stops before a line whose worst case would pass the budget, and says so. An empty pattern or one longer than 500 characters is refused with the reason. A pattern `re2js` can't compile, such as one with lookaround or a backreference, is searched as literal text, and the answer says so.
- **`tree(path?, depth?)`.** The directories and files under `path` from the snapshot's paths, with the left-out paths marked by their reason, at most 500 entries, depth 2 by default.
- **`read_file`.** At the head, when a snapshot is loaded, it reads from the snapshot. A path the snapshot left out falls back to the contents API, as today. Without a snapshot it uses the API.
- **Budget.** The work budget bounds what a search costs: on ASCII text a unit cost at most 11.5 ns in measurement (one Aho–Corasick prefilter scan plus 15 substring scans), so a call that spends all 750,000,000 units takes at most about 8.6 s of CPU, and the output caps bound only the answer. CJK text with many character classes costs 16–21 ns a unit, but the byte-counted snapshot cap holds a whole snapshot of it to about 3 s. A `^`-anchored search may need a path or glob on a large repository. A review gets at most 40 `grep` and `tree` calls together, after which the tools say the budget is spent.
- **The answer flow.** A question asked in a thread gets the same tools.

`read_file` is `replay: "safe"`. `grep` and `tree` are not, so a scan that resets the object isn't rerun when it reopens.

### When search is unavailable

If the tarball can't be read, or the tree can't, the tools answer "Repository search is unavailable for this review: <reason>. Use read_file." and the review goes on. The failure is logged and not retried within the review.

### The skill and the prompt

The review skill's defect check adds: when a changed signature, export or type has callers, `grep` for them before judging. It also adds: before writing a failure scenario that depends on another function, read that function. The skill version is bumped. The system prompt's tool list names `grep` and `tree`.

### Logs

`snapshot.loaded`, with the head sha, files, bytes, the counts left out by reason, gap-filled files and milliseconds. `snapshot.failed`, with the step and the error. `snapshot.dropped`, when a review or an answer ends or a new head replaces it. `review.done` adds `greps` and `trees`, the number of calls.

### Docs

`docs/design.md`'s tools table and execution tiers: tier 2 becomes the tarball snapshot, and `@cloudflare/computer` is no longer named.

## Tests

- **The tar reader**, on archives built in the test: ustar names with a prefix, pax long paths, GNU long names, a file split across chunks at every boundary, zero-block padding, skipped large and binary files, the leading directory stripped.
- **The gap fill:** paths in the tree but not the tarball are requested, binary and truncated answers skipped, the 500-file cap noted.
- **`grep`:** glob and path filters, the match, line and character caps with their notes, refused patterns, and a left-out path reported, not silently absent.
- **`tree`:** depth, the 500-entry cap, left-out paths marked.
- **Fallbacks:** a failed tarball or tree makes the tools say so, and `read_file` falls back to the API for a left-out path.
- **Storage:** a record for another sha counts as no snapshot.

GitHub is replaced through the client's interface, as elsewhere, with no `vi.mock`.

## Done when

- The tests above pass under `pnpm check`.
- On a throwaway pull request that changes a function's signature, the review gets a finding that names a caller outside the diff, on GLM-5.3 Flash. This is #30's own check.
- **A private, large repository** *(decided with Andrew after the builder check)*. A private throwaway repository on Andrew's account holds facebook/react at a pinned commit, with one directory marked `export-ignore` in `.gitattributes`, and andabot is installed on it. Copying a GameSheet repository is out, since that is company code outside the org. Andrew installs the App. A throwaway pull request there must log a `snapshot.loaded` with the installation token, the gap fill bringing back the `export-ignore` directory, and the load's CPU from the tail; and a `grep` that finds a match inside that directory.
- `snapshot.loaded` on the review of this repository shows the snapshot's numbers. Its footer cost is compared by hand with the same pull request reviewed without the tools, to see what searching added; the footer itself is unchanged *(decided after the builder check)*.
