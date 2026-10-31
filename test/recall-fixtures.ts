import type { ExpectedFinding, HeadCase } from "../tools/recall/schema.ts"

export const expected = {
  id: "9-1",
  path: "src/example.ts",
  lines: [10, 12],
  severity: "blocking",
  basis_kind: "defect",
  scenario: "An empty input returns the wrong total.",
  pattern: "wrong total|empty input",
  evidence: "answer key on #2",
} satisfies ExpectedFinding

export function expecting(id: string, changes: Partial<ExpectedFinding> = {}): ExpectedFinding {
  return { ...expected, id, ...changes }
}

export function headCase(changes: Partial<HeadCase> = {}): HeadCase {
  return {
    pr: 9,
    head: "a".repeat(40),
    base: "b".repeat(40),
    title: "Tidy the example",
    body: "Fixture pull request, never merge.",
    author: "ItsAndrewM",
    headRef: "chore/tidy-the-example",
    baseRef: "main",
    labels: [],
    issues: [],
    expects: [expected],
    allowed: [],
    knownFalse: [],
    stats: { files: 1, additions: 3, deletions: 1 },
    ...changes,
  }
}
