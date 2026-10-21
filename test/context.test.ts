import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { GitHubClient, type TreeEntry } from "../src/github/client.ts"
import {
  CONTEXT_PREFIX,
  contextKey,
  loadRepositoryContext,
  MAX_INSTRUCTION_LOADS,
  readRepositoryContext,
  reviewInstructions,
  reviewStandards,
  staleContextKeys,
  standardsFor,
  StoredRepositoryContext,
  unloadedPaths,
  type RepositoryContext,
} from "../src/repository/context.ts"

const ref = { owner: "o", repo: "r" }
const BASE = "ba5e5".repeat(8)
const OTHER_BASE = "0".repeat(40)
const TREE_SHA = "f00d".repeat(10)
const CONTENTS = "/repos/o/r/contents/"
const TREE_PATH = `/repos/o/r/git/trees/${BASE}?recursive=1`
const WEB = ["apps/web/src/a.ts"]

const blob = (path: string): TreeEntry => ({ path, type: "blob", sha: "1" })

const contentsPath = (path: string): string => `${CONTENTS}${path}?ref=${BASE}`

const ENTRIES: TreeEntry[] = [
  blob("CLAUDE.md"),
  blob("AGENTS.md"),
  { path: "apps", type: "tree", sha: "2" },
  blob("apps/web/CLAUDE.md"),
  blob("apps/web/src/a.ts"),
  blob("apps/api/CLAUDE.md"),
]

const BODIES = new Map([
  ["CLAUDE.md", "Root rules."],
  ["apps/web/CLAUDE.md", "Web rules."],
  ["apps/api/CLAUDE.md", "Api rules."],
])

function fakeGitHub(entries: readonly TreeEntry[], bodies: ReadonlyMap<string, string>, truncated = false) {
  const calls: string[] = []
  const answer = (pathname: string): Response => {
    if (pathname.startsWith("/repos/o/r/git/trees/")) {
      return new Response(JSON.stringify({ sha: TREE_SHA, truncated, tree: entries }), { status: 200 })
    }
    const body = bodies.get(decodeURIComponent(pathname.slice(CONTENTS.length)))
    return body === undefined
      ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
      : new Response(body, { status: 200 })
  }
  const fetchImpl: typeof fetch = async (input) => {
    const { pathname, search } = new URL(String(input))
    calls.push(`${pathname}${search}`)
    return answer(pathname)
  }
  return { github: new GitHubClient("t", "https://api.example", fetchImpl), calls }
}

const loaded = (changed: readonly string[], cached?: RepositoryContext): Promise<RepositoryContext> =>
  loadRepositoryContext(fakeGitHub(ENTRIES, BODIES).github, ref, BASE, changed, cached)

const contextOf = (entries: readonly TreeEntry[], files: Readonly<Record<string, string>>): RepositoryContext => ({
  baseSha: BASE,
  tree: { sha: TREE_SHA, truncated: false, entries },
  files,
})

