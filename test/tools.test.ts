import { describe, expect, it } from "vitest"
import { GitHubClient, type PullRequestInfo } from "../src/github/client.ts"
import { MemorySnapshotFiles, type SnapshotFiles } from "../src/repository/snapshot.ts"
import {
  changedFilesText,
  createReviewExtension,
  grepText,
  readFileText,
  readIssue,
  submitResult,
  treeText,
  type ReviewHost,
  type SearchAccess,
} from "../src/review/tools.ts"

const pr = {
  number: 21,
  title: "Fix totals",
  body: "Totals were NaN for an empty cart.",
  state: "open",
  user: { login: "andrew" },
  base: { ref: "main", sha: "0123456789abcdef", repo: { full_name: "o/r" } },
  head: { ref: "fix/totals.GH-7", sha: "fedcba9876543210" },
  changed_files: 0,
  additions: 0,
  deletions: 0,
  labels: [],
} satisfies PullRequestInfo

const answers = new Map([
  [
    "https://api.example/repos/o/r/issues/7",
    { status: 200, body: JSON.stringify({ number: 7, title: "Fix totals", body: "Totals are NaN.", state: "open" }) },
  ],
  ["https://api.example/repos/o/r/issues/8", { status: 404, body: "{}" }],
  [
    "https://api.example/repos/o/r/issues/9",
    {
      status: 200,
      body: JSON.stringify({ number: 9, title: "Add totals", body: "", state: "open", pull_request: {} }),
    },
  ],
])

const fakeFetch = async (input: RequestInfo | URL) => {
  const answer = answers.get(String(input))
  if (answer === undefined) return new Response(`no answer for ${String(input)}`, { status: 500 })
  return new Response(answer.body, { status: answer.status })
}

const host = {
  botLogin: () => "andabot",
  github: async () => new GitHubClient("token", "https://api.example", fakeFetch),
  pullRequest: async () => pr,
  changedFiles: async () => [],
  pathFilters: async () => [],
  submitReview: async () => ({ text: "Nothing to post.", done: false }),
  repositorySearch: async (): Promise<SearchAccess> => ({ kind: "unavailable", reason: "no snapshot" }),
  loadedSnapshot: (): SnapshotFiles | undefined => undefined,
} satisfies ReviewHost

const headSha = pr.head.sha
const baseSha = pr.base.sha

function snapshotOf(sha: string, files: Record<string, string>): MemorySnapshotFiles {
  const snapshot = new MemorySnapshotFiles()
  snapshot.begin(sha)
  snapshot.add(Object.entries(files).map(([path, content]) => ({ path, content })))
  snapshot.finish({
    sha,
    files: Object.keys(files).length,
    bytes: 0,
    gapFilled: 0,
    leftOut: {},
    capped: false,
    treeTruncated: false,
  })
  return snapshot
}

function hostWith(options: { snapshot?: SnapshotFiles; search?: SearchAccess }) {
  const requested: string[] = []
  const contents = new Map([
    [`https://api.example/repos/o/r/contents/src/a.ts?ref=${headSha}`, "from the head api"],
    [`https://api.example/repos/o/r/contents/src/a.ts?ref=${baseSha}`, "from the base api"],
  ])
  const recordingFetch = async (input: RequestInfo | URL) => {
    requested.push(String(input))
    const body = contents.get(String(input))
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(body, { status: 200 })
  }
  const searched: string[] = []
  const wired = {
    ...host,
    github: async () => new GitHubClient("token", "https://api.example", recordingFetch),
    loadedSnapshot: () => options.snapshot,
    repositorySearch: async (tool: "grep" | "tree"): Promise<SearchAccess> => {
      searched.push(tool)
      return options.search ?? { kind: "unavailable", reason: "no snapshot" }
    },
  } satisfies ReviewHost
  return { host: wired, requested, searched }
}

describe("changedFilesText", () => {
  const files = [
    { filename: "src/x.ts", status: "modified", additions: 3, deletions: 1 },
    { filename: "test/__snapshots__/x.test.ts.snap", status: "added", additions: 40, deletions: 0 },
  ]

  it("lists each changed file with its status and counts, and marks the ones path_filters leave out", async () => {
    const filtering = { ...host, changedFiles: async () => files, pathFilters: async () => ["!**/*.snap"] }
    expect(await changedFilesText(filtering)).toBe(
      "modified  +3 -1  src/x.ts\nadded     +40 -0  test/__snapshots__/x.test.ts.snap (filtered)",
    )
  })

  it("marks nothing when no filter applies, and says so when nothing changed", async () => {
    expect(await changedFilesText({ ...host, changedFiles: async () => files })).toBe(
      "modified  +3 -1  src/x.ts\nadded     +40 -0  test/__snapshots__/x.test.ts.snap",
    )
    expect(await changedFilesText(host)).toBe("(no files)")
  })
})

