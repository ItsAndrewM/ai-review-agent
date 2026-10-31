import { describe, expect, it } from "vitest"
import {
  accessRefusal,
  argvFromTemplate,
  CHECK_ENV,
  checkKey,
  checkRecordOf,
  checkText,
  checkTimeoutOf,
  DEFAULT_CHECK_TIMEOUT_MS,
  existsArgv,
  fallbackArgv,
  knownChecksOf,
  MAX_CHECK_PATHS,
  missingPath,
  pathProblem,
  refusalText,
} from "../src/sandbox/checks.ts"
import type { RunOutcome } from "../src/sandbox/run.ts"

const exited = (exitCode: number, tail: string, cut = false): RunOutcome => ({ outcome: "exited", exitCode, tail, cut })
const timedOut: RunOutcome = { outcome: "timeout", tail: "", cut: false }

describe("checkTimeoutOf", () => {
  it("parses a positive whole number of milliseconds and falls back to five minutes", () => {
    expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(300_000)
    expect(checkTimeoutOf("1000")).toBe(1000)
    expect(checkTimeoutOf("0")).toBe(300_000)
    expect(checkTimeoutOf(undefined)).toBe(300_000)
  })
})

describe("pathProblem", () => {
  it("accepts repository paths with the characters a file name needs", () => {
    expect(pathProblem(["src/a.ts", "test/sandbox-policy.test.ts", "packages/@scope/x", "a+b/c.d"])).toBeUndefined()
    expect(pathProblem([])).toBeUndefined()
  })

  it("refuses a path with a space or a shell metacharacter before anything runs", () => {
    expect(pathProblem(["a b"])).toContain("a b")
    expect(pathProblem(["a;rm"])).toBeDefined()
    expect(pathProblem(["$(x)"])).toBeDefined()
    expect(pathProblem(["a`b"])).toBeDefined()
  })

  it("refuses a parent segment, an absolute path and a leading dash", () => {
    expect(pathProblem(["../etc/passwd"])).toBeDefined()
    expect(pathProblem(["src/../x"])).toBeDefined()
    expect(pathProblem(["/etc/passwd"])).toBeDefined()
    expect(pathProblem(["--help"])).toBeDefined()
    expect(pathProblem(["a..b/c"])).toBeUndefined()
  })

  it("refuses more than the cap of paths, and an over-long one", () => {
    expect(pathProblem(Array.from({ length: MAX_CHECK_PATHS + 1 }, (_, i) => `f${i}`))).toContain("20")
    expect(pathProblem(["x".repeat(513)])).toBeDefined()
  })
})

describe("argvFromTemplate", () => {
  it("splits on whitespace and puts each path in place of a standalone {paths} token", () => {
    expect(argvFromTemplate("pnpm  vitest run {paths}", ["a.ts", "b.ts"])).toEqual([
      "pnpm",
      "vitest",
      "run",
      "a.ts",
      "b.ts",
    ])
  })

  it("ignores paths when the template has no slot, and drops an empty slot", () => {
    expect(argvFromTemplate("pnpm tsc --noEmit", ["a.ts"])).toEqual(["pnpm", "tsc", "--noEmit"])
    expect(argvFromTemplate("pnpm vitest run {paths}", [])).toEqual(["pnpm", "vitest", "run"])
  })

  it("treats a slot glued to other text as no slot, so paths are ignored rather than mangled", () => {
    expect(argvFromTemplate("eslint --files={paths}", ["a.ts"])).toEqual(["eslint", "--files={paths}"])
  })
})

describe("fallbackArgv", () => {
  const pkg = JSON.stringify({ devDependencies: { vitest: "4", oxlint: "1", typescript: "5" } })

  it("picks the runner package.json names, through the manager's exec", () => {
    expect(fallbackArgv("test", "pnpm", pkg, ["a.test.ts"])).toEqual(["pnpm", "exec", "vitest", "run", "a.test.ts"])
    expect(fallbackArgv("lint", "pnpm", pkg, ["src"])).toEqual(["pnpm", "exec", "oxlint", "src"])
    expect(fallbackArgv("typecheck", "pnpm", pkg, ["src"])).toEqual(["pnpm", "exec", "tsc", "--noEmit"])
    expect(fallbackArgv("test", "npm", pkg, [])).toEqual(["npx", "--no-install", "vitest", "run"])
  })

  it("falls back to eslint and jest, and answers nothing when no runner is named", () => {
    const alt = JSON.stringify({ dependencies: { eslint: "9", jest: "30" } })
    expect(fallbackArgv("lint", "npm", alt, [])).toEqual(["npx", "--no-install", "eslint"])
    expect(fallbackArgv("test", "npm", alt, ["a"])).toEqual(["npx", "--no-install", "jest", "a"])
    expect(fallbackArgv("typecheck", "pnpm", alt, [])).toBeUndefined()
  })

  it("answers nothing without an installed manager, since npx would exit 1 and read as a failed check", () => {
    expect(fallbackArgv("test", "none", pkg, ["a.test.ts"])).toBeUndefined()
  })

  it("answers nothing for a missing or unparsable package.json", () => {
    expect(fallbackArgv("test", "pnpm", undefined, [])).toBeUndefined()
    expect(fallbackArgv("test", "pnpm", "{not json", [])).toBeUndefined()
    expect(fallbackArgv("test", "pnpm", '"a string"', [])).toBeUndefined()
  })
})

