import { describe, expect, it } from "vitest"
import type { TreeEntry } from "../src/github/client.ts"
import {
  applyToKeeps,
  frontmatterStripped,
  instructionCandidates,
  MAX_STANDARDS_CHARS,
  orderedStandards,
  renderStandards,
  type Standard,
} from "../src/repository/instructions.ts"

const SHA = "0123456789abcdef0123456789abcdef01234567"

const blob = (path: string): TreeEntry => ({ path, type: "blob", sha: SHA })

const tree = (path: string): TreeEntry => ({ path, type: "tree", sha: SHA })

const standard = (path: string, text: string): Standard => ({ path, text, source: "root" })

const withApplyTo = (applyTo: string): string => `---\napplyTo: ${applyTo}\n---\nBody.\n`

describe("instructionCandidates", () => {
  it("lists the nested CLAUDE.md of each ancestor directory of a changed file ahead of the root one, and none from beside or below it", () => {
    const entries = [
      blob("CLAUDE.md"),
      blob("apps/web/CLAUDE.md"),
      blob("apps/api/CLAUDE.md"),
      blob("apps/web/src/components/CLAUDE.md"),
    ]
    expect(instructionCandidates(entries, ["apps/web/src/button.tsx"])).toEqual(["apps/web/CLAUDE.md", "CLAUDE.md"])
  })

  it("lists nested files deepest first, so the most specific rules lead", () => {
    const entries = [
      blob("CLAUDE.md"),
      blob("apps/CLAUDE.md"),
      blob("apps/web/CLAUDE.md"),
      blob("apps/web/src/CLAUDE.md"),
    ]
    expect(instructionCandidates(entries, ["apps/web/src/a.ts"])).toEqual([
      "apps/web/src/CLAUDE.md",
      "apps/web/CLAUDE.md",
      "apps/CLAUDE.md",
      "CLAUDE.md",
    ])
  })

  it("lists CLAUDE.md before AGENTS.md in a directory that has both, whatever order the tree gave them in", () => {
    const entries = [blob("apps/web/AGENTS.md"), blob("apps/web/CLAUDE.md"), blob("AGENTS.md"), blob("CLAUDE.md")]
    expect(instructionCandidates(entries, ["apps/web/a.ts"])).toEqual([
      "apps/web/CLAUDE.md",
      "apps/web/AGENTS.md",
      "CLAUDE.md",
      "AGENTS.md",
    ])
  })

  it("lists the root files in the spec's order, with .github/copilot-instructions.md before CONTRIBUTING.md", () => {
    const entries = [
      blob("CONTRIBUTING.md"),
      blob(".github/copilot-instructions.md"),
      blob("CODING_STANDARDS.md"),
      blob("REVIEW.md"),
      blob("AGENTS.md"),
      blob("CLAUDE.md"),
      blob("README.md"),
    ]
    expect(instructionCandidates(entries, ["src/a.ts"])).toEqual([
      "CLAUDE.md",
      "AGENTS.md",
      "REVIEW.md",
      "CODING_STANDARDS.md",
      ".github/copilot-instructions.md",
      "CONTRIBUTING.md",
    ])
  })

  it("lists only the paths the tree holds as blobs, so a missing file or a directory named like one is no candidate", () => {
    const entries = [
      tree("CLAUDE.md"),
      blob("REVIEW.md"),
      tree(".github"),
      blob("apps/web/AGENTS.md"),
      tree("apps/CLAUDE.md"),
    ]
    expect(instructionCandidates(entries, ["apps/web/a.ts"])).toEqual(["apps/web/AGENTS.md", "REVIEW.md"])
  })

  it("lists every .github/instructions file, whatever its applyTo, ahead of the nested and root files, since its body decides", () => {
    const entries = [
      blob("CLAUDE.md"),
      blob("apps/web/CLAUDE.md"),
      blob(".github/instructions/testing.instructions.md"),
      blob(".github/instructions/a-style.instructions.md"),
    ]
    expect(instructionCandidates(entries, ["apps/web/a.ts"])).toEqual([
      ".github/instructions/a-style.instructions.md",
      ".github/instructions/testing.instructions.md",
      "apps/web/CLAUDE.md",
      "CLAUDE.md",
    ])
  })

  it("lists only NAME.instructions.md files directly inside .github/instructions", () => {
    const entries = [
      blob(".github/instructions/README.md"),
      blob(".github/instructions/frontend/react.instructions.md"),
      blob("docs/style.instructions.md"),
      blob(".github/instructions/ts.instructions.md"),
    ]
    expect(instructionCandidates(entries, ["src/a.ts"])).toEqual([".github/instructions/ts.instructions.md"])
  })

  it("lists a directory once however many changed files sit in it, and orders directories of equal depth by path", () => {
    const entries = [blob("b/CLAUDE.md"), blob("a/CLAUDE.md")]
    expect(instructionCandidates(entries, ["b/x.ts", "a/y.ts", "b/z.ts"])).toEqual(["a/CLAUDE.md", "b/CLAUDE.md"])
  })

  it("lists no nested file for a changed file at the root, since the root files come last on their own", () => {
    const entries = [blob("apps/web/CLAUDE.md"), blob("CLAUDE.md")]
    expect(instructionCandidates(entries, ["README.md"])).toEqual(["CLAUDE.md"])
    expect(instructionCandidates(entries, [])).toEqual(["CLAUDE.md"])
  })
})

