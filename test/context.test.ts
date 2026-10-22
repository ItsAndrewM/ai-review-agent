import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { GitHubClient, type TreeEntry } from "../src/github/client.ts"
import { isGenerated } from "../src/github/diff.ts"
import {
  CONTEXT_PREFIX,
  contextInputs,
  contextKey,
  entriesThatMatter,
  loadRepositoryContext,
  MAX_INSTRUCTION_LOADS,
  readRepositoryContext,
  repositoryRecord,
  reviewInstructions,
  reviewRepository,
  reviewStandards,
  staleContextKeys,
  standardsFor,
  StoredRepositoryContext,
  unloadedPaths,
  type RepositoryContext,
} from "../src/repository/context.ts"
import { instructionCandidates } from "../src/repository/instructions.ts"

const ref = { owner: "o", repo: "r" }
const BASE = "ba5e5".repeat(8)
const HEAD = "4ead5".repeat(8)
const OTHER_BASE = "0".repeat(40)
const TREE_SHA = "f00d".repeat(10)
const CONTENTS = "/repos/o/r/contents/"
const TREE_PATH = `/repos/o/r/git/trees/${BASE}?recursive=1`
const WEB = ["apps/web/src/a.ts"]

const blob = (path: string): TreeEntry => ({ path, type: "blob", sha: "1" })

const directory = (path: string): TreeEntry => ({ path, type: "tree", sha: "2" })

const contentsPath = (path: string): string => `${CONTENTS}${path}?ref=${BASE}`

const ENTRIES: TreeEntry[] = [
  blob("CLAUDE.md"),
  blob("AGENTS.md"),
  directory("apps"),
  blob("apps/web/CLAUDE.md"),
  blob("apps/web/src/a.ts"),
  blob("apps/api/CLAUDE.md"),
]

const KEPT = [blob("CLAUDE.md"), blob("AGENTS.md"), blob("apps/web/CLAUDE.md"), blob("apps/api/CLAUDE.md")]

const BODIES = new Map([
  ["CLAUDE.md", "Root rules."],
  ["apps/web/CLAUDE.md", "Web rules."],
  ["apps/api/CLAUDE.md", "Api rules."],
])

const NO_STANDARDS = { text: "", used: [], cut: [], loadsSkipped: 0, treeTruncated: false }

