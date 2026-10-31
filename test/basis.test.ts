import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  docsBasisProblem,
  pairingProblem,
  SMELLS,
  standardBasisProblem,
  type BasisContext,
} from "../src/review/basis.ts"

const NEW_CAP =
  "a standard, test or docs finding cannot be blocking or major; grade it suggestion or nitpick, or give it the defect or spec basis it rests on"

describe("SMELLS", () => {
  it("names every smell bullet of references/smells.md and nothing else", () => {
    const text = readFileSync(new URL("../skills/review/references/smells.md", import.meta.url), "utf8")
    const bullets = [...text.matchAll(/^- \*\*([^*]+)\*\*:/gm)].map((match) => match[1])
    expect(bullets.length).toBeGreaterThan(0)
    expect([...SMELLS]).toEqual(bullets)
  })
})

describe("standardBasisProblem", () => {
  const context: BasisContext = {
    hasLinkedIssues: false,
    instructionFiles: ["CLAUDE.md", ".github/instructions/lint.instructions.md", ".andabot.yaml: src/**"],
    activatedSkills: [],
    docs: [],
  }

  it("passes a basis naming a standards file by path or basename, in any case", () => {
    expect(standardBasisProblem("CLAUDE.md: no comments of any kind", context)).toBeUndefined()
    expect(standardBasisProblem("lint.instructions.md says one export per file", context)).toBeUndefined()
    expect(standardBasisProblem("claude.md forbids comments", context)).toBeUndefined()
  })

  it("passes a path_instructions standard named by the config file", () => {
    expect(standardBasisProblem(".andabot.yaml: src/** forbids default exports", context)).toBeUndefined()
  })

  it("passes a smell by name in any case", () => {
    expect(standardBasisProblem("possible feature envy: reaches into Cart", context)).toBeUndefined()
    expect(standardBasisProblem("Duplicated Code across invoice.ts and receipt.ts", context)).toBeUndefined()
  })

  it("passes an activated skill's name, and SKILL.md once a skill was activated", () => {
    const activated = { ...context, activatedSkills: ["react-conventions"] }
    expect(standardBasisProblem("react-conventions: hooks at the top", activated)).toBeUndefined()
    expect(standardBasisProblem("SKILL.md: hooks at the top", activated)).toBeUndefined()
  })

  it("refuses SKILL.md when no skill was activated, and a file that isn't a standards file", () => {
    const refused = standardBasisProblem("docs/design.md says the object re-reads the head", context)
    expect(refused).toBe(
      "a standard finding must name a repository standards file (CLAUDE.md, .github/instructions/lint.instructions.md, .andabot.yaml: src/**), a smell from references/smells.md, or a repository skill this review activated (none was); if the code is wrong on its own terms, make it a defect with its failure scenario",
    )
    expect(standardBasisProblem("src/pull-request.ts trusts the stored scope", context)).toBe(refused)
    expect(standardBasisProblem("SKILL.md: hooks at the top", context)).toBe(refused)
  })

  it("offers only the smells when there are no standards files and no activation", () => {
    const bare = { hasLinkedIssues: false, instructionFiles: [], activatedSkills: [], docs: [] }
    expect(standardBasisProblem("the project convention", bare)).toBe(
      "a standard finding must name a repository standards file (none is listed), a smell from references/smells.md, or a repository skill this review activated (none was); if the code is wrong on its own terms, make it a defect with its failure scenario",
    )
    expect(standardBasisProblem("Middle Man", bare)).toBeUndefined()
  })

  it("names the activated skills in the refusal", () => {
    const activated = { ...context, activatedSkills: ["react-conventions", "api-style"] }
    expect(standardBasisProblem("the team prefers it", activated)).toContain(
      "a repository skill this review activated (react-conventions, api-style)",
    )
  })
})

describe("docsBasisProblem", () => {
  const context: BasisContext = {
    hasLinkedIssues: false,
    instructionFiles: [],
    activatedSkills: [],
    docs: ["docs/design.md", "README.md", "docs/superpowers/plans/2026-10-31-new.md"],
  }

  it("passes a basis naming one of the pull request's docs by path or basename, in any case", () => {
    expect(
      docsBasisProblem("docs/design.md:112 says the snapshot is dropped; src/x.ts:40 keeps it", context),
    ).toBeUndefined()
    expect(docsBasisProblem("readme.md:3 names grep, src/x.ts:9 renamed it", context)).toBeUndefined()
    expect(docsBasisProblem("the plan docs/superpowers/plans/2026-10-31-new.md:8 says X", context)).toBeUndefined()
  })

  it("refuses a basis that names a code file or a modified plan, listing the docs it may name", () => {
    const refused = docsBasisProblem("src/x.ts:40 contradicts the comment above it", context)
    expect(refused).toBe(
      "a docs finding must name one of the pull request's docs (docs/design.md, README.md, docs/superpowers/plans/2026-10-31-new.md); if the code is wrong on its own terms, make it a defect with its failure scenario",
    )
    expect(docsBasisProblem("docs/superpowers/plans/2026-10-17-old.md:3 says Y", context)).toBe(refused)
    expect(docsBasisProblem("anything", { ...context, docs: [] })).toContain("(none is known)")
  })
})

describe("pairingProblem", () => {
  it("allows defect and spec at blocking or major, standard and test at suggestion or nitpick", () => {
    for (const basis_kind of ["defect", "spec"] as const) {
      for (const severity of ["blocking", "major"] as const) {
        expect(pairingProblem({ basis_kind, severity })).toBeUndefined()
      }
    }
    for (const basis_kind of ["standard", "test"] as const) {
      for (const severity of ["suggestion", "nitpick"] as const) {
        expect(pairingProblem({ basis_kind, severity })).toBeUndefined()
      }
    }
  })

  it("refuses a defect or spec finding graded suggestion or nitpick, since its basis says the code fails", () => {
    for (const basis_kind of ["defect", "spec"] as const) {
      for (const severity of ["suggestion", "nitpick"] as const) {
        expect(pairingProblem({ basis_kind, severity })).toBe(
          "a defect or spec finding is blocking or major, since its basis says the code fails; if the code works as it stands, give it the standard or test basis it rests on",
        )
      }
    }
  })

  it("allows a docs finding at suggestion or nitpick and refuses it at blocking or major", () => {
    expect(pairingProblem({ basis_kind: "docs", severity: "suggestion" })).toBeUndefined()
    expect(pairingProblem({ basis_kind: "docs", severity: "nitpick" })).toBeUndefined()
    expect(pairingProblem({ basis_kind: "docs", severity: "major" })).toBe(NEW_CAP)
    expect(pairingProblem({ basis_kind: "docs", severity: "blocking" })).toBe(NEW_CAP)
  })

  it("refuses a standard or test finding graded blocking or major", () => {
    for (const basis_kind of ["standard", "test"] as const) {
      for (const severity of ["blocking", "major"] as const) {
        expect(pairingProblem({ basis_kind, severity })).toBe(
          "a standard, test or docs finding cannot be blocking or major; grade it suggestion or nitpick, or give it the defect or spec basis it rests on",
        )
      }
    }
  })
})