describe("applyToKeeps", () => {
  it("keeps a file with no frontmatter, or frontmatter without an applyTo", () => {
    expect(applyToKeeps("Use strict mode.\n", ["src/a.ts"])).toBe(true)
    expect(applyToKeeps('---\ndescription: "Style"\n---\nBody.\n', ["src/a.ts"])).toBe(true)
    expect(applyToKeeps("---\n---\nBody.\n", ["src/a.ts"])).toBe(true)
  })

  it("keeps a file when its glob matches a changed path and drops it when none does, so src/** leaves test/a.ts alone", () => {
    expect(applyToKeeps(withApplyTo('"src/**"'), ["src/a.ts"])).toBe(true)
    expect(applyToKeeps(withApplyTo('"src/**"'), ["test/a.ts"])).toBe(false)
    expect(applyToKeeps(withApplyTo('"src/**"'), ["test/a.ts", "README.md", "src/deep/b.ts"])).toBe(true)
    expect(applyToKeeps(withApplyTo('"src/**"'), [])).toBe(false)
  })

  it("reads a list of globs, keeping the file when any one matches", () => {
    const block = '---\napplyTo:\n  - "src/**"\n  - "docs/**"\n---\nBody.\n'
    const flow = withApplyTo('["src/**", "docs/**"]')
    for (const text of [block, flow]) {
      expect(applyToKeeps(text, ["docs/guide.md"])).toBe(true)
      expect(applyToKeeps(text, ["src/a.ts"])).toBe(true)
      expect(applyToKeeps(text, ["test/a.ts"])).toBe(false)
    }
  })

  it("splits a comma-separated string into globs and trims each", () => {
    const text = withApplyTo('"src/**,  docs/** ,"')
    expect(applyToKeeps(text, ["docs/guide.md"])).toBe(true)
    expect(applyToKeeps(text, ["src/a.ts"])).toBe(true)
    expect(applyToKeeps(text, ["test/a.ts"])).toBe(false)
  })

  it("splits the strings inside a list as well", () => {
    const text = withApplyTo('["src/**, docs/**", "lib/**"]')
    expect(applyToKeeps(text, ["docs/guide.md"])).toBe(true)
    expect(applyToKeeps(text, ["lib/a.ts"])).toBe(true)
    expect(applyToKeeps(text, ["test/a.ts"])).toBe(false)
  })

  it("leaves a comma inside braces alone, so one glob can name several extensions", () => {
    const text = withApplyTo('"**/*.{ts,tsx}, docs/**"')
    expect(applyToKeeps(text, ["apps/web/button.tsx"])).toBe(true)
    expect(applyToKeeps(text, ["src/a.ts"])).toBe(true)
    expect(applyToKeeps(text, ["docs/guide.md"])).toBe(true)
    expect(applyToKeeps(text, ["src/a.js"])).toBe(false)
    expect(applyToKeeps(withApplyTo('"src/{a,{b,c}}.ts"'), ["src/c.ts"])).toBe(true)
  })

  it("matches a changed path under a dot directory, so a glob for everything covers .github", () => {
    expect(applyToKeeps(withApplyTo('"**"'), [".github/workflows/ci.yml"])).toBe(true)
    expect(applyToKeeps(withApplyTo('".github/**"'), [".github/workflows/ci.yml"])).toBe(true)
  })

  it("keeps a file whose frontmatter is not valid YAML, since a rule is worth more kept than dropped by a typo", () => {
    expect(applyToKeeps(withApplyTo("**/*.ts"), ["docs/guide.md"])).toBe(true)
    expect(applyToKeeps(withApplyTo('["src/**"'), ["docs/guide.md"])).toBe(true)
    expect(applyToKeeps("---\napplyTo: a\napplyTo: b\n---\nBody.\n", ["docs/guide.md"])).toBe(true)
  })

  it("keeps a file whose applyTo is not a string or a list of strings", () => {
    expect(applyToKeeps(withApplyTo("5"), ["docs/guide.md"])).toBe(true)
    expect(applyToKeeps(withApplyTo("[1, 2]"), ["docs/guide.md"])).toBe(true)
    expect(applyToKeeps(withApplyTo("{ a: b }"), ["docs/guide.md"])).toBe(true)
    expect(applyToKeeps("---\napplyTo:\n---\nBody.\n", ["docs/guide.md"])).toBe(true)
    expect(applyToKeeps("---\n- src/**\n---\nBody.\n", ["docs/guide.md"])).toBe(true)
  })

  it("keeps a file whose applyTo names no glob", () => {
    expect(applyToKeeps(withApplyTo('""'), ["docs/guide.md"])).toBe(true)
    expect(applyToKeeps(withApplyTo('" , "'), ["docs/guide.md"])).toBe(true)
    expect(applyToKeeps(withApplyTo("[]"), ["docs/guide.md"])).toBe(true)
  })

  it("reads frontmatter with Windows line endings", () => {
    const text = '---\r\napplyTo: "src/**"\r\n---\r\nBody.\r\n'
    expect(applyToKeeps(text, ["src/a.ts"])).toBe(true)
    expect(applyToKeeps(text, ["test/a.ts"])).toBe(false)
  })

  it("reads frontmatter only at the top, so a later pair of --- lines in the body is no applyTo", () => {
    const text = 'Rules.\n\n---\napplyTo: "src/**"\n---\nMore rules.\n'
    expect(applyToKeeps(text, ["test/a.ts"])).toBe(true)
  })
})