describe("checkKey, existsArgv and missingPath", () => {
  it("keys a run by sha, name and paths", () => {
    expect(checkKey("abc", "test", ["a", "b"])).toBe("abc:test:a b")
    expect(checkKey("abc", "lint", [])).toBe("abc:lint:")
  })

  it("probes the paths in the repository and reads back the first missing one", () => {
    const argv = existsArgv(["a.ts", "b.ts"])
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"])
    expect(argv.slice(3)).toEqual(["andabot-exists", "a.ts", "b.ts"])
    expect(argv[2]).toContain('[ -e "$p" ]')
    expect(missingPath(exited(1, "b.ts\n"))).toBe("b.ts")
    expect(missingPath(exited(0, ""))).toBeUndefined()
    expect(missingPath(timedOut)).toBeUndefined()
  })
})

describe("checkText and refusalText", () => {
  it("heads the tail with the exit code and the seconds, and notes a cut", () => {
    expect(checkText({ name: "test", paths: ["a"], outcome: exited(1, "FAIL a\n"), ms: 2_400 })).toBe(
      "test exited 1 in 2.4s\n\nFAIL a\n",
    )
    expect(checkText({ name: "lint", paths: [], outcome: exited(0, "", false), ms: 1300 })).toBe(
      "lint exited 0 in 1.3s\n\n(no output)",
    )
    expect(checkText({ name: "lint", paths: [], outcome: exited(0, "", false), ms: 450 })).toBe(
      "lint exited 0 in 450 ms\n\n(no output)",
    )
    expect(checkText({ name: "test", paths: [], outcome: exited(0, "x", true), ms: 1000 })).toContain(
      "(output cut to its last 8 KiB)",
    )
    expect(checkText({ name: "test", paths: [], outcome: timedOut, ms: 300_000 })).toBe(
      "test timed out after 300s\n\n(no output)",
    )
  })

  it("says why a check didn't run", () => {
    expect(refusalText("test", { kind: "off" })).toBe("The sandbox is off for this repository, so test did not run.")
    expect(refusalText("test", { kind: "spent", seconds: 900, budget: 900 })).toContain("900")
    expect(refusalText("lint", { kind: "unavailable", reason: "install" })).toContain("install")
    expect(refusalText("lint", { kind: "no_command" })).toContain("no lint command")
    expect(refusalText("test", { kind: "bad_path", problem: "a b" })).toContain("a b")
    expect(refusalText("test", { kind: "missing_path", path: "x.ts" })).toContain("x.ts")
  })
})

describe("CHECK_ENV", () => {
  it("turns colour off and says it's CI", () => {
    expect(CHECK_ENV).toEqual({ NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" })
  })
})

describe("checkRecordOf", () => {
  it("keeps what the summary and the record need, with the exit code only for a run that exited", () => {
    expect(checkRecordOf({ name: "test", paths: ["a.ts"], outcome: exited(1, "FAIL\n"), ms: 2_400 })).toEqual({
      name: "test",
      paths: ["a.ts"],
      outcome: "exited",
      exitCode: 1,
      ms: 2_400,
      tail: "FAIL\n",
    })
    expect(checkRecordOf({ name: "lint", paths: [], outcome: timedOut, ms: 300_000 })).toEqual({
      name: "lint",
      paths: [],
      outcome: "timeout",
      ms: 300_000,
      tail: "",
    })
  })
})

describe("accessRefusal and knownChecksOf", () => {
  it("turns a sandbox access that isn't ready into the tool's refusal", () => {
    expect(accessRefusal({ kind: "off" })).toEqual({ kind: "off" })
    expect(accessRefusal({ kind: "spent", seconds: 901, budget: 900 })).toEqual({
      kind: "spent",
      seconds: 901,
      budget: 900,
    })
    expect(accessRefusal({ kind: "unavailable", reason: "install" })).toEqual({
      kind: "unavailable",
      reason: "install",
    })
  })

  it("maps the head's exited runs to the keys a finding's check uses, leaving other heads and timeouts out", () => {
    const runs = new Map([
      [checkKey("abc", "test", ["a.ts"]), { name: "test", paths: ["a.ts"], outcome: exited(1, ""), ms: 1 }],
      [checkKey("abc", "lint", []), { name: "lint", paths: [], outcome: timedOut, ms: 1 }],
      [checkKey("old", "test", ["a.ts"]), { name: "test", paths: ["a.ts"], outcome: exited(0, ""), ms: 1 }],
    ] as const)
    expect(knownChecksOf(runs, "abc")).toEqual(new Map([["test:a.ts", 1]]))
  })
})
