import { readFileSync } from "node:fs"
import type { Context } from "@earendil-works/chord/context"
import { Type } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import {
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
  type Registry,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable"
import type { SkillManifestEntry, SkillSource } from "agents/skills"
import { describe, expect, it } from "vitest"
import { GitHubClient, SYMLINK_MODE, type TreeEntry } from "../src/github/client.ts"
import {
  loadRepositoryContext,
  MAX_INSTRUCTION_LOADS,
  reviewRepository,
  reviewStandards,
  type RepositoryContext,
} from "../src/repository/context.ts"
import {
  CATALOG_OUTPUT_LIMITS,
  catalogFor,
  installCatalog,
  MAX_CATALOG_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILE_BYTES,
  outputFromContent,
  repositorySkillFiles,
  repositorySkillFingerprint,
  repositorySkills,
  restoredCatalog,
  shadowedSkillFiles,
  skillLogs,
  skillSourceFor,
  skillsStartFields,
  unlisted,
  unloadedSkillPaths,
  SKILL_NOT_FOUND,
  withActivationReport,
  withContentAsOutput,
  withOutputFromContent,
  type ReportActivation,
  type ReportSkippedRestore,
  type SkillState,
} from "../src/repository/skills.ts"
import { BUNDLED_SKILL_NAMES, bundledSkills } from "../src/review/bundled-skills.ts"
import { renderActivatedSkill, sha256Hex } from "../src/review/skills.ts"

const ref = { owner: "o", repo: "r" }
const BASE = "ba5e5".repeat(8)
const TREE_SHA = "f00d".repeat(10)
const CONTENTS = "/repos/o/r/contents/"

const blob = (path: string, sha = "1", size = 100): TreeEntry => ({ path, type: "blob", sha, size })

const symlink = (path: string, sha = "1", size = 100): TreeEntry => ({ ...blob(path, sha, size), mode: SYMLINK_MODE })

const unsized = (path: string): TreeEntry => ({ path, type: "blob", sha: "1" })

const directory = (path: string): TreeEntry => ({ path, type: "tree", sha: "2" })

const file = (path: string, text: string): [string, string] => [path, text]

const skillMd = (description: string, body = "Check the thing."): string =>
  `---\ndescription: ${description}\n---\n${body}\n`

const contextOf = (entries: readonly TreeEntry[], files: Readonly<Record<string, string>>): RepositoryContext => ({
  baseSha: BASE,
  tree: { sha: TREE_SHA, truncated: false, entries },
  files,
})

const failOnUnreadable = (path: string, error: string): void => {
  throw new Error(`${path} was reported unreadable: ${error}`)
}

function recorder() {
  const reported: string[] = []
  const report = (path: string): void => {
    reported.push(path)
  }
  return { report, reported }
}

function fakeGitHub(
  entries: readonly TreeEntry[],
  bodies: ReadonlyMap<string, string>,
  unserved: readonly string[] = [],
) {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const { pathname, search } = new URL(String(input))
    calls.push(`${pathname}${search}`)
    if (pathname.startsWith("/repos/o/r/git/trees/")) {
      return new Response(JSON.stringify({ sha: TREE_SHA, truncated: false, tree: entries }), { status: 200 })
    }
    const path = decodeURIComponent(pathname.slice(CONTENTS.length))
    if (unserved.includes(path)) return new Response("boom", { status: 502 })
    const body = bodies.get(path)
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(body, { status: 200 })
  }
  return { github: new GitHubClient("t", "https://api.example", fetchImpl), calls }
}

const fetchesOf = (calls: readonly string[], path: string): number =>
  calls.filter((call) => call.startsWith(`${CONTENTS}${path}?`)).length

const nestedRules = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `pkg-${String(index).padStart(2, "0")}/CLAUDE.md`)

const changedUnder = (rules: readonly string[]): string[] => rules.map((path) => path.replace("CLAUDE.md", "a.ts"))

const ALPHA = [".github/skills/alpha/SKILL.md", ".github/skills/alpha/references/a.md"]
const BETA = [".claude/skills/beta/SKILL.md", ".claude/skills/beta/notes.md"]

const SKILL_BODIES: [string, string][] = [
  file(".github/skills/alpha/SKILL.md", skillMd("Alpha checks.")),
  file(".github/skills/alpha/references/a.md", "Alpha reference."),
  file(".claude/skills/beta/SKILL.md", skillMd("Beta checks.")),
  file(".claude/skills/beta/notes.md", "Beta notes."),
]

const FOO_SKILL = ".claude/skills/foo/SKILL.md"
const FOO_RULES = ".claude/skills/foo/CLAUDE.md"
const FOO_CHANGED = [".claude/skills/foo/scripts/x.sh"]

const rulesFor = (paths: readonly string[]): [string, string][] =>
  paths.map((path) => file(path, `Rules from ${path}.`))

const indexed = (index: number): string => String(index).padStart(2, "0")

describe("repositorySkillFiles", () => {
  it("finds each SKILL.md one directory below a skills root, with every blob under that directory as the skill's files", () => {
    const entries = [
      directory(".github/skills"),
      directory(".github/skills/code-review"),
      blob(".github/skills/code-review/SKILL.md"),
      blob(".github/skills/code-review/references/checks.md"),
      blob(".github/skills/code-review/agents/openai.yaml"),
      blob(".github/skills/README.md"),
      blob(".github/skills/notes/guide.md"),
      blob(".github/skills/deep/nested/SKILL.md"),
      blob(".github/skillset/lint/SKILL.md"),
      blob("skills/lint/SKILL.md"),
      blob("src/a.ts"),
    ]
    expect(repositorySkillFiles(entries)).toEqual([
      {
        name: "code-review",
        dir: ".github/skills/code-review",
        files: [
          ".github/skills/code-review/SKILL.md",
          ".github/skills/code-review/agents/openai.yaml",
          ".github/skills/code-review/references/checks.md",
        ],
      },
    ])
  })

  it("lists .github/skills, then .agents/skills, then .claude/skills, with the names sorted within each root", () => {
    const dirs = [
      ".claude/skills/beta",
      ".agents/skills/zeta",
      ".github/skills/mu",
      ".claude/skills/alpha",
      ".github/skills/lambda",
    ]
    expect(repositorySkillFiles(dirs.map((dir) => blob(`${dir}/SKILL.md`))).map(({ dir }) => dir)).toEqual([
      ".github/skills/lambda",
      ".github/skills/mu",
      ".agents/skills/zeta",
      ".claude/skills/alpha",
      ".claude/skills/beta",
    ])
  })

  it("leaves out a skill named review or answer, which the built-in skills shadow, and one whose name an earlier root holds", () => {
    const entries = [
      blob(".github/skills/review/SKILL.md"),
      blob(".github/skills/review/references/extra.md"),
      blob(".agents/skills/answer/SKILL.md"),
      blob(".agents/skills/lint/SKILL.md"),
      blob(".claude/skills/lint/SKILL.md"),
      blob(".claude/skills/tdd/SKILL.md"),
    ]
    expect(repositorySkillFiles(entries).map(({ dir }) => dir)).toEqual([".agents/skills/lint", ".claude/skills/tdd"])
    expect(shadowedSkillFiles(entries).map(({ dir }) => dir)).toEqual([
      ".github/skills/review",
      ".agents/skills/answer",
      ".claude/skills/lint",
    ])
  })

  it("shadows exactly the skills the bundle holds, the summary skill included", async () => {
    const bundled = (await (await bundledSkills()).source.list()).map(({ name }) => name)
    expect([...BUNDLED_SKILL_NAMES].sort()).toEqual([...bundled].sort())
    expect([...BUNDLED_SKILL_NAMES].sort()).toEqual(["answer", "review", "summary", "verify"])
    expect(shadowedSkillFiles([blob(".claude/skills/summary/SKILL.md")]).map(({ name }) => name)).toEqual(["summary"])
  })

  it("refuses a path with a .. segment or a leading slash, whether it would be a skill or one of its files", () => {
    const entries = [
      blob(".github/skills/../SKILL.md"),
      blob("/.github/skills/rooted/SKILL.md"),
      blob(".github/skills/ok/SKILL.md"),
      blob(".github/skills/ok/../../../CLAUDE.md"),
      blob(".github/skills/ok/references/../notes.md"),
      blob(".github/skills/ok/references/checks.md"),
    ]
    expect(repositorySkillFiles(entries)).toEqual([
      {
        name: "ok",
        dir: ".github/skills/ok",
        files: [".github/skills/ok/SKILL.md", ".github/skills/ok/references/checks.md"],
      },
    ])
  })

  it("finds no skill in a SKILL.md that is a directory", () => {
    expect(repositorySkillFiles([directory(".github/skills/odd/SKILL.md")])).toEqual([])
  })

  it("leaves out a resource over 50 KiB by the listing's size, or one the listing gives no size, and keeps the skill's SKILL.md whatever its size", () => {
    expect(MAX_SKILL_FILE_BYTES).toBe(51_200)
    const entries = [
      blob(".github/skills/lint/SKILL.md", "1", 60_000),
      blob(".github/skills/lint/big.md", "1", MAX_SKILL_FILE_BYTES + 1),
      blob(".github/skills/lint/edge.md", "1", MAX_SKILL_FILE_BYTES),
      unsized(".github/skills/lint/unsized.md"),
    ]
    expect(repositorySkillFiles(entries)).toEqual([
      {
        name: "lint",
        dir: ".github/skills/lint",
        files: [".github/skills/lint/SKILL.md", ".github/skills/lint/edge.md"],
      },
    ])
  })
})

