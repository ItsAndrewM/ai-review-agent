import { createRegistry, defineExtension, type Extension, type Registry } from "@earendil-works/pi-durable"
import type { SkillSource } from "agents/skills"
import { describe, expect, it } from "vitest"
import { GitHubClient, type TreeEntry } from "../src/github/client.ts"
import {
  loadRepositoryContext,
  MAX_INSTRUCTION_LOADS,
  reviewRepository,
  reviewStandards,
  type RepositoryContext,
} from "../src/repository/context.ts"
import {
  catalogFor,
  installCatalog,
  repositorySkillFiles,
  repositorySkillFingerprint,
  repositorySkills,
  shadowedSkillFiles,
  skillLogs,
  skillSourceFor,
  skillsStartFields,
  unlisted,
  unloadedSkillPaths,
  type Catalog,
} from "../src/repository/skills.ts"
import { BUNDLED_SKILL_NAMES, bundledSkills } from "../src/review/bundled-skills.ts"
import { sha256Hex } from "../src/review/skills.ts"

const ref = { owner: "o", repo: "r" }
const BASE = "ba5e5".repeat(8)
const CONTENTS = "/repos/o/r/contents/"

const blob = (path: string, sha = "1"): TreeEntry => ({ path, type: "blob", sha })

const directory = (path: string): TreeEntry => ({ path, type: "tree", sha: "2" })

const skillMd = (description: string, body = "Check the thing."): string =>
  `---\ndescription: ${description}\n---\n${body}\n`

const contextOf = (entries: readonly TreeEntry[], files: Readonly<Record<string, string>>): RepositoryContext => ({
  baseSha: BASE,
  tree: { sha: "f00d".repeat(10), truncated: false, entries },
  files,
})

const failOnUnreadable = (path: string, error: string): void => {
  throw new Error(`${path} was reported unreadable: ${error}`)
}

function fakeGitHub(entries: readonly TreeEntry[], bodies: ReadonlyMap<string, string>) {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const { pathname, search } = new URL(String(input))
    calls.push(`${pathname}${search}`)
    if (pathname.startsWith("/repos/o/r/git/trees/")) {
      return new Response(JSON.stringify({ sha: "f00d".repeat(10), truncated: false, tree: entries }), { status: 200 })
    }
    const body = bodies.get(decodeURIComponent(pathname.slice(CONTENTS.length)))
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(body, { status: 200 })
  }
  return { github: new GitHubClient("t", "https://api.example", fetchImpl), calls }
}

const nestedRules = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `pkg-${String(index).padStart(2, "0")}/CLAUDE.md`)

const changedUnder = (rules: readonly string[]): string[] => rules.map((path) => path.replace("CLAUDE.md", "a.ts"))

const ALPHA = [".github/skills/alpha/SKILL.md", ".github/skills/alpha/references/a.md"]
const BETA = [".claude/skills/beta/SKILL.md", ".claude/skills/beta/notes.md"]

const SKILL_BODIES: [string, string][] = [
  [".github/skills/alpha/SKILL.md", skillMd("Alpha checks.")],
  [".github/skills/alpha/references/a.md", "Alpha reference."],
  [".claude/skills/beta/SKILL.md", skillMd("Beta checks.")],
  [".claude/skills/beta/notes.md", "Beta notes."],
]

