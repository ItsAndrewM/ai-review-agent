import { describe, expect, it } from "vitest"
import { pairingProblem } from "../src/review/basis.ts"

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
