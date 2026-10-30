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
  changes(base: string, head: string): Promise<ChangeAt[]>
  tree(sha: string): Promise<TreeEntryAt[]>
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

  async changes(): Promise<ChangeAt[]> {
    throw new Error("changes is not implemented yet")
  }

  async tree(): Promise<TreeEntryAt[]> {
    throw new Error("tree is not implemented yet")
  }
}

export function patchHunks(diff: string): string | undefined {
  const start = diff.indexOf("@@ ")
  return start < 0 ? undefined : diff.slice(start).trimEnd()
}
