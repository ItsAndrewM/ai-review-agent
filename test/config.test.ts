import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { GitHubClient } from "../src/github/client.ts"
import {
  AndabotConfig,
  CONFIG_FILE,
  CONFIG_PREFIX,
  configKey,
  configReadOf,
  configStatus,
  DEFAULT_CONFIG,
  isCacheable,
  parseConfig,
  pullRequestFacts,
  readConfig,
  requestChangesWorkflow,
  reviewTrigger,
  runSettings,
  shouldReview,
  staleConfigKeys,
  StoredConfig,
  storedConfig,
  verifyModelFor,
  type ConfigRead,
} from "../src/repository/config.ts"

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
  "  verify: false",
  "  sandbox: false",
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
  "  verify: '@cf/x/y'",
  "checks:",
  "  lint: pnpm oxlint {paths}",
  "  typecheck: pnpm tsc --noEmit",
  "  test: pnpm vitest run {paths}",
  "",
].join("\n")

const FULL_CONFIG = {
  reviews: {
    auto: false,
    drafts: true,
    base_branches: ["main", "release/*"],
    ignore_title_keywords: ["WIP", "[skip review]"],
    request_changes_workflow: true,
    verify: false,
    sandbox: false,
    path_filters: ["!**/*.snap", "!pnpm-lock.yaml"],
    path_instructions: [
      { path: "apps/web/**", instructions: "Use the design tokens, not raw colors." },
      { path: "**/*.sql", instructions: "A migration must be reversible.\nName the rollback.\n" },
    ],
  },
  model: { verify: "@cf/x/y" },
  checks: { lint: "pnpm oxlint {paths}", typecheck: "pnpm tsc --noEmit", test: "pnpm vitest run {paths}" },
} satisfies AndabotConfig

const LITERAL_DEFAULTS = {
  reviews: {
    auto: true,
    drafts: false,
    base_branches: [],
    ignore_title_keywords: [],
    verify: true,
    sandbox: true,
    path_filters: [],
    path_instructions: [],
  },
}

const BEFORE_VERIFY_REVIEWS = {
  auto: true,
  drafts: false,
  base_branches: [],
  ignore_title_keywords: [],
  path_filters: [],
  path_instructions: [],
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
  it("reviews on every push, waits on drafts, restricts no base branch, ignores no title, filters no path, adds no instructions, verifies and allows the sandbox", () => {
    expect(DEFAULT_CONFIG).toEqual(LITERAL_DEFAULTS)
  })

  it("leaves request_changes_workflow unset, which means the Worker var applies", () => {
    expect(DEFAULT_CONFIG.reviews.request_changes_workflow).toBeUndefined()
  })

  it("names no verify model, which means the Worker var applies", () => {
    expect(DEFAULT_CONFIG.model).toBeUndefined()
  })

  it("names no checks, which means run_check falls back to the runners package.json names", () => {
    expect(DEFAULT_CONFIG.checks).toBeUndefined()
  })
})

