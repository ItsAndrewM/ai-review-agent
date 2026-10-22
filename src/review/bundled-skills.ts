import type { SkillSource } from "agents/skills"
import answerSkill from "../../skills/answer/SKILL.md"
import reviewCredits from "../../skills/review/CREDITS.md"
import mergeDangerReference from "../../skills/review/references/merge-danger.md"
import severityReference from "../../skills/review/references/severity.md"
import smellsReference from "../../skills/review/references/smells.md"
import testsReference from "../../skills/review/references/tests.md"
import reviewSkill from "../../skills/review/SKILL.md"
import { buildSkillManifest, fingerprintOf, manifestSource, type SkillFile } from "./skills.ts"

export const BUNDLED_SKILL_FILES: readonly SkillFile[] = [
  { path: "answer/SKILL.md", content: answerSkill },
  { path: "review/CREDITS.md", content: reviewCredits },
  { path: "review/SKILL.md", content: reviewSkill },
  { path: "review/references/merge-danger.md", content: mergeDangerReference },
  { path: "review/references/severity.md", content: severityReference },
  { path: "review/references/smells.md", content: smellsReference },
  { path: "review/references/tests.md", content: testsReference },
]

const SKILL_FILE_SUFFIX = "/SKILL.md"

export const BUNDLED_SKILL_NAMES = new Set(
  BUNDLED_SKILL_FILES.flatMap(({ path }) =>
    path.endsWith(SKILL_FILE_SUFFIX) ? [path.slice(0, -SKILL_FILE_SUFFIX.length)] : [],
  ),
)

export interface BundledSkills {
  readonly source: SkillSource
  readonly fingerprint: string
}

const assemble = async (): Promise<BundledSkills> => {
  const fingerprint = await fingerprintOf(BUNDLED_SKILL_FILES)
  return { source: manifestSource(buildSkillManifest(BUNDLED_SKILL_FILES, fingerprint)), fingerprint }
}

let assembled: Promise<BundledSkills> | undefined

export function bundledSkills(): Promise<BundledSkills> {
  assembled ??= assemble()
  return assembled
}