describe("loadRepositoryContext", () => {
  it("reads the tree and each candidate's body at the base commit, and remembers a file the contents API does not find as empty", async () => {
    const { github, calls } = fakeGitHub(ENTRIES, BODIES)
    const context = await loadRepositoryContext(github, ref, BASE, WEB)
    expect(context).toEqual({
      baseSha: BASE,
      tree: { sha: TREE_SHA, truncated: false, entries: ENTRIES },
      files: { "apps/web/CLAUDE.md": "Web rules.", "CLAUDE.md": "Root rules.", "AGENTS.md": "" },
    })
    expect([...calls].sort()).toEqual(
      [TREE_PATH, contentsPath("apps/web/CLAUDE.md"), contentsPath("CLAUDE.md"), contentsPath("AGENTS.md")].sort(),
    )
  })

  it("reuses the cached context of the same base sha, though its tree has a sha of its own, without calling GitHub, the missing file included", async () => {
    const cached = await loaded(WEB)
    const { github, calls } = fakeGitHub(ENTRIES, BODIES)
    expect(await loadRepositoryContext(github, ref, BASE, WEB, cached)).toBe(cached)
    expect(calls).toEqual([])
  })

  it("extends the cached context with the candidates a new changed path brings, loading only those", async () => {
    const cached = await loaded(WEB)
    const { github, calls } = fakeGitHub(ENTRIES, BODIES)
    const extended = await loadRepositoryContext(github, ref, BASE, [...WEB, "apps/api/b.ts"], cached)
    expect(calls).toEqual([contentsPath("apps/api/CLAUDE.md")])
    expect(extended).toEqual({ ...cached, files: { ...cached.files, "apps/api/CLAUDE.md": "Api rules." } })
  })

  it("fetches a fresh tree for another base sha and keeps none of that commit's files", async () => {
    const other: RepositoryContext = {
      baseSha: OTHER_BASE,
      tree: { sha: OTHER_BASE, truncated: false, entries: [blob("CLAUDE.md"), blob("REVIEW.md")] },
      files: { "CLAUDE.md": "Old rules.", "REVIEW.md": "Old review rules." },
    }
    const { github, calls } = fakeGitHub(ENTRIES, BODIES)
    const context = await loadRepositoryContext(github, ref, BASE, WEB, other)
    expect(calls).toContain(TREE_PATH)
    expect(context).toEqual(await loaded(WEB))
  })

  it("loads at most 24 uncached candidates a review, the root files first and then the rest in candidate order, and leaves the rest to the next review", async () => {
    const rules = Array.from(
      { length: 30 },
      (_, index) => `.github/instructions/rule-${String(index).padStart(2, "0")}.instructions.md`,
    )
    const bodies = new Map([...rules, "CLAUDE.md"].map((path): [string, string] => [path, `Rules from ${path}.`]))
    const { github, calls } = fakeGitHub([blob("CLAUDE.md"), ...rules.map(blob)], bodies)
    const first = await loadRepositoryContext(github, ref, BASE, ["a.ts"])
    expect(Object.keys(first.files)).toEqual(["CLAUDE.md", ...rules.slice(0, 23)])
    expect(unloadedPaths(first, ["a.ts"])).toEqual(rules.slice(23))
    const second = await loadRepositoryContext(github, ref, BASE, ["a.ts"], first)
    expect(unloadedPaths(second, ["a.ts"])).toEqual([])
    expect(calls).toHaveLength(1 + 24 + 7)
    expect(MAX_INSTRUCTION_LOADS).toBe(24)
  })

  it("loads all five root files of 25 candidates ahead of the 20 nested ones, so many nested files never cost the root CLAUDE.md, and still renders them last", async () => {
    const nested = Array.from({ length: 20 }, (_, index) => `pkg-${String(index).padStart(2, "0")}/CLAUDE.md`)
    const root = ["CLAUDE.md", "AGENTS.md", "REVIEW.md", "CODING_STANDARDS.md", "CONTRIBUTING.md"]
    const changed = nested.map((path) => path.replace("CLAUDE.md", "a.ts"))
    const bodies = new Map([...nested, ...root].map((path): [string, string] => [path, `Rules from ${path}.`]))
    const { github } = fakeGitHub([...root, ...nested].map(blob), bodies)
    const context = await loadRepositoryContext(github, ref, BASE, changed)
    expect(Object.keys(context.files)).toEqual([...root, ...nested.slice(0, 19)])
    expect(unloadedPaths(context, changed)).toEqual(["pkg-19/CLAUDE.md"])
    expect(standardsFor(context, changed, []).used).toEqual([...nested.slice(0, 19), ...root])
  })

  it("reads a truncated tree as listed", async () => {
    const { github } = fakeGitHub([blob("CLAUDE.md")], BODIES, true)
    const context = await loadRepositoryContext(github, ref, BASE, WEB)
    expect(context.tree.truncated).toBe(true)
    expect(context.files).toEqual({ "CLAUDE.md": "Root rules." })
  })

  it("keeps the tree of a base with no instruction file, so the next review of that base calls nothing", async () => {
    const { github } = fakeGitHub([blob("README.md")], BODIES)
    const context = await loadRepositoryContext(github, ref, BASE, WEB)
    expect(context).toEqual(contextOf([blob("README.md")], {}))
    const { github: idle, calls } = fakeGitHub([], new Map())
    expect(await loadRepositoryContext(idle, ref, BASE, WEB, context)).toBe(context)
    expect(calls).toEqual([])
  })

  it("throws when the contents API fails for another reason than a missing file, so a failed read is never cached as missing", async () => {
    await expect(loadRepositoryContext(unservedFiles(), ref, BASE, WEB)).rejects.toThrow(/GitHub 502 .*boom/)
  })
})

