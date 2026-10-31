import { readFile } from "node:fs/promises"
import type { ChangedFile } from "../../src/github/diff.ts"
import { NO_DOCS, reviewPrompt, systemPrompt } from "../../src/review/prompt.ts"
import {
  buildSkillManifest,
  fingerprintOf,
  manifestSource,
  renderSkillWithResources,
  type SkillFile,
} from "../../src/review/skills.ts"
import { pullRequestOf, type HeadCase } from "./schema.ts"

const BUNDLED_SKILL_PATHS = [
  "answer/SKILL.md",
  "review/CREDITS.md",
  "review/SKILL.md",
  "review/references/merge-danger.md",
  "review/references/severity.md",
  "review/references/smells.md",
  "review/references/tests.md",
  "summary/SKILL.md",
  "verify/SKILL.md",
] as const

export interface ReviewSkill {
  readonly rendered: string
  readonly fingerprint: string
}

export async function reviewSkillFiles(): Promise<SkillFile[]> {
  return Promise.all(
    BUNDLED_SKILL_PATHS.map(async (path) => ({
      path,
      content: await readFile(new URL(`../../skills/${path}`, import.meta.url), "utf8"),
    })),
  )
}

export async function reviewSkill(): Promise<ReviewSkill> {
  const files = await reviewSkillFiles()
  const fingerprint = await fingerprintOf(files)
  const source = manifestSource(buildSkillManifest(files, fingerprint))
  const skill = await source.load("review")
  if (skill === null) throw new Error("The review skill is missing from skills/")
  const references = await Promise.all(
    (skill.resources ?? [])
      .filter(({ kind }) => kind === "reference")
      .map(async ({ path }) => {
        const reference = await source.readResource?.("review", path)
        if (reference === null || reference === undefined)
          throw new Error(`The review skill's reference ${path} is missing`)
        return reference
      }),
  )
  return { rendered: renderSkillWithResources(skill, references), fingerprint }
}

function instructionsOf(skill: string, standards: string): string {
  return [skill, standards].filter((section) => section !== "").join("\n\n")
}

export function systemFor(botLogin: string, toolNames: readonly string[], skill: string, standards: string): string {
  return `${systemPrompt(botLogin, toolNames)}\n\n<instructions>\n${instructionsOf(skill, standards)}\n</instructions>`
}

export function promptFor(head: HeadCase, files: readonly ChangedFile[]): string {
  return reviewPrompt(pullRequestOf(head), files, true, head.issues, NO_DOCS)
}