describe("checks", () => {
  it("refuses a check it doesn't know and an empty template, applying the defaults", () => {
    expect(parseConfig("checks:\n  build: pnpm build\n").error).toContain("build")
    expect(parseConfig("checks:\n  lint: ''\n").error).toBeDefined()
    expect(parseConfig("checks:\n  lint: ''\n").config.checks).toBeUndefined()
  })

  it("reads a partial map", () => {
    expect(parseConfig("checks:\n  test: pnpm vitest run {paths}\n").config.checks).toEqual({
      test: "pnpm vitest run {paths}",
    })
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

  it("refuses a config from before reviews.verify existed, so a record cached then reads as a miss", () => {
    expect(Value.Check(AndabotConfig, { reviews: BEFORE_VERIFY_REVIEWS })).toBe(false)
  })

  it("takes a verify model, and refuses one that is not a non-empty string", () => {
    expect(Value.Check(AndabotConfig, { ...LITERAL_DEFAULTS, model: { verify: "@cf/x/y" } })).toBe(true)
    expect(Value.Check(AndabotConfig, { ...LITERAL_DEFAULTS, model: {} })).toBe(true)
    expect(Value.Check(AndabotConfig, { ...LITERAL_DEFAULTS, model: { verify: 3 } })).toBe(false)
    expect(Value.Check(AndabotConfig, { ...LITERAL_DEFAULTS, model: { verify: "" } })).toBe(false)
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

  it("reads every setting of a full file, carrying model.verify and dropping the rest of model", () => {
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
          verify: true,
          sandbox: true,
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

  it("keeps reviews.verify: false as the repository's switch off, and leaves verify on when the file says nothing", () => {
    expect(parseConfig("reviews:\n  verify: false\n").config.reviews.verify).toBe(false)
    expect(parseConfig("reviews:\n  verify: true\n").config.reviews.verify).toBe(true)
    expect(parseConfig("reviews:\n  auto: false\n").config.reviews.verify).toBe(true)
    expect(DEFAULT_CONFIG.reviews.verify).toBe(true)
  })

  it("reads model.verify as the repository's verify model", () => {
    expect(parseConfig('model:\n  verify: "@cf/x/y"\n')).toEqual({
      config: { ...LITERAL_DEFAULTS, model: { verify: "@cf/x/y" } },
      error: undefined,
    })
  })

  it("leaves the verify model unset for a model that names none, as model.draft does", () => {
    const parsed = parseConfig('model:\n  draft: "@cf/a"\n')
    expect(parsed.error).toBeUndefined()
    expect(parsed.config.model?.verify).toBeUndefined()
    expect(parsed).toStrictEqual({ config: LITERAL_DEFAULTS, error: undefined })
  })

  it("accepts any other mapping under model and ignores it", () => {
    const text = "model:\n  name: glm-5.3-flash\n  options:\n    temperature: 0.2\n    stops: [a, b]\n"
    expect(parseConfig(text)).toStrictEqual({ config: LITERAL_DEFAULTS, error: undefined })
  })

  it("carries model.verify and nothing else of model, beside the other keys", () => {
    const text = 'model:\n  name: glm-5.3-flash\n  verify: "@cf/x/y"\n  options:\n    temperature: 0.2\n'
    expect(parseConfig(text).config.model).toStrictEqual({ verify: "@cf/x/y" })
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
    ["a model key with nothing under it", "model:\n", "/model must be object"],
    ["a reviews that is not a mapping", "reviews: always\n", "/reviews must be object"],
    ["a reviews key with nothing under it", "reviews:\n", "/reviews must be object"],
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
    ["a reviews verify that is not a boolean", "reviews:\n  verify: sometimes\n", "/reviews/verify must be boolean"],
    ["a model verify that is not a string", "model:\n  verify: 3\n", "/model/verify must be string"],
    ["a model verify that is empty", "model:\n  verify: ''\n", "/model/verify must not have fewer than 1 characters"],
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
    [
      "a path_instructions entry with an unknown key",
      "reviews:\n  path_instructions:\n    - path: 'docs/**'\n      instructions: Be kind.\n      severity: high\n",
      "/reviews/path_instructions/0/severity schema is false",
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
    [403, "GitHubError: GitHub 403 : forbidden"],
    [500, "GitHubError: GitHub 500 : forbidden"],
    [502, "GitHubError: GitHub 502 : forbidden"],
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
      error: `GitHubError: GitHub /repos/o/r/contents/.andabot.yaml?ref=${BASE}: TypeError: fetch failed`,
      present: false,
    })
    expect(reported).toEqual([
      `GitHubError: GitHub /repos/o/r/contents/.andabot.yaml?ref=${BASE}: TypeError: fetch failed`,
    ])
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

  it("reads the one file name the standards' labels use too", () => {
    expect(CONFIG_FILE).toBe(".andabot.yaml")
  })
})

const OTHER_BASE = "0".repeat(40)

const MISSING: ConfigRead = { config: LITERAL_DEFAULTS, error: undefined, present: false }
const VALID: ConfigRead = { config: FULL_CONFIG, error: undefined, present: true }
const INVALID: ConfigRead = { config: LITERAL_DEFAULTS, error: "/reviews/auto must be boolean", present: true }
const UNREADABLE: ConfigRead = { config: LITERAL_DEFAULTS, error: "Error: GitHub 502 : boom", present: false }

const READY = { draft: false, baseRef: "main", title: "Read the config at the base" }

const withReviews = (reviews: Partial<AndabotConfig["reviews"]>): AndabotConfig => ({
  reviews: { ...LITERAL_DEFAULTS.reviews, ...reviews },
})

const NAMES_A_VERIFY_MODEL: AndabotConfig = { ...LITERAL_DEFAULTS, model: { verify: "k" } }

const OPTS_OUT_OF_VERIFY: AndabotConfig = withReviews({ verify: false })

describe("shouldReview", () => {
  const draft = { ...READY, draft: true }

  it("reviews a push on a ready pull request under the defaults", () => {
    expect(shouldReview(LITERAL_DEFAULTS, READY, "push")).toEqual({ review: true })
  })

  it("starts no review on a push when auto is false, and still reviews on a command", () => {
    const manual = withReviews({ auto: false })
    expect(shouldReview(manual, READY, "push")).toEqual({ review: false, reason: "auto" })
    expect(shouldReview(manual, READY, "command")).toEqual({ review: true })
  })

  it("waits on a draft by default, reviews one when drafts is true, and reviews one on a command either way", () => {
    expect(shouldReview(LITERAL_DEFAULTS, draft, "push")).toEqual({ review: false, reason: "draft" })
    expect(shouldReview(withReviews({ drafts: true }), draft, "push")).toEqual({ review: true })
    expect(shouldReview(LITERAL_DEFAULTS, draft, "command")).toEqual({ review: true })
  })

  it("reviews only pull requests against a listed base branch, matching its name exactly rather than as a glob", () => {
    const listed = withReviews({ base_branches: ["main", "release/*"] })
    expect(shouldReview(listed, READY, "push")).toEqual({ review: true })
    expect(shouldReview(listed, { ...READY, baseRef: "release/*" }, "push")).toEqual({ review: true })
    for (const baseRef of ["develop", "release/1.0", "Main"]) {
      expect(shouldReview(listed, { ...READY, baseRef }, "push")).toEqual({ review: false, reason: "base_branch" })
    }
    expect(shouldReview(listed, { ...READY, baseRef: "develop" }, "command")).toEqual({ review: true })
  })

  it("reviews against any base branch when the list is empty", () => {
    expect(shouldReview(LITERAL_DEFAULTS, { ...READY, baseRef: "develop" }, "push")).toEqual({ review: true })
  })

  it("skips a title that holds an ignored keyword anywhere, ignoring case and the keyword's surrounding spaces", () => {
    const ignoring = withReviews({ ignore_title_keywords: ["WIP", " [skip review] "] })
    for (const title of ["WIP: read the config", "wip read the config", "Read it [Skip Review]", "Wipe the cache"]) {
      expect(shouldReview(ignoring, { ...READY, title }, "push")).toEqual({ review: false, reason: "title_keyword" })
    }
    expect(shouldReview(ignoring, READY, "push")).toEqual({ review: true })
    expect(shouldReview(ignoring, { ...READY, title: "WIP" }, "command")).toEqual({ review: true })
  })

  it("matches no title with an empty or blank keyword", () => {
    expect(shouldReview(withReviews({ ignore_title_keywords: [""] }), READY, "push")).toEqual({ review: true })
    expect(shouldReview(withReviews({ ignore_title_keywords: ["  ", "\t"] }), READY, "push")).toEqual({ review: true })
    const mixed = withReviews({ ignore_title_keywords: ["", "WIP"] })
    expect(shouldReview(mixed, { ...READY, title: "WIP: x" }, "push")).toEqual({
      review: false,
      reason: "title_keyword",
    })
  })

  it("checks auto, then drafts, then the base branch, then the title, and names the first that skips", () => {
    const strict = withReviews({ drafts: false, base_branches: ["main"], ignore_title_keywords: ["WIP"] })
    const manual = { reviews: { ...strict.reviews, auto: false } }
    const everything = { draft: true, baseRef: "develop", title: "WIP: x" }
    expect(shouldReview(manual, everything, "push")).toEqual({ review: false, reason: "auto" })
    expect(shouldReview(strict, everything, "push")).toEqual({ review: false, reason: "draft" })
    expect(shouldReview(strict, { ...everything, draft: false }, "push")).toEqual({
      review: false,
      reason: "base_branch",
    })
    expect(shouldReview(strict, { ...everything, draft: false, baseRef: "main" }, "push")).toEqual({
      review: false,
      reason: "title_keyword",
    })
  })

  it("lets a command through every setting at once", () => {
    const closed = withReviews({ auto: false, base_branches: ["main"], ignore_title_keywords: ["WIP"] })
    expect(shouldReview(closed, { draft: true, baseRef: "develop", title: "WIP: x" }, "command")).toEqual({
      review: true,
    })
  })
})

describe("reviewTrigger", () => {
  it("calls a review nobody asked for a push", () => {
    expect(reviewTrigger({ full: false })).toBe("push")
  })

  it("calls a review someone asked for a command: @andabot review, full review, or a check re-run", () => {
    expect(reviewTrigger({ full: false, requestedBy: "andrew" })).toBe("command")
    expect(reviewTrigger({ full: true, requestedBy: "andrew" })).toBe("command")
    expect(reviewTrigger({ full: true })).toBe("command")
  })
})

describe("pullRequestFacts", () => {
  it("takes the draft flag, the base branch's name and the title, and reads a missing draft flag as ready", () => {
    const pr = { title: "Read the config", base: { ref: "main", sha: BASE }, draft: true }
    expect(pullRequestFacts(pr)).toEqual({ draft: true, baseRef: "main", title: "Read the config" })
    expect(pullRequestFacts({ title: "Read the config", base: { ref: "main" } })).toEqual({
      draft: false,
      baseRef: "main",
      title: "Read the config",
    })
  })
})

describe("configStatus", () => {
  it("names a read by whether a file was there and whether it had an error", () => {
    expect(configStatus(MISSING)).toBe("missing")
    expect(configStatus(VALID)).toBe("file")
    expect(configStatus(INVALID)).toBe("invalid")
    expect(configStatus(UNREADABLE)).toBe("unreadable")
  })

  it("names each of readConfig's outcomes", async () => {
    const statusOf = async (respond: () => Response) =>
      configStatus(await readConfig(fakeGitHub(respond).github, ref, BASE, recorder().report))
    expect(await statusOf(() => new Response("", { status: 404 }))).toBe("missing")
    expect(await statusOf(served(FULL_FILE))).toBe("file")
    expect(await statusOf(served("reviews: always\n"))).toBe("invalid")
    expect(await statusOf(() => new Response("boom", { status: 502 }))).toBe("unreadable")
  })
})

describe("isCacheable", () => {
  it("caches a missing, valid or invalid file, and never an unreadable one, so a passing failure can't pin the defaults", () => {
    expect(isCacheable(MISSING)).toBe(true)
    expect(isCacheable(VALID)).toBe(true)
    expect(isCacheable(INVALID)).toBe(true)
    expect(isCacheable(UNREADABLE)).toBe(false)
  })
})

describe("the config cache", () => {
  it("keys a read by the base commit sha", () => {
    expect(CONFIG_PREFIX).toBe("config:")
    expect(configKey(BASE)).toBe(`config:${BASE}`)
  })

  it("names every other base's record as stale, and no other key, the context's included", () => {
    const keys = ["pending", `config:${OTHER_BASE}`, configKey(BASE), `context:${OTHER_BASE}`, "config:abc"]
    expect(staleConfigKeys(keys, BASE)).toEqual([`config:${OTHER_BASE}`, "config:abc"])
    expect(staleConfigKeys([configKey(BASE)], BASE)).toEqual([])
  })

  it.each<[string, ConfigRead]>([
    ["missing", MISSING],
    ["valid", VALID],
    ["invalid", INVALID],
  ])("reads back the record of a %s file as it was read", (_name, read) => {
    const stored = structuredClone(storedConfig(BASE, read))
    expect(Value.Check(StoredConfig, stored)).toBe(true)
    expect(stored.baseSha).toBe(BASE)
    expect(configReadOf(stored)).toEqual(read)
  })

  it("refuses a record a read could not have written", () => {
    const stored = storedConfig(BASE, VALID)
    expect(Value.Check(StoredConfig, { ...stored, config: { reviews: { auto: true } } })).toBe(false)
    expect(Value.Check(StoredConfig, { ...stored, error: 5 })).toBe(false)
    expect(Value.Check(StoredConfig, { baseSha: BASE, config: FULL_CONFIG })).toBe(false)
  })

  it("refuses a record cached before reviews.verify existed, so it reads as a miss and the file is read again", () => {
    const stored = storedConfig(BASE, VALID)
    expect(Value.Check(StoredConfig, { ...stored, config: { reviews: BEFORE_VERIFY_REVIEWS } })).toBe(false)
  })
})

describe("requestChangesWorkflow", () => {
  it("follows the file's setting over the Worker var", () => {
    expect(requestChangesWorkflow(true, undefined)).toBe(true)
    expect(requestChangesWorkflow(true, "false")).toBe(true)
    expect(requestChangesWorkflow(false, "true")).toBe(false)
  })

  it("follows the Worker var when the file sets nothing, on only for the exact text true", () => {
    expect(requestChangesWorkflow(undefined, "true")).toBe(true)
    expect(requestChangesWorkflow(undefined, "false")).toBe(false)
    expect(requestChangesWorkflow(undefined, "TRUE")).toBe(false)
    expect(requestChangesWorkflow(undefined, undefined)).toBe(false)
  })
})

describe("verifyModelFor", () => {
  it("is off whatever the file says when the variable is empty or unset, the Worker's global switch", () => {
    expect(verifyModelFor(LITERAL_DEFAULTS, "")).toBeUndefined()
    expect(verifyModelFor(NAMES_A_VERIFY_MODEL, "")).toBeUndefined()
    expect(verifyModelFor(LITERAL_DEFAULTS, undefined)).toBeUndefined()
    expect(verifyModelFor(NAMES_A_VERIFY_MODEL, undefined)).toBeUndefined()
  })

  it("is the variable's model when the file names none", () => {
    expect(verifyModelFor(LITERAL_DEFAULTS, "m")).toBe("m")
  })

  it("is the file's model over the variable's, once the variable has turned verify on", () => {
    expect(verifyModelFor(NAMES_A_VERIFY_MODEL, "m")).toBe("k")
  })

  it("is off for a repository whose file sets reviews.verify to false, whichever model is named", () => {
    expect(verifyModelFor(OPTS_OUT_OF_VERIFY, "m")).toBeUndefined()
    expect(verifyModelFor({ ...OPTS_OUT_OF_VERIFY, model: { verify: "k" } }, "m")).toBeUndefined()
  })
})

describe("runSettings", () => {
  it("carries the request-changes workflow a run starts with, the file's over the var", () => {
    const off = { ...parseConfig("reviews:\n  request_changes_workflow: false\n"), present: true }
    expect(runSettings(off, "true", "")).toEqual({ requestChangesWorkflow: false })
    expect(runSettings(VALID, "false", "")).toEqual({ requestChangesWorkflow: true })
    expect(runSettings(MISSING, "true", "")).toEqual({ requestChangesWorkflow: true })
  })

  it("carries the error of a file the run ignored, invalid or unreadable, with the var's workflow, since the defaults applied", () => {
    expect(runSettings(INVALID, "true", "")).toEqual({
      requestChangesWorkflow: true,
      configError: "/reviews/auto must be boolean",
    })
    expect(runSettings(UNREADABLE, "false", "")).toEqual({
      requestChangesWorkflow: false,
      configError: "Error: GitHub 502 : boom",
    })
  })

  it("carries the verify model a run starts with, and has no verifyModel key when verify is off", () => {
    expect(runSettings(MISSING, "true", "m")).toStrictEqual({ requestChangesWorkflow: true, verifyModel: "m" })
    expect(runSettings(MISSING, "true", "")).toStrictEqual({ requestChangesWorkflow: true })
    expect(runSettings(MISSING, "true", undefined)).toStrictEqual({ requestChangesWorkflow: true })
  })

  it("carries the file's verify model over the var's, and none for a file that turns verify off", () => {
    const naming: ConfigRead = { config: NAMES_A_VERIFY_MODEL, error: undefined, present: true }
    const optedOut: ConfigRead = { config: OPTS_OUT_OF_VERIFY, error: undefined, present: true }
    expect(runSettings(naming, "false", "m")).toStrictEqual({ requestChangesWorkflow: false, verifyModel: "k" })
    expect(runSettings(optedOut, "false", "m")).toStrictEqual({ requestChangesWorkflow: false })
  })

  it("carries the var's verify model beside the error of a file the run ignored, since the defaults applied", () => {
    expect(runSettings(INVALID, "true", "m")).toStrictEqual({
      requestChangesWorkflow: true,
      verifyModel: "m",
      configError: "/reviews/auto must be boolean",
    })
    expect(runSettings(UNREADABLE, "false", "m")).toStrictEqual({
      requestChangesWorkflow: false,
      verifyModel: "m",
      configError: "Error: GitHub 502 : boom",
    })
  })
})
