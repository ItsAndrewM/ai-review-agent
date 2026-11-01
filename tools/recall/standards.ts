import type { TreeEntry } from "../../src/github/client.ts"
import { configFileOf } from "../../src/names.ts"
import { DEFAULT_CONFIG, parseConfig, type AndabotConfig } from "../../src/repository/config.ts"
import { instructionCandidates, orderedStandards, renderStandards } from "../../src/repository/instructions.ts"
import type { GitHistory } from "../replay/git.ts"

export interface BaseStandards {
  text: string
  pathFilters: string[]
  used: string[]
}

async function configAt(git: GitHistory, base: string): Promise<AndabotConfig> {
  const text = await git.read(base, configFileOf("andabot"))
  return text === undefined ? DEFAULT_CONFIG : parseConfig(text, true).config
}

async function loadedBodies(git: GitHistory, base: string, paths: readonly string[]) {
  const bodies = await Promise.all(
    paths.map(async (path) => {
      const text = await git.read(base, path)
      return text === undefined ? [] : [{ path, text }]
    }),
  )
  return bodies.flat()
}

export async function standardsAt(git: GitHistory, base: string, changed: readonly string[]): Promise<BaseStandards> {
  const config = await configAt(git, base)
  const entries: TreeEntry[] = await git.tree(base)
  const loaded = await loadedBodies(git, base, instructionCandidates(entries, changed))
  const rendered = renderStandards(
    orderedStandards(loaded, changed, config.reviews.path_instructions, configFileOf("andabot")),
  )
  return { text: rendered.text, pathFilters: [...config.reviews.path_filters], used: rendered.used }
}
