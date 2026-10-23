import { Type } from "typebox"
import type { GitHubClient, RepoRef, RepositoryTree, TreeEntry } from "../github/client.ts"
import type { ChangedFile } from "../github/diff.ts"
import { errorText } from "../log.ts"
import type { StoredPending } from "../review/flight.ts"
import {
  instructionCandidates,
  mayBeInstructionFile,
  orderedStandards,
  renderStandards,
  sourceOf,
  type PathInstruction,
  type RenderedStandards,
  type StandardSource,
} from "./instructions.ts"
import {
  isUnderSkillRoot,
  repositorySkills,
  unloadedSkillBodies,
  unloadedSkillResources,
  type RepositorySkills,
} from "./skills.ts"

export interface RepositoryContext {
  readonly baseSha: string
  readonly tree: RepositoryTree
  readonly files: Readonly<Record<string, string>>
}

export interface ReviewStandards extends RenderedStandards {
  loadsSkipped: number
  treeTruncated: boolean
}

export interface ReviewRepository {
  readonly context: RepositoryContext | undefined
  readonly standards: ReviewStandards
  readonly skills: RepositorySkills
}

export type RepositoryRecord = Pick<StoredPending, "instructionFiles" | "repoSkillsFingerprint">

export interface ContextInputs {
  readonly baseSha: string
  readonly changed: string[]
}

type ReportUnreadable = (error: string) => void

type ReportUnreadableFile = (path: string, error: string) => void

type ReadFile = (path: string) => Promise<string | undefined>

export const StoredRepositoryContext = Type.Object({
  baseSha: Type.String(),
  tree: Type.Object({
    sha: Type.String(),
    truncated: Type.Boolean(),
    entries: Type.Array(
      Type.Object({ path: Type.String(), type: Type.Literal("blob"), sha: Type.String(), size: Type.Integer() }),
    ),
  }),
  files: Type.Record(Type.String(), Type.String()),
})

export const MAX_INSTRUCTION_LOADS = 24

export const CONTEXT_PREFIX = "context:"

const MISSING_AT_BASE = ""

const LOAD_ORDER = ["root", "nested", "instructions"] as const satisfies readonly StandardSource[]

export const contextKey = (baseSha: string): string => `${CONTEXT_PREFIX}${baseSha}`

export function staleContextKeys(keys: readonly string[], baseSha: string): string[] {
  const current = contextKey(baseSha)
  return keys.filter((key) => key.startsWith(CONTEXT_PREFIX) && key !== current)
}

export function contextInputs(
  pr: { base: { sha: string } },
  files: readonly Pick<ChangedFile, "filename">[],
): ContextInputs {
  return { baseSha: pr.base.sha, changed: files.map(({ filename }) => filename) }
}

const mayMatter = ({ path, type, size }: TreeEntry): boolean =>
  type === "blob" && size !== undefined && (mayBeInstructionFile(path) || isUnderSkillRoot(path))

export const entriesThatMatter = (entries: readonly TreeEntry[]): TreeEntry[] => entries.filter(mayMatter)

const isCached = (context: RepositoryContext, path: string): boolean => Object.hasOwn(context.files, path)

const cachedBody = (context: RepositoryContext, path: string): string | undefined =>
  isCached(context, path) ? context.files[path] : undefined

export function unloadedPaths(context: RepositoryContext, changed: readonly string[]): string[] {
  return instructionCandidates(context.tree.entries, changed).filter((path) => !isCached(context, path))
}

const inLoadOrder = (paths: readonly string[]): string[] =>
  LOAD_ORDER.flatMap((source) => paths.filter((path) => sourceOf(path) === source))

const contextAt = async (
  github: GitHubClient,
  ref: RepoRef,
  baseSha: string,
  cached: RepositoryContext | undefined,
): Promise<RepositoryContext> => {
  if (cached?.baseSha === baseSha) return cached
  const tree = await github.getTree(ref, baseSha)
  return { baseSha, tree: { ...tree, entries: entriesThatMatter(tree.entries) }, files: {} }
}

const loadedFile = async (
  read: ReadFile,
  path: string,
  unreadable: ReportUnreadableFile,
): Promise<[string, string][]> => {
  try {
    return [[path, (await read(path)) ?? MISSING_AT_BASE]]
  } catch (cause) {
    unreadable(path, errorText(cause))
    return []
  }
}

const withLoaded = async (
  context: RepositoryContext,
  paths: readonly string[],
  read: ReadFile,
  unreadable: ReportUnreadableFile,
): Promise<RepositoryContext> => {
  const loaded = (await Promise.all(paths.map((path) => loadedFile(read, path, unreadable)))).flat()
  if (loaded.length === 0) return context
  return { ...context, files: { ...context.files, ...Object.fromEntries(loaded) } }
}

export async function loadRepositoryContext(
  github: GitHubClient,
  ref: RepoRef,
  baseSha: string,
  changed: readonly string[],
  unreadable: ReportUnreadableFile,
  cached?: RepositoryContext,
): Promise<RepositoryContext> {
  const context = await contextAt(github, ref, baseSha, cached)
  const read: ReadFile = (path) => github.getFileContent(ref, path, baseSha)
  const ahead = new Set([...inLoadOrder(unloadedPaths(context, changed)), ...unloadedSkillBodies(context)])
  const first = [...ahead].slice(0, MAX_INSTRUCTION_LOADS)
  const withBodies = await withLoaded(context, first, read, unreadable)
  const attempted = new Set(first)
  const resources = unloadedSkillResources(withBodies).filter((path) => !attempted.has(path))
  return withLoaded(withBodies, resources.slice(0, MAX_INSTRUCTION_LOADS - first.length), read, unreadable)
}

export async function readRepositoryContext(
  load: () => Promise<RepositoryContext>,
  unreadable: ReportUnreadable,
): Promise<RepositoryContext | undefined> {
  try {
    return await load()
  } catch (cause) {
    unreadable(errorText(cause))
    return undefined
  }
}

export function standardsFor(
  context: RepositoryContext,
  changed: readonly string[],
  pathInstructions: readonly PathInstruction[],
): RenderedStandards {
  const loaded = instructionCandidates(context.tree.entries, changed).flatMap((path) => {
    const text = cachedBody(context, path)
    return text === undefined ? [] : [{ path, text }]
  })
  return renderStandards(orderedStandards(loaded, changed, pathInstructions))
}

export function reviewStandards(
  context: RepositoryContext | undefined,
  changed: readonly string[],
  pathInstructions: readonly PathInstruction[],
): ReviewStandards {
  if (context === undefined) {
    const configured = renderStandards(orderedStandards([], changed, pathInstructions))
    return { ...configured, loadsSkipped: 0, treeTruncated: false }
  }
  return {
    ...standardsFor(context, changed, pathInstructions),
    loadsSkipped: unloadedPaths(context, changed).length,
    treeTruncated: context.tree.truncated,
  }
}

export async function reviewRepository(
  context: RepositoryContext | undefined,
  changed: readonly string[],
  pathInstructions: readonly PathInstruction[],
): Promise<ReviewRepository> {
  return {
    context,
    standards: reviewStandards(context, changed, pathInstructions),
    skills: await repositorySkills(context),
  }
}

export function repositoryRecord({ standards, skills }: ReviewRepository): RepositoryRecord {
  const instructionFiles = [...standards.used]
  return skills.offered === undefined
    ? { instructionFiles }
    : { instructionFiles, repoSkillsFingerprint: skills.offered.fingerprint }
}

export function reviewInstructions(skill: string, sections: readonly string[]): string {
  return [skill, ...sections.filter((section) => section !== "")].join("\n\n")
}
