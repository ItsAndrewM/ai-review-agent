import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execute = promisify(execFile)
const MAX_GIT_OUTPUT = 24 * 1024 * 1024

export interface HistoricalFiles {
  read(sha: string, path: string): Promise<string | undefined>
  diff(base: string, head: string, path: string): Promise<string>
  paths(sha: string): Promise<string[]>
}

export interface TreeEntryAt {
  path: string
  type: "blob"
  sha: string
  size: number
  mode: string
}

export interface ChangeAt {
  path: string
  status: "added" | "removed" | "modified" | "renamed"
  additions: number
  deletions: number
  previousPath?: string
}

export interface GitHistory extends HistoricalFiles {
  renameDiff(base: string, head: string, previousPath: string, path: string): Promise<string>
  changes(base: string, head: string): Promise<ChangeAt[]>
  tree(sha: string): Promise<TreeEntryAt[]>
}

const STATUS_OF = { A: "added", D: "removed", M: "modified", R: "renamed" } as const

interface Counts {
  additions: number
  deletions: number
}

function statusOf(code: string): ChangeAt["status"] {
  const letter = code[0]
  return letter === "A" || letter === "D" || letter === "R" ? STATUS_OF[letter] : STATUS_OF.M
}

function countOf(text: string): number {
  const count = Number(text)
  return Number.isSafeInteger(count) ? count : 0
}

export function parseNameStatus(text: string): Omit<ChangeAt, "additions" | "deletions">[] {
  const fields = text.split("\0").filter((field) => field !== "")
  const changes: Omit<ChangeAt, "additions" | "deletions">[] = []
  for (let index = 0; index < fields.length;) {
    const code = fields[index] ?? ""
    const status = statusOf(code)
    if (code.startsWith("R") || code.startsWith("C")) {
      const previousPath = fields[index + 1] ?? ""
      changes.push({ path: fields[index + 2] ?? "", status, previousPath })
      index += 3
    } else {
      changes.push({ path: fields[index + 1] ?? "", status })
      index += 2
    }
  }
  return changes
}

export function parseNumstat(text: string): Map<string, Counts> {
  const counts = new Map<string, Counts>()
  const fields = text.split("\0")
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? ""
    const [additions = "", deletions = "", path = ""] = field.split("\t")
    if (additions === "") continue
    const key = path === "" ? (fields[index + 2] ?? "") : path
    if (path === "") index += 2
    counts.set(key, { additions: countOf(additions), deletions: countOf(deletions) })
  }
  return counts
}

export function parseTree(text: string): TreeEntryAt[] {
  return text
    .split("\0")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const [meta = "", path = ""] = line.split("\t")
      const [mode = "", type = "", sha = "", size = ""] = meta.split(/\s+/)
      return type === "blob" ? [{ path, type, sha, size: countOf(size), mode }] : []
    })
}

export class GitFiles implements GitHistory {
  readonly #root: string
  readonly #paths = new Map<string, Promise<string[]>>()

  constructor(root: string) {
    this.#root = root
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await execute("git", args, {
      cwd: this.#root,
      env: { ...process.env, GIT_MASTER: "1" },
      maxBuffer: MAX_GIT_OUTPUT,
      encoding: "utf8",
    })
    return stdout
  }

  paths(sha: string): Promise<string[]> {
    const known =
      this.#paths.get(sha) ??
      this.git("ls-tree", "-r", "-z", "--name-only", sha).then((text) => text.split("\0").filter(Boolean))
    this.#paths.set(sha, known)
    return known
  }

  async read(sha: string, path: string): Promise<string | undefined> {
    if (!(await this.paths(sha)).includes(path)) return undefined
    return this.git("show", `${sha}:${path}`)
  }

  diff(base: string, head: string, path: string): Promise<string> {
    return this.git("diff", base, head, "--", path)
  }

  renameDiff(base: string, head: string, previousPath: string, path: string): Promise<string> {
    return this.git("diff", "-M", base, head, "--", previousPath, path)
  }

  async changes(base: string, head: string): Promise<ChangeAt[]> {
    const [names, numbers] = await Promise.all([
      this.git("diff", "-M", "--name-status", "-z", base, head),
      this.git("diff", "-M", "--numstat", "-z", base, head),
    ])
    const counts = parseNumstat(numbers)
    return parseNameStatus(names).map((change) => ({
      ...change,
      ...(counts.get(change.path) ?? { additions: 0, deletions: 0 }),
    }))
  }

  async tree(sha: string): Promise<TreeEntryAt[]> {
    return parseTree(await this.git("ls-tree", "-r", "-l", "-z", sha))
  }
}

export function patchHunks(diff: string): string | undefined {
  const start = diff.indexOf("@@ ")
  return start < 0 ? undefined : diff.slice(start).trimEnd()
}
