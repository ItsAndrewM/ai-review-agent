import { Type, type Static } from "typebox"
import type { TLocalizedValidationError } from "typebox/error"
import { Value } from "typebox/value"
import { parse } from "yaml"
import type { GitHubClient, RepoRef } from "../github/client.ts"
import { errorText } from "../log.ts"

const PathInstructionEntry = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    instructions: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

const Reviews = Type.Object(
  {
    auto: Type.Boolean(),
    drafts: Type.Boolean(),
    base_branches: Type.Array(Type.String()),
    ignore_title_keywords: Type.Array(Type.String()),
    request_changes_workflow: Type.Optional(Type.Boolean()),
    verify: Type.Boolean(),
    path_filters: Type.Array(Type.String({ pattern: "^!" })),
    path_instructions: Type.Array(PathInstructionEntry),
  },
  { additionalProperties: false },
)

const Model = Type.Object({ verify: Type.Optional(Type.String({ minLength: 1 })) })

export const AndabotConfig = Type.Object({ reviews: Reviews, model: Type.Optional(Model) })

export type AndabotConfig = Static<typeof AndabotConfig>

const AndabotConfigFile = Type.Object(
  {
    reviews: Type.Optional(Type.Partial(Reviews, { additionalProperties: false })),
    model: Type.Optional(Model),
  },
  { additionalProperties: false },
)

type AndabotConfigFile = Static<typeof AndabotConfigFile>

export interface ParsedConfig {
  config: AndabotConfig
  error: string | undefined
}

export interface ConfigRead extends ParsedConfig {
  present: boolean
}

export const StoredConfig = Type.Object({
  baseSha: Type.String(),
  config: AndabotConfig,
  error: Type.Optional(Type.String()),
  present: Type.Boolean(),
})

export type StoredConfig = Static<typeof StoredConfig>

export type ConfigStatus = "missing" | "file" | "invalid" | "unreadable"

export type ReviewTrigger = "push" | "command"

export type SkipReason = "auto" | "draft" | "base_branch" | "title_keyword"

export type ReviewDecision = { review: true } | { review: false; reason: SkipReason }

export interface PullRequestFacts {
  draft: boolean
  baseRef: string
  title: string
}

export interface PullRequestSource {
  draft?: boolean | undefined
  base: { ref: string }
  title: string
}

export interface ReviewRequest {
  full: boolean
  requestedBy?: string | undefined
}

export interface RunSettings {
  requestChangesWorkflow: boolean
  configError?: string
  verifyModel?: string
}

type ReportUnreadable = (error: string) => void

type Reviews = Static<typeof Reviews>

export const DEFAULT_CONFIG: AndabotConfig = {
  reviews: {
    auto: true,
    drafts: false,
    base_branches: [],
    ignore_title_keywords: [],
    verify: true,
    path_filters: [],
    path_instructions: [],
  },
}

export const CONFIG_FILE = ".andabot.yaml"

export const CONFIG_PREFIX = "config:"

const LINE_BREAK = /\r?\n/

const TRAILING_COLON = /:$/

const defaults = (): AndabotConfig => structuredClone(DEFAULT_CONFIG)

const rejected = (error: string): ParsedConfig => ({ config: defaults(), error })

const firstLine = (text: string): string => (text.split(LINE_BREAK)[0] ?? "").replace(TRAILING_COLON, "")

const yamlProblem = (cause: unknown): string =>
  `invalid YAML: ${firstLine(cause instanceof Error ? cause.message : String(cause))}`

const schemaProblem = ([first]: readonly TLocalizedValidationError[]): string =>
  `${first?.instancePath || "/"} ${first?.message ?? "is invalid"}`

const withDefaults = ({ reviews, model }: AndabotConfigFile): AndabotConfig => {
  const config = { reviews: { ...defaults().reviews, ...reviews } }
  return model?.verify === undefined ? config : { ...config, model: { verify: model.verify } }
}

export function parseConfig(text: string): ParsedConfig {
  let document: unknown
  try {
    document = parse(text)
  } catch (cause) {
    return rejected(yamlProblem(cause))
  }
  const file = document ?? {}
  if (!Value.Check(AndabotConfigFile, file)) return rejected(schemaProblem(Value.Errors(AndabotConfigFile, file)))
  return { config: withDefaults(file), error: undefined }
}

