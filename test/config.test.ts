import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { GitHubClient } from "../src/github/client.ts"
import { AndabotConfig, DEFAULT_CONFIG, parseConfig, readConfig } from "../src/repository/config.ts"

const ref = { owner: "o", repo: "r" }
const BASE = "ba5e5".repeat(8)
const CONFIG_PATH = `/repos/o/r/contents/.andabot.yaml?ref=${BASE}`

const FULL_FILE = [
  "reviews:",
  "  auto: false",
  "  drafts: true",
  "  base_branches:",
  "    - main",
  "    - release/*",
  "  ignore_title_keywords:",
  "    - WIP",
  "    - '[skip review]'",
  "  request_changes_workflow: true",
  "  path_filters:",
  "    - '!**/*.snap'",
  "    - '!pnpm-lock.yaml'",
  "  path_instructions:",
  "    - path: 'apps/web/**'",
  "      instructions: Use the design tokens, not raw colors.",
  "    - path: '**/*.sql'",
  "      instructions: |",
  "        A migration must be reversible.",
  "        Name the rollback.",
  "model:",
  "  name: glm-5.3-flash",
  "",
].join("\n")

const FULL_CONFIG = {
  reviews: {
    auto: false,
    drafts: true,
    base_branches: ["main", "release/*"],
    ignore_title_keywords: ["WIP", "[skip review]"],
    request_changes_workflow: true,
    path_filters: ["!**/*.snap", "!pnpm-lock.yaml"],
    path_instructions: [
      { path: "apps/web/**", instructions: "Use the design tokens, not raw colors." },
      { path: "**/*.sql", instructions: "A migration must be reversible.\nName the rollback.\n" },
    ],
  },
} satisfies AndabotConfig

const LITERAL_DEFAULTS = {
  reviews: {
    auto: true,
    drafts: false,
    base_branches: [],
    ignore_title_keywords: [],
    path_filters: [],
    path_instructions: [],
  },
}

function fakeGitHub(respond: () => Response) {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const { pathname, search } = new URL(String(input))
    calls.push(`${pathname}${search}`)
    return respond()
  }
  return { github: new GitHubClient("t", "https://api.example", fetchImpl), calls }
}

function recorder() {
  const reported: string[] = []
  const report = (error: string): void => {
    reported.push(error)
  }
  return { report, reported }
}

const failOnUnreadable = (error: string): void => {
  throw new Error(`reported unreadable: ${error}`)
}

const served = (body: string) => () => new Response(body, { status: 200 })

describe("DEFAULT_CONFIG", () => {
  it("reviews on every push, waits on drafts, restricts no base branch, ignores no title, filters no path and adds no instructions", () => {
    expect(DEFAULT_CONFIG).toEqual(LITERAL_DEFAULTS)
  })

  it("leaves request_changes_workflow unset, which means the Worker var applies", () => {
    expect(DEFAULT_CONFIG.reviews.request_changes_workflow).toBeUndefined()
  })
})

describe("AndabotConfig", () => {
  it("accepts the defaults and a parsed full file, so a stored config can be checked on its way back in", () => {
    expect(Value.Check(AndabotConfig, DEFAULT_CONFIG)).toBe(true)
    expect(Value.Check(AndabotConfig, parseConfig(FULL_FILE).config)).toBe(true)
  })

  it("is the complete config, refusing one that lacks a setting or carries an unknown one", () => {
    expect(Value.Check(AndabotConfig, { reviews: { auto: true } })).toBe(false)
    expect(Value.Check(AndabotConfig, { reviews: { ...LITERAL_DEFAULTS.reviews, mode: "strict" } })).toBe(false)
    expect(Value.Check(AndabotConfig, {})).toBe(false)
  })
})

