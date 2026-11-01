import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { PullRequestInfo } from "../src/github/client.ts"
import {
  CLOSES_END,
  CLOSES_START,
  closesBlock,
  closesBlockOf,
  closesOf,
  refText,
  withClosesBlock,
  type Closes,
} from "../src/review/closes.ts"

const REPO = "ItsAndrewM/ai-review-agent"

const closed = (body: string | null): string[] => closesOf(body, REPO).closes.map(refText)

const listed = (closes: Closes): string[] =>
  closes.listed.map((entry) => `${refText(entry.ref)} after "${entry.separator}"`)

describe("closesOf", () => {
  it("reads each of the nine keywords, in any case and with a colon", () => {
    const keywords = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]
    keywords.forEach((keyword, index) => expect(closed(`${keyword} #${index + 1}`)).toEqual([`#${index + 1}`]))
    expect(closed("CLOSED #122")).toEqual(["#122"])
    expect(closed("Fixes: #123")).toEqual(["#123"])
  })

  it("reads another repository's reference in full, and collapses this repository's to #n", () => {
    expect(closed("Fixes octo/repo#100")).toEqual(["octo/repo#100"])
    expect(closed(`Resolves ${REPO}#120`)).toEqual(["#120"])
    expect(closed(`Closes https://github.com/${REPO}/issues/121`)).toEqual(["#121"])
    expect(closed("Closes https://github.com/octo/repo/issues/7")).toEqual(["octo/repo#7"])
  })

  it("closes only the first reference of a list, and names each later one with its separator", () => {
    const pair = closesOf("Closes #140 and #138", REPO)
    expect(pair.closes.map(refText)).toEqual(["#140"])
    expect(listed(pair)).toEqual(['#138 after "and"'])
    const run = closesOf("Fixes #1, #2 and #3 & #4 or #5", REPO)
    expect(run.closes.map(refText)).toEqual(["#1"])
    expect(listed(run)).toEqual(['#2 after ","', '#3 after "and"', '#4 after "&"', '#5 after "or"'])
    expect(listed(closesOf("Fixes #1, and #2", REPO))).toEqual(['#2 after ", and"'])
  })

  it("closes nothing with no whitespace after the keyword, inside a word, or with no reference", () => {
    expect(closed("fixes#119")).toEqual([])
    expect(closed("prefixes #115")).toEqual([])
    expect(closed("This closes the loop.")).toEqual([])
  })

  it("skips inline code, fenced code with or without a language, and HTML comments, as GitHub does", () => {
    expect(closed("`Fixes #133`")).toEqual([])
    expect(closed("```\nResolves #132\n```")).toEqual([])
    expect(closed("```md\nCloses #9 and #10\n```\nCloses #11")).toEqual(["#11"])
    expect(closed("<!-- Closes #131 -->")).toEqual([])
    expect(closed("<!-- an unclosed template comment\nCloses #8")).toEqual([])
    expect(listed(closesOf("Write `Closes #80 and #100` instead.", REPO))).toEqual([])
  })

  it("reads a keyword in a blockquote or in bold", () => {
    expect(closed("> Fixes #125")).toEqual(["#125"])
    expect(closed("**Closes #118**")).toEqual(["#118"])
  })

  it("marks a close with a negation in the three words before its keyword, in the same clause", () => {
    const negated = (body: string): string[] => closesOf(body, REPO).negated.map((entry) => entry.phrase)
    expect(negated("Merging won't close #124")).toEqual(["won't close #124"])
    expect(negated("This will not fix #4")).toEqual(["not fix #4"])
    expect(negated("It doesn’t resolve #8 yet")).toEqual(["doesn’t resolve #8"])
    expect(negated("This doesn't fix the flake; closes #5")).toEqual([])
    expect(negated("Not now, maybe later we close #7")).toEqual([])
    expect(negated("It no longer fixes #3")).toEqual(["no longer fixes #3"])
    expect(closed("Merging won't close #124")).toEqual(["#124"])
  })

  it("lists each issue once, and drops a listed one that its own keyword closes elsewhere", () => {
    expect(closed("Closes #1. Fixes #1.")).toEqual(["#1"])
    const both = closesOf("Closes #1 and #2. Closes #2.", REPO)
    expect(both.closes.map(refText)).toEqual(["#1", "#2"])
    expect(both.listed).toEqual([])
  })

  it("closes nothing for no description", () => {
    expect(closesOf(null, REPO)).toEqual({ closes: [], listed: [], negated: [] })
  })
})