const rulesFor = (paths: readonly string[]): [string, string][] => paths.map((path) => [path, `Rules from ${path}.`])

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

  it("leaves out a skill named review or answer, which the built-in skills shadow, and one whose name an earlier root took", () => {
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

  it("shadows exactly the skills the bundle holds", async () => {
    const bundled = (await (await bundledSkills()).source.list()).map(({ name }) => name)
    expect([...BUNDLED_SKILL_NAMES].sort()).toEqual([...bundled].sort())
    expect([...BUNDLED_SKILL_NAMES].sort()).toEqual(["answer", "review"])
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

  it("ignores what lies outside the skills and the skills the built-in ones shadow", async () => {
    const fingerprint = await repositorySkillFingerprint(entries)
    const around = [...entries, blob("CLAUDE.md", "e5"), blob(".github/skills/review/SKILL.md", "f6")]
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
    expect(
      (await (await repositorySkills(second)).offered?.source.load("alpha"))?.resources?.map(({ path }) => path),
    ).toEqual(["references/a.md"])
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
    const skillPaths = Array.from(
      { length: 30 },
      (_, index) => `.agents/skills/s-${String(index).padStart(2, "0")}/SKILL.md`,
    )
    const bodies = new Map([...rulesFor(rules), ...skillPaths.map((path): [string, string] => [path, skillMd(path)])])
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
    const bodies = new Map([...SKILL_BODIES, ...shadowed.map((path): [string, string] => [path, skillMd("Ours.")])])
    const { github, calls } = fakeGitHub(
      [...shadowed, ...ALPHA].map((path) => blob(path)),
      bodies,
    )
    const context = await loadRepositoryContext(github, ref, BASE, ["src/a.ts"], failOnUnreadable)
    expect(Object.keys(context.files)).toEqual(ALPHA)
    expect(calls.some((call) => call.includes("skills/review"))).toBe(false)
  })
})

describe("skillSourceFor", () => {
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

  it("offers each loaded skill under its directory's name, with its description, its version and the resources that loaded, through a source named repo", async () => {
    const offered = await skillSourceFor(contextOf(entries, files))
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
    const offered = await skillSourceFor(contextOf([blob(".github/skills/my-review/SKILL.md")], posing))
    expect(offered?.names).toEqual(["my-review"])
    expect(await offered?.source.load("review")).toBeNull()
  })

  it("fingerprints the files it serves, so a resource that loads later changes the fingerprint", async () => {
    const partial = { ".github/skills/code-review/SKILL.md": files[".github/skills/code-review/SKILL.md"] }
    const before = await skillSourceFor(contextOf(entries, partial))
    const after = await skillSourceFor(contextOf(entries, files))
    expect(before?.fingerprint).toBe(await repositorySkillFingerprint(entries.slice(0, 1)))
    expect(after?.fingerprint).toBe(await repositorySkillFingerprint(entries))
    expect(after?.source.fingerprint).toBe(after?.fingerprint)
    expect(after?.fingerprint).not.toBe(before?.fingerprint)
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
    const offered = await skillSourceFor(context)
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
  ])("offers no skill whose SKILL.md has $label", async ({ text }) => {
    const context = contextOf([blob(".github/skills/lint/SKILL.md")], { ".github/skills/lint/SKILL.md": text })
    expect(await skillSourceFor(context)).toBeUndefined()
  })

  it("is nothing for a base without skills", async () => {
    expect(await skillSourceFor(contextOf([blob("CLAUDE.md")], { "CLAUDE.md": "Rules." }))).toBeUndefined()
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
    expect(skills.loadsSkipped).toBe(2)
  })

  it("is no skill at all for an unreadable context", async () => {
    expect(await repositorySkills(undefined)).toEqual({
      offered: undefined,
      shadowed: [],
      unloaded: [],
      invalid: [],
      loadsSkipped: 0,
    })
  })
})

describe("skillLogs", () => {
  it("logs each shadowed, unloaded and invalid skill with the pull request, its name and its SKILL.md", async () => {
    const skills = {
      offered: undefined,
      shadowed: [{ name: "review", path: ".github/skills/review/SKILL.md" }],
      unloaded: [{ name: "later", path: ".claude/skills/later/SKILL.md" }],
      invalid: [{ name: "broken", path: ".agents/skills/broken/SKILL.md" }],
      loadsSkipped: 1,
    }
    expect(skillLogs(7, skills)).toEqual([
      { event: "skills.shadowed", fields: { number: 7, name: "review", path: ".github/skills/review/SKILL.md" } },
      { event: "skills.unloaded", fields: { number: 7, name: "later", path: ".claude/skills/later/SKILL.md" } },
      { event: "skills.invalid", fields: { number: 7, name: "broken", path: ".agents/skills/broken/SKILL.md" } },
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
  const offeredLint = async () =>
    skillSourceFor(
      contextOf([blob(".github/skills/lint/SKILL.md")], { ".github/skills/lint/SKILL.md": skillMd("Lint.") }),
    )

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

  it("puts the hidden built-in skills ahead of the repository's, keyed by both sources' fingerprints", async () => {
    const { source } = await bundledSkills()
    const offered = await offeredLint()
    const catalog = catalogFor(source, offered)
    expect(catalog?.sources.map(({ id }) => id)).toEqual(["builtin", "repo"])
    expect(catalog?.key).toBe(`builtin:${source.fingerprint}|repo:${offered?.fingerprint}`)
    const listed = (await catalog?.sources[0]?.list()) ?? []
    expect(listed.every(({ metadata }) => metadata?.["disable-model-invocation"] === true)).toBe(true)
    expect(await catalog?.sources[1]?.list()).toEqual(await offered?.source.list())
  })

  it("is no catalog when the repository offers no skill", async () => {
    expect(catalogFor((await bundledSkills()).source, undefined)).toBeUndefined()
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

    const catalog = (key: string): Catalog => ({ key, sources: [] })

    const installedNames = (registry: Registry): string[] =>
      registry
        .snapshot()
        .installed()
        .map(({ name }) => name)

    it("installs the catalog after the extensions already installed when the repository offers skills", async () => {
      const registry = createRegistry()
      registry.install(review)
      const { build, built } = builder()
      const installed = await installCatalog(registry, undefined, catalog("k1"), build)
      expect(installedNames(registry)).toEqual(["andabot", "agents.skills"])
      expect(installed?.key).toBe("k1")
      expect(installed?.extension).toBe(registry.snapshot().extension("agents.skills"))
      expect(built).toHaveLength(1)
    })

    it("keeps the installed catalog, building none, while its key stays the same", async () => {
      const registry = createRegistry()
      const first = builder()
      const installed = await installCatalog(registry, undefined, catalog("k1"), first.build)
      const second = builder()
      expect(await installCatalog(registry, installed, catalog("k1"), second.build)).toBe(installed)
      expect(second.built).toHaveLength(0)
    })

    it("replaces the catalog in place when the key changes", async () => {
      const registry = createRegistry()
      registry.install(review)
      const { build } = builder()
      const first = await installCatalog(registry, undefined, catalog("k1"), build)
      const second = await installCatalog(registry, first, catalog("k2"), build)
      expect(installedNames(registry)).toEqual(["andabot", "agents.skills"])
      expect(second?.key).toBe("k2")
      expect(registry.snapshot().extension("agents.skills")).toBe(second?.extension)
      expect(second?.extension).not.toBe(first?.extension)
    })

    it("uninstalls the catalog when the repository offers none, leaving the review's own extension", async () => {
      const registry = createRegistry()
      registry.install(review)
      const { build } = builder()
      const installed = await installCatalog(registry, undefined, catalog("k1"), build)
      expect(await installCatalog(registry, installed, undefined, build)).toBeUndefined()
      expect(installedNames(registry)).toEqual(["andabot"])
    })

    it("changes nothing when no catalog is installed or offered", async () => {
      const registry = createRegistry()
      registry.install(review)
      const { build, built } = builder()
      expect(await installCatalog(registry, undefined, undefined, build)).toBeUndefined()
      expect(installedNames(registry)).toEqual(["andabot"])
      expect(built).toHaveLength(0)
    })
  })
})
