import type { Extension, Registry, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable"
import type { SkillManifestEntry, SkillSource } from "agents/skills"
import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import type { TreeEntry } from "../github/client.ts"
import { BUNDLED_SKILL_NAMES } from "../review/bundled-skills.ts"
import { describedSkillEntry, manifestSource, sha256Hex, type SkillFile } from "../review/skills.ts"
import type { RepositoryContext } from "./context.ts"

export interface RepositorySkillFiles {
  readonly name: string
  readonly dir: string
  readonly files: string[]
}

export interface SkillAt {
  readonly name: string
  readonly path: string
}

export type SkillCap = "file" | "base" | "description" | "listing"

export interface CappedSkill extends SkillAt {
  readonly cap: SkillCap
  readonly resources?: number
}

export interface OfferedSkills {
  readonly source: SkillSource
  readonly fingerprint: string
  readonly names: string[]
}

export interface RepositorySkills {
  readonly offered: OfferedSkills | undefined
  readonly shadowed: SkillAt[]
  readonly unloaded: SkillAt[]
  readonly invalid: SkillAt[]
  readonly capped: CappedSkill[]
  readonly loadsSkipped: number
}

export type SkillState =
  | { readonly kind: "offered"; readonly at: SkillAt; readonly entry: SkillManifestEntry }
  | { readonly kind: "unloaded" | "invalid"; readonly at: SkillAt }
  | { readonly kind: "capped"; readonly at: SkillAt; readonly cap: SkillCap }

type SkillLogFields = {
  readonly number: number
  readonly name: string
  readonly path: string
  readonly cap?: SkillCap
  readonly resources?: number
}

export interface SkillLog {
  readonly event: "skills.shadowed" | "skills.unloaded" | "skills.invalid" | "skills.capped"
  readonly fields: SkillLogFields
}

export interface SkillStartFields {
  readonly repoSkills: number
  readonly repoSkillsFingerprint: string | undefined
  readonly skillLoadsSkipped: number
}

export type BuildCatalog = (sources: readonly SkillSource[]) => Promise<Extension>

export type RestoreGuard = { pending: false } | { pending: true; fingerprint: string | undefined }

export type ReportSkippedRestore = (records: number, reason: "records" | "fingerprint") => void

type SkillContext = Pick<RepositoryContext, "tree" | "files">

type CachedFiles = Readonly<Record<string, string>>

interface SkillPlan {
  readonly skills: RepositorySkillFiles[]
  readonly oversized: ReadonlySet<string>
  readonly loadable: ReadonlySet<string>
  readonly overFileCap: ReadonlyMap<string, number>
}

interface SkillSurvey {
  readonly plan: SkillPlan
  readonly states: SkillState[]
}

const TextPart = Type.Object({ type: Type.Literal("text"), text: Type.String() })

const ImagePart = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() })

export const ContentOnlyResult = Type.Object({
  content: Type.Array(Type.Union([TextPart, ImagePart])),
  output: Type.Optional(Type.Undefined()),
})

export type ContentOnlyResult = Static<typeof ContentOnlyResult>

export const SKILL_ROOTS = [".github/skills/", ".agents/skills/", ".claude/skills/"]

export const MAX_SKILL_FILE_BYTES = 51_200

const CATALOG_OUTPUT_MAX_BYTES = 2 * MAX_SKILL_FILE_BYTES

const mostLinesIn = (bytes: number): number => bytes

export const CATALOG_OUTPUT_LIMITS = {
  maxBytes: CATALOG_OUTPUT_MAX_BYTES,
  maxLines: mostLinesIn(CATALOG_OUTPUT_MAX_BYTES),
} as const

export const MAX_SKILL_BYTES = 524_288

export const MAX_DESCRIPTION_CHARS = 1_024

export const MAX_CATALOG_CHARS = 12_000

const SKILL_FILE = "SKILL.md"
const SKILL_FILE_IN_DIRECTORY = /^([^/]+)\/SKILL\.md$/
const REPOSITORY_SOURCE = "repo"
const HIDDEN_FROM_CATALOG = "disable-model-invocation"
const FINGERPRINT_SHOWN = 8

const NO_SKILLS = {
  offered: undefined,
  shadowed: [],
  unloaded: [],
  invalid: [],
  capped: [],
  loadsSkipped: 0,
} satisfies RepositorySkills

const compareText = (a: string, b: string): number => {
  if (a < b) return -1
  return a > b ? 1 : 0
}

const isSafe = (path: string): boolean => !path.startsWith("/") && !path.split("/").includes("..")

export const isUnderSkillRoot = (path: string): boolean => SKILL_ROOTS.some((root) => path.startsWith(root))

const sizeOf = ({ size }: TreeEntry): number => size ?? Number.POSITIVE_INFINITY