describe("parseConfig", () => {
  it.each([
    ["an empty file", ""],
    ["a file of only comments", "# nothing set yet\n"],
    ["an empty document", "---\n"],
    ["an empty reviews mapping", "reviews: {}\n"],
    ["a model alone", "model: {}\n"],
  ])("gives the defaults and no error for %s", (_name, text) => {
    expect(parseConfig(text)).toEqual({ config: LITERAL_DEFAULTS, error: undefined })
  })

  it("reads every setting of a full file and drops model from the config", () => {
    expect(parseConfig(FULL_FILE)).toEqual({ config: FULL_CONFIG, error: undefined })
  })

  it("fills in the defaults for the settings a file leaves out", () => {
    const text = "reviews:\n  drafts: true\n  path_filters:\n    - '!**/*.snap'\n"
    expect(parseConfig(text)).toEqual({
      config: {
        reviews: {
          auto: true,
          drafts: true,
          base_branches: [],
          ignore_title_keywords: [],
          path_filters: ["!**/*.snap"],
          path_instructions: [],
        },
      },
      error: undefined,
    })
  })

  it("keeps request_changes_workflow: false as an override, and leaves it unset when the file says nothing", () => {
    const overridden = parseConfig("reviews:\n  request_changes_workflow: false\n")
    expect(overridden.config.reviews.request_changes_workflow).toBe(false)
    expect(parseConfig("reviews:\n  auto: false\n").config.reviews.request_changes_workflow).toBeUndefined()
  })

  it("accepts any mapping under model and ignores it", () => {
    const text = "model:\n  name: glm-5.3-flash\n  options:\n    temperature: 0.2\n    stops: [a, b]\n"
    expect(parseConfig(text)).toEqual({ config: LITERAL_DEFAULTS, error: undefined })
  })

  it("gives the defaults and an error naming reviews/auto for a boolean written as a string", () => {
    expect(parseConfig('reviews:\n  auto: "yes"\n')).toEqual({
      config: LITERAL_DEFAULTS,
      error: "/reviews/auto must be boolean",
    })
  })

  it("reads YAML 1.2, where an unquoted yes is the string and not a boolean", () => {
    expect(parseConfig("reviews:\n  drafts: yes\n").error).toBe("/reviews/drafts must be boolean")
  })

  it("applies none of an invalid file, though some of its settings are valid", () => {
    const { config, error } = parseConfig(
      "reviews:\n  auto: false\n  drafts: soon\n  path_filters:\n    - '!**/*.snap'\n",
    )
    expect(error).toBe("/reviews/drafts must be boolean")
    expect(config).toEqual(LITERAL_DEFAULTS)
  })

  it.each([
    ["an unknown key under reviews", "reviews:\n  draft: true\n", "/reviews/draft schema is false"],
    ["an unknown top-level key", "reveiws:\n  auto: false\n", "/reveiws schema is false"],
    ["an unknown key beside valid ones", "reviews:\n  auto: false\n  mode: strict\n", "/reviews/mode schema is false"],
    ["a model that is not a mapping", "model: glm-5.3-flash\n", "/model must be object"],
    ["a model that is a list", "model:\n  - glm\n", "/model must be object"],
    ["a reviews that is not a mapping", "reviews: always\n", "/reviews must be object"],
    ["a base_branches that is not a list", "reviews:\n  base_branches: main\n", "/reviews/base_branches must be array"],
    [
      "a base_branches entry that is not a string",
      "reviews:\n  base_branches:\n    - main\n    - 3.10\n",
      "/reviews/base_branches/1 must be string",
    ],
    [
      "an ignore_title_keywords entry that is not a string",
      "reviews:\n  ignore_title_keywords:\n    - WIP\n    - 2024\n",
      "/reviews/ignore_title_keywords/1 must be string",
    ],
    [
      "a request_changes_workflow that is not a boolean",
      "reviews:\n  request_changes_workflow: sometimes\n",
      "/reviews/request_changes_workflow must be boolean",
    ],
    [
      "a path_filters entry without the leading !",
      "reviews:\n  path_filters:\n    - '!**/*.snap'\n    - pnpm-lock.yaml\n",
      '/reviews/path_filters/1 must match pattern "^!"',
    ],
    [
      "a path_instructions entry with an empty path",
      "reviews:\n  path_instructions:\n    - path: ''\n      instructions: Be kind.\n",
      "/reviews/path_instructions/0/path must not have fewer than 1 characters",
    ],
    [
      "a path_instructions entry with empty instructions",
      "reviews:\n  path_instructions:\n    - path: 'docs/**'\n      instructions: ''\n",
      "/reviews/path_instructions/0/instructions must not have fewer than 1 characters",
    ],
    [
      "a path_instructions entry without instructions",
      "reviews:\n  path_instructions:\n    - path: 'docs/**'\n",
      "/reviews/path_instructions/0 must have required properties instructions",
    ],
    [
      "a path_instructions entry without a path",
      "reviews:\n  path_instructions:\n    - instructions: Be kind.\n",
      "/reviews/path_instructions/0 must have required properties path",
    ],
  ])("gives the defaults and names the first problem, for %s", (_name, text, error) => {
    expect(parseConfig(text)).toEqual({ config: LITERAL_DEFAULTS, error })
  })

  it.each([
    ["a list", "- reviews\n- model\n"],
    ["a scalar", "just some words\n"],
    ["a number", "5\n"],
  ])("names the document itself as the problem when it is %s and not a mapping", (_name, text) => {
    expect(parseConfig(text)).toEqual({ config: LITERAL_DEFAULTS, error: "/ must be object" })
  })

  it("gives the defaults and the first line of the YAML error, with its location and without its code frame", () => {
    const { config, error } = parseConfig("reviews:\n  auto: true\n  auto: false\n")
    expect(config).toEqual(LITERAL_DEFAULTS)
    expect(error).toBe("invalid YAML: Map keys must be unique at line 3, column 3")
  })

  it.each([
    ["an unterminated flow mapping", "reviews: {auto: false\n"],
    ["a tab for indentation", "reviews:\n\tauto: false\n"],
    ["two documents", "reviews: {}\n---\nmodel: {}\n"],
    ["an alias with no anchor", "reviews: *missing\n"],
  ])("reports %s as one line starting with invalid YAML", (_name, text) => {
    const { config, error } = parseConfig(text)
    expect(config).toEqual(LITERAL_DEFAULTS)
    expect(error).toMatch(/^invalid YAML: [^\n]+$/)
  })

  it("hands each caller its own copy of the defaults, so changing one leaves them alone", () => {
    parseConfig("").config.reviews.path_filters.push("!first")
    parseConfig("reviews: always\n").config.reviews.base_branches.push("first")
    expect(parseConfig("").config).toEqual(LITERAL_DEFAULTS)
    expect(DEFAULT_CONFIG).toEqual(LITERAL_DEFAULTS)
  })
})