describe("frontmatterStripped", () => {
  it("removes the frontmatter block and keeps the body as it was", () => {
    expect(frontmatterStripped('---\napplyTo: "src/**"\n---\n# Style\n\nUse strict mode.\n')).toBe(
      "# Style\n\nUse strict mode.\n",
    )
    expect(frontmatterStripped('---\napplyTo: "src/**"\n---\n\n# Style\n')).toBe("\n# Style\n")
  })

  it("returns a file without frontmatter unchanged", () => {
    expect(frontmatterStripped("# Style\n\nUse strict mode.\n")).toBe("# Style\n\nUse strict mode.\n")
    expect(frontmatterStripped("")).toBe("")
  })

  it("leaves a block that is never closed, and a later pair of --- lines, alone", () => {
    const unclosed = '---\napplyTo: "src/**"\n# Style\n'
    expect(frontmatterStripped(unclosed)).toBe(unclosed)
    const later = 'Rules.\n\n---\napplyTo: "src/**"\n---\nMore rules.\n'
    expect(frontmatterStripped(later)).toBe(later)
  })

  it("removes an empty block and a block whose YAML is invalid, since the delimiters make it metadata", () => {
    expect(frontmatterStripped("---\n---\nBody.\n")).toBe("Body.\n")
    expect(frontmatterStripped("---\napplyTo: **/*.ts\n---\nBody.\n")).toBe("Body.\n")
  })

  it("removes a block with Windows line endings and a block with nothing after it", () => {
    expect(frontmatterStripped('---\r\napplyTo: "src/**"\r\n---\r\nBody.\r\n')).toBe("Body.\r\n")
    expect(frontmatterStripped('---\napplyTo: "src/**"\n---')).toBe("")
    expect(frontmatterStripped('---\napplyTo: "src/**"\n---\n')).toBe("")
  })

  it("closes the block at the first line that is exactly ---, not at a longer run of dashes", () => {
    expect(frontmatterStripped("---\na: 1\n----\n---\nBody.\n")).toBe("Body.\n")
  })

  it("accepts spaces or tabs after either --- delimiter", () => {
    expect(frontmatterStripped('---  \napplyTo: "src/**"\n---\t\nBody.\n')).toBe("Body.\n")
    expect(applyToKeeps('---  \napplyTo: "src/**"\n---  \nBody.\n', ["test/a.ts"])).toBe(false)
  })
})

