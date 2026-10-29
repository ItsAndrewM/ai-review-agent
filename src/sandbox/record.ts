import { Type, type Static } from "typebox"
import { PullRequestKey } from "../records.ts"
import type { CheckRun } from "./checks.ts"

export const UNAVAILABLE_REASONS = ["head", "lease", "start", "checkout", "install"] as const

export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number]

const checkFields = {
  name: Type.Union([Type.Literal("lint"), Type.Literal("typecheck"), Type.Literal("test")]),
  paths: Type.Array(Type.String()),
  ms: Type.Integer(),
  tail: Type.String(),
  cut: Type.Boolean(),
}

export const StoredCheck = Type.Union([
  Type.Object({ ...checkFields, outcome: Type.Literal("exited"), exitCode: Type.Integer() }),
  Type.Object({ ...checkFields, outcome: Type.Literal("timeout") }),
])

export type StoredCheck = Static<typeof StoredCheck>

export const SandboxRecord = Type.Object({
  head: Type.Object({ number: Type.Integer(), key: PullRequestKey, sha: Type.String() }),
  started: Type.Integer(),
  leased: Type.Boolean(),
  running: Type.Boolean(),
  settled: Type.Optional(
    Type.Union([
      Type.Object({
        kind: Type.Literal("ready"),
        manager: Type.Union([Type.Literal("pnpm"), Type.Literal("npm"), Type.Literal("none")]),
      }),
      Type.Object({
        kind: Type.Literal("unavailable"),
        reason: Type.Union([
          Type.Literal("head"),
          Type.Literal("lease"),
          Type.Literal("start"),
          Type.Literal("checkout"),
          Type.Literal("install"),
        ]),
      }),
    ]),
  ),
  checks: Type.Array(StoredCheck),
})

export type SandboxRecord = Static<typeof SandboxRecord>

export function storedCheckOf(run: CheckRun): StoredCheck {
  const fields = { name: run.name, paths: [...run.paths], ms: run.ms, tail: run.outcome.tail, cut: run.outcome.cut }
  return run.outcome.outcome === "exited"
    ? { ...fields, outcome: "exited", exitCode: run.outcome.exitCode }
    : { ...fields, outcome: "timeout" }
}

export function checkRunOf(stored: StoredCheck): CheckRun {
  const outcome =
    stored.outcome === "exited"
      ? { outcome: "exited" as const, exitCode: stored.exitCode, tail: stored.tail, cut: stored.cut }
      : { outcome: "timeout" as const, tail: stored.tail, cut: stored.cut }
  return { name: stored.name, paths: stored.paths, outcome, ms: stored.ms }
}
