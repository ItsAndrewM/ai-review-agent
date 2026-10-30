import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { pairingProblem, SMELLS, standardBasisProblem, type BasisContext } from "../src/review/basis.ts"

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
    const bare = { hasLinkedIssues: false, instructionFiles: [], activatedSkills: [] }
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

  it("refuses a standard or test finding graded blocking or major", () => {
    for (const basis_kind of ["standard", "test"] as const) {
      for (const severity of ["blocking", "major"] as const) {
        expect(pairingProblem({ basis_kind, severity })).toBe(
          "a standard or test finding cannot be blocking or major; grade it suggestion or nitpick, or give it the defect or spec basis it rests on",
        )
      }
    }
  })
})
