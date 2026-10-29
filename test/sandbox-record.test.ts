import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import type { PullRequestKey } from "../src/records.ts"
import type { CheckRun } from "../src/sandbox/checks.ts"
import { checkRunOf, SandboxRecord, storedCheckOf, UNAVAILABLE_REASONS } from "../src/sandbox/record.ts"

const KEY: PullRequestKey = { installationId: 1, owner: "o", repo: "r", number: 7 }

const exitedRun: CheckRun = {
  name: "test",
  paths: ["test/a.test.ts"],
  outcome: { outcome: "exited", exitCode: 1, tail: "FAIL\n", cut: true },
  ms: 4_400,
}

const timedOutRun: CheckRun = {
  name: "typecheck",
  paths: [],
  outcome: { outcome: "timeout", tail: "", cut: false },
  ms: 300_000,
}

const ready = {
  head: { number: 7, key: KEY, sha: "abc123" },
  started: 1_000_000,
  leased: true,
  running: true,
  settled: { kind: "ready", manager: "pnpm" },
  checks: [storedCheckOf(exitedRun)],
}

describe("storedCheckOf and checkRunOf", () => {
  it("round-trips an exited run with a cut tail, and a timed-out run", () => {
    expect(checkRunOf(storedCheckOf(exitedRun))).toEqual(exitedRun)
    expect(checkRunOf(storedCheckOf(timedOutRun))).toEqual(timedOutRun)
  })

  it("stores the exit code only for a run that exited", () => {
    expect(storedCheckOf(exitedRun)).toMatchObject({ outcome: "exited", exitCode: 1, cut: true })
    expect(storedCheckOf(timedOutRun)).not.toHaveProperty("exitCode")
  })
})

describe("SandboxRecord", () => {
  it("accepts a ready record with a check, and an unavailable one with none", () => {
    expect(Value.Check(SandboxRecord, ready)).toBe(true)
    const unavailable = {
      ...ready,
      leased: false,
      running: false,
      settled: { kind: "unavailable", reason: "install" },
      checks: [],
    }
    expect(Value.Check(SandboxRecord, unavailable)).toBe(true)
    expect(UNAVAILABLE_REASONS).toEqual(["head", "lease", "start", "checkout", "install"])
  })

  it("accepts a record that was still preparing, with no settled answer", () => {
    const { settled: _settled, ...preparing } = ready
    expect(Value.Check(SandboxRecord, preparing)).toBe(true)
  })

  it("refuses a settled kind, a check name or a reason it doesn't know", () => {
    expect(Value.Check(SandboxRecord, { ...ready, settled: { kind: "spent" } })).toBe(false)
    expect(Value.Check(SandboxRecord, { ...ready, settled: { kind: "unavailable", reason: "network" } })).toBe(false)
    expect(Value.Check(SandboxRecord, { ...ready, checks: [{ ...storedCheckOf(exitedRun), name: "build" }] })).toBe(
      false,
    )
  })

  it("refuses an exited check without an exit code", () => {
    const noCode = { name: "test", paths: [], outcome: "exited", ms: 1, tail: "", cut: false }
    expect(Value.Check(SandboxRecord, { ...ready, checks: [noCode] })).toBe(false)
  })
})