describe("closesBlock", () => {
  const block = (body: string, base = "main", defaultBranch: string | undefined = "main"): string[] =>
    closesBlock(closesOf(body, REPO), base, defaultBranch)

  it("wraps the close line in the markers, joining the issues with commas and a final and", () => {
    expect(block("Closes #80")).toEqual([
      CLOSES_START,
      "<sub>Merging closes #80 (from the description).</sub>",
      CLOSES_END,
    ])
    expect(block("Closes #1. Fixes octo/repo#100. Resolves #3.")[1]).toBe(
      "<sub>Merging closes #1, octo/repo#100 and #3 (from the description).</sub>",
    )
  })

  it("warns above the close line about each listed reference and each negated close", () => {
    expect(block("Closes #80 and #100. Merging won't close #6.")).toEqual([
      CLOSES_START,
      '⚠️ #100 follows "and" after a keyword, so merging won\'t close it. Repeat the keyword for each issue: "Closes #80, closes #100".',
      '⚠️ "won\'t close #6" still closes #6 on merge: GitHub ignores the "won\'t". Name it without a keyword to leave it open, such as "Part of #6".',
      "<sub>Merging closes #80 and #6 (from the description).</sub>",
      CLOSES_END,
    ])
    expect(block("Fixes #1, #2 and #3")[2]).toBe(
      '⚠️ #3 follows "and" after a keyword, so merging won\'t close it. Repeat the keyword for each issue: "Fixes #1, fixes #2, fixes #3".',
    )
  })

  it("says nothing between the markers when the description has no closing keyword", () => {
    expect(block("Part of #6.")).toEqual([CLOSES_START, CLOSES_END])
  })

  it("says merging closes nothing off the default branch, without the list or warnings", () => {
    expect(block("Closes #80 and #100", "staging", "main")).toEqual([
      CLOSES_START,
      "<sub>Merging into `staging` closes no issue: GitHub closes them only on a merge into `main`.</sub>",
      CLOSES_END,
    ])
    expect(block("Part of #6.", "staging", "main")).toEqual([CLOSES_START, CLOSES_END])
  })

  it("takes a base with no known default branch as the default", () => {
    expect(closesBlock(closesOf("Closes #80", REPO), "staging", undefined)[1]).toBe(
      "<sub>Merging closes #80 (from the description).</sub>",
    )
  })
})

describe("withClosesBlock", () => {
  const comment = ["<!-- andabot:summary -->", "body", CLOSES_START, "<sub>old</sub>", CLOSES_END, "footer"].join("\n")

  it("replaces only the text between the markers", () => {
    expect(withClosesBlock(comment, [CLOSES_START, "<sub>new</sub>", CLOSES_END])).toBe(
      ["<!-- andabot:summary -->", "body", CLOSES_START, "<sub>new</sub>", CLOSES_END, "footer"].join("\n"),
    )
  })

  it("answers nothing for a comment without the markers, or when the block is unchanged", () => {
    expect(withClosesBlock("<!-- andabot:summary -->\nolder comment", [CLOSES_START, CLOSES_END])).toBeUndefined()
    expect(withClosesBlock(comment, [CLOSES_START, "<sub>old</sub>", CLOSES_END])).toBeUndefined()
  })
})

describe("closesBlockOf", () => {
  const repoOf = (defaultBranch: string | undefined): PullRequestInfo["base"]["repo"] =>
    defaultBranch === undefined ? { full_name: REPO } : { full_name: REPO, default_branch: defaultBranch }
  const pr = (body: string | null, ref: string, defaultBranch?: string): PullRequestInfo => ({
    number: 5,
    title: "t",
    body,
    state: "open",
    user: { login: "a" },
    base: { ref, sha: "b", repo: repoOf(defaultBranch) },
    head: { ref: "h", sha: "c" },
    changed_files: 1,
    additions: 1,
    deletions: 0,
    labels: [],
  })

  it("reads the description, the base and the repository's default branch from the pull request", () => {
    expect(closesBlockOf(pr("Closes #80", "main", "main"))[1]).toBe(
      "<sub>Merging closes #80 (from the description).</sub>",
    )
    expect(closesBlockOf(pr("Closes #80", "staging", "main"))[1]).toContain("Merging into `staging` closes no issue")
    expect(Value.Check(PullRequestInfo, pr("Closes #80", "main", "main"))).toBe(true)
    expect(Value.Check(PullRequestInfo, pr(null, "main"))).toBe(true)
  })
})
