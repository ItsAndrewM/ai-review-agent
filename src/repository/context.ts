import { Type } from "typebox"
import type { GitHubClient, RepoRef, RepositoryTree } from "../github/client.ts"
import { errorText } from "../log.ts"
import {
  instructionCandidates,
  isRootFile,
  orderedStandards,
  renderStandards,
  type RenderedStandards,
} from "./instructions.ts"

export interface RepositoryContext {
  readonly baseSha: string
  readonly tree: RepositoryTree
  readonly files: Readonly<Record<string, string>>
}

export interface ReviewStandards extends RenderedStandards {
  loadsSkipped: number
  treeTruncated: boolean
}

type ReportUnreadable = (error: string) => void

type PathInstructions = readonly { path: string; instructions: string }[]

export const StoredRepositoryContext = Type.Object({
  baseSha: Type.String(),
  tree: Type.Object({
    sha: Type.String(),
    truncated: Type.Boolean(),
    entries: Type.Array(
      Type.Object({
        path: Type.String(),
        type: Type.Union([Type.Literal("blob"), Type.Literal("tree")]),
        sha: Type.String(),
      }),
    ),
  }),
  files: Type.Record(Type.String(), Type.String()),
})

export const MAX_INSTRUCTION_LOADS = 24

export const CONTEXT_PREFIX = "context:"

const MISSING_AT_BASE = ""

export const contextKey = (baseSha: string): string => `${CONTEXT_PREFIX}${baseSha}`

export function staleContextKeys(keys: readonly string[], baseSha: string): string[] {
  const current = contextKey(baseSha)
  return keys.filter((key) => key.startsWith(CONTEXT_PREFIX) && key !== current)
}

const isCached = (context: RepositoryContext, path: string): boolean => Object.hasOwn(context.files, path)

const cachedBody = (context: RepositoryContext, path: string): string | undefined =>
  isCached(context, path) ? context.files[path] : undefined

export function unloadedPaths(context: RepositoryContext, changed: readonly string[]): string[] {
  return instructionCandidates(context.tree.entries, changed).filter((path) => !isCached(context, path))
}

const contextAt = async (
  github: GitHubClient,
  ref: RepoRef,
  baseSha: string,
  cached: RepositoryContext | undefined,
): Promise<RepositoryContext> =>
  cached?.baseSha === baseSha ? cached : { baseSha, tree: await github.getTree(ref, baseSha), files: {} }

const rootFirst = (paths: readonly string[]): string[] => [
  ...paths.filter(isRootFile),
  ...paths.filter((path) => !isRootFile(path)),
]

const loadedFile = async (
  github: GitHubClient,
  ref: RepoRef,
  baseSha: string,
  path: string,
): Promise<[string, string]> => [path, (await github.getFileContent(ref, path, baseSha)) ?? MISSING_AT_BASE]

export async function loadRepositoryContext(
  github: GitHubClient,
  ref: RepoRef,
  baseSha: string,
  changed: readonly string[],
  cached?: RepositoryContext,
): Promise<RepositoryContext> {
  const context = await contextAt(github, ref, baseSha, cached)
  const paths = rootFirst(unloadedPaths(context, changed)).slice(0, MAX_INSTRUCTION_LOADS)
  if (paths.length === 0) return context
  const loaded = await Promise.all(paths.map((path) => loadedFile(github, ref, baseSha, path)))
  return { ...context, files: { ...context.files, ...Object.fromEntries(loaded) } }
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
  pathInstructions: PathInstructions,
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
  pathInstructions: PathInstructions,
): ReviewStandards {
  if (context === undefined) return { text: "", used: [], cut: [], loadsSkipped: 0, treeTruncated: false }
  return {
    ...standardsFor(context, changed, pathInstructions),
    loadsSkipped: unloadedPaths(context, changed).length,
    treeTruncated: context.tree.truncated,
  }
}

export function reviewInstructions(skill: string, standards: string): string {
  return standards === "" ? skill : `${skill}\n\n${standards}`
}