describe("createReviewExtension", () => {
  it("offers the model six tools, with submit_review last", () => {
    expect(createReviewExtension(host).tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_changed_files",
      "get_issue",
      "grep",
      "tree",
      "submit_review",
    ])
  })

  it("never reruns grep or tree after a reset, so a scan that reset the object cannot loop", () => {
    const tools = createReviewExtension(host).tools ?? []
    const replays = tools.filter((tool) => tool.name === "grep" || tool.name === "tree").map((tool) => tool.replay)
    expect(replays).toEqual(["unsafe", "unsafe"])
  })

  it("still reruns the API reads after a reset", () => {
    const tools = createReviewExtension(host).tools ?? []
    const reads = ["read_file", "list_changed_files", "get_issue"]
    const replays = tools.filter((tool) => reads.includes(tool.name)).map((tool) => tool.replay)
    expect(replays).toEqual(["safe", "safe", "safe"])
  })

  it("tells the model that a grep glob matches the repository-relative path at any depth", () => {
    const grepTool = createReviewExtension(host).tools?.find((tool) => tool.name === "grep")
    const glob = JSON.stringify(grepTool?.parameters)
    expect(glob).toContain("repository root")
    expect(glob).toContain("*.ts")
  })
})

describe("grepText", () => {
  const snapshot = snapshotOf(headSha, { "src/a.ts": "export const total = 1\n", "src/b.ts": "const x = total + 1\n" })

  it("answers from the snapshot", async () => {
    const { host: wired } = hostWith({ search: { kind: "ready", files: snapshot } })
    const answer = await grepText(wired, { pattern: "total", glob: "*.ts" })
    expect(answer).toContain("src/a.ts")
    expect(answer).toContain("export const total = 1")
    expect(answer).toContain("src/b.ts")
  })

  it("says search is unavailable", async () => {
    const { host: wired } = hostWith({ search: { kind: "unavailable", reason: "the tarball failed: 502" } })
    expect(await grepText(wired, { pattern: "total" })).toBe(
      "Repository search is unavailable for this review: the tarball failed: 502. Use read_file.",
    )
  })

  it("says the budget is spent", async () => {
    const { host: wired } = hostWith({ search: { kind: "spent" } })
    expect(await grepText(wired, { pattern: "total" })).toBe(
      "Search budget spent: 40 grep and tree calls this review. Use read_file.",
    )
  })

  it("says search again when the snapshot was dropped between the access check and the scan", async () => {
    const unfinished = new MemorySnapshotFiles()
    unfinished.begin(headSha)
    unfinished.add([{ path: "src/a.ts", content: "export const total = 1\n" }])
    const { host: wired } = hostWith({ search: { kind: "ready", files: unfinished } })
    const replaced =
      "Repository search is unavailable for this review: the snapshot was replaced while searching; search again. Use read_file."
    expect(await grepText(wired, { pattern: "total" })).toBe(replaced)
    expect(await treeText(wired, {})).toBe(replaced)
  })

  it("refuses a bad pattern without asking for search access, so the refusal uses no budget", async () => {
    const { host: wired, searched } = hostWith({ search: { kind: "ready", files: snapshot } })
    expect(await grepText(wired, { pattern: "" })).toBe("Pattern refused: The pattern is empty.")
    expect(searched).toEqual([])
  })

  it("refuses two wildcards with the prefix said once", async () => {
    const { host: wired, searched } = hostWith({ search: { kind: "ready", files: snapshot } })
    expect(await grepText(wired, { pattern: ".*a.*b" })).toMatch(
      /^Pattern refused: it has more than one unbounded wildcard \(such as \.\* twice\)/,
    )
    expect(searched).toEqual([])
  })

  it("refuses a repeated alternation", async () => {
    const { host: wired } = hostWith({ search: { kind: "ready", files: snapshot } })
    expect(await grepText(wired, { pattern: String.raw`foo(.|\s)*bar` })).toBe(
      String.raw`Pattern refused: it repeats an alternation such as (.|\s)*, which can run for minutes; use a character class such as [\s\S]* instead`,
    )
  })
})