function unservedFiles(): GitHubClient {
  const fetchImpl: typeof fetch = async (input) =>
    String(input).includes("/git/trees/")
      ? new Response(JSON.stringify({ sha: TREE_SHA, truncated: false, tree: [blob("CLAUDE.md")] }), { status: 200 })
      : new Response("boom", { status: 502 })
  return new GitHubClient("t", "https://api.example", fetchImpl)
}

const NO_STANDARDS = { text: "", used: [], cut: [], loadsSkipped: 0, treeTruncated: false }

describe("readRepositoryContext", () => {
  it("reports a tree GitHub fails to serve and leaves the review without standards, rather than failing it", async () => {
    const reported: string[] = []
    const failing = new GitHubClient("t", "https://api.example", async () => new Response("boom", { status: 500 }))
    const context = await readRepositoryContext(
      () => loadRepositoryContext(failing, ref, BASE, WEB),
      (error) => reported.push(error),
    )
    expect(context).toBeUndefined()
    expect(reported).toEqual(["Error: GitHub 500 : boom"])
    expect(reviewStandards(context, WEB, [])).toEqual(NO_STANDARDS)
  })

  it("reports a file GitHub fails to serve the same way, so no standard renders from a partial read", async () => {
    const reported: string[] = []
    const context = await readRepositoryContext(
      () => loadRepositoryContext(unservedFiles(), ref, BASE, WEB),
      (error) => reported.push(error),
    )
    expect(context).toBeUndefined()
    expect(reported).toEqual(["Error: GitHub 502 : boom"])
  })

  it("passes a readable context through and reports nothing", async () => {
    const reported: string[] = []
    const context = await readRepositoryContext(
      () => loaded(WEB),
      (error) => reported.push(error),
    )
    expect(context).toEqual(await loaded(WEB))
    expect(reported).toEqual([])
  })
})

describe("reviewStandards", () => {
  it("carries the rendered standards, the count of candidates left unloaded and the truncated flag, for the log", () => {
    const context: RepositoryContext = {
      ...contextOf(ENTRIES, { "CLAUDE.md": "Root rules." }),
      tree: { sha: TREE_SHA, truncated: true, entries: ENTRIES },
    }
    expect(reviewStandards(context, WEB, [])).toEqual({
      ...standardsFor(context, WEB, []),
      loadsSkipped: 2,
      treeTruncated: true,
    })
    expect(reviewStandards(context, WEB, []).used).toEqual(["CLAUDE.md"])
  })

  it("is no standards at all for an unreadable context", () => {
    expect(reviewStandards(undefined, WEB, [])).toEqual(NO_STANDARDS)
  })
})

describe("unloadedPaths", () => {
  it("names the changed paths' candidates with no body cached, in candidate order, counting a file remembered as missing as cached", () => {
    expect(unloadedPaths(contextOf(ENTRIES, { "AGENTS.md": "" }), WEB)).toEqual(["apps/web/CLAUDE.md", "CLAUDE.md"])
    expect(unloadedPaths(contextOf(ENTRIES, {}), ["README.md"])).toEqual(["CLAUDE.md", "AGENTS.md"])
  })
})