export async function readConfig(
  github: GitHubClient,
  ref: RepoRef,
  baseSha: string,
  unreadable: ReportUnreadable,
): Promise<ConfigRead> {
  let text: string | undefined
  try {
    text = await github.getFileContent(ref, CONFIG_FILE, baseSha)
  } catch (cause) {
    const error = errorText(cause)
    unreadable(error)
    return { config: defaults(), error, present: false }
  }
  if (text === undefined) return { config: defaults(), error: undefined, present: false }
  return { ...parseConfig(text), present: true }
}

export function configStatus({ present, error }: ConfigRead): ConfigStatus {
  if (error === undefined) return present ? "file" : "missing"
  return present ? "invalid" : "unreadable"
}

export const isCacheable = (read: ConfigRead): boolean => configStatus(read) !== "unreadable"

export const configKey = (baseSha: string): string => `${CONFIG_PREFIX}${baseSha}`

export function staleConfigKeys(keys: readonly string[], baseSha: string): string[] {
  const current = configKey(baseSha)
  return keys.filter((key) => key.startsWith(CONFIG_PREFIX) && key !== current)
}

export function storedConfig(baseSha: string, { config, error, present }: ConfigRead): StoredConfig {
  const record = { baseSha, config, present }
  return error === undefined ? record : { ...record, error }
}

export const configReadOf = ({ config, error, present }: StoredConfig): ConfigRead => ({ config, error, present })

export const pullRequestFacts = ({ draft, base, title }: PullRequestSource): PullRequestFacts => ({
  draft: draft === true,
  baseRef: base.ref,
  title,
})

export const reviewTrigger = ({ full, requestedBy }: ReviewRequest): ReviewTrigger =>
  full || requestedBy !== undefined ? "command" : "push"

const ignoredKeywords = (keywords: readonly string[]): string[] =>
  keywords.map((keyword) => keyword.trim().toLowerCase()).filter((keyword) => keyword !== "")

const holdsIgnoredKeyword = (title: string, keywords: readonly string[]): boolean => {
  const lowered = title.toLowerCase()
  return ignoredKeywords(keywords).some((keyword) => lowered.includes(keyword))
}

const outsideBaseBranches = (baseRef: string, branches: readonly string[]): boolean =>
  branches.length > 0 && !branches.includes(baseRef)

function skipReason(reviews: Reviews, pr: PullRequestFacts): SkipReason | undefined {
  if (!reviews.auto) return "auto"
  if (pr.draft && !reviews.drafts) return "draft"
  if (outsideBaseBranches(pr.baseRef, reviews.base_branches)) return "base_branch"
  return holdsIgnoredKeyword(pr.title, reviews.ignore_title_keywords) ? "title_keyword" : undefined
}

export function shouldReview(config: AndabotConfig, pr: PullRequestFacts, trigger: ReviewTrigger): ReviewDecision {
  const reason = trigger === "command" ? undefined : skipReason(config.reviews, pr)
  return reason === undefined ? { review: true } : { review: false, reason }
}

export const requestChangesWorkflow = (override: boolean | undefined, variable: string | undefined): boolean =>
  override ?? variable === "true"

export function verifyModelFor({ reviews, model }: AndabotConfig, variable: string | undefined): string | undefined {
  if (variable === undefined || variable === "" || !reviews.verify) return undefined
  return model?.verify ?? variable
}

const withVerifyModel = (settings: RunSettings, verifyModel: string | undefined): RunSettings =>
  verifyModel === undefined ? settings : { ...settings, verifyModel }

export function runSettings(
  { config, error }: ConfigRead,
  workflowVariable: string | undefined,
  verifyVariable: string | undefined,
): RunSettings {
  const settings = withVerifyModel(
    { requestChangesWorkflow: requestChangesWorkflow(config.reviews.request_changes_workflow, workflowVariable) },
    verifyModelFor(config, verifyVariable),
  )
  return error === undefined ? settings : { ...settings, configError: error }
}
