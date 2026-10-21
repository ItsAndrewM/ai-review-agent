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
    path_filters: Type.Array(Type.String({ pattern: "^!" })),
    path_instructions: Type.Array(PathInstructionEntry),
  },
  { additionalProperties: false },
)

export const AndabotConfig = Type.Object({ reviews: Reviews })

export type AndabotConfig = Static<typeof AndabotConfig>

const AndabotConfigFile = Type.Object(
  {
    reviews: Type.Optional(Type.Partial(Reviews, { additionalProperties: false })),
    model: Type.Optional(Type.Object({})),
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

type ReportUnreadable = (error: string) => void

export const DEFAULT_CONFIG: AndabotConfig = {
  reviews: {
    auto: true,
    drafts: false,
    base_branches: [],
    ignore_title_keywords: [],
    path_filters: [],
    path_instructions: [],
  },
}

const CONFIG_FILE = ".andabot.yaml"

const LINE_BREAK = /\r?\n/

const TRAILING_COLON = /:$/

const defaults = (): AndabotConfig => structuredClone(DEFAULT_CONFIG)

const rejected = (error: string): ParsedConfig => ({ config: defaults(), error })

const firstLine = (text: string): string => (text.split(LINE_BREAK)[0] ?? "").replace(TRAILING_COLON, "")

const yamlProblem = (cause: unknown): string =>
  `invalid YAML: ${firstLine(cause instanceof Error ? cause.message : String(cause))}`

const schemaProblem = ([first]: readonly TLocalizedValidationError[]): string =>
  `${first?.instancePath || "/"} ${first?.message ?? "is invalid"}`

const withDefaults = ({ reviews }: AndabotConfigFile): AndabotConfig => ({
  reviews: { ...defaults().reviews, ...reviews },
})

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