const safeBlobs = (entries: readonly TreeEntry[]): TreeEntry[] =>
  entries.filter(({ path, type }) => type === "blob" && isSafe(path))

const skillNameAt = (root: string, path: string): string[] => {
  const match = path.startsWith(root) ? SKILL_FILE_IN_DIRECTORY.exec(path.slice(root.length)) : null
  return match?.[1] === undefined ? [] : [match[1]]
}

const isFileOf = (dir: string, entry: TreeEntry): boolean =>
  entry.path.startsWith(`${dir}/`) && (entry.path === `${dir}/${SKILL_FILE}` || sizeOf(entry) <= MAX_SKILL_FILE_BYTES)

const skillsUnder = (root: string, blobs: readonly TreeEntry[]): RepositorySkillFiles[] =>
  blobs
    .flatMap(({ path }) => skillNameAt(root, path))
    .sort(compareText)
    .map((name) => {
      const dir = `${root}${name}`
      const files = blobs.filter((entry) => isFileOf(dir, entry)).map(({ path }) => path)
      return { name, dir, files: files.sort(compareText) }
    })

const discoveredSkills = (entries: readonly TreeEntry[]): RepositorySkillFiles[] => {
  const blobs = safeBlobs(entries)
  return SKILL_ROOTS.flatMap((root) => skillsUnder(root, blobs))
}

const isShadowed = (skill: RepositorySkillFiles, index: number, skills: readonly RepositorySkillFiles[]): boolean =>
  BUNDLED_SKILL_NAMES.has(skill.name) || skills.slice(0, index).some(({ name }) => name === skill.name)

export function repositorySkillFiles(entries: readonly TreeEntry[]): RepositorySkillFiles[] {
  return discoveredSkills(entries).filter((skill, index, skills) => !isShadowed(skill, index, skills))
}

export function shadowedSkillFiles(entries: readonly TreeEntry[]): RepositorySkillFiles[] {
  return discoveredSkills(entries).filter(isShadowed)
}

export async function repositorySkillFingerprint(entries: readonly TreeEntry[]): Promise<string> {
  const files = new Set(repositorySkillFiles(entries).flatMap(({ files }) => files))
  const pairs = entries.filter(({ path }) => files.has(path)).map(({ path, sha }) => `${path}:${sha}`)
  return sha256Hex(pairs.sort(compareText).join("\n"))
}

const bodyPathOf = ({ dir }: RepositorySkillFiles): string => `${dir}/${SKILL_FILE}`

const resourcePathsOf = (skill: RepositorySkillFiles): string[] =>
  skill.files.filter((path) => path !== bodyPathOf(skill))

const withinSkillBytes = (order: readonly string[], sizes: ReadonlyMap<string, number>): Set<string> => {
  const within = new Set<string>()
  let total = 0
  for (const path of order) {
    total += sizes.get(path) ?? Number.POSITIVE_INFINITY
    if (total > MAX_SKILL_BYTES) break
    within.add(path)
  }
  return within
}

const overFileCapOf = (skill: RepositorySkillFiles, blobs: readonly TreeEntry[]): number =>
  blobs.filter(
    (entry) =>
      entry.path.startsWith(`${skill.dir}/`) &&
      entry.path !== bodyPathOf(skill) &&
      sizeOf(entry) > MAX_SKILL_FILE_BYTES,
  ).length

const planOf = (entries: readonly TreeEntry[]): SkillPlan => {
  const skills = repositorySkillFiles(entries)
  const sizes = new Map(entries.map((entry): [string, number] => [entry.path, sizeOf(entry)]))
  const tooLarge = (path: string): boolean => (sizes.get(path) ?? Number.POSITIVE_INFINITY) > MAX_SKILL_FILE_BYTES
  const oversized = new Set(skills.map(bodyPathOf).filter(tooLarge))
  const servable = skills.filter((skill) => !oversized.has(bodyPathOf(skill)))
  const order = [...servable.map(bodyPathOf), ...servable.flatMap(resourcePathsOf)]
  const blobs = safeBlobs(entries)
  return {
    skills,
    oversized,
    loadable: withinSkillBytes(order, sizes),
    overFileCap: new Map(skills.map((skill): [string, number] => [skill.name, overFileCapOf(skill, blobs)])),
  }
}

const cachedText = (files: CachedFiles, path: string): string | undefined =>
  Object.hasOwn(files, path) ? files[path] : undefined

const loadedResources = (skill: RepositorySkillFiles, files: CachedFiles, loadable: ReadonlySet<string>): SkillFile[] =>
  resourcePathsOf(skill).flatMap((path) => {
    const content = loadable.has(path) ? cachedText(files, path) : undefined
    return content === undefined ? [] : [{ path: path.slice(skill.dir.length + 1), content }]
  })