describe("orderedStandards", () => {
  const loaded = [
    { path: ".github/instructions/ts.instructions.md", text: '---\napplyTo: "**/*.ts"\n---\nUse strict mode.\n' },
    { path: ".github/instructions/py.instructions.md", text: '---\napplyTo: "**/*.py"\n---\nUse type hints.\n' },
    { path: "apps/web/CLAUDE.md", text: "Web rules." },
    { path: "CLAUDE.md", text: "Root rules." },
    { path: "CONTRIBUTING.md", text: "Contributing." },
  ]

  it("puts the path_instructions whose glob matches a changed path first, then the matching instructions, nested and root files", () => {
    const pathInstructions = [
      { path: "docs/**", instructions: "Docs rule." },
      { path: "apps/web/**", instructions: "Web path rule." },
      { path: "**/*.ts", instructions: "Any TypeScript rule." },
    ]
    expect(orderedStandards(loaded, ["apps/web/src/a.ts"], pathInstructions)).toEqual([
      { path: ".andabot.yaml: apps/web/**", text: "Web path rule.", source: "path_instructions" },
      { path: ".andabot.yaml: **/*.ts", text: "Any TypeScript rule.", source: "path_instructions" },
      { path: ".github/instructions/ts.instructions.md", text: "Use strict mode.\n", source: "instructions" },
      { path: "apps/web/CLAUDE.md", text: "Web rules.", source: "nested" },
      { path: "CLAUDE.md", text: "Root rules.", source: "root" },
      { path: "CONTRIBUTING.md", text: "Contributing.", source: "root" },
    ])
  })

  it("drops an instructions file whose applyTo matches no changed path and strips the frontmatter of the ones it keeps", () => {
    const standards = orderedStandards(loaded, ["lib/tool.py"], [])
    expect(standards.map(({ path }) => path)).toEqual([
      ".github/instructions/py.instructions.md",
      "apps/web/CLAUDE.md",
      "CLAUDE.md",
      "CONTRIBUTING.md",
    ])
    expect(standards[0]?.text).toBe("Use type hints.\n")
  })

  it("matches a path_instructions glob against changed paths under a dot directory", () => {
    const standards = orderedStandards([], [".github/workflows/ci.yml"], [{ path: "**", instructions: "CI rule." }])
    expect(standards).toEqual([{ path: ".andabot.yaml: **", text: "CI rule.", source: "path_instructions" }])
  })

  it("leaves the text of a root or nested file as loaded, even when it opens with a --- line", () => {
    const text = "---\nnot: frontmatter here\n---\nRules.\n"
    expect(orderedStandards([{ path: "CLAUDE.md", text }], ["a.ts"], [])).toEqual([
      { path: "CLAUDE.md", text, source: "root" },
    ])
  })

  it("leaves out a standard with no text, such as an instructions file that is all frontmatter", () => {
    const empty = [
      { path: ".github/instructions/empty.instructions.md", text: '---\napplyTo: "**"\n---\n' },
      { path: "CLAUDE.md", text: " \n" },
      { path: "REVIEW.md", text: "Review rules." },
    ]
    const standards = orderedStandards(empty, ["a.ts"], [{ path: "**", instructions: "" }])
    expect(standards.map(({ path }) => path)).toEqual(["REVIEW.md"])
  })

  it("returns nothing when nothing was loaded and no path instruction applies", () => {
    expect(orderedStandards([], ["a.ts"], [{ path: "docs/**", instructions: "Docs rule." }])).toEqual([])
  })
})

