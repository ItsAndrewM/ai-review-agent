import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { lintProbes, ROOT, VENDORED_PLUGIN, type Diagnostic } from "./probes.ts"

const REPO_WIDE_RULES = [
  "anti-slop(require-safety-comment-for-type-assertion)",
  "eslint(complexity)",
  "eslint(no-debugger)",
  "gamesheet(no-comments)",
]

const PROBE_SOURCE = `// an inline comment
export const unchecked = (input: string) => input as never
export const branchy = (n: number) => ${Array.from({ length: 50 }, (_, i) => `n === ${i}`).join(" || ")}
export const pause = () => {
  debugger
}
`

const listFiles = (...pathspecs: string[]) => {
  const run = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...pathspecs], {
    cwd: ROOT,
    encoding: "utf8",
  })
  if (run.status !== 0) throw new Error(`git ls-files failed: ${run.error?.message ?? run.stderr}`)
  return run.stdout.split("\n").filter((file) => file !== "")
}

const PROBES = [...new Set(listFiles("*.ts", "*.mjs").map((file) => dirname(file)))]
  .filter((dir) => !dir.startsWith(VENDORED_PLUGIN))
  .map((dir) => ({ dir, path: join(dir, "coverage-probe.ts"), source: PROBE_SOURCE }))

describe("one root lint config for the whole repo", () => {
  let diagnostics: ReadonlyArray<Diagnostic>
  beforeAll(() => {
    diagnostics = lintProbes(PROBES)
  })

  it.each(PROBES)("lints $dir with the repo-wide rules", ({ path }) => {
    const codes = diagnostics.filter((d) => d.filename === path).map((d) => d.code)
    expect(codes).toEqual(expect.arrayContaining(REPO_WIDE_RULES))
  })

  it("has no nested oxlint or oxfmt config to replace the root one in a folder", () => {
    const configs = listFiles("*oxlint.config.*", "*.oxlintrc*", "*oxfmt.config.*", "*.oxfmtrc*")
    expect(configs.filter((file) => file.includes("/"))).toEqual([])
  })
})