const stateOf = (skill: RepositorySkillFiles, files: CachedFiles, plan: SkillPlan): SkillState => {
  const bodyPath = bodyPathOf(skill)
  const at = { name: skill.name, path: bodyPath }
  if (plan.oversized.has(bodyPath)) return { kind: "capped", at, cap: "file" }
  if (!plan.loadable.has(bodyPath)) return { kind: "capped", at, cap: "base" }
  const body = cachedText(files, bodyPath)
  if (body === undefined) return { kind: "unloaded", at }
  const entry = describedSkillEntry(skill.name, body, loadedResources(skill, files, plan.loadable))
  if (entry === undefined) return { kind: "invalid", at }
  if (entry.description.length > MAX_DESCRIPTION_CHARS) return { kind: "capped", at, cap: "description" }
  return { kind: "offered", at, entry }
}

const catalogLine = ({ name, description }: SkillManifestEntry): string => `- ${name}: ${description}`

const fittingCount = (entries: readonly SkillManifestEntry[]): number => {
  let chars = -1
  for (const [index, entry] of entries.entries()) {
    chars += catalogLine(entry).length + 1
    if (chars > MAX_CATALOG_CHARS) return index
  }
  return entries.length
}

const withCatalogCap = (states: readonly SkillState[]): SkillState[] => {
  const entries = states.flatMap((state) => (state.kind === "offered" ? [state.entry] : []))
  const fitting = new Set(entries.slice(0, fittingCount(entries)))
  return states.map((state): SkillState =>
    state.kind !== "offered" || fitting.has(state.entry) ? state : { kind: "capped", at: state.at, cap: "listing" },
  )
}

const surveyOf = ({ tree, files }: SkillContext): SkillSurvey => {
  const plan = planOf(tree.entries)
  return { plan, states: withCatalogCap(plan.skills.map((skill) => stateOf(skill, files, plan))) }
}

const isUncachedIn =
  (files: CachedFiles, loadable: ReadonlySet<string>) =>
  (path: string): boolean =>
    loadable.has(path) && !Object.hasOwn(files, path)

const offeredNamesOf = (states: readonly SkillState[]): Set<string> =>
  new Set(states.flatMap((state) => (state.kind === "offered" ? [state.at.name] : [])))

const offeredSkillsOf = ({ plan, states }: SkillSurvey): RepositorySkillFiles[] => {
  const offered = offeredNamesOf(states)
  return plan.skills.filter(({ name }) => offered.has(name))
}

const unloadedBodies = (plan: SkillPlan, files: CachedFiles): string[] =>
  plan.skills.map(bodyPathOf).filter(isUncachedIn(files, plan.loadable))

const unloadedResources = (survey: SkillSurvey, files: CachedFiles): string[] =>
  offeredSkillsOf(survey).flatMap(resourcePathsOf).filter(isUncachedIn(files, survey.plan.loadable))

export function unloadedSkillBodies({ tree, files }: SkillContext): string[] {
  return unloadedBodies(planOf(tree.entries), files)
}

export function unloadedSkillResources(context: SkillContext): string[] {
  return unloadedResources(surveyOf(context), context.files)
}

export function unloadedSkillPaths(context: SkillContext): string[] {
  const survey = surveyOf(context)
  return [...unloadedBodies(survey.plan, context.files), ...unloadedResources(survey, context.files)]
}

const atsOf = (states: readonly SkillState[], kind: "unloaded" | "invalid"): SkillAt[] =>
  states.flatMap((state) => (state.kind === kind ? [state.at] : []))

const cappedSkillsOf = (states: readonly SkillState[]): CappedSkill[] =>
  states.flatMap((state) => (state.kind === "capped" ? [{ ...state.at, cap: state.cap }] : []))

const resourceCapsOf = (skill: RepositorySkillFiles, plan: SkillPlan): CappedSkill[] => {
  const at = { name: skill.name, path: bodyPathOf(skill) }
  const leftOut = (cap: SkillCap, resources: number): CappedSkill[] =>
    resources === 0 ? [] : [{ ...at, cap, resources }]
  const pastBase = resourcePathsOf(skill).filter((path) => !plan.loadable.has(path)).length
  return [...leftOut("file", plan.overFileCap.get(skill.name) ?? 0), ...leftOut("base", pastBase)]
}

const cappedResourcesOf = (survey: SkillSurvey): CappedSkill[] =>
  offeredSkillsOf(survey).flatMap((skill) => resourceCapsOf(skill, survey.plan))