describe("treeText", () => {
  const snapshot = snapshotOf(headSha, { "src/a.ts": "a", "src/deep/b.ts": "b", "README.md": "r" })

  it("lists the snapshot under a path", async () => {
    const { host: wired, searched } = hostWith({ search: { kind: "ready", files: snapshot } })
    expect(await treeText(wired, { path: "src", depth: 1 })).toBe("src/a.ts\nsrc/deep/")
    expect(searched).toEqual(["tree"])
  })

  it("says search is unavailable", async () => {
    const { host: wired } = hostWith({ search: { kind: "unavailable", reason: "no snapshot" } })
    expect(await treeText(wired, {})).toBe(
      "Repository search is unavailable for this review: no snapshot. Use read_file.",
    )
  })

  it("says the budget is spent", async () => {
    const { host: wired } = hostWith({ search: { kind: "spent" } })
    expect(await treeText(wired, {})).toBe("Search budget spent: 40 grep and tree calls this review. Use read_file.")
  })
})

describe("readFileText", () => {
  it("reads the head from a loaded snapshot without calling the API", async () => {
    const snapshot = snapshotOf(headSha, { "src/a.ts": "from the snapshot" })
    const { host: wired, requested } = hostWith({ snapshot })
    expect(await readFileText(wired, { path: "src/a.ts" })).toBe("    1 | from the snapshot")
    expect(requested).toEqual([])
  })

  it("reads the head from the API when the snapshot is for another sha", async () => {
    const snapshot = snapshotOf(baseSha, { "src/a.ts": "from the snapshot" })
    const { host: wired, requested } = hostWith({ snapshot })
    expect(await readFileText(wired, { path: "src/a.ts" })).toBe("    1 | from the head api")
    expect(requested).toHaveLength(1)
  })

  it("reads the head from the API when the snapshot left that path out", async () => {
    const snapshot = snapshotOf(headSha, { "src/other.ts": "x" })
    const { host: wired, requested } = hostWith({ snapshot })
    expect(await readFileText(wired, { path: "src/a.ts" })).toBe("    1 | from the head api")
    expect(requested).toHaveLength(1)
  })

  it("reads the head from the API when the snapshot has no record, as when a load was interrupted", async () => {
    const snapshot = new MemorySnapshotFiles()
    snapshot.begin(headSha)
    snapshot.add([{ path: "src/a.ts", content: "partial" }])
    const { host: wired } = hostWith({ snapshot })
    expect(await readFileText(wired, { path: "src/a.ts" })).toBe("    1 | from the head api")
  })

  it("reads the base from the API and ignores the snapshot", async () => {
    const snapshot = snapshotOf(headSha, { "src/a.ts": "from the snapshot" })
    const { host: wired, requested } = hostWith({ snapshot })
    expect(await readFileText(wired, { path: "src/a.ts", ref: "base" })).toBe("    1 | from the base api")
    expect(requested).toHaveLength(1)
  })

  it("says so when the file does not exist at the head", async () => {
    const { host: wired } = hostWith({})
    expect(await readFileText(wired, { path: "src/none.ts" })).toBe("src/none.ts does not exist at head (fedcba9).")
  })
})

describe("readIssue", () => {
  it("gives an issue's number, title, state and body", async () => {
    expect(await readIssue(host, 7)).toBe("#7: Fix totals (open)\n\nTotals are NaN.")
  })

  it("says so when the issue does not exist", async () => {
    expect(await readIssue(host, 8)).toBe("Issue #8 does not exist.")
  })

  it("says so when the number is a pull request, which GitHub's issue endpoint also serves", async () => {
    expect(await readIssue(host, 9)).toBe("#9 is a pull request, not an issue.")
  })
})

describe("submitResult", () => {
  it("ends the run when the host says the review is done", () => {
    expect(submitResult({ text: "Posted review 1.", done: true })).toEqual({
      output: [{ type: "text", text: "Posted review 1." }],
      control: { terminate: true },
    })
  })

  it("leaves the run going when the host says there is more to do, so the model can correct and submit again", () => {
    const result = submitResult({ text: "Nothing to post.", done: false })
    expect(result.output).toEqual([{ type: "text", text: "Nothing to post." }])
    expect(result).not.toHaveProperty("control")
  })
})
