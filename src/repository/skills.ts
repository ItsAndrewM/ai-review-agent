import type { Extension, Registry } from "@earendil-works/pi-durable"
import type { SkillManifestEntry, SkillSource } from "agents/skills"
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
  readonly loadsSkipped: number
}

export interface SkillLog {
  readonly event: "skills.shadowed" | "skills.unloaded" | "skills.invalid"
  readonly fields: { readonly number: number; readonly name: string; readonly path: string }
}

export interface SkillStartFields {
  readonly repoSkills: number
  readonly repoSkillsFingerprint: string | undefined
  readonly skillLoadsSkipped: number
}

export interface Catalog {
  readonly key: string
  readonly sources: readonly SkillSource[]
}

export interface InstalledCatalog {
  readonly key: string
  readonly extension: Extension
}

export type BuildCatalog = (sources: readonly SkillSource[]) => Promise<Extension>

type SkillContext = Pick<RepositoryContext, "tree" | "files">

type CachedFiles = Readonly<Record<string, string>>

type SkillState =
  | { readonly kind: "offered"; readonly entry: SkillManifestEntry; readonly served: string[] }
  | { readonly kind: "unloaded" | "invalid"; readonly at: SkillAt }

export const SKILL_ROOTS = [".github/skills/", ".agents/skills/", ".claude/skills/"]

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
  loadsSkipped: 0,
} satisfies RepositorySkills

const compareText = (a: string, b: string): number => {
  if (a < b) return -1
  return a > b ? 1 : 0
}

const isSafe = (path: string): boolean => !path.startsWith("/") && !path.split("/").includes("..")

export const isUnderSkillRoot = (path: string): boolean => SKILL_ROOTS.some((root) => path.startsWith(root))

const safeBlobs = (entries: readonly TreeEntry[]): string[] =>
  entries.filter(({ path, type }) => type === "blob" && isSafe(path)).map(({ path }) => path)

const skillNameAt = (root: string, path: string): string[] => {
  const match = path.startsWith(root) ? SKILL_FILE_IN_DIRECTORY.exec(path.slice(root.length)) : null
  return match?.[1] === undefined ? [] : [match[1]]
}

const skillsUnder = (root: string, blobs: readonly string[]): RepositorySkillFiles[] =>
  blobs
    .flatMap((path) => skillNameAt(root, path))
    .sort(compareText)
    .map((name) => {
      const dir = `${root}${name}`
      return { name, dir, files: blobs.filter((path) => path.startsWith(`${dir}/`)).sort(compareText) }
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

const skillLoadOrder = (entries: readonly TreeEntry[]): string[] => {
  const skills = repositorySkillFiles(entries)
  return [...skills.map(bodyPathOf), ...skills.flatMap(resourcePathsOf)]
}

export function unloadedSkillPaths({ tree, files }: SkillContext): string[] {
  return skillLoadOrder(tree.entries).filter((path) => !Object.hasOwn(files, path))
}

const cachedText = (files: CachedFiles, path: string): string | undefined =>
  Object.hasOwn(files, path) ? files[path] : undefined

const loadedResources = (skill: RepositorySkillFiles, files: CachedFiles): SkillFile[] =>
  resourcePathsOf(skill).flatMap((path) => {
    const content = cachedText(files, path)
    return content === undefined ? [] : [{ path, content }]
  })

const relativeTo = (dir: string, { path, content }: SkillFile): SkillFile => ({
  path: path.slice(dir.length + 1),
  content,
})

const stateOf = (skill: RepositorySkillFiles, files: CachedFiles): SkillState => {
  const bodyPath = bodyPathOf(skill)
  const at = { name: skill.name, path: bodyPath }
  const body = cachedText(files, bodyPath)
  if (body === undefined) return { kind: "unloaded", at }
  const resources = loadedResources(skill, files)
  const entry = describedSkillEntry(
    skill.name,
    body,
    resources.map((resource) => relativeTo(skill.dir, resource)),
  )
  if (entry === undefined) return { kind: "invalid", at }
  return { kind: "offered", entry, served: [bodyPath, ...resources.map(({ path }) => path)] }
}

const statesOf = ({ tree, files }: SkillContext): SkillState[] =>
  repositorySkillFiles(tree.entries).map((skill) => stateOf(skill, files))

const atsOf = (states: readonly SkillState[], kind: "unloaded" | "invalid"): SkillAt[] =>
  states.flatMap((state) => (state.kind !== "offered" && state.kind === kind ? [state.at] : []))

export async function skillSourceFor(context: SkillContext): Promise<OfferedSkills | undefined> {
  const offered = statesOf(context).flatMap((state) => (state.kind === "offered" ? [state] : []))
  if (offered.length === 0) return undefined
  const served = new Set(offered.flatMap((state) => state.served))
  const fingerprint = await repositorySkillFingerprint(context.tree.entries.filter(({ path }) => served.has(path)))
  const skills = offered.map(({ entry }) => entry)
  return {
    source: manifestSource({ id: REPOSITORY_SOURCE, fingerprint, skills }),
    fingerprint,
    names: skills.map(({ name }) => name),
  }
}

export async function repositorySkills(context: SkillContext | undefined): Promise<RepositorySkills> {
  if (context === undefined) return NO_SKILLS
  const states = statesOf(context)
  return {
    offered: await skillSourceFor(context),
    shadowed: shadowedSkillFiles(context.tree.entries).map((skill) => ({ name: skill.name, path: bodyPathOf(skill) })),
    unloaded: atsOf(states, "unloaded"),
    invalid: atsOf(states, "invalid"),
    loadsSkipped: unloadedSkillPaths(context).length,
  }
}

export function skillLogs(number: number, skills: RepositorySkills): SkillLog[] {
  const logsOf = (event: SkillLog["event"], ats: readonly SkillAt[]): SkillLog[] =>
    ats.map((at) => ({ event, fields: { number, ...at } }))
  return [
    ...logsOf("skills.shadowed", skills.shadowed),
    ...logsOf("skills.unloaded", skills.unloaded),
    ...logsOf("skills.invalid", skills.invalid),
  ]
}

export function skillsStartFields({ offered, loadsSkipped }: RepositorySkills): SkillStartFields {
  return {
    repoSkills: offered?.names.length ?? 0,
    repoSkillsFingerprint: offered?.fingerprint.slice(0, FINGERPRINT_SHOWN),
    skillLoadsSkipped: loadsSkipped,
  }
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

const keyOf = (sources: readonly SkillSource[]): string =>
  sources.map(({ id, fingerprint }) => `${id}:${fingerprint}`).join("|")

export function catalogFor(builtin: SkillSource, offered: OfferedSkills | undefined): Catalog | undefined {
  if (offered === undefined) return undefined
  const sources = [unlisted(builtin), offered.source]
  return { key: keyOf(sources), sources }
}

export async function installCatalog(
  registry: Registry,
  installed: InstalledCatalog | undefined,
  catalog: Catalog | undefined,
  build: BuildCatalog,
): Promise<InstalledCatalog | undefined> {
  if (catalog === undefined) {
    if (installed !== undefined) registry.uninstall(installed.extension)
    return undefined
  }
  if (installed?.key === catalog.key) return installed
  const extension = await build(catalog.sources)
  registry.install(extension)
  return { key: catalog.key, extension }
}
