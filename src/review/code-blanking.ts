const INLINE_CODE_OR_COMMENT = /<!--[\s\S]*?-->|(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g
const FENCE_OPEN = /^ {0,3}(?:(`{3,})(?![^\n]*`)|(~{3,}))/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const COMMENT_BLOCK = /^ {0,3}<!--/
const COMMENT_END = "-->"
const LIST_MARKER = /^ {0,3}(?:[-*+]|(\d{1,9})[.)])(?:[ \t]+|$)/
const ENDS_PARAGRAPH = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-*_][ \t]*){3,}$|=+[ \t]*$)/
const QUOTE_MARKER = /^ {0,3}> ?/
const CODE_INDENT = 4
const TAB_STOP = 4

interface OpenFence {
  run: string
  indent: number
  quote: number
}

interface BlockScan {
  fence: OpenFence | undefined
  comment: boolean
  lists: number[]
  paragraph: boolean
  quote: number
}

export function withoutCode(text: string): string {
  return blankBlocks(text).replace(INLINE_CODE_OR_COMMENT, blank)
}

function blankBlocks(text: string): string {
  const scan: BlockScan = { fence: undefined, comment: false, lists: [], paragraph: false, quote: 0 }
  return text
    .split("\n")
    .map((line) => blankedLine(scan, line))
    .join("\n")
}

function blankedLine(scan: BlockScan, line: string): string {
  const { depth, rest } = unquoted(line)
  if (scan.fence !== undefined && depth >= scan.fence.quote) return fenceLine(scan, scan.fence, line)
  scan.fence = undefined
  if (scan.comment) return endOfComment(scan, line)
  enterQuote(scan, depth)
  if (rest.trim() === "") {
    scan.paragraph = false
    return line
  }
  return blankedContent(scan, line, rest)
}

function fenceLine(scan: BlockScan, fence: OpenFence, line: string): string {
  const inside = dedented(stripQuotes(line, fence.quote), fence.indent)
  const closer = FENCE_CLOSE.exec(inside)?.[1]
  if (closer !== undefined && closer[0] === fence.run[0] && closer.length >= fence.run.length) {
    scan.fence = undefined
    scan.paragraph = false
  }
  return blank(line)
}

function endOfComment(scan: BlockScan, line: string): string {
  const end = line.indexOf(COMMENT_END)
  if (end < 0) return blank(line)
  scan.comment = false
  scan.paragraph = false
  const after = end + COMMENT_END.length
  return `${blank(line.slice(0, after))}${line.slice(after)}`
}

function enterQuote(scan: BlockScan, depth: number): void {
  if (depth === scan.quote) return
  if (depth < scan.quote && scan.paragraph) return
  scan.quote = depth
  scan.lists = []
  scan.paragraph = false
}

function blankedContent(scan: BlockScan, line: string, rest: string): string {
  const indent = indentOf(rest)
  leaveListsUnlessContinued(scan, rest, indent)
  const container = scan.lists.at(-1) ?? 0
  if (indent - container >= CODE_INDENT && !scan.paragraph) return blank(line)
  return blockStart(scan, line, dedented(rest, container), container)
}

function leaveListsUnlessContinued(scan: BlockScan, rest: string, indent: number): void {
  const top = scan.lists.at(-1)
  if (top === undefined || indent >= top) return
  const opens = FENCE_OPEN.test(rest) || COMMENT_BLOCK.test(rest) || LIST_MARKER.test(rest)
  if (scan.paragraph && !opens) return
  while ((scan.lists.at(-1) ?? -1) > indent) scan.lists.pop()
}

function blockStart(scan: BlockScan, line: string, body: string, container: number): string {
  const fence = FENCE_OPEN.exec(body)
  if (fence !== null) {
    scan.fence = { run: fence[1] ?? fence[2] ?? "", indent: container, quote: scan.quote }
    scan.paragraph = false
    return blank(line)
  }
  if (COMMENT_BLOCK.test(body) && !body.includes(COMMENT_END)) {
    scan.comment = true
    scan.paragraph = false
    return blank(line)
  }
  if (ENDS_PARAGRAPH.test(body)) {
    scan.paragraph = false
    return line
  }
  startList(scan, body, container)
  scan.paragraph = true
  return line
}

function startList(scan: BlockScan, body: string, container: number): void {
  const marker = LIST_MARKER.exec(body)
  if (marker === null) return
  const ordinal = marker[1]
  const interrupts = scan.paragraph && scan.lists.length === 0
  if (interrupts && ordinal !== undefined && Number(ordinal) !== 1) return
  scan.lists.push(container + indentOf(marker[0].replace(/[^ \t]/g, " ")))
}

interface Unquoted {
  depth: number
  rest: string
}

function unquoted(line: string): Unquoted {
  let depth = 0
  let rest = line
  for (let marker = QUOTE_MARKER.exec(rest); marker !== null; marker = QUOTE_MARKER.exec(rest)) {
    depth += 1
    rest = rest.slice(marker[0].length)
  }
  return { depth, rest }
}

function stripQuotes(line: string, depth: number): string {
  let rest = line
  for (let level = 0; level < depth; level++) rest = rest.replace(QUOTE_MARKER, "")
  return rest
}

function indentOf(line: string): number {
  let columns = 0
  for (const character of line) {
    if (character === " ") columns += 1
    else if (character === "\t") columns += TAB_STOP - (columns % TAB_STOP)
    else break
  }
  return columns
}

function dedented(line: string, columns: number): string {
  let used = 0
  let index = 0
  while (index < line.length && used < columns && (line[index] === " " || line[index] === "\t")) {
    used += line[index] === "\t" ? TAB_STOP - (used % TAB_STOP) : 1
    index += 1
  }
  return line.slice(index)
}

function blank(span: string): string {
  return span.replace(/[^\n]/g, " ")
}