describe("renderStandards", () => {
  it("renders nothing for no standards", () => {
    expect(renderStandards([])).toEqual({ text: "", used: [], cut: [] })
  })

  it("renders a heading, then each standard under its path, and says nothing was cut", () => {
    const { text, used, cut } = renderStandards([
      standard("apps/web/CLAUDE.md", "Web rules.\n"),
      standard("CLAUDE.md", "\nRoot rules.\n\n"),
    ])
    expect(text).toBe("## Repository standards\n\n### apps/web/CLAUDE.md\n\nWeb rules.\n\n### CLAUDE.md\n\nRoot rules.")
    expect(used).toEqual(["apps/web/CLAUDE.md", "CLAUDE.md"])
    expect(cut).toEqual([])
  })

  it("keeps whole leading entries within 12,000 characters and names every entry after them as cut", () => {
    const { text, used, cut } = renderStandards([
      standard("CLAUDE.md", "a".repeat(5_000)),
      standard("AGENTS.md", "b".repeat(5_000)),
      standard("REVIEW.md", "c".repeat(5_000)),
      standard("CONTRIBUTING.md", "d".repeat(100)),
    ])
    expect(used).toEqual(["CLAUDE.md", "AGENTS.md"])
    expect(cut).toEqual(["REVIEW.md", "CONTRIBUTING.md"])
    expect(text).toContain(`### CLAUDE.md\n\n${"a".repeat(5_000)}\n\n### AGENTS.md\n\n${"b".repeat(5_000)}`)
    expect(text).not.toContain("### REVIEW.md")
    expect(text).not.toContain("### CONTRIBUTING.md")
    expect(text.endsWith("\n\n_Cut for length: REVIEW.md, CONTRIBUTING.md._")).toBe(true)
    expect(text.length).toBeLessThanOrEqual(12_000)
  })

  it("drops a small entry after one that did not fit rather than skipping the big one, so the entries kept are a prefix", () => {
    const { used, cut } = renderStandards([
      standard("CLAUDE.md", "a".repeat(5_000)),
      standard("AGENTS.md", "b".repeat(9_000)),
      standard("REVIEW.md", "c".repeat(10)),
    ])
    expect(used).toEqual(["CLAUDE.md"])
    expect(cut).toEqual(["AGENTS.md", "REVIEW.md"])
  })

  it("keeps a first entry that fills the cap exactly, and truncates it one character later", () => {
    const overhead = renderStandards([standard("CLAUDE.md", "x")]).text.length - 1
    const exact = renderStandards([standard("CLAUDE.md", "x".repeat(12_000 - overhead))])
    expect(exact.text).toHaveLength(12_000)
    expect(exact.used).toEqual(["CLAUDE.md"])
    expect(exact.cut).toEqual([])
    const over = renderStandards([standard("CLAUDE.md", "x".repeat(12_000 - overhead + 1))])
    expect(over.cut).toEqual(["CLAUDE.md (truncated)"])
    expect(over.used).toEqual(["CLAUDE.md"])
    expect(over.text).toHaveLength(12_000)
  })

  it("truncates a first entry longer than the cap at the cap, counts it as used and names it as truncated", () => {
    const { text, used, cut } = renderStandards([standard("CLAUDE.md", "x".repeat(20_000))])
    expect(used).toEqual(["CLAUDE.md"])
    expect(cut).toEqual(["CLAUDE.md (truncated)"])
    expect(text.startsWith("## Repository standards\n\n### CLAUDE.md\n\nxxxx")).toBe(true)
    expect(text.endsWith("x\n\n_Cut for length: CLAUDE.md (truncated)._")).toBe(true)
    expect(text).toHaveLength(12_000)
  })

  it("names the entries dropped after a truncated first entry, the truncated one first", () => {
    const { text, used, cut } = renderStandards([
      standard("CLAUDE.md", "x".repeat(20_000)),
      standard("AGENTS.md", "y".repeat(10)),
      standard("REVIEW.md", "z".repeat(10)),
    ])
    expect(used).toEqual(["CLAUDE.md"])
    expect(cut).toEqual(["CLAUDE.md (truncated)", "AGENTS.md", "REVIEW.md"])
    expect(text.endsWith("\n\n_Cut for length: CLAUDE.md (truncated), AGENTS.md, REVIEW.md._")).toBe(true)
    expect(text).not.toContain("### AGENTS.md")
    expect(text).toHaveLength(12_000)
  })

  it.each([1, 5_000, 11_900, 11_950, 11_960, 11_975, 11_990, 12_000, 12_010, 40_000])(
    "never renders more than 12,000 characters, the closing note included, for a first entry of %i characters",
    (size) => {
      const { text } = renderStandards([
        standard("CLAUDE.md", "x".repeat(size)),
        standard("AGENTS.md", "y".repeat(500)),
      ])
      expect(text.length).toBeLessThanOrEqual(12_000)
    },
  )

  it("sets the cap at 12,000 characters", () => {
    expect(MAX_STANDARDS_CHARS).toBe(12_000)
  })
})
