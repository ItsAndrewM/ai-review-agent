import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { BUNDLED_SKILL_FILES, bundledSkills } from "../src/review/bundled-skills.ts"
import {
  buildSkillManifest,
  fingerprintOf,
  manifestSource,
  renderActivatedSkill,
  type SkillFile,
} from "../src/review/skills.ts"

const ROOT = new URL("../skills/", import.meta.url).pathname
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
const files: SkillFile[] = walk(ROOT).map((full) => ({
  path: relative(ROOT, full),
  content: readFileSync(full, "utf8"),
}))

describe("buildSkillManifest", () => {
  it("lists review and answer with their frontmatter and the review references", () => {
    const manifest = buildSkillManifest(files, "abc")
    expect(manifest.id).toBe("builtin")
    expect(manifest.skills.map((s) => s.name).sort()).toEqual(["answer", "review"])
    const review = manifest.skills.find((s) => s.name === "review")
    expect(review?.version).toBe("1")
    expect(review?.resources?.map((r) => r.path).sort()).toEqual([
      "CREDITS.md",
      "references/merge-danger.md",
      "references/severity.md",
      "references/smells.md",
      "references/tests.md",
    ])
    expect(review?.resources?.find((r) => r.path === "CREDITS.md")?.kind).toBe("file")
    expect(review?.resources?.find((r) => r.path === "references/smells.md")?.kind).toBe("reference")
  })

  it("keeps the review body under 120 lines and every description under 1024 characters", () => {
    const manifest = buildSkillManifest(files, "abc")
    for (const skill of manifest.skills) {
      expect(skill.description.length).toBeLessThan(1024)
      expect(skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
    expect(manifest.skills.find((s) => s.name === "review")?.body.split("\n").length).toBeLessThan(120)
  })

  it("refuses a skill without a description", () => {
    expect(() => buildSkillManifest([{ path: "x/SKILL.md", content: "---\nname: x\n---\nbody" }], "f")).toThrow(
      "skills/x/SKILL.md: invalid frontmatter",
    )
  })
})

describe("frontmatter", () => {
  const skillFile = (content: string): SkillFile[] => [{ path: "x/SKILL.md", content }]
  const firstSkill = (content: string) => buildSkillManifest(skillFile(content), "f").skills[0]

  it.each([
    { label: "no frontmatter", content: "body only" },
    { label: "frontmatter that never closes", content: "---\nname: x\ndescription: d\nbody" },
    { label: "a name that is not a string", content: "---\nname: 5\ndescription: d\n---\nbody" },
    { label: "a blank description", content: '---\nname: x\ndescription: "  "\n---\nbody' },
    {
      label: "a version that is neither a string nor a number",
      content: "---\nname: x\ndescription: d\nmetadata:\n  version: [1]\n---\nbody",
    },
    { label: "YAML that does not parse", content: "---\nname: x\ndescription: Review: a diff\n---\nbody" },
  ])("refuses $label", ({ content }) => {
    expect(() => buildSkillManifest(skillFile(content), "f")).toThrow("skills/x/SKILL.md: invalid frontmatter")
  })

  it("reads a numeric metadata.version as a string", () => {
    expect(firstSkill("---\nname: x\ndescription: d\nmetadata:\n  version: 2\n---\nbody")?.version).toBe("2")
  })

  it("gives a skill without metadata no version", () => {
    expect(firstSkill("---\nname: x\ndescription: d\n---\nbody")?.version).toBeUndefined()
  })

  it("keeps the other metadata keys, which the harness reads to hide a skill", () => {
    const skill = firstSkill(
      "---\nname: x\ndescription: d\nmetadata:\n  version: '3'\n  disable-model-invocation: true\n---\nb",
    )
    expect(skill?.metadata?.["disable-model-invocation"]).toBe(true)
  })

  it("trims the name and a folded description", () => {
    const skill = firstSkill("---\nname: ' x '\ndescription: >\n  one\n  two\n---\nbody")
    expect([skill?.name, skill?.description]).toEqual(["x", "one two"])
  })

  it("ends the frontmatter at the first closing line, so a later rule stays in the body", () => {
    expect(firstSkill("---\nname: x\ndescription: d\n---\n\nfirst\n---\nsecond")?.body).toBe("\nfirst\n---\nsecond")
  })
})

describe("fingerprintOf", () => {
  it("is 64 hex characters, stable, and changes with any byte", async () => {
    const a = await fingerprintOf(files)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await fingerprintOf(files)).toBe(a)
    const edited = files.map((f, i) => (i === 0 ? { ...f, content: `${f.content} ` } : f))
    expect(await fingerprintOf(edited)).not.toBe(a)
  })
})

describe("renderActivatedSkill", () => {
  it("wraps the body in skill_content with the resource list", () => {
    const text = renderActivatedSkill({
      name: "review",
      description: "d",
      version: "1",
      body: "Steps.",
      resources: [{ path: "references/severity.md", kind: "reference", encoding: "text", size: 12 }],
    })
    expect(text).toBe(
      [
        '<skill_content name="review" version="1">',
        "Steps.",
        "<skill_resources>",
        '  <file kind="reference" encoding="text" size="12">references/severity.md</file>',
        "</skill_resources>",
        "</skill_content>",
        "",
        "Bundled resources:",
        "- references/severity.md (reference, text, 12 bytes)",
      ].join("\n"),
    )
  })
})

describe("manifestSource", () => {
  const source = manifestSource(buildSkillManifest(files, "fingerprint"))

  it("carries the manifest's id and fingerprint and lists both skills", async () => {
    expect([source.id, source.fingerprint]).toEqual(["builtin", "fingerprint"])
    expect((await source.list()).map((s) => s.name).sort()).toEqual(["answer", "review"])
  })

  it("loads a skill with its resources as descriptors, without their content", async () => {
    const review = await source.load("review")
    expect(review?.resources?.map((r) => r.path).sort()).toEqual([
      "CREDITS.md",
      "references/merge-danger.md",
      "references/severity.md",
      "references/smells.md",
      "references/tests.md",
    ])
    for (const resource of review?.resources ?? []) expect(resource).not.toHaveProperty("content")
  })

  it("reads a resource with its content", async () => {
    const resource = await source.readResource?.("review", "references/severity.md")
    expect(resource?.content).toContain("blocking")
  })

  it("resolves to null for an unknown skill or resource", async () => {
    expect(await source.load("nope")).toBeNull()
    expect(await source.readResource?.("review", "missing.md")).toBeNull()
    expect(await source.readResource?.("nope", "references/severity.md")).toBeNull()
  })
})

describe("bundledSkills", () => {
  it("bundles exactly the files under skills/", () => {
    expect(BUNDLED_SKILL_FILES.map((f) => f.path).sort()).toEqual(files.map((f) => f.path).sort())
  })

  it("lists both skills and serves a reference through the source", async () => {
    const { source, fingerprint } = await bundledSkills()
    expect(fingerprint).toBe(await fingerprintOf(files))
    expect((await source.list()).map((s) => s.name).sort()).toEqual(["answer", "review"])
    const resource = await source.readResource?.("review", "references/severity.md")
    expect(resource?.content).toContain("blocking")
  })
})
