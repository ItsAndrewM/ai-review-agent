import { beforeAll, describe, expect, it } from "vitest"
import { lintProbes } from "./probes.ts"

const ASSERTION = `JSON.parse("1") as number`

const CASES = [
  {
    comment: "above an exported const",
    source: `// SAFETY: probe\nexport const value = ${ASSERTION}\n`,
    accepted: true,
  },
  {
    comment: "above a local const",
    source: `// SAFETY: probe\nconst value = ${ASSERTION}\nexport { value }\n`,
    accepted: true,
  },
  { comment: "above export default", source: `// SAFETY: probe\nexport default ${ASSERTION}\n`, accepted: true },
  { comment: "missing", source: `export const value = ${ASSERTION}\n`, accepted: false },
  {
    comment: "above the exported class, not its field",
    source: `// SAFETY: probe\nexport class Holder {\n  value = ${ASSERTION}\n}\n`,
    accepted: false,
  },
].map((probe, i) => ({ ...probe, path: `test/lint/safety-probe-${i}.ts` }))

describe("SAFETY comments on type assertions", () => {
  let reported: ReadonlySet<string>
  beforeAll(() => {
    reported = new Set(
      lintProbes(CASES)
        .filter((d) => d.code === "anti-slop(require-safety-comment-for-type-assertion)")
        .map((d) => d.filename),
    )
  })

  it.each(CASES)("comment $comment → assertion accepted: $accepted", ({ path, accepted }) => {
    expect(reported.has(path)).toBe(!accepted)
  })
})
