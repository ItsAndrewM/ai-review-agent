import { describe, expect, it } from "vitest"
import { RecallTools, type RecallSource } from "../tools/recall/tools.ts"

const source: RecallSource = {
  readFile: async ({ path, ref }) => `read ${path} at ${ref ?? "head"}`,
  grep: async ({ pattern }) => `grep ${pattern}`,
  tree: async ({ path }) => `tree ${path ?? "."}`,
  changedFilesText: async () => "modified  +1 -0  src/a.ts",
  issue: (number) => `#${number}: frozen`,
}

const submission = {
  summary: "s",
  walkthrough: [{ path: "src/a.ts", summary: "changed" }],
  findings: [],
  verdict: "approve",
  merge_danger: { door: "two-way", blast_radius: "none" },
}

describe("RecallTools", () => {
  it("offers production's eight tools in production's order", () => {
    const tools = new RecallTools(source, async () => ({ text: "posted", done: true }))
    expect(tools.descriptions().map(({ name }) => name)).toEqual([
      "read_file",
      "list_changed_files",
      "get_issue",
      "grep",
      "tree",
      "run_check",
      "resolve_thread",
      "submit_review",
    ])
    expect(
      tools.descriptions().every(({ description, parameters }) => description !== "" && parameters !== undefined),
    ).toBe(true)
  })

  it("serves the reading tools from the source", async () => {
    const tools = new RecallTools(source, async () => ({ text: "posted", done: true }))
    expect(await tools.execute("read_file", { path: "src/a.ts", ref: "base" })).toEqual({
      text: "read src/a.ts at base",
      done: false,
    })
    expect((await tools.execute("grep", { pattern: "foo" })).text).toBe("grep foo")
    expect((await tools.execute("tree", { path: "src" })).text).toBe("tree src")
    expect((await tools.execute("list_changed_files", {})).text).toBe("modified  +1 -0  src/a.ts")
    expect((await tools.execute("get_issue", { number: 50 })).text).toBe("#50: frozen")
  })

  it("answers run_check as the tier being off, and resolve_thread as not answering", async () => {
    const tools = new RecallTools(source, async () => ({ text: "posted", done: true }))
    expect((await tools.execute("run_check", { name: "test", paths: ["test/a.test.ts"] })).text).toBe(
      "The sandbox is off for this repository, so test did not run.",
    )
    expect((await tools.execute("resolve_thread", { reason: "fixed", evidence: "src/a.ts:1" })).text).toBe(
      "Not resolved: resolve_thread acts only while answering a reply in one of my threads; a review lists fixed threads in addressed_threads.",
    )
  })

  it("validates submit_review's arguments and passes a valid submission on", async () => {
    const submitted: string[] = []
    const tools = new RecallTools(source, async (given) => {
      submitted.push(given.verdict)
      return { text: "Posted review 1.", done: true }
    })
    const refused = await tools.execute("submit_review", { summary: "no walkthrough" })
    expect(refused.text).toContain('Validation failed for tool "submit_review":')
    expect(refused.done).toBe(false)
    expect(await tools.execute("submit_review", submission)).toEqual({ text: "Posted review 1.", done: true })
    expect(submitted).toEqual(["approve"])
  })

  it("answers bad arguments with pi-ai's validation message, as the harness does, and refuses unknown tools", async () => {
    const tools = new RecallTools(source, async () => ({ text: "posted", done: true }))
    const read = await tools.execute("read_file", { ref: "head" })
    expect(read.text).toContain('Validation failed for tool "read_file":')
    expect(read.text).toContain("path")
    expect(read.isError).toBe(true)
    const submitted = await tools.execute("submit_review", {
      ...submission,
      findings: [
        { line: 1, quote: "q", severity: "blocking", basis_kind: "defect", basis: "b", title: "t", body: "b" },
      ],
    })
    expect(submitted.text).toContain('Validation failed for tool "submit_review":')
    expect(submitted.text).toContain("findings.0.path")
    expect(submitted.done).toBe(false)
    expect((await tools.execute("nothing", {})).text).toBe("Unknown review tool: nothing")
  })

  it("coerces a numeric string the way the harness does", async () => {
    const tools = new RecallTools(source, async () => ({ text: "posted", done: true }))
    expect((await tools.execute("get_issue", { number: "50" })).text).toBe("#50: frozen")
  })
})
