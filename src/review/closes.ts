export interface IssueRef {
  repo: string | undefined
  number: number
}

export interface ListedRef {
  ref: IssueRef
  separator: string
  keyword: string
  first: IssueRef
}

export interface NegatedClose {
  ref: IssueRef
  phrase: string
  negation: string
}

export interface Closes {
  closes: IssueRef[]
  listed: ListedRef[]
  negated: NegatedClose[]
}

const KEYWORD = String.raw`(?<![\p{L}\p{N}_])(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?![\p{L}\p{N}_])`
const REFERENCE = String.raw`(https://github\.com/([\w.-]+/[\w.-]+)/issues/(\d+)|([\w.-]+/[\w.-]+)#(\d+)|#(\d+))(?![\p{L}\p{N}_])`
const CLOSE = new RegExp(`${KEYWORD}:?\\s+${REFERENCE}`, "giu")
const NEXT = new RegExp(`\\s*(,\\s*and|,|and|&|or)\\s+${REFERENCE}`, "iuy")
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$(?![\s\S]))/g
const INLINE_CODE = /(`+)[^`][\s\S]*?\1/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CLAUSE_END = /[.!?;\n]/g
const WORD = /\S+/g
const NEGATIONS = new Set(["not", "never", "without"])
const NEGATION_WINDOW = 3

interface Found {
  closes: Map<string, IssueRef>
  listed: Map<string, ListedRef>
  negated: Map<string, NegatedClose>
}

export function refText(ref: IssueRef): string {
  return ref.repo === undefined ? `#${ref.number}` : `${ref.repo}#${ref.number}`
}

export function closesOf(body: string | null, repo: string): Closes {
  const text = body ?? ""
  const readable = withoutCode(text)
  const found: Found = { closes: new Map(), listed: new Map(), negated: new Map() }
  for (const match of readable.matchAll(CLOSE)) recordClose(found, text, readable, match, repo)
  const listed = [...found.listed].filter(([key]) => !found.closes.has(key)).map(([, entry]) => entry)
  return { closes: [...found.closes.values()], listed, negated: [...found.negated.values()] }
}

function recordClose(found: Found, text: string, readable: string, match: RegExpMatchArray, repo: string): void {
  const ref = refFrom(match, repo)
  const start = match.index ?? 0
  const end = start + match[0].length
  const key = refText(ref)
  if (!found.closes.has(key)) found.closes.set(key, ref)
  const negated = negationBefore(text, start, end, ref)
  if (negated !== undefined && !found.negated.has(key)) found.negated.set(key, negated)
  recordListed(found, readable, end, { keyword: match[1] ?? "", first: ref }, repo)
}

function recordListed(
  found: Found,
  readable: string,
  from: number,
  close: Pick<ListedRef, "keyword" | "first">,
  repo: string,
): void {
  NEXT.lastIndex = from
  for (let next = NEXT.exec(readable); next !== null; next = NEXT.exec(readable)) {
    const ref = refFrom(next, repo)
    const separator = (next[1] ?? "").replace(/\s+/g, " ")
    const key = refText(ref)
    if (!found.listed.has(key)) found.listed.set(key, { ref, separator, ...close })
  }
}

function refFrom(match: RegExpMatchArray, repo: string): IssueRef {
  const named = match[3] ?? match[5]
  const number = Number(match[4] ?? match[6] ?? match[7])
  const other = named !== undefined && named.toLowerCase() !== repo.toLowerCase()
  return { repo: other ? named : undefined, number }
}

function negationBefore(text: string, start: number, end: number, ref: IssueRef): NegatedClose | undefined {
  const clauseStart = lastClauseEnd(text.slice(0, start))
  const words = [...text.slice(clauseStart, start).matchAll(WORD)].slice(-NEGATION_WINDOW)
  const index = words.findIndex((word, at) => negates(word[0], words[at + 1]?.[0]))
  const word = words[index]
  if (word === undefined) return undefined
  const from = clauseStart + (word.index ?? 0)
  return { ref, phrase: text.slice(from, end).replace(/\s+/g, " "), negation: plainWord(word[0]) }
}

function lastClauseEnd(before: string): number {
  const ends = [...before.matchAll(CLAUSE_END)]
  const last = ends.at(-1)
  return last === undefined ? 0 : (last.index ?? 0) + 1
}

function negates(word: string, next: string | undefined): boolean {
  const plain = plainWord(word)
  if (NEGATIONS.has(plain) || plain.endsWith("n't") || plain.endsWith("n’t")) return true
  return plain === "no" && next !== undefined && plainWord(next) === "longer"
}

function plainWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}'’]/gu, "")
}

function withoutCode(text: string): string {
  return blankInlineCode(blankFences(text.replace(HTML_COMMENT, blank)))
}

function blankFences(text: string): string {
  let fence: string | undefined
  return text
    .split("\n")
    .map((line) => {
      const opener = FENCE.exec(line)?.[1]
      if (fence !== undefined) {
        if (closesFence(opener, fence)) fence = undefined
        return blank(line)
      }
      if (opener === undefined) return line
      fence = opener
      return blank(line)
    })
    .join("\n")
}

function closesFence(opener: string | undefined, fence: string): boolean {
  return opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length
}

function blankInlineCode(text: string): string {
  return text.replace(INLINE_CODE, blank)
}

function blank(span: string): string {
  return span.replace(/[^\n]/g, " ")
}