describe("readConfig", () => {
  it("is the defaults, absent and without an error, when the base commit has no .andabot.yaml", async () => {
    const { github, calls } = fakeGitHub(() => new Response('{"message":"Not Found"}', { status: 404 }))
    expect(await readConfig(github, ref, BASE, failOnUnreadable)).toEqual({
      config: LITERAL_DEFAULTS,
      error: undefined,
      present: false,
    })
    expect(calls).toEqual([CONFIG_PATH])
  })

  it("reads the one file at the base commit and parses it", async () => {
    const { github, calls } = fakeGitHub(served(FULL_FILE))
    expect(await readConfig(github, ref, BASE, failOnUnreadable)).toEqual({
      config: FULL_CONFIG,
      error: undefined,
      present: true,
    })
    expect(calls).toEqual([CONFIG_PATH])
  })

  it("counts an empty file as present, with the defaults and no error", async () => {
    const { github } = fakeGitHub(served(""))
    expect(await readConfig(github, ref, BASE, failOnUnreadable)).toEqual({
      config: LITERAL_DEFAULTS,
      error: undefined,
      present: true,
    })
  })

  it("gives the defaults and the parse error for an invalid file, which is present and not unreadable", async () => {
    const { report, reported } = recorder()
    const { github } = fakeGitHub(served('reviews:\n  auto: "yes"\n'))
    expect(await readConfig(github, ref, BASE, report)).toEqual({
      config: LITERAL_DEFAULTS,
      error: "/reviews/auto must be boolean",
      present: true,
    })
    expect(reported).toEqual([])
  })

  it.each<[number, string]>([
    [403, "Error: GitHub 403 : forbidden"],
    [500, "Error: GitHub 500 : forbidden"],
    [502, "Error: GitHub 502 : forbidden"],
  ])("reports a %s as unreadable and reviews with the defaults and the error text", async (status, error) => {
    const { report, reported } = recorder()
    const { github } = fakeGitHub(() => new Response("forbidden", { status }))
    expect(await readConfig(github, ref, BASE, report)).toEqual({ config: LITERAL_DEFAULTS, error, present: false })
    expect(reported).toEqual([error])
  })

  it("reports a failed request as unreadable the same way", async () => {
    const { report, reported } = recorder()
    const { github } = fakeGitHub(() => {
      throw new TypeError("fetch failed")
    })
    expect(await readConfig(github, ref, BASE, report)).toEqual({
      config: LITERAL_DEFAULTS,
      error: "TypeError: fetch failed",
      present: false,
    })
    expect(reported).toEqual(["TypeError: fetch failed"])
  })

  it("hands out copies of the defaults whether the file is missing or unreadable", async () => {
    const missing = fakeGitHub(() => new Response("", { status: 404 }))
    const broken = fakeGitHub(() => new Response("boom", { status: 502 }))
    const absent = await readConfig(missing.github, ref, BASE, failOnUnreadable)
    const unreadable = await readConfig(broken.github, ref, BASE, recorder().report)
    absent.config.reviews.path_filters.push("!first")
    unreadable.config.reviews.base_branches.push("first")
    expect(DEFAULT_CONFIG).toEqual(LITERAL_DEFAULTS)
    expect((await readConfig(missing.github, ref, BASE, failOnUnreadable)).config).toEqual(LITERAL_DEFAULTS)
  })
})