describe("repositorySkillFingerprint", () => {
  const entries = [
    blob(".github/skills/lint/SKILL.md", "a1"),
    blob(".github/skills/lint/references/rules.md", "b2"),
    blob(".claude/skills/tdd/SKILL.md", "c3"),
  ]

  it("is SHA-256 over the skill files' path:sha pairs, sorted, one per line", async () => {
    const pairs = [
      ".claude/skills/tdd/SKILL.md:c3",
      ".github/skills/lint/SKILL.md:a1",
      ".github/skills/lint/references/rules.md:b2",
    ]
    expect(await repositorySkillFingerprint(entries)).toBe(await sha256Hex(pairs.join("\n")))
    expect(await repositorySkillFingerprint(entries)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is the same for the same files in any order", async () => {
    expect(await repositorySkillFingerprint([...entries].reverse())).toBe(await repositorySkillFingerprint(entries))
  })

  it("changes when a skill file's sha changes or a skill gains a file", async () => {
    const fingerprint = await repositorySkillFingerprint(entries)
    const edited = entries.map((entry) => (entry.sha === "b2" ? { ...entry, sha: "b3" } : entry))
    expect(await repositorySkillFingerprint(edited)).not.toBe(fingerprint)
    const grown = [...entries, blob(".claude/skills/tdd/references/cycle.md", "d4")]
    expect(await repositorySkillFingerprint(grown)).not.toBe(fingerprint)
  })

  it("ignores what lies outside the skills, the skills the built-in ones shadow, and a resource over the size cap", async () => {
    const fingerprint = await repositorySkillFingerprint(entries)
    const around = [
      ...entries,
      blob("CLAUDE.md", "e5"),
      blob(".github/skills/review/SKILL.md", "f6"),
      blob(".github/skills/lint/huge.bin", "g7", MAX_SKILL_FILE_BYTES + 1),
    ]
    expect(await repositorySkillFingerprint(around)).toBe(fingerprint)
  })
})

describe("loading a repository's skills at the base commit", () => {
  it("loads the skill bodies after the instruction files and before their resources, within the same budget of 24, and a later review of the base loads the rest", async () => {
    const rules = ["CLAUDE.md", ...nestedRules(21)]
    const changed = changedUnder(rules.slice(1))
    const bodies = new Map([...rulesFor(rules), ...SKILL_BODIES])
    const { github, calls } = fakeGitHub(
      [...rules, ...ALPHA, ...BETA].map((path) => blob(path)),
      bodies,
    )
    const first = await loadRepositoryContext(github, ref, BASE, changed, failOnUnreadable)
    expect(Object.keys(first.files)).toEqual([...rules, ALPHA[0], BETA[0]])
    expect(unloadedSkillPaths(first)).toEqual([ALPHA[1], BETA[1]])
    const skills = await repositorySkills(first)
    expect(skills.offered?.names).toEqual(["alpha", "beta"])
    expect((await skills.offered?.source.load("alpha"))?.resources).toEqual([])
    expect(skills.loadsSkipped).toBe(2)
    const second = await loadRepositoryContext(github, ref, BASE, changed, failOnUnreadable, first)
    expect(unloadedSkillPaths(second)).toEqual([])
    const later = await repositorySkills(second)
    expect((await later.offered?.source.load("alpha"))?.resources?.map(({ path }) => path)).toEqual(["references/a.md"])
    expect(calls).toHaveLength(1 + MAX_INSTRUCTION_LOADS + 2)
  })

  it("leaves out a skill whose body did not load this review, reports it unloaded, and offers it once a later review loads it", async () => {
    const rules = ["CLAUDE.md", ...nestedRules(22)]
    const changed = changedUnder(rules.slice(1))
    const bodies = new Map([...rulesFor(rules), ...SKILL_BODIES])
    const { github } = fakeGitHub(
      [...rules, ...ALPHA, ...BETA].map((path) => blob(path)),
      bodies,
    )
    const first = await loadRepositoryContext(github, ref, BASE, changed, failOnUnreadable)
    const skills = await repositorySkills(first)
    expect(skills.offered?.names).toEqual(["alpha"])
    expect(skills.unloaded).toEqual([{ name: "beta", path: BETA[0] }])
    const second = await loadRepositoryContext(github, ref, BASE, changed, failOnUnreadable, first)
    const later = await repositorySkills(second)
    expect(later.offered?.names).toEqual(["alpha", "beta"])
    expect(later.unloaded).toEqual([])
  })

  it("loads every instruction file of a repository with thirty skills before any skill body, so skills cannot starve the standards", async () => {
    const rules = ["CLAUDE.md", "AGENTS.md", "REVIEW.md"]
    const skillPaths = Array.from({ length: 30 }, (_, index) => `.agents/skills/s-${indexed(index)}/SKILL.md`)
    const bodies = new Map([...rulesFor(rules), ...skillPaths.map((path) => file(path, skillMd(path)))])
    const { github } = fakeGitHub(
      [...rules, ...skillPaths].map((path) => blob(path)),
      bodies,
    )
    const context = await loadRepositoryContext(github, ref, BASE, ["src/a.ts"], failOnUnreadable)
    expect(Object.keys(context.files)).toEqual([...rules, ...skillPaths.slice(0, MAX_INSTRUCTION_LOADS - 3)])
    expect(reviewStandards(context, ["src/a.ts"], []).used).toEqual(rules)
    const skills = await repositorySkills(context)
    expect(skills.offered?.names).toHaveLength(MAX_INSTRUCTION_LOADS - 3)
    expect(skills.unloaded).toHaveLength(9)
  })

  it("loads no file of a skill the built-in ones shadow", async () => {
    const shadowed = [".github/skills/review/SKILL.md", ".github/skills/review/references/extra.md"]
    const bodies = new Map([...SKILL_BODIES, ...shadowed.map((path) => file(path, skillMd("Ours.")))])
    const { github, calls } = fakeGitHub(
      [...shadowed, ...ALPHA].map((path) => blob(path)),
      bodies,
    )
    const context = await loadRepositoryContext(github, ref, BASE, ["src/a.ts"], failOnUnreadable)
    expect(Object.keys(context.files)).toEqual(ALPHA)
    expect(calls.some((call) => call.includes("skills/review"))).toBe(false)
  })

  it("loads a skill's resources in the same review once its body parses, and never the resources of a skill whose body does not", async () => {
    const broken = [
      file(".agents/skills/broken/SKILL.md", "No frontmatter."),
      file(".agents/skills/broken/notes.md", "Notes."),
    ]
    const bodies = new Map([...SKILL_BODIES, ...broken])
    const entries = [...ALPHA, ...broken.map(([path]) => path)].map((path) => blob(path))
    const { github, calls } = fakeGitHub(entries, bodies)
    const context = await loadRepositoryContext(github, ref, BASE, ["src/a.ts"], failOnUnreadable)
    expect(Object.keys(context.files)).toEqual([ALPHA[0], ".agents/skills/broken/SKILL.md", ALPHA[1]])
    expect(fetchesOf(calls, ".agents/skills/broken/notes.md")).toBe(0)
    expect(calls).toHaveLength(1 + 3)
    expect(unloadedSkillPaths(context)).toEqual([])
  })

  it("fetches a skill's own CLAUDE.md once when it is also a nested instruction file of a changed path, and both the standards and the skill read it", async () => {
    const bodies = new Map([file(FOO_SKILL, skillMd("Foo.")), file(FOO_RULES, "Foo rules.")])
    const { github, calls } = fakeGitHub([blob(FOO_SKILL), blob(FOO_RULES)], bodies)
    const context = await loadRepositoryContext(github, ref, BASE, FOO_CHANGED, failOnUnreadable)
    expect(fetchesOf(calls, FOO_RULES)).toBe(1)
    expect(reviewStandards(context, FOO_CHANGED, []).used).toEqual([FOO_RULES])
    const skill = await (await repositorySkills(context)).offered?.source.load("foo")
    expect(skill?.resources?.map(({ path }) => path)).toEqual(["CLAUDE.md"])
  })

  it("does not fetch that CLAUDE.md a second time in the same review when the first fetch fails, and reports it once", async () => {
    const { report, reported } = recorder()
    const bodies = new Map([file(FOO_SKILL, skillMd("Foo."))])
    const { github, calls } = fakeGitHub([blob(FOO_SKILL), blob(FOO_RULES)], bodies, [FOO_RULES])
    await loadRepositoryContext(github, ref, BASE, FOO_CHANGED, report)
    expect(fetchesOf(calls, FOO_RULES)).toBe(1)
    expect(reported).toEqual([FOO_RULES])
  })

  it("never fetches a SKILL.md the listing sizes over 50 KiB, and reports its skill capped by the file cap", async () => {
    const huge = blob(".github/skills/huge/SKILL.md", "1", MAX_SKILL_FILE_BYTES + 1)
    const bodies = new Map([...SKILL_BODIES, file(huge.path, skillMd("Huge."))])
    const { github, calls } = fakeGitHub([huge, ...ALPHA.map((path) => blob(path))], bodies)
    const context = await loadRepositoryContext(github, ref, BASE, ["src/a.ts"], failOnUnreadable)
    expect(fetchesOf(calls, huge.path)).toBe(0)
    const skills = await repositorySkills(context)
    expect(skills.capped).toEqual([{ name: "huge", path: huge.path, cap: "file" }])
    expect(skills.invalid).toEqual([])
    expect(skills.offered?.names).toEqual(["alpha"])
  })

  it("loads no SKILL.md past 512 KiB of the listing's sizes, summed bodies first, and reports those skills capped", async () => {
    expect(MAX_SKILL_BYTES).toBe(524_288)
    const paths = Array.from({ length: 12 }, (_, index) => `.agents/skills/s-${indexed(index)}/SKILL.md`)
    const entries = [...paths.map((path) => blob(path, "1", 50_000)), blob(".agents/skills/s-00/notes.md", "1", 10)]
    expect(unloadedSkillPaths(contextOf(entries, {}))).toEqual(paths.slice(0, 10))
    const loaded = contextOf(entries, Object.fromEntries(paths.slice(0, 10).map((path) => file(path, skillMd(path)))))
    const skills = await repositorySkills(loaded)
    expect(skills.offered?.names).toHaveLength(10)
    expect(skills.capped).toEqual([
      { name: "s-10", path: paths[10], cap: "base" },
      { name: "s-11", path: paths[11], cap: "base" },
      { name: "s-00", path: paths[0], cap: "base", resources: 1 },
    ])
    expect(unloadedSkillPaths(loaded)).toEqual([])
    expect(skillLogs(3, skills).filter(({ event }) => event === "skills.capped")).toHaveLength(3)
  })

  it("never loads or serves a resource past 512 KiB of the listing's sizes, even one already cached", async () => {
    const body = ".github/skills/big/SKILL.md"
    const resources = Array.from({ length: 10 }, (_, index) => `.github/skills/big/r-${index}.md`)
    const entries = [blob(body, "1", 50_000), ...resources.map((path) => blob(path, "1", 50_000))]
    const bodyOnly = contextOf(entries, Object.fromEntries([file(body, skillMd("Big."))]))
    expect(unloadedSkillPaths(bodyOnly)).toEqual(resources.slice(0, 9))
    const cached = Object.fromEntries([file(body, skillMd("Big.")), ...resources.map((path) => file(path, "Text."))])
    const skills = await repositorySkills(contextOf(entries, cached))
    const skill = await skills.offered?.source.load("big")
    expect(skill?.resources?.map(({ path }) => path)).toEqual(
      resources.slice(0, 9).map((path) => path.slice(".github/skills/big/".length)),
    )
    expect(skills.capped).toEqual([{ name: "big", path: body, cap: "base", resources: 1 }])
  })

  it("counts the resources each byte cap leaves out of an offered skill in one skills.capped event per cap", async () => {
    const body = ".github/skills/lint/SKILL.md"
    const heavy = Array.from({ length: 11 }, (_, index) => `.github/skills/lint/r-${indexed(index)}.md`)
    const entries = [
      blob(body),
      blob(".github/skills/lint/huge.md", "1", MAX_SKILL_FILE_BYTES + 1),
      blob(".github/skills/lint/vast.md", "1", MAX_SKILL_FILE_BYTES * 2),
      ...heavy.map((path) => blob(path, "1", 50_000)),
    ]
    const skills = await repositorySkills(contextOf(entries, Object.fromEntries([file(body, skillMd("Lint."))])))
    expect(skills.offered?.names).toEqual(["lint"])
    expect(skills.capped).toEqual([
      { name: "lint", path: body, cap: "file", resources: 2 },
      { name: "lint", path: body, cap: "base", resources: 1 },
    ])
    expect(skillLogs(9, skills)).toEqual([
      { event: "skills.capped", fields: { number: 9, name: "lint", path: body, cap: "file", resources: 2 } },
      { event: "skills.capped", fields: { number: 9, name: "lint", path: body, cap: "base", resources: 1 } },
    ])
  })

  it("counts no file of a skill whose SKILL.md is over 50 KiB toward the 512 KiB, since that skill is never served", async () => {
    const huge = ".github/skills/huge/SKILL.md"
    const heavy = Array.from({ length: 11 }, (_, index) => `.github/skills/huge/r-${indexed(index)}.md`)
    const small = [".claude/skills/small/SKILL.md", ".claude/skills/small/notes.md"]
    const entries = [
      blob(huge, "1", MAX_SKILL_FILE_BYTES + 1),
      ...heavy.map((path) => blob(path, "1", 50_000)),
      ...small.map((path) => blob(path)),
    ]
    const smallBody = contextOf(entries, Object.fromEntries([file(".claude/skills/small/SKILL.md", skillMd("Small."))]))
    expect(unloadedSkillPaths(smallBody)).toEqual([".claude/skills/small/notes.md"])
  })
})

describe("a skill file the listing marks as a symlink", () => {
  const lintBody = ".github/skills/lint/SKILL.md"
  const lintRules = ".github/skills/lint/rules.md"
  const lintExtra = ".github/skills/lint/extra.md"
  const linkedBody = ".github/skills/linked/SKILL.md"

  it("leaves out a skill whose SKILL.md is a symlink, logging cap symlink, and still offers a regular skill beside it", async () => {
    const regular = [blob(lintBody, "b2")]
    const entries = [symlink(linkedBody, "a1"), ...regular]
    const cached = Object.fromEntries([file(linkedBody, skillMd("Linked.")), file(lintBody, skillMd("Lint."))])
    const skills = await repositorySkills(contextOf(entries, cached))
    expect(skills.offered?.names).toEqual(["lint"])
    expect(skills.capped).toEqual([{ name: "linked", path: linkedBody, cap: "symlink" }])
    expect(skills.invalid).toEqual([])
    expect(skillLogs(4, skills)).toEqual([
      { event: "skills.capped", fields: { number: 4, name: "linked", path: linkedBody, cap: "symlink" } },
    ])
    expect(skills.offered?.fingerprint).toBe(await repositorySkillFingerprint(regular))
    expect(unloadedSkillPaths(contextOf(entries, {}))).toEqual([lintBody])
  })

  it.each([
    { label: "an earlier", linked: ".github/skills/x/SKILL.md", regular: ".claude/skills/x/SKILL.md" },
    { label: "a later", linked: ".claude/skills/x/SKILL.md", regular: ".github/skills/x/SKILL.md" },
  ])(
    "offers the regular skill of a name when $label root's SKILL.md of that name is a symlink, which holds no name, so nothing is shadowed",
    async ({ linked, regular }) => {
      const entries = [symlink(linked), blob(regular)]
      const cached = Object.fromEntries([file(linked, skillMd("Linked.")), file(regular, skillMd("Regular."))])
      const skills = await repositorySkills(contextOf(entries, cached))
      expect(skills.offered?.names).toEqual(["x"])
      expect(await skills.offered?.source.list()).toEqual([{ name: "x", description: "Regular." }])
      expect(skills.capped).toEqual([{ name: "x", path: linked, cap: "symlink" }])
      expect(skills.shadowed).toEqual([])
      expect(repositorySkillFiles(entries).map(({ files }) => files)).toEqual([[regular]])
    },
  )

  it("fingerprints no file of a skill whose SKILL.md is a symlink, its regular resources included", async () => {
    const lint = [blob(lintBody, "a1")]
    const linked = [symlink(linkedBody, "b2"), blob(".github/skills/linked/notes.md", "c3")]
    expect(repositorySkillFiles([...linked, ...lint]).map(({ name }) => name)).toEqual(["lint"])
    expect(await repositorySkillFingerprint([...linked, ...lint])).toBe(await repositorySkillFingerprint(lint))
  })

  it("logs each skill whose SKILL.md is a symlink as capped by symlink, roots in order and names sorted within each, a built-in skill's name included", async () => {
    const claudeBeta = ".claude/skills/beta/SKILL.md"
    const githubReview = ".github/skills/review/SKILL.md"
    const githubAlpha = ".github/skills/alpha/SKILL.md"
    const entries = [symlink(claudeBeta), symlink(githubReview), symlink(githubAlpha)]
    const skills = await repositorySkills(contextOf(entries, {}))
    expect(skills.capped).toEqual([
      { name: "alpha", path: githubAlpha, cap: "symlink" },
      { name: "review", path: githubReview, cap: "symlink" },
      { name: "beta", path: claudeBeta, cap: "symlink" },
    ])
    expect(skills.shadowed).toEqual([])
    expect(skills.offered).toBeUndefined()
  })

  it("leaves a symlinked resource out of its skill's files, the catalog's resource list and the fingerprint, and counts it under resources", async () => {
    const regular = [blob(lintBody, "a1"), blob(lintRules, "b2")]
    const entries = [...regular, symlink(lintExtra, "c3")]
    expect(repositorySkillFiles(entries).map(({ files }) => files)).toEqual([[lintBody, lintRules]])
    expect(await repositorySkillFingerprint(entries)).toBe(await repositorySkillFingerprint(regular))
    const cached = Object.fromEntries([
      file(lintBody, skillMd("Lint.")),
      file(lintRules, "Rules."),
      file(lintExtra, "Target text."),
    ])
    const skills = await repositorySkills(contextOf(entries, cached))
    expect(skills.offered?.names).toEqual(["lint"])
    expect(skills.offered?.fingerprint).toBe(await repositorySkillFingerprint(regular))
    expect((await skills.offered?.source.load("lint"))?.resources?.map(({ path }) => path)).toEqual(["rules.md"])
    expect(await skills.offered?.source.readResource?.("lint", "extra.md")).toBeNull()
    expect(skills.capped).toEqual([{ name: "lint", path: lintBody, cap: "symlink", resources: 1 }])
    const bodyOnly = contextOf(entries, Object.fromEntries([file(lintBody, skillMd("Lint."))]))
    expect(unloadedSkillPaths(bodyOnly)).toEqual([lintRules])
  })

  it.each([
    { label: "skills root", link: ".claude/skills" },
    { label: "skill's directory", link: ".claude/skills/lint" },
  ])(
    "discovers nothing under a $label that is itself a symlink, so a skill symlinked between roots is offered once",
    async ({ link }) => {
      const entries = [symlink(link), blob(lintBody)]
      const skills = await repositorySkills(contextOf(entries, Object.fromEntries([file(lintBody, skillMd("Lint."))])))
      expect(skills.offered?.names).toEqual(["lint"])
      expect(skills.shadowed).toEqual([])
      expect(skills.capped).toEqual([])
    },
  )

  it("treats a skill file listed without a mode as a regular one, as records from before modes were kept list it", async () => {
    const entries = [blob(lintBody, "a1"), blob(lintExtra, "b2")]
    expect(repositorySkillFiles(entries).map(({ files }) => files)).toEqual([[lintBody, lintExtra]])
    expect(await repositorySkillFingerprint(entries)).toBe(await sha256Hex(`${lintBody}:a1\n${lintExtra}:b2`))
    const cached = Object.fromEntries([file(lintBody, skillMd("Lint.")), file(lintExtra, "Extra.")])
    const skills = await repositorySkills(contextOf(entries, cached))
    expect(skills.capped).toEqual([])
    expect((await skills.offered?.source.readResource?.("lint", "extra.md"))?.content).toBe("Extra.")
  })

  it("counts no file of a skill whose SKILL.md is a symlink toward the 512 KiB, since that skill is never served", () => {
    const heavy = Array.from({ length: 11 }, (_, index) => `.github/skills/linked/r-${indexed(index)}.md`)
    const small = [".claude/skills/small/SKILL.md", ".claude/skills/small/notes.md"]
    const entries = [
      symlink(linkedBody),
      ...heavy.map((path) => blob(path, "1", 50_000)),
      ...small.map((path) => blob(path)),
    ]
    const smallBody = contextOf(entries, Object.fromEntries([file(".claude/skills/small/SKILL.md", skillMd("Small."))]))
    expect(unloadedSkillPaths(smallBody)).toEqual([".claude/skills/small/notes.md"])
  })

  it("names the symlink rather than the size when the listing also sizes a symlinked SKILL.md or resource over 50 KiB", async () => {
    const huge = MAX_SKILL_FILE_BYTES + 1
    const entries = [symlink(linkedBody, "a1", huge), blob(lintBody), symlink(lintExtra, "c3", huge)]
    const skills = await repositorySkills(contextOf(entries, Object.fromEntries([file(lintBody, skillMd("Lint."))])))
    expect(skills.capped).toEqual([
      { name: "linked", path: linkedBody, cap: "symlink" },
      { name: "lint", path: lintBody, cap: "symlink", resources: 1 },
    ])
  })
})

describe("the repository source", () => {
  const entries = [
    blob(".github/skills/code-review/SKILL.md", "a1"),
    blob(".github/skills/code-review/references/checks.md", "b2"),
    blob(".github/skills/code-review/scripts/run.sh", "c3"),
  ]
  const files = {
    ".github/skills/code-review/SKILL.md":
      "---\nname: two-axis\ndescription: Two-axis review.\nmetadata:\n  version: 3\n---\nCheck both axes.\n",
    ".github/skills/code-review/references/checks.md": "Checks.",
    ".github/skills/code-review/scripts/run.sh": "echo hi",
  }

  const offeredBy = async (context: RepositoryContext) => (await repositorySkills(context)).offered

  it("offers each loaded skill under its directory's name, with its description, its version and the resources that loaded, through a source named repo", async () => {
    const offered = await offeredBy(contextOf(entries, files))
    expect(offered?.source.id).toBe("repo")
    expect(offered?.names).toEqual(["code-review"])
    expect(await offered?.source.list()).toEqual([
      { name: "code-review", description: "Two-axis review.", version: "3", metadata: { version: 3 } },
    ])
    const skill = await offered?.source.load("code-review")
    expect(skill?.body).toBe("Check both axes.\n")
    expect(skill?.resources).toEqual([
      { path: "references/checks.md", kind: "reference", encoding: "text", size: 7 },
      { path: "scripts/run.sh", kind: "file", encoding: "text", size: 7 },
    ])
    expect((await offered?.source.readResource?.("code-review", "references/checks.md"))?.content).toBe("Checks.")
  })

  it("names a skill by its directory, so a frontmatter name cannot take a built-in skill's place", async () => {
    const posing = { ".github/skills/my-review/SKILL.md": "---\nname: review\ndescription: Ours.\n---\nBody.\n" }
    const offered = await offeredBy(contextOf([blob(".github/skills/my-review/SKILL.md")], posing))
    expect(offered?.names).toEqual(["my-review"])
    expect(await offered?.source.load("review")).toBeNull()
  })

  it("fingerprints its skills' files in the base's listing, whatever has loaded, so repo@ is the same for every review of a base", async () => {
    const partial = { ".github/skills/code-review/SKILL.md": files[".github/skills/code-review/SKILL.md"] }
    const listed = await repositorySkillFingerprint(entries)
    const before = await offeredBy(contextOf(entries, partial))
    const after = await offeredBy(contextOf(entries, files))
    expect(before?.fingerprint).toBe(listed)
    expect(after?.fingerprint).toBe(listed)
    expect(after?.source.fingerprint).toBe(listed)
  })

  it("treats an empty SKILL.md as no skill and keeps an empty resource as empty text", async () => {
    const context = contextOf(
      [
        blob(".github/skills/empty/SKILL.md"),
        blob(".github/skills/lint/SKILL.md"),
        blob(".github/skills/lint/blank.md"),
      ],
      {
        ".github/skills/empty/SKILL.md": "",
        ".github/skills/lint/SKILL.md": skillMd("Lint."),
        ".github/skills/lint/blank.md": "",
      },
    )
    const offered = await offeredBy(context)
    expect(offered?.names).toEqual(["lint"])
    expect((await offered?.source.load("lint"))?.resources).toEqual([
      { path: "blank.md", kind: "file", encoding: "text", size: 0 },
    ])
    expect((await offered?.source.readResource?.("lint", "blank.md"))?.content).toBe("")
  })

  it.each([
    { label: "no frontmatter", text: "Just a body." },
    { label: "no description", text: "---\nname: lint\n---\nBody." },
    { label: "a blank description", text: '---\ndescription: "  "\n---\nBody.' },
    { label: "frontmatter that does not parse", text: "---\ndescription: Lint: the code\n---\nBody." },
  ])("offers no skill whose SKILL.md has $label, and reports it invalid", async ({ text }) => {
    const context = contextOf([blob(".github/skills/lint/SKILL.md")], { ".github/skills/lint/SKILL.md": text })
    const skills = await repositorySkills(context)
    expect(skills.offered).toBeUndefined()
    expect(skills.invalid).toEqual([{ name: "lint", path: ".github/skills/lint/SKILL.md" }])
  })

  it("reports a skill whose description passes 1,024 characters capped by the description cap, and offers one at the limit", async () => {
    expect(MAX_DESCRIPTION_CHARS).toBe(1_024)
    const context = contextOf([blob(".github/skills/at/SKILL.md"), blob(".github/skills/over/SKILL.md")], {
      ".github/skills/at/SKILL.md": skillMd("d".repeat(MAX_DESCRIPTION_CHARS)),
      ".github/skills/over/SKILL.md": skillMd("d".repeat(MAX_DESCRIPTION_CHARS + 1)),
    })
    const skills = await repositorySkills(context)
    expect(skills.offered?.names).toEqual(["at"])
    expect(skills.capped).toEqual([{ name: "over", path: ".github/skills/over/SKILL.md", cap: "description" }])
    expect(skills.invalid).toEqual([])
  })

  it("offers skills in discovery order while their catalog lines fit in 12,000 characters, and reports capped every skill from the first that does not fit", async () => {
    expect(MAX_CATALOG_CHARS).toBe(12_000)
    const catalogOf = (descriptions: readonly string[]): RepositoryContext => {
      const skills = descriptions.map((description, index) =>
        file(`.agents/skills/s-${indexed(index)}/SKILL.md`, skillMd(description)),
      )
      return contextOf(
        skills.map(([path]) => blob(path)),
        Object.fromEntries(skills),
      )
    }
    const long = Array.from({ length: 11 }, () => "d".repeat(1_000))
    const exact = await repositorySkills(catalogOf([...long, "d".repeat(893), "short"]))
    expect(exact.offered?.names).toHaveLength(12)
    expect(exact.capped.map(({ name }) => name)).toEqual(["s-12"])
    const over = await repositorySkills(catalogOf([...long, "d".repeat(894), "short"]))
    expect(over.offered?.names).toHaveLength(11)
    expect(over.capped.map(({ name, cap }) => [name, cap])).toEqual([
      ["s-11", "listing"],
      ["s-12", "listing"],
    ])
    expect((await over.offered?.source.list())?.map(({ name }) => name)).toEqual(over.offered?.names)
  })

  it("is nothing for a base without skills", async () => {
    expect(await offeredBy(contextOf([blob("CLAUDE.md")], { "CLAUDE.md": "Rules." }))).toBeUndefined()
  })
})

describe("skillSourceFor", () => {
  const entry = (name: string): SkillManifestEntry => ({
    name,
    description: `${name} checks.`,
    body: "Body.",
    resources: [],
  })
  const at = (name: string) => ({ name, path: `.github/skills/${name}/SKILL.md` })
  const FINGERPRINT = "f".repeat(64)

  it("builds the repo source from the offered states alone, under the fingerprint it is given", async () => {
    const states: SkillState[] = [
      { kind: "offered", at: at("lint"), entry: entry("lint") },
      { kind: "invalid", at: at("broken") },
      { kind: "capped", at: at("later"), cap: "listing" },
    ]
    const offered = skillSourceFor(states, FINGERPRINT)
    expect(offered?.names).toEqual(["lint"])
    expect([offered?.source.id, offered?.source.fingerprint, offered?.fingerprint]).toEqual([
      "repo",
      FINGERPRINT,
      FINGERPRINT,
    ])
    expect((await offered?.source.list())?.map(({ name }) => name)).toEqual(["lint"])
  })

  it("is nothing when no state is offered", () => {
    expect(skillSourceFor([{ kind: "unloaded", at: at("later") }], FINGERPRINT)).toBeUndefined()
  })
})

describe("repositorySkills", () => {
  it("reports the shadowed, the unloaded and the invalid skills beside what it offers", async () => {
    const context = contextOf(
      [
        blob(".github/skills/review/SKILL.md"),
        blob(".github/skills/lint/SKILL.md"),
        blob(".github/skills/lint/references/rules.md"),
        blob(".agents/skills/broken/SKILL.md"),
        blob(".claude/skills/later/SKILL.md"),
      ],
      { ".github/skills/lint/SKILL.md": skillMd("Lint."), ".agents/skills/broken/SKILL.md": "No frontmatter." },
    )
    const skills = await repositorySkills(context)
    expect(skills.offered?.names).toEqual(["lint"])
    expect(skills.shadowed).toEqual([{ name: "review", path: ".github/skills/review/SKILL.md" }])
    expect(skills.unloaded).toEqual([{ name: "later", path: ".claude/skills/later/SKILL.md" }])
    expect(skills.invalid).toEqual([{ name: "broken", path: ".agents/skills/broken/SKILL.md" }])
    expect(skills.capped).toEqual([])
    expect(skills.loadsSkipped).toBe(2)
  })

  it("is no skill at all for an unreadable context", async () => {
    expect(await repositorySkills(undefined)).toEqual({
      offered: undefined,
      shadowed: [],
      unloaded: [],
      invalid: [],
      capped: [],
      loadsSkipped: 0,
    })
  })
})

describe("skillLogs", () => {
  it("logs each shadowed, unloaded, invalid and capped skill with the pull request, its name and its SKILL.md, naming the cap and counting the resources it left out", () => {
    const skills = {
      offered: undefined,
      shadowed: [{ name: "review", path: ".github/skills/review/SKILL.md" }],
      unloaded: [{ name: "later", path: ".claude/skills/later/SKILL.md" }],
      invalid: [{ name: "broken", path: ".agents/skills/broken/SKILL.md" }],
      capped: [
        { name: "last", path: ".claude/skills/last/SKILL.md", cap: "listing" as const },
        { name: "lint", path: ".github/skills/lint/SKILL.md", cap: "file" as const, resources: 2 },
      ],
      loadsSkipped: 1,
    }
    expect(skillLogs(7, skills)).toEqual([
      { event: "skills.shadowed", fields: { number: 7, name: "review", path: ".github/skills/review/SKILL.md" } },
      { event: "skills.unloaded", fields: { number: 7, name: "later", path: ".claude/skills/later/SKILL.md" } },
      { event: "skills.invalid", fields: { number: 7, name: "broken", path: ".agents/skills/broken/SKILL.md" } },
      {
        event: "skills.capped",
        fields: { number: 7, name: "last", path: ".claude/skills/last/SKILL.md", cap: "listing" },
      },
      {
        event: "skills.capped",
        fields: { number: 7, name: "lint", path: ".github/skills/lint/SKILL.md", cap: "file", resources: 2 },
      },
    ])
  })
})

describe("skillsStartFields", () => {
  it("counts the skills offered and shortens their fingerprint to eight characters for review.start", async () => {
    const context = contextOf([blob(".github/skills/lint/SKILL.md"), blob(".github/skills/lint/rules.md")], {
      ".github/skills/lint/SKILL.md": skillMd("Lint."),
    })
    const skills = await repositorySkills(context)
    expect(skillsStartFields(skills)).toEqual({
      repoSkills: 1,
      repoSkillsFingerprint: skills.offered?.fingerprint.slice(0, 8),
      skillLoadsSkipped: 1,
    })
    expect(skills.offered?.fingerprint).toHaveLength(64)
  })

  it("logs no fingerprint when no repository skill is offered", async () => {
    expect(skillsStartFields(await repositorySkills(undefined))).toEqual({
      repoSkills: 0,
      repoSkillsFingerprint: undefined,
      skillLoadsSkipped: 0,
    })
  })
})

describe("reviewRepository", () => {
  it("carries the context, its standards and its skills from one load of the base", async () => {
    const context = contextOf([blob("CLAUDE.md"), blob(".github/skills/lint/SKILL.md")], {
      "CLAUDE.md": "Rules.",
      ".github/skills/lint/SKILL.md": skillMd("Lint."),
    })
    const repository = await reviewRepository(context, ["src/a.ts"], [])
    expect(repository.context).toBe(context)
    expect(repository.standards).toEqual(reviewStandards(context, ["src/a.ts"], []))
    expect(repository.skills.offered?.names).toEqual(["lint"])
  })

  it("carries no standard and no skill for an unreadable context", async () => {
    const repository = await reviewRepository(undefined, ["src/a.ts"], [])
    expect(repository.standards.used).toEqual([])
    expect(repository.skills).toEqual(await repositorySkills(undefined))
  })
})

describe("the catalog", () => {
  const LINT = contextOf([blob(".github/skills/lint/SKILL.md")], { ".github/skills/lint/SKILL.md": skillMd("Lint.") })
  const BARE = contextOf([blob("CLAUDE.md")], { "CLAUDE.md": "Rules." })

  it("hides the built-in skills from the catalog's listing, keeping their names, metadata and bodies, so they shadow without being offered", async () => {
    const { source } = await bundledSkills()
    const hidden = unlisted(source)
    expect([hidden.id, hidden.fingerprint]).toEqual([source.id, source.fingerprint])
    const original = await source.list()
    const descriptors = await hidden.list()
    expect(descriptors).toEqual(
      original.map((descriptor) => ({
        ...descriptor,
        metadata: { ...descriptor.metadata, "disable-model-invocation": true },
      })),
    )
    expect(original.find(({ name }) => name === "review")?.metadata).toHaveProperty("version")
    expect(await hidden.load("review")).toEqual(await source.load("review"))
    expect(await hidden.readResource?.("review", "references/severity.md")).toEqual(
      await source.readResource?.("review", "references/severity.md"),
    )
  })

  it("puts the hidden built-in skills ahead of the repository's", async () => {
    const { source } = await bundledSkills()
    const { offered } = await repositorySkills(LINT)
    const sources = catalogFor(source, offered)
    expect(sources?.map(({ id }) => id)).toEqual(["builtin", "repo"])
    const listed = (await sources?.[0]?.list()) ?? []
    expect(listed.every(({ metadata }) => metadata?.["disable-model-invocation"] === true)).toBe(true)
    expect(await sources?.[1]?.list()).toEqual(await offered?.source.list())
  })

  it("is no catalog when the repository offers no skill", async () => {
    expect(catalogFor((await bundledSkills()).source, undefined)).toBeUndefined()
  })

  function skipRecorder() {
    const skipped: Parameters<ReportSkippedRestore>[] = []
    const report: ReportSkippedRestore = (records, reason) => {
      skipped.push([records, reason])
    }
    return { report, skipped }
  }

  const ignoreActivation: ReportActivation = () => {}

  function activationRecorder() {
    const names: string[] = []
    const report: ReportActivation = (name) => {
      names.push(name)
    }
    return { report, names }
  }

  interface CalledWithoutHarness {
    execute(args?: Record<string, string>, api?: ToolExecutionApi, context?: Context): Promise<ToolExecutionResult>
  }

  function toolCalledWithoutHarness(extension: Extension | undefined, name: string): CalledWithoutHarness {
    const tool = extension?.tools?.find((candidate) => candidate.name === name)
    if (tool === undefined) throw new Error(`the catalog should hold ${name}`)
    return tool
  }

  const sdkAnswer = { isError: false, content: [{ type: "text" as const, text: "Activated." }] }

  const activateSkill = () =>
    defineTool({
      name: "activate_skill",
      description: "Activate a skill by name.",
      parameters: Type.Object({ name: Type.String() }),
      async execute() {
        return sdkAnswer
      },
    })

  const sdkResource = { isError: false, content: [{ type: "text" as const, text: "Read." }] }

  const readSkillResource = () =>
    defineTool({
      name: "read_skill_resource",
      description: "Read a resource of a skill.",
      parameters: Type.Object({ name: Type.String(), path: Type.String() }),
      async execute() {
        return sdkResource
      },
    })

  it("rebuilds the catalog from the one context the object holds while no review is pending, so a later question can open a repository skill", async () => {
    const { source } = await bundledSkills()
    const { report, skipped } = skipRecorder()
    const sources = await restoredCatalog(source, [LINT], 1, { pending: false }, report)
    expect(sources?.map(({ id }) => id)).toEqual(["builtin", "repo"])
    expect((await sources?.[1]?.list())?.map(({ name }) => name)).toEqual(["lint"])
    expect(skipped).toEqual([])
  })

  it("restores nothing and reports nothing for an object that holds no context, or one without skills", async () => {
    const { source } = await bundledSkills()
    const { report, skipped } = skipRecorder()
    expect(await restoredCatalog(source, [], 0, { pending: false }, report)).toBeUndefined()
    expect(await restoredCatalog(source, [BARE], 1, { pending: false }, report)).toBeUndefined()
    expect(await restoredCatalog(source, [BARE], 1, { pending: true, fingerprint: undefined }, report)).toBeUndefined()
    expect(skipped).toEqual([])
  })

  it("declines, reporting how many records it found, when the object holds several contexts or one its schema refuses", async () => {
    const { source } = await bundledSkills()
    const { report, skipped } = skipRecorder()
    expect(await restoredCatalog(source, [LINT, LINT], 2, { pending: false }, report)).toBeUndefined()
    expect(await restoredCatalog(source, [], 1, { pending: false }, report)).toBeUndefined()
    expect(await restoredCatalog(source, [LINT], 2, { pending: false }, report)).toBeUndefined()
    expect(skipped).toEqual([
      [2, "records"],
      [1, "records"],
      [2, "records"],
    ])
  })

  it("rebuilds the catalog while a review is pending only from the record whose fingerprint is the review's, so a resumed review never gets another base's skills", async () => {
    const { source } = await bundledSkills()
    const { report, skipped } = skipRecorder()
    const lint = await repositorySkills(LINT)
    const fingerprint = lint.offered?.fingerprint
    expect(fingerprint).toBeDefined()
    expect(await restoredCatalog(source, [LINT], 1, { pending: true, fingerprint }, report)).toHaveLength(2)
    expect(
      await restoredCatalog(source, [LINT], 1, { pending: true, fingerprint: "0".repeat(64) }, report),
    ).toBeUndefined()
    expect(await restoredCatalog(source, [LINT], 1, { pending: true, fingerprint: undefined }, report)).toBeUndefined()
    expect(await restoredCatalog(source, [BARE], 1, { pending: true, fingerprint }, report)).toBeUndefined()
    expect(skipped).toEqual([
      [1, "fingerprint"],
      [1, "fingerprint"],
      [1, "fingerprint"],
    ])
  })

  describe("the output channel", () => {
    const SDK_TEXT = '<skill_content name="lint">\nCheck it.\n</skill_content>'

    it("moves the content a tool returns to its output, the only channel pi-durable 1.3.0 shows the model", () => {
      expect(outputFromContent({ content: [{ type: "text", text: SDK_TEXT }] })).toEqual({
        output: [{ type: "text", text: SDK_TEXT }],
      })
    })

    it("passes a result that already carries output through unchanged, even one that also has content", () => {
      const own = { output: [{ type: "text" as const, text: "Ours." }] }
      expect(outputFromContent(own)).toBe(own)
      const both = {
        output: [{ type: "text" as const, text: "Ours." }],
        content: [{ type: "text" as const, text: "Theirs." }],
      }
      expect(outputFromContent(both)).toBe(both)
      const neither = { isError: true }
      expect(outputFromContent(neither)).toBe(neither)
    })

    async function lintSource(): Promise<SkillSource> {
      const context = contextOf([blob(".github/skills/lint/SKILL.md"), blob(".github/skills/lint/rules.md")], {
        ".github/skills/lint/SKILL.md": skillMd("Lint.", "Check every export."),
        ".github/skills/lint/rules.md": "No default exports.",
      })
      const offered = (await repositorySkills(context)).offered
      if (offered === undefined) throw new Error("the lint skill should be offered")
      return offered.source
    }

    async function loaded<T>(value: Promise<T | null> | undefined): Promise<T> {
      const resolved = await value
      if (resolved === null || resolved === undefined) throw new Error("the lint skill and its resource should load")
      return resolved
    }

    it("hands the model the skill body and the resource text that agents 0.28.1's textResult puts in content, since agents/harness/pi cannot load under vitest", async () => {
      const source = await lintSource()
      const skill = await loaded(source.load("lint"))
      const resource = await loaded(source.readResource?.("lint", "rules.md"))
      const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] })
      const activate = withOutputFromContent(async () => textResult(renderActivatedSkill(skill)))
      const read = withOutputFromContent(async () =>
        textResult(['<skill_resource name="lint" path="rules.md">', resource.content, "</skill_resource>"].join("\n")),
      )
      expect((await activate()).output?.[0]).toEqual({
        type: "text",
        text: expect.stringContaining("Check every export."),
      })
      expect((await read()).output?.[0]).toEqual({ type: "text", text: expect.stringContaining("No default exports.") })
    })

    it("wraps every tool of an extension, keeping its name, its sections and each tool's definition", () => {
      const activate = { ...activateSkill(), replay: "safe" as const }
      const section = { key: "skills", render: () => "Available skills." }
      const extension = defineExtension({ name: "agents.skills", tools: [activate], sections: [section] })
      const wrapped = withContentAsOutput(extension, ignoreActivation)
      expect(wrapped.name).toBe("agents.skills")
      expect(wrapped.sections).toBe(extension.sections)
      const [tool] = wrapped.tools ?? []
      expect([tool?.name, tool?.description, tool?.parameters, tool?.replay]).toEqual([
        activate.name,
        activate.description,
        activate.parameters,
        activate.replay,
      ])
      expect(tool?.execute).not.toBe(activate.execute)
    })

    it("sets output limits above the file cap in bytes and in lines on every wrapped tool, since pi-durable cuts a tool result at 50 KiB and 2,000 lines by default", () => {
      const wrapped = withContentAsOutput(
        defineExtension({ name: "agents.skills", tools: [activateSkill(), readSkillResource()] }),
        ignoreActivation,
      )
      expect((wrapped.tools ?? []).map((tool) => tool.outputLimits)).toEqual([
        CATALOG_OUTPUT_LIMITS,
        CATALOG_OUTPUT_LIMITS,
      ])
      expect(CATALOG_OUTPUT_LIMITS.maxBytes).toBeGreaterThan(MAX_SKILL_FILE_BYTES)
      expect(CATALOG_OUTPUT_LIMITS.maxLines).toBeGreaterThanOrEqual(CATALOG_OUTPUT_LIMITS.maxBytes)
    })

    it("reports the activated skill's name once the activation ran, and reports nothing for a call without a name", async () => {
      const events: string[] = []
      const wrapped = withActivationReport(
        async (args: { name?: string | number }) => {
          events.push(`ran ${JSON.stringify(args)}`)
          return { output: [] }
        },
        (name) => {
          events.push(`reported ${name}`)
        },
      )
      await wrapped({ name: "lint" })
      await wrapped({})
      await wrapped({ name: 7 })
      expect(events).toEqual(['ran {"name":"lint"}', "reported lint", "ran {}", 'ran {"name":7}'])
    })

    it("waits for an asynchronous report after the activation, and returns the activation's own result", async () => {
      const events: string[] = []
      const answer = { content: [{ type: "text" as const, text: SDK_TEXT }] }
      const wrapped = withActivationReport(
        async (_args: { name: string }) => {
          events.push("ran")
          return answer
        },
        async (name) => {
          await Promise.resolve()
          events.push(`reported ${name}`)
        },
      )
      expect(await wrapped({ name: "lint" })).toBe(answer)
      expect(events).toEqual(["ran", "reported lint"])
    })

    it("reports nothing when the SDK answers that the skill wasn't found, answers an error, or throws", async () => {
      const { report, names } = activationRecorder()
      const notFound = withActivationReport(
        async (_args: { name: string }) => ({ content: [{ type: "text" as const, text: "Skill not found: lint" }] }),
        report,
      )
      expect(await notFound({ name: "lint" })).toEqual({ content: [{ type: "text", text: "Skill not found: lint" }] })
      const errored = withActivationReport(async (_args: { name: string }) => ({ isError: true, output: [] }), report)
      await errored({ name: "lint" })
      const throwing = withActivationReport(async (_args: { name: string }) => {
        throw new Error("the loader broke")
      }, report)
      await expect(throwing({ name: "lint" })).rejects.toThrow("the loader broke")
      expect(names).toEqual([])
    })

    it("hands the report the calling conversation, undefined when the tool is called without the harness", async () => {
      const calls: [string, ConversationId | undefined][] = []
      const wrapped = withActivationReport(
        async (_args: { name: string }) => ({ output: [] }),
        (name, conversationId) => {
          calls.push([name, conversationId])
        },
      )
      await wrapped({ name: "lint" })
      expect(calls).toEqual([["lint", undefined]])
    })

    it("pins the not-found wording to the agents SDK this repository installs, so a reworded SDK fails here first", () => {
      const sdk = readFileSync(new URL("../node_modules/agents/dist/skills/index.js", import.meta.url), "utf8")
      expect(sdk).toContain("`Skill not found: ${name}`")
      expect(SKILL_NOT_FOUND).toBe("Skill not found:")
    })

    it("wraps activate_skill with the activation report inside the content wrapper, so the SDK's content still reaches the model, and leaves read_skill_resource with the content wrapper alone, even for a call that carries a name", async () => {
      const { report, names } = activationRecorder()
      const wrapped = withContentAsOutput(
        defineExtension({ name: "agents.skills", tools: [activateSkill(), readSkillResource()] }),
        report,
      )
      const activate = await toolCalledWithoutHarness(wrapped, "activate_skill").execute({ name: "lint" })
      expect(activate.output).toEqual(sdkAnswer.content)
      expect(names).toEqual(["lint"])
      const read = await toolCalledWithoutHarness(wrapped, "read_skill_resource").execute({
        name: "lint",
        path: "rules.md",
      })
      expect(read.output).toEqual(sdkResource.content)
      expect(names).toEqual(["lint"])
    })
  })

  describe("installCatalog", () => {
    const review = defineExtension({ name: "andabot" })

    function builder() {
      const built: (readonly SkillSource[])[] = []
      const build = async (sources: readonly SkillSource[]): Promise<Extension> => {
        built.push(sources)
        return defineExtension({ name: "agents.skills" })
      }
      return { build, built }
    }

    const installedNames = (registry: Registry): string[] =>
      registry
        .snapshot()
        .installed()
        .map(({ name }) => name)

    it("installs the catalog after the extensions already installed when the repository offers skills", async () => {
      const registry = createRegistry()
      registry.install(review)
      const { build, built } = builder()
      const installed = await installCatalog(registry, undefined, [], build, ignoreActivation)
      expect(installedNames(registry)).toEqual(["andabot", "agents.skills"])
      expect(installed).toBe(registry.snapshot().extension("agents.skills"))
      expect(built).toHaveLength(1)
    })

    it("installs the catalog with every tool wrapped, so what the SDK's tools return reaches the model", async () => {
      const registry = createRegistry()
      const activate = activateSkill()
      const sdkCatalog = defineExtension({ name: "agents.skills", tools: [activate] })
      const installed = await installCatalog(registry, undefined, [], async () => sdkCatalog, ignoreActivation)
      expect(installed).not.toBe(sdkCatalog)
      const [tool] = registry.snapshot().extension("agents.skills")?.tools ?? []
      expect(tool?.name).toBe("activate_skill")
      expect(tool?.execute).not.toBe(activate.execute)
    })

    it("threads its report to the installed activate_skill, so a call through the registry's tool is reported", async () => {
      const registry = createRegistry()
      const { report, names } = activationRecorder()
      const sdkCatalog = defineExtension({ name: "agents.skills", tools: [activateSkill(), readSkillResource()] })
      await installCatalog(registry, undefined, [], async () => sdkCatalog, report)
      const installed = registry.snapshot().extension("agents.skills")
      await toolCalledWithoutHarness(installed, "read_skill_resource").execute({ name: "lint", path: "rules.md" })
      expect(names).toEqual([])
      await toolCalledWithoutHarness(installed, "activate_skill").execute({ name: "lint" })
      expect(names).toEqual(["lint"])
    })

    it("rebuilds the catalog in place every review, so a resource that loaded since is served", async () => {
      const registry = createRegistry()
      registry.install(review)
      const { build, built } = builder()
      const { source } = await bundledSkills()
      const entries = [blob(".github/skills/lint/SKILL.md"), blob(".github/skills/lint/rules.md")]
      const body = { ".github/skills/lint/SKILL.md": skillMd("Lint.") }
      const partial = await repositorySkills(contextOf(entries, body))
      const full = await repositorySkills(contextOf(entries, { ...body, ".github/skills/lint/rules.md": "Rules." }))
      expect(full.offered?.fingerprint).toBe(partial.offered?.fingerprint)
      const first = await installCatalog(
        registry,
        undefined,
        catalogFor(source, partial.offered),
        build,
        ignoreActivation,
      )
      const second = await installCatalog(registry, first, catalogFor(source, full.offered), build, ignoreActivation)
      expect(installedNames(registry)).toEqual(["andabot", "agents.skills"])
      expect(registry.snapshot().extension("agents.skills")).toBe(second)
      expect(second).not.toBe(first)
      expect(await built[0]?.[1]?.readResource?.("lint", "rules.md")).toBeNull()
      expect((await built[1]?.[1]?.readResource?.("lint", "rules.md"))?.content).toBe("Rules.")
    })

    it("uninstalls the catalog when the repository offers none, leaving the review's own extension", async () => {
      const registry = createRegistry()
      registry.install(review)
      const { build } = builder()
      const installed = await installCatalog(registry, undefined, [], build, ignoreActivation)
      expect(await installCatalog(registry, installed, undefined, build, ignoreActivation)).toBeUndefined()
      expect(installedNames(registry)).toEqual(["andabot"])
    })

    it("changes nothing when no catalog is installed or offered", async () => {
      const registry = createRegistry()
      registry.install(review)
      const { build, built } = builder()
      expect(await installCatalog(registry, undefined, undefined, build, ignoreActivation)).toBeUndefined()
      expect(installedNames(registry)).toEqual(["andabot"])
      expect(built).toHaveLength(0)
    })
  })
})
