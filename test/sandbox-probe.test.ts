import { describe, expect, it } from "vitest"
import { parseProbe, probeEnabled } from "../src/sandbox/probe.ts"

const key = { installationId: 1, owner: "o", repo: "r", number: 7 }

describe("probeEnabled", () => {
  it("is on only for the exact string true", () => {
    expect(probeEnabled("true")).toBe(true)
    expect(probeEnabled("false")).toBe(false)
    expect(probeEnabled("TRUE")).toBe(false)
    expect(probeEnabled("1")).toBe(false)
    expect(probeEnabled(undefined)).toBe(false)
  })
})

describe("parseProbe", () => {
  it("accepts a run with a command", () => {
    const body = JSON.stringify({ key, action: "run", command: ["node", "--version"], timeoutMs: 5000 })
    expect(parseProbe(body)).toEqual({ key, action: "run", command: ["node", "--version"], timeoutMs: 5000 })
  })

  it("accepts a destroy without one", () => {
    expect(parseProbe(JSON.stringify({ key, action: "destroy" }))).toEqual({ key, action: "destroy" })
  })

  it("refuses a run without a command", () => {
    expect(parseProbe(JSON.stringify({ key, action: "run" }))).toBeUndefined()
    expect(parseProbe(JSON.stringify({ key, action: "run", command: [] }))).toBeUndefined()
  })

  it("refuses a key that isn't a pull request key, and an unknown field", () => {
    expect(parseProbe(JSON.stringify({ key: { owner: "o" }, action: "destroy" }))).toBeUndefined()
    expect(parseProbe(JSON.stringify({ key, action: "destroy", shell: "rm -rf /" }))).toBeUndefined()
  })

  it("refuses a body that isn't JSON", () => {
    expect(parseProbe("not json")).toBeUndefined()
  })
})