export function skillSourceFor(states: readonly SkillState[], fingerprint: string): OfferedSkills | undefined {
  const skills = states.flatMap((state) => (state.kind === "offered" ? [state.entry] : []))
  if (skills.length === 0) return undefined
  return {
    source: manifestSource({ id: REPOSITORY_SOURCE, fingerprint, skills }),
    fingerprint,
    names: skills.map(({ name }) => name),
  }
}

export async function repositorySkills(context: SkillContext | undefined): Promise<RepositorySkills> {
  if (context === undefined) return NO_SKILLS
  const survey = surveyOf(context)
  const { states } = survey
  return {
    offered: skillSourceFor(states, await repositorySkillFingerprint(context.tree.entries)),
    shadowed: shadowedSkillFiles(context.tree.entries).map((skill) => ({ name: skill.name, path: bodyPathOf(skill) })),
    unloaded: atsOf(states, "unloaded"),
    invalid: atsOf(states, "invalid"),
    capped: [...cappedSkillsOf(states), ...cappedResourcesOf(survey)],
    loadsSkipped: unloadedBodies(survey.plan, context.files).length + unloadedResources(survey, context.files).length,
  }
}

export function skillLogs(number: number, skills: RepositorySkills): SkillLog[] {
  const logsOf = (event: SkillLog["event"], ats: readonly (SkillAt | CappedSkill)[]): SkillLog[] =>
    ats.map((at) => ({ event, fields: { number, ...at } }))
  return [
    ...logsOf("skills.shadowed", skills.shadowed),
    ...logsOf("skills.unloaded", skills.unloaded),
    ...logsOf("skills.invalid", skills.invalid),
    ...logsOf("skills.capped", skills.capped),
  ]
}

export function skillsStartFields({ offered, loadsSkipped }: RepositorySkills): SkillStartFields {
  return {
    repoSkills: offered?.names.length ?? 0,
    repoSkillsFingerprint: offered?.fingerprint.slice(0, FINGERPRINT_SHOWN),
    skillLoadsSkipped: loadsSkipped,
  }
}

const isModelCallable = ({ callers }: ToolRegistration): boolean => callers === undefined || callers.includes("model")

export function offeredToolNames(installed: readonly Extension[]): string[] {
  return installed.flatMap(({ tools }) => (tools ?? []).filter(isModelCallable).map(({ name }) => name))
}

export function unlisted(source: SkillSource): SkillSource {
  return {
    ...source,
    list: async () =>
      (await source.list()).map((descriptor) => ({
        ...descriptor,
        metadata: { ...descriptor.metadata, [HIDDEN_FROM_CATALOG]: true },
      })),
  }
}

export function catalogFor(
  builtin: SkillSource,
  offered: OfferedSkills | undefined,
): readonly SkillSource[] | undefined {
  return offered === undefined ? undefined : [unlisted(builtin), offered.source]
}

export async function restoredCatalog(
  builtin: SkillSource,
  contexts: readonly SkillContext[],
  records: number,
  guard: RestoreGuard,
  skipped: ReportSkippedRestore,
): Promise<readonly SkillSource[] | undefined> {
  const [context] = contexts
  if (records === 0) return undefined
  if (records !== 1 || context === undefined) {
    skipped(records, "records")
    return undefined
  }
  const { offered } = await repositorySkills(context)
  if (guard.pending && offered?.fingerprint !== guard.fingerprint) {
    skipped(records, "fingerprint")
    return undefined
  }
  return catalogFor(builtin, offered)
}

export function outputFromContent(result: ToolExecutionResult | ContentOnlyResult): ToolExecutionResult {
  if (!Value.Check(ContentOnlyResult, result)) return result
  const { content, ...rest } = result
  return { ...rest, output: content }
}

type ExecuteArgs = Partial<Parameters<ToolRegistration["execute"]>>

export const withOutputFromContent =
  <Args extends ExecuteArgs>(execute: (...args: Args) => Promise<ToolExecutionResult | ContentOnlyResult>) =>
  async (...args: Args): Promise<ToolExecutionResult> =>
    outputFromContent(await execute(...args))

const toolWithOutput = (tool: ToolRegistration): ToolRegistration => ({
  ...tool,
  outputLimits: CATALOG_OUTPUT_LIMITS,
  execute: withOutputFromContent(tool.execute.bind(tool)),
})

export function withContentAsOutput(extension: Extension): Extension {
  return { ...extension, tools: (extension.tools ?? []).map(toolWithOutput) }
}

export async function installCatalog(
  registry: Registry,
  installed: Extension | undefined,
  sources: readonly SkillSource[] | undefined,
  build: BuildCatalog,
): Promise<Extension | undefined> {
  if (sources === undefined) {
    if (installed !== undefined) registry.uninstall(installed)
    return undefined
  }
  const extension = withContentAsOutput(await build(sources))
  registry.install(extension)
  return extension
}
