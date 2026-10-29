import { Type } from "typebox"
import { Value } from "typebox/value"
import type { CheckRecord } from "../records.ts"
import type { Manager } from "./checkout.ts"
import { lastLine } from "./checkout.ts"
import type { RunOutcome } from "./run.ts"
import type { SandboxAccess } from "./runs.ts"

export const CHECK_NAMES = ["lint", "typecheck", "test"] as const

export type CheckName = (typeof CHECK_NAMES)[number]

export const DEFAULT_CHECK_TIMEOUT_MS = 300_000

export const MAX_CHECK_PATHS = 20

const MAX_PATH_LENGTH = 512

const SAFE_PATH = /^[A-Za-z0-9_@+./-]+$/

const PATHS_SLOT = "{paths}"

const EXISTS_SCRIPT = `cd /workspace/repo || exit 2
for p; do [ -e "$p" ] || { echo "$p"; exit 1; }; done`

export const CHECK_ENV = { NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" } as const

export function checkTimeoutOf(value: string | undefined): number {
  const ms = Number(value)
  return Number.isSafeInteger(ms) && ms > 0 ? ms : DEFAULT_CHECK_TIMEOUT_MS
}

export function pathProblem(paths: readonly string[]): string | undefined {
  if (paths.length > MAX_CHECK_PATHS) return `more than ${MAX_CHECK_PATHS} paths; name the few that matter`
  for (const path of paths) {
    const problem = onePathProblem(path)
    if (problem !== undefined) return problem
  }
  return undefined
}

function onePathProblem(path: string): string | undefined {
  if (path.length > MAX_PATH_LENGTH) return `path longer than ${MAX_PATH_LENGTH} characters`
  if (!SAFE_PATH.test(path))
    return `path "${path}" has a character a repository path can't: letters, digits, _ @ + . / - only`
  if (path.startsWith("/") || path.startsWith("-")) return `path "${path}" must be relative and not start with -`
  if (path.split("/").includes("..")) return `path "${path}" leaves the repository`
  return undefined
}

export function argvFromTemplate(template: string, paths: readonly string[]): string[] {
  return template
    .split(/\s+/)
    .filter((word) => word !== "")
    .flatMap((word) => (word === PATHS_SLOT ? [...paths] : [word]))
}

const PackageJson = Type.Object({
  dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  devDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
})

const RUNNERS = {
  lint: [
    ["oxlint", ["oxlint"], true],
    ["eslint", ["eslint"], true],
  ],
  typecheck: [["typescript", ["tsc", "--noEmit"], false]],
  test: [
    ["vitest", ["vitest", "run"], true],
    ["jest", ["jest"], true],
  ],
} as const satisfies Record<CheckName, readonly (readonly [string, readonly string[], boolean])[]>

export function fallbackArgv(
  name: CheckName,
  manager: Manager,
  packageJson: string | undefined,
  paths: readonly string[],
): string[] | undefined {
  if (manager === "none") return undefined
  const named = dependencyNames(packageJson)
  const runner = RUNNERS[name].find(([dependency]) => named.has(dependency))
  if (runner === undefined) return undefined
  const [, command, takesPaths] = runner
  const prefix = manager === "pnpm" ? ["pnpm", "exec"] : ["npx", "--no-install"]
  return [...prefix, ...command, ...(takesPaths ? paths : [])]
}

function dependencyNames(packageJson: string | undefined): Set<string> {
  if (packageJson === undefined) return new Set()
  let parsed: unknown
  try {
    parsed = JSON.parse(packageJson)
  } catch {
    return new Set()
  }
  if (!Value.Check(PackageJson, parsed)) return new Set()
  return new Set([...Object.keys(parsed.devDependencies ?? {}), ...Object.keys(parsed.dependencies ?? {})])
}

export function checkKey(sha: string, name: CheckName, paths: readonly string[]): string {
  return `${sha}:${name}:${paths.join(" ")}`
}

export function knownChecksOf(runs: ReadonlyMap<string, CheckRun>, sha: string): Map<string, number> {
  const known = new Map<string, number>()
  for (const [key, run] of runs) {
    if (!key.startsWith(`${sha}:`) || run.outcome.outcome !== "exited") continue
    known.set(`${run.name}:${run.paths.join(" ")}`, run.outcome.exitCode)
  }
  return known
}

export function accessRefusal(access: Exclude<SandboxAccess, { kind: "ready" }>): CheckRefusal {
  return access
}

export function existsArgv(paths: readonly string[]): string[] {
  return ["/bin/sh", "-c", EXISTS_SCRIPT, "andabot-exists", ...paths]
}

export function missingPath(outcome: RunOutcome): string | undefined {
  if (outcome.outcome !== "exited" || outcome.exitCode !== 1) return undefined
  return lastLine(outcome.tail) || undefined
}

export interface CheckRun {
  readonly name: CheckName
  readonly paths: readonly string[]
  readonly outcome: RunOutcome
  readonly ms: number
}

export function checkRecordOf(run: CheckRun): CheckRecord {
  const record: CheckRecord = {
    name: run.name,
    paths: [...run.paths],
    outcome: run.outcome.outcome,
    ms: run.ms,
    tail: run.outcome.tail,
  }
  if (run.outcome.outcome === "exited") record.exitCode = run.outcome.exitCode
  return record
}

export function checkText(run: CheckRun): string {
  const seconds = (run.ms / 1000).toFixed(1).replace(/\.0$/, "")
  const head =
    run.outcome.outcome === "exited"
      ? `${run.name} exited ${run.outcome.exitCode} in ${seconds}s`
      : `${run.name} timed out after ${seconds}s`
  const tail = run.outcome.tail === "" ? "(no output)" : run.outcome.tail
  const cut = run.outcome.cut ? "\n(output cut to its last 8 KiB)" : ""
  return `${head}\n\n${tail}${cut}`
}

export type CheckRefusal =
  | { readonly kind: "off" }
  | { readonly kind: "spent"; readonly seconds: number; readonly budget: number }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "no_command" }
  | { readonly kind: "bad_path"; readonly problem: string }
  | { readonly kind: "missing_path"; readonly path: string }

export function refusalText(name: CheckName, refusal: CheckRefusal): string {
  switch (refusal.kind) {
    case "off":
      return `The sandbox is off for this repository, so ${name} did not run.`
    case "spent":
      return `The sandbox budget is spent (${refusal.seconds} of ${refusal.budget} seconds), so ${name} did not run.`
    case "unavailable":
      return `The sandbox is unavailable for this review (${refusal.reason} failed), so ${name} did not run.`
    case "no_command":
      return `This repository has no ${name} command: nothing in .andabot.yaml's checks and no runner package.json names.`
    case "bad_path":
      return `${name} did not run: ${refusal.problem}.`
    case "missing_path":
      return `${name} did not run: ${refusal.path} does not exist at the pull request's head.`
  }
}
