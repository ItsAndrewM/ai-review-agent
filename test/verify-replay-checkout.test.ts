import { describe, expect, it } from "vitest"
import { replayContexts, replaySource } from "../tools/verify-replay/checkout.ts"
import { labelled } from "./verify-replay-fixtures.ts"

describe("replayContexts", () => {
  it("reads a LEFT finding at the base and a RIGHT finding at the head, with issue only on spec", async () => {
    const right = labelled("1", "keep")
    const left = labelled("2", "keep", { side: "LEFT", basis_kind: "spec" })
    const refs: string[] = []
    const files = {
      read: async (sha: string, path: string) => {
        refs.push(`${sha}:${path}`)
        return sha === right.head ? "head line" : "base line"
      },
      diff: async () =>
        "diff --git a/src/example.ts b/src/example.ts\nindex 123..456\n@@ -1,1 +1,1 @@\n-base line\n+head line",
      paths: async () => ["src/example.ts"],
    }
    const contexts = await replayContexts([right, { ...left, issue: "#50: Required one decimal" }], files)
    expect(refs).toEqual([`${right.head}:src/example.ts`, `${left.base}:src/example.ts`])
    expect(contexts.map(({ window }) => window)).toEqual(["    1 | head line", "    1 | base line"])
    expect(contexts.map(({ issue }) => issue)).toEqual([undefined, "#50: Required one decimal"])
    expect(contexts.map(({ patch }) => patch)).toEqual([
      "@@ -1,1 +1,1 @@\n-base line\n+head line",
      "@@ -1,1 +1,1 @@\n-base line\n+head line",
    ])
  })

  it("serves grep and tree over the historical head rather than this working tree", async () => {
    const files = {
      read: async (_sha: string, path: string) => (path === "src/example.ts" ? "legacyFunction()" : undefined),
      diff: async () => "",
      paths: async () => ["src/example.ts", "src/missing.ts"],
    }
    const source = await replaySource("a".repeat(40), "b".repeat(40), files)
    expect(await source.grep({ pattern: "legacyFunction" })).toContain("src/example.ts:1: legacyFunction()")
    expect(await source.tree({ path: "src" })).toContain("src/example.ts")
    expect(await source.readFile({ path: "src/example.ts" })).toBe("    1 | legacyFunction()")
    expect(await source.readFile({ path: "src/missing.ts" })).toContain("does not exist at head")
  })
})
