import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import type { SkillContent } from "agents/skills"
import { describe, expect, it } from "vitest"
import { renderStandards } from "../src/repository/instructions.ts"
import { BUNDLED_SKILL_FILES, bundledSkills } from "../src/review/bundled-skills.ts"
import {
  buildSkillManifest,
  fingerprintOf,
  manifestSource,
  renderActivatedSkill,
  renderSkillWithResources,
  type SkillFile,
} from "../src/review/skills.ts"
import { SUBMIT_VERDICTS_TOOL, VERIFY_TOOL_BUDGET } from "../src/review/verify-tools.ts"
import { verifyPrompt } from "../src/review/verify.ts"

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
  it("lists the four skills with their frontmatter and the review references", () => {
    const manifest = buildSkillManifest(files, "abc")
    expect(manifest.id).toBe("builtin")
    expect(manifest.skills.map((s) => s.name).sort()).toEqual(["answer", "review", "summary", "verify"])
    const review = manifest.skills.find((s) => s.name === "review")
    expect(review?.version).toBe("12")
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

describe("renderSkillWithResources", () => {
  const skill = {
    name: "review",
    description: "d",
    version: "1",
    body: "Steps.",
    resources: [{ path: "references/severity.md", kind: "reference", encoding: "text", size: 10 }],
  } satisfies SkillContent

  it("follows the activated skill with each resource in the wrapper read_skill_resource returns", () => {
    const text = renderSkillWithResources(skill, [
      { path: "references/severity.md", kind: "reference", encoding: "text", size: 10, content: "Blocking.\n" },
    ])
    expect(text).toBe(
      [
        renderActivatedSkill(skill),
        "",
        '<skill_resource name="review" path="references/severity.md" kind="reference" encoding="text">',
        "Blocking.",
        "</skill_resource>",
      ].join("\n"),
    )
  })

  it("is the activated skill alone when there are no resources", () => {
    expect(renderSkillWithResources(skill, [])).toBe(renderActivatedSkill(skill))
  })
})

describe("manifestSource", () => {
  const source = manifestSource(buildSkillManifest(files, "fingerprint"))

  it("carries the manifest's id and fingerprint and lists the four skills", async () => {
    expect([source.id, source.fingerprint]).toEqual(["builtin", "fingerprint"])
    expect((await source.list()).map((s) => s.name).sort()).toEqual(["answer", "review", "summary", "verify"])
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

  it("loads the summary skill with no resources of its own", async () => {
    const summary = await source.load("summary")
    expect(summary?.name).toBe("summary")
    expect(summary?.resources ?? []).toEqual([])
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

  it("lists the four skills and serves a reference through the source", async () => {
    const { source, fingerprint } = await bundledSkills()
    expect(fingerprint).toBe(await fingerprintOf(files))
    expect((await source.list()).map((s) => s.name).sort()).toEqual(["answer", "review", "summary", "verify"])
    const resource = await source.readResource?.("review", "references/severity.md")
    expect(resource?.content).toContain("blocking")
  })

  it("marks exactly the four files under references/ as the review skill's references, so its instructions carry all of them", async () => {
    const review = await (await bundledSkills()).source.load("review")
    const references = review?.resources?.filter(({ kind }) => kind === "reference").map(({ path }) => path)
    expect(references?.sort()).toEqual([
      "references/merge-danger.md",
      "references/severity.md",
      "references/smells.md",
      "references/tests.md",
    ])
  })

  it("tells the review to claim only what the code shows, since the model can't build or run it", async () => {
    const review = await (await bundledSkills()).source.load("review")
    expect(review?.body).toContain("You can't build, run or test the code")
  })

  it("points the standards check at the heading the host renders the repository's rules under, and has a standard finding's basis name the standards file and the rule", async () => {
    const review = await (await bundledSkills()).source.load("review")
    const heading = renderStandards([{ path: "CLAUDE.md", text: "Rules.", source: "root" }]).text.split("\n")[0]
    expect(heading).toBe("## Repository standards")
    expect(review?.body).toContain(`the repository's own rules under \`${heading}\` in your instructions, when present`)
    expect(review?.body).toContain(
      "A `standard` finding's basis names the standards file and the rule, such as `CLAUDE.md: no comments of any kind`, a smell by its name, or an activated repository skill; the host refuses a `standard` basis that names none of them.",
    )
  })

  it("tells the review to check the docs under review and the docs mentioning the change, and to anchor a stale doc on the changed code line", async () => {
    const review = await (await bundledSkills()).source.load("review")
    expect(review?.body).toContain("- **Docs**: for each file under `## Docs under review`")
    expect(review?.body).toContain("## Docs mentioning the change")
    expect(review?.body).toContain("anchors on the changed code line")
    expect(review?.description).toContain("docs")
  })

  it("tells the review to use activate_skill with a matching skill's name before step 2, in the words of the catalog's list headed Available skills, and to grade the finding the skill asks for as a standard finding", async () => {
    const review = await (await bundledSkills()).source.load("review")
    expect(review?.body).toContain(
      "A list headed `Available skills` in your prompt names the repository's own skills. When one's description matches this pull request, use `activate_skill` with its name before step 2. That skill supplements this one: this procedure and `submit_review` stay in force, the repository's skill supplies checks and vocabulary, and a tool it names that you do not have is skipped. A finding a repository skill asks for is a `standard` finding, graded suggestion or nitpick, whose basis names the skill's `SKILL.md` and the rule.",
    )
  })

  it("skips only the smells tooling enforces, so a repository rule a linter enforces is still reported", async () => {
    const smells = await (await bundledSkills()).source.readResource?.("review", "references/smells.md")
    expect(smells?.content).toContain(
      "Skip a smell that tooling already enforces; a repository rule under `## Repository standards` is reported even when a linter enforces it, since the review cannot run the linter.",
    )
    expect(smells?.content).not.toContain("Like any standard")
  })

  it("names the files that need a walkthrough row in an incremental review, in its step and in its completion criterion", async () => {
    const review = await (await bundledSkills()).source.load("review")
    expect(review?.body).toContain(
      "Every changed file gets a row; in an incremental review, every file under `## Changes since your last review`.",
    )
    expect(review?.body).toContain(
      "Done when every changed file, or in an incremental review every file under `## Changes since your last review`, has a walkthrough row, every finding has an anchor, a quote and a basis, and `merge_danger` states the door and the blast radius.",
    )
  })

  it("points verify at the patches heading and the held-back mark its prompt writes, the severity reference it is handed, its tool budget and submit_verdicts", async () => {
    const verify = await (await bundledSkills()).source.load("verify")
    const held = {
      path: "src/a.ts",
      line: 40,
      quote: "q",
      basis_kind: "defect",
      basis: "b",
      severity: "blocking",
      title: "t",
      body: "b",
    } as const
    const prompt = verifyPrompt([
      {
        candidate: { id: "F1", finding: held, held: true },
        window: "    1 | a",
        patch: "@@ -1 +1 @@\n-a\n+b",
        issue: undefined,
      },
    ])
    for (const mark of ["`## Patches`", "`held back:`"]) {
      expect(prompt).toContain(mark.slice(1, -1))
      expect(verify?.body).toContain(mark)
    }
    expect(verify?.body).toContain("`references/severity.md`, below")
    expect(verify?.body).toContain(`at most ${VERIFY_TOOL_BUDGET} tool calls`)
    expect(verify?.body).toContain(`\`${SUBMIT_VERDICTS_TOOL}\``)
  })
})

describe("the answer skill", () => {
  it("tells the model when to resolve its own thread, and never on the author's word alone", async () => {
    const skill = await (await bundledSkills()).source.load("answer")
    if (skill === null) throw new Error("the answer skill is missing")
    const text = renderActivatedSkill(skill)
    expect(text).toContain("resolve_thread")
    expect(text).toContain("withdrawn")
    expect(text).toContain("Never resolve on the author's word alone")
    expect(text).toContain('version="2"')
  })
})