describe("standardsFor", () => {
  it("composes the candidates, the applyTo filter and the renderer, dropping an instructions file whose applyTo matches no changed path", () => {
    const entries = [
      blob(".github/instructions/py.instructions.md"),
      blob(".github/instructions/ts.instructions.md"),
      blob("apps/web/CLAUDE.md"),
      blob("CLAUDE.md"),
    ]
    const context = contextOf(entries, {
      ".github/instructions/py.instructions.md": '---\napplyTo: "**/*.py"\n---\nUse type hints.\n',
      ".github/instructions/ts.instructions.md": '---\napplyTo: "**/*.ts"\n---\nUse strict mode.\n',
      "apps/web/CLAUDE.md": "Web rules.",
      "CLAUDE.md": "Root rules.",
    })
    expect(standardsFor(context, WEB, [])).toEqual({
      text: [
        "## Repository standards",
        "### .github/instructions/ts.instructions.md",
        "Use strict mode.",
        "### apps/web/CLAUDE.md",
        "Web rules.",
        "### CLAUDE.md",
        "Root rules.",
      ].join("\n\n"),
      used: [".github/instructions/ts.instructions.md", "apps/web/CLAUDE.md", "CLAUDE.md"],
      cut: [],
    })
  })

  it("renders in candidate order, whatever order the bodies were cached in", () => {
    const context = contextOf(ENTRIES, { "CLAUDE.md": "Root rules.", "apps/web/CLAUDE.md": "Web rules." })
    expect(standardsFor(context, WEB, []).used).toEqual(["apps/web/CLAUDE.md", "CLAUDE.md"])
  })

  it("leaves out a file remembered as missing, one not loaded yet, and one cached for a path the pull request no longer changes", () => {
    const context = contextOf(ENTRIES, {
      "AGENTS.md": "",
      "apps/api/CLAUDE.md": "Api rules.",
      "CLAUDE.md": "Root rules.",
    })
    const { text, used } = standardsFor(context, WEB, [])
    expect(used).toEqual(["CLAUDE.md"])
    expect(text).toBe("## Repository standards\n\n### CLAUDE.md\n\nRoot rules.")
  })

  it("puts the path instructions whose glob matches a changed path ahead of the files", () => {
    const context = contextOf(ENTRIES, { "CLAUDE.md": "Root rules." })
    const pathInstructions = [
      { path: "docs/**", instructions: "Docs rule." },
      { path: "apps/web/**", instructions: "Web path rule." },
    ]
    expect(standardsFor(context, WEB, pathInstructions).used).toEqual([".andabot.yaml: apps/web/**", "CLAUDE.md"])
  })

  it("names what the cap cut", () => {
    const context = contextOf(ENTRIES, { "apps/web/CLAUDE.md": "w".repeat(11_000), "CLAUDE.md": "r".repeat(1_000) })
    const { used, cut } = standardsFor(context, WEB, [])
    expect(used).toEqual(["apps/web/CLAUDE.md"])
    expect(cut).toEqual(["CLAUDE.md"])
  })

  it("renders nothing when the base has no instruction file", () => {
    expect(standardsFor(contextOf([blob("README.md")], {}), WEB, [])).toEqual({ text: "", used: [], cut: [] })
  })
})

describe("reviewInstructions", () => {
  it("follows the skill with a blank line and the standards section", () => {
    const standards = "## Repository standards\n\n### CLAUDE.md\n\nRoot rules."
    expect(reviewInstructions("<skill_content>Steps.</skill_content>", standards)).toBe(
      `<skill_content>Steps.</skill_content>\n\n${standards}`,
    )
  })

  it("is the skill alone when no standard rendered", () => {
    expect(reviewInstructions("<skill_content>Steps.</skill_content>", "")).toBe(
      "<skill_content>Steps.</skill_content>",
    )
  })
})

describe("the context cache", () => {
  it("keys a context by the base commit sha", () => {
    expect(CONTEXT_PREFIX).toBe("context:")
    expect(contextKey(BASE)).toBe(`context:${BASE}`)
  })

  it("names every other base's context as stale, and no other key", () => {
    const keys = ["pending", `context:${OTHER_BASE}`, contextKey(BASE), "context:abc", "scope"]
    expect(staleContextKeys(keys, BASE)).toEqual([`context:${OTHER_BASE}`, "context:abc"])
    expect(staleContextKeys([contextKey(BASE)], BASE)).toEqual([])
  })

  it("reads back a loaded context as stored, and refuses a record a load could not have written", async () => {
    const context = await loaded(WEB)
    expect(Value.Check(StoredRepositoryContext, structuredClone(context))).toBe(true)
    expect(Value.Check(StoredRepositoryContext, { ...context, files: { "CLAUDE.md": 5 } })).toBe(false)
    const submodule = { path: "vendor/lib", type: "commit", sha: "3" }
    expect(Value.Check(StoredRepositoryContext, { ...context, tree: { ...context.tree, entries: [submodule] } })).toBe(
      false,
    )
    expect(Value.Check(StoredRepositoryContext, { baseSha: BASE, files: {} })).toBe(false)
  })
})