function fakeGitHub(
  entries: readonly TreeEntry[],
  bodies: ReadonlyMap<string, string>,
  truncated = false,
  unserved: readonly string[] = [],
) {
  const calls: string[] = []
  const answer = (pathname: string): Response => {
    if (pathname.startsWith("/repos/o/r/git/trees/")) {
      return new Response(JSON.stringify({ sha: TREE_SHA, truncated, tree: entries }), { status: 200 })
    }
    const path = decodeURIComponent(pathname.slice(CONTENTS.length))
    if (unserved.includes(path)) return new Response("boom", { status: 502 })
    const body = bodies.get(path)
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

function recorder() {
  const reported: [string, string][] = []
  const report = (path: string, error: string): void => {
    reported.push([path, error])
  }
  return { report, reported }
}

const failOnUnreadable = (path: string, error: string): void => {
  throw new Error(`${path} was reported unreadable: ${error}`)
}

const loaded = (changed: readonly string[], cached?: RepositoryContext): Promise<RepositoryContext> =>
  loadRepositoryContext(fakeGitHub(ENTRIES, BODIES).github, ref, BASE, changed, failOnUnreadable, cached)

const contextOf = (entries: readonly TreeEntry[], files: Readonly<Record<string, string>>): RepositoryContext => ({
  baseSha: BASE,
  tree: { sha: TREE_SHA, truncated: false, entries },
  files,
})

describe("contextInputs", () => {
  it("reads the repository at the pull request's base commit, not its head", () => {
    const pr = { base: { sha: BASE }, head: { sha: HEAD } }
    expect(contextInputs(pr, [{ filename: "apps/web/src/a.ts" }]).baseSha).toBe(BASE)
  })

  it("scopes to every changed path, a generated one included, since a nested CLAUDE.md above a generated file still governs its directory", () => {
    const pr = { base: { sha: BASE }, head: { sha: HEAD } }
    const generated = "apps/web/dist/app.min.js"
    expect(isGenerated(generated)).toBe(true)
    const { changed } = contextInputs(pr, [{ filename: "README.md" }, { filename: generated }])
    expect(changed).toEqual(["README.md", generated])
    expect(unloadedPaths(contextOf(KEPT, {}), changed)).toEqual(["apps/web/CLAUDE.md", "CLAUDE.md", "AGENTS.md"])
  })
})

describe("entriesThatMatter", () => {
  const whole: TreeEntry[] = [
    directory(".github"),
    directory(".github/instructions"),
    directory("apps"),
    directory("apps/web"),
    directory("apps/CLAUDE.md"),
    blob("README.md"),
    blob("package.json"),
    blob("CLAUDE.md"),
    blob("AGENTS.md"),
    blob("REVIEW.md"),
    blob("CODING_STANDARDS.md"),
    blob("CONTRIBUTING.md"),
    blob(".github/copilot-instructions.md"),
    blob(".github/instructions/ts.instructions.md"),
    blob(".github/instructions/lists.instructions.md"),
    blob(".github/instructions/README.md"),
    blob(".github/instructions/frontend/react.instructions.md"),
    blob("apps/web/CLAUDE.md"),
    blob("apps/web/AGENTS.md"),
    blob("apps/web/src/a.ts"),
    blob("apps/web/src/button.tsx"),
    blob("apps/web/src/components/CLAUDE.md"),
    blob("apps/api/CLAUDE.md"),
    blob("apps/api/server.ts"),
    blob("docs/CLAUDE.md.bak"),
    blob("docs/MY-CLAUDE.md"),
    blob("test/a.ts"),
    blob(".github/skills/code-review/SKILL.md"),
    blob(".agents/skills/lint/SKILL.md"),
    blob(".claude/skills/tdd/references/cycle.md"),
    blob(".github/skillset/notes.md"),
  ]

  it("keeps the blobs that may be instruction files and those under the three skills roots, and nothing else", () => {
    expect(entriesThatMatter(whole)).toEqual([
      blob("CLAUDE.md"),
      blob("AGENTS.md"),
      blob("REVIEW.md"),
      blob("CODING_STANDARDS.md"),
      blob("CONTRIBUTING.md"),
      blob(".github/copilot-instructions.md"),
      blob(".github/instructions/ts.instructions.md"),
      blob(".github/instructions/lists.instructions.md"),
      blob("apps/web/CLAUDE.md"),
      blob("apps/web/AGENTS.md"),
      blob("apps/web/src/components/CLAUDE.md"),
      blob("apps/api/CLAUDE.md"),
      blob(".github/skills/code-review/SKILL.md"),
      blob(".agents/skills/lint/SKILL.md"),
      blob(".claude/skills/tdd/references/cycle.md"),
    ])
  })

  it.each([
    [["apps/web/src/a.ts"]],
    [["apps/web/src/button.tsx", "test/a.ts"]],
    [["apps/web/src/components/button.tsx"]],
    [["apps/api/server.ts", "docs/guide.md"]],
    [["README.md"]],
    [[]],
  ])("lists the same candidates from the kept entries as from the whole tree, for %j", (changed) => {
    expect(instructionCandidates(entriesThatMatter(whole), changed)).toEqual(instructionCandidates(whole, changed))
  })

  it("stores only the instruction files of a 50,000-blob tree", async () => {
    const instructionFiles = ["CLAUDE.md", "apps/web/CLAUDE.md", ".github/instructions/ts.instructions.md"]
    const sources = Array.from({ length: 50_000 }, (_, index) => blob(`src/module-${index}.ts`))
    const { github } = fakeGitHub([...sources, ...instructionFiles.map(blob)], BODIES)
    const context = await loadRepositoryContext(github, ref, BASE, WEB, failOnUnreadable)
    expect(context.tree.entries).toEqual(instructionFiles.map(blob))
  })
})

describe("loadRepositoryContext", () => {
  it("reads the tree and each candidate's body at the base commit, keeps only the entries that matter, and remembers a file the contents API does not find as empty", async () => {
    const { github, calls } = fakeGitHub(ENTRIES, BODIES)
    const context = await loadRepositoryContext(github, ref, BASE, WEB, failOnUnreadable)
    expect(context).toEqual({
      baseSha: BASE,
      tree: { sha: TREE_SHA, truncated: false, entries: KEPT },
      files: { "apps/web/CLAUDE.md": "Web rules.", "CLAUDE.md": "Root rules.", "AGENTS.md": "" },
    })
    expect([...calls].sort()).toEqual(
      [TREE_PATH, contentsPath("apps/web/CLAUDE.md"), contentsPath("CLAUDE.md"), contentsPath("AGENTS.md")].sort(),
    )
  })

  it("reuses the cached context of the same base sha, though its tree has a sha of its own, without calling GitHub, the missing file included", async () => {
    const cached = await loaded(WEB)
    const { github, calls } = fakeGitHub(ENTRIES, BODIES)
    expect(await loadRepositoryContext(github, ref, BASE, WEB, failOnUnreadable, cached)).toBe(cached)
    expect(calls).toEqual([])
  })

  it("extends the cached context with the candidates a new changed path brings, loading only those", async () => {
    const cached = await loaded(WEB)
    const { github, calls } = fakeGitHub(ENTRIES, BODIES)
    const extended = await loadRepositoryContext(github, ref, BASE, [...WEB, "apps/api/b.ts"], failOnUnreadable, cached)
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
    const context = await loadRepositoryContext(github, ref, BASE, WEB, failOnUnreadable, other)
    expect(calls).toContain(TREE_PATH)
    expect(context).toEqual(await loaded(WEB))
  })

  it("loads at most 24 bodies a review, the root files, then nested files, then .github/instructions files, each in candidate order, and a later review of the same base loads the rest", async () => {
    const rules = Array.from({ length: 10 }, (_, index) => `.github/instructions/rule-${index}.instructions.md`)
    const nested = Array.from({ length: 20 }, (_, index) => `pkg-${String(index).padStart(2, "0")}/CLAUDE.md`)
    const changed = nested.map((path) => path.replace("CLAUDE.md", "a.ts"))
    const paths = [...rules, ...nested, "CLAUDE.md"]
    const bodies = new Map(paths.map((path): [string, string] => [path, `Rules from ${path}.`]))
    const { github, calls } = fakeGitHub(paths.map(blob), bodies)
    const first = await loadRepositoryContext(github, ref, BASE, changed, failOnUnreadable)
    expect(Object.keys(first.files)).toEqual(["CLAUDE.md", ...nested, ...rules.slice(0, 3)])
    expect(unloadedPaths(first, changed)).toEqual(rules.slice(3))
    expect(standardsFor(first, changed, []).used).toEqual([...rules.slice(0, 3), ...nested, "CLAUDE.md"])
    const second = await loadRepositoryContext(github, ref, BASE, changed, failOnUnreadable, first)
    expect(unloadedPaths(second, changed)).toEqual([])
    expect(calls).toHaveLength(1 + 24 + 7)
    expect(MAX_INSTRUCTION_LOADS).toBe(24)
  })

  it("loads all five root files of 25 candidates within the budget ahead of the 20 nested ones, and still renders them last", async () => {
    const nested = Array.from({ length: 20 }, (_, index) => `pkg-${String(index).padStart(2, "0")}/CLAUDE.md`)
    const root = ["CLAUDE.md", "AGENTS.md", "REVIEW.md", "CODING_STANDARDS.md", "CONTRIBUTING.md"]
    const changed = nested.map((path) => path.replace("CLAUDE.md", "a.ts"))
    const bodies = new Map([...nested, ...root].map((path): [string, string] => [path, `Rules from ${path}.`]))
    const { github } = fakeGitHub([...root, ...nested].map(blob), bodies)
    const context = await loadRepositoryContext(github, ref, BASE, changed, failOnUnreadable)
    expect(Object.keys(context.files)).toEqual([...root, ...nested.slice(0, 19)])
    expect(unloadedPaths(context, changed)).toEqual(["pkg-19/CLAUDE.md"])
    expect(standardsFor(context, changed, []).used).toEqual([...nested.slice(0, 19), ...root])
  })

  it("reads a truncated tree as listed", async () => {
    const { github } = fakeGitHub([blob("CLAUDE.md")], BODIES, true)
    const context = await loadRepositoryContext(github, ref, BASE, WEB, failOnUnreadable)
    expect(context.tree.truncated).toBe(true)
    expect(context.files).toEqual({ "CLAUDE.md": "Root rules." })
  })

  it("keeps the tree of a base with no instruction file, so the next review of that base calls nothing", async () => {
    const { github } = fakeGitHub([blob("README.md")], BODIES)
    const context = await loadRepositoryContext(github, ref, BASE, WEB, failOnUnreadable)
    expect(context).toEqual(contextOf([], {}))
    const { github: idle, calls } = fakeGitHub([], new Map())
    expect(await loadRepositoryContext(idle, ref, BASE, WEB, failOnUnreadable, context)).toBe(context)
    expect(calls).toEqual([])
  })

  it("skips a file GitHub fails to serve, reports it and keeps the others, so it loads again on the next review", async () => {
    const { report, reported } = recorder()
    const { github } = fakeGitHub(ENTRIES, BODIES, false, ["apps/web/CLAUDE.md"])
    const context = await loadRepositoryContext(github, ref, BASE, WEB, report)
    expect(reported).toEqual([["apps/web/CLAUDE.md", "Error: GitHub 502 : boom"]])
    expect(context.files).toEqual({ "CLAUDE.md": "Root rules.", "AGENTS.md": "" })
    expect(unloadedPaths(context, WEB)).toEqual(["apps/web/CLAUDE.md"])
    expect(reviewStandards(context, WEB, [])).toEqual({
      text: "## Repository standards\n\n### CLAUDE.md\n\nRoot rules.",
      used: ["CLAUDE.md"],
      cut: [],
      loadsSkipped: 1,
      treeTruncated: false,
    })
  })

  it("returns the cached context itself when its only new load fails, and still renders what it holds", async () => {
    const cached = await loaded(WEB)
    const { report, reported } = recorder()
    const { github } = fakeGitHub(ENTRIES, BODIES, false, ["apps/api/CLAUDE.md"])
    const changed = [...WEB, "apps/api/b.ts"]
    const context = await loadRepositoryContext(github, ref, BASE, changed, report, cached)
    expect(context).toBe(cached)
    expect(reported).toEqual([["apps/api/CLAUDE.md", "Error: GitHub 502 : boom"]])
    expect(reviewStandards(context, changed, []).used).toEqual(["apps/web/CLAUDE.md", "CLAUDE.md"])
  })
})

describe("readRepositoryContext", () => {
  it("reports a tree GitHub fails to serve and leaves the review without standards, rather than failing it", async () => {
    const reported: string[] = []
    const failing = new GitHubClient("t", "https://api.example", async () => new Response("boom", { status: 500 }))
    const context = await readRepositoryContext(
      () => loadRepositoryContext(failing, ref, BASE, WEB, failOnUnreadable),
      (error) => reported.push(error),
    )
    expect(context).toBeUndefined()
    expect(reported).toEqual(["Error: GitHub 500 : boom"])
    expect(reviewStandards(context, WEB, [])).toEqual(NO_STANDARDS)
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
      ...contextOf(KEPT, { "CLAUDE.md": "Root rules." }),
      tree: { sha: TREE_SHA, truncated: true, entries: KEPT },
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

  it("keeps the matching path instructions for an unreadable context, since .andabot.yaml is read on its own", () => {
    const pathInstructions = [
      { path: "docs/**", instructions: "Docs rule." },
      { path: "apps/web/**", instructions: "Web path rule." },
    ]
    expect(reviewStandards(undefined, WEB, pathInstructions)).toEqual({
      text: "## Repository standards\n\n### .andabot.yaml: apps/web/**\n\nWeb path rule.",
      used: [".andabot.yaml: apps/web/**"],
      cut: [],
      loadsSkipped: 0,
      treeTruncated: false,
    })
  })
})

describe("unloadedPaths", () => {
  it("names the changed paths' candidates with no body cached, in candidate order, counting a file remembered as missing as cached", () => {
    expect(unloadedPaths(contextOf(KEPT, { "AGENTS.md": "" }), WEB)).toEqual(["apps/web/CLAUDE.md", "CLAUDE.md"])
    expect(unloadedPaths(contextOf(KEPT, {}), ["README.md"])).toEqual(["CLAUDE.md", "AGENTS.md"])
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
    const context = contextOf(KEPT, { "CLAUDE.md": "Root rules.", "apps/web/CLAUDE.md": "Web rules." })
    expect(standardsFor(context, WEB, []).used).toEqual(["apps/web/CLAUDE.md", "CLAUDE.md"])
  })

  it("leaves out a file remembered as missing, one not loaded yet, and one cached for a path the pull request no longer changes", () => {
    const context = contextOf(KEPT, {
      "AGENTS.md": "",
      "apps/api/CLAUDE.md": "Api rules.",
      "CLAUDE.md": "Root rules.",
    })
    const { text, used } = standardsFor(context, WEB, [])
    expect(used).toEqual(["CLAUDE.md"])
    expect(text).toBe("## Repository standards\n\n### CLAUDE.md\n\nRoot rules.")
  })

  it("puts the path instructions whose glob matches a changed path ahead of the files", () => {
    const context = contextOf(KEPT, { "CLAUDE.md": "Root rules." })
    const pathInstructions = [
      { path: "docs/**", instructions: "Docs rule." },
      { path: "apps/web/**", instructions: "Web path rule." },
    ]
    expect(standardsFor(context, WEB, pathInstructions).used).toEqual([".andabot.yaml: apps/web/**", "CLAUDE.md"])
  })

  it("names what the cap cut", () => {
    const context = contextOf(KEPT, { "apps/web/CLAUDE.md": "w".repeat(11_000), "CLAUDE.md": "r".repeat(1_000) })
    const { used, cut } = standardsFor(context, WEB, [])
    expect(used).toEqual(["apps/web/CLAUDE.md"])
    expect(cut).toEqual(["CLAUDE.md"])
  })

  it("renders nothing when the base has no instruction file", () => {
    expect(standardsFor(contextOf([], {}), WEB, [])).toEqual({ text: "", used: [], cut: [] })
  })
})

describe("reviewInstructions", () => {
  it("follows the skill with a blank line and the standards section", () => {
    const standards = "## Repository standards\n\n### CLAUDE.md\n\nRoot rules."
    expect(reviewInstructions("<skill_content>Steps.</skill_content>", [standards])).toBe(
      `<skill_content>Steps.</skill_content>\n\n${standards}`,
    )
  })

  it("is the skill alone when no standard rendered", () => {
    expect(reviewInstructions("<skill_content>Steps.</skill_content>", [""])).toBe(
      "<skill_content>Steps.</skill_content>",
    )
  })

  it("renders each non-empty section after a blank line, in order, so a later section needs no parameter of its own", () => {
    expect(reviewInstructions("Skill.", ["## One", "", "## Two"])).toBe("Skill.\n\n## One\n\n## Two")
    expect(reviewInstructions("Skill.", [])).toBe("Skill.")
  })
})

describe("repositoryRecord", () => {
  const skillMd = "---\ndescription: Lint.\n---\nCheck it.\n"

  it("records the instruction files the standards used, and the fingerprint of the repository skills the review was offered", async () => {
    const context = contextOf([blob("CLAUDE.md"), blob(".github/skills/lint/SKILL.md")], {
      "CLAUDE.md": "Root rules.",
      ".github/skills/lint/SKILL.md": skillMd,
    })
    const repository = await reviewRepository(context, WEB, [])
    expect(repositoryRecord(repository)).toEqual({
      instructionFiles: ["CLAUDE.md"],
      repoSkillsFingerprint: repository.skills.offered?.fingerprint,
    })
    expect(repository.skills.offered?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it("records no fingerprint when the review was offered no repository skill, so the footer claims none", async () => {
    const repository = await reviewRepository(contextOf(KEPT, { "CLAUDE.md": "Root rules." }), WEB, [])
    expect(repositoryRecord(repository)).toEqual({ instructionFiles: ["CLAUDE.md"] })
    expect(repositoryRecord(await reviewRepository(undefined, WEB, []))).toEqual({ instructionFiles: [] })
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

  it("refuses a record whose tree holds a directory, as the first format's whole trees did, so such a record is deleted and fetched again", async () => {
    const context = await loaded(WEB)
    const whole = { ...context, tree: { ...context.tree, entries: [...context.tree.entries, directory("apps")] } }
    expect(Value.Check(StoredRepositoryContext, whole)).toBe(false)
  })
})
