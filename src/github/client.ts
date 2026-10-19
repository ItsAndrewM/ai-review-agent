import { Type, type Static, type TSchema } from "typebox"
import { Value } from "typebox/value"
import { ChangedFile, type Side } from "./diff.ts"

export interface RepoRef {
  owner: string
  repo: string
}

export const PullRequestInfo = Type.Object({
  number: Type.Integer(),
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  state: Type.String(),
  user: Type.Object({ login: Type.String() }),
  base: Type.Object({ ref: Type.String(), sha: Type.String(), repo: Type.Object({ full_name: Type.String() }) }),
  head: Type.Object({ ref: Type.String(), sha: Type.String() }),
  changed_files: Type.Integer(),
  additions: Type.Integer(),
  deletions: Type.Integer(),
  labels: Type.Array(Type.Object({ name: Type.String() })),
})

export type PullRequestInfo = Static<typeof PullRequestInfo>

export const IssueComment = Type.Object({ id: Type.Integer(), body: Type.Optional(Type.String()) })

export type IssueComment = Static<typeof IssueComment>

export const Issue = Type.Object({
  number: Type.Integer(),
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  state: Type.String(),
  pull_request: Type.Optional(Type.Object({})),
})

export type Issue = Static<typeof Issue>

const ChangedFiles = Type.Array(ChangedFile)
const IssueComments = Type.Array(IssueComment)
const CreatedReview = Type.Object({ id: Type.Integer() })
const CheckRun = Type.Object({ id: Type.Integer() })
const CollaboratorPermission = Type.Object({ permission: Type.String() })

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT"

export interface ReviewComment {
  path: string
  body: string
  line: number
  side: Side
  start_line?: number
  start_side?: Side
}

export interface CreateReview {
  commit_id: string
  event: ReviewEvent
  body: string
  comments: ReviewComment[]
}

export type CheckRunConclusion = "success" | "failure" | "cancelled"

export interface CheckRunOutput {
  title: string
  summary: string
}

export interface CreateCheckRun {
  name: string
  head_sha: string
  status: "in_progress"
  external_id: string
  started_at: string
  output: CheckRunOutput
}

export interface UpdateCheckRun {
  conclusion: CheckRunConclusion
  completed_at: string
  output: CheckRunOutput
  details_url?: string
}

const PER_PAGE = 100
const MOST_FILES_GITHUB_LISTS = 3000
const MOST_COMMENT_PAGES = 10

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = "https://api.github.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getPullRequest(ref: RepoRef, number: number): Promise<PullRequestInfo> {
    return this.json(PullRequestInfo, `/repos/${ref.owner}/${ref.repo}/pulls/${number}`)
  }

  async listPullRequestFiles(ref: RepoRef, number: number): Promise<ChangedFile[]> {
    const files: ChangedFile[] = []
    for (let page = 1; page <= MOST_FILES_GITHUB_LISTS / PER_PAGE; page++) {
      const batch = await this.json(
        ChangedFiles,
        `/repos/${ref.owner}/${ref.repo}/pulls/${number}/files?per_page=${PER_PAGE}&page=${page}`,
      )
      files.push(...batch)
      if (batch.length < PER_PAGE) break
    }
    return files
  }

  async getFileContent(ref: RepoRef, path: string, gitRef: string): Promise<string | undefined> {
    const response = await this.request(
      `/repos/${ref.owner}/${ref.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(gitRef)}`,
      { headers: { accept: "application/vnd.github.raw+json" } },
    )
    if (response.status === 404) return undefined
    if (!response.ok) throw await this.error(response)
    return response.text()
  }

  async getIssue(ref: RepoRef, number: number): Promise<Issue | undefined> {
    const path = `/repos/${ref.owner}/${ref.repo}/issues/${number}`
    const response = await this.request(path)
    if (response.status === 404) return undefined
    return this.parse(Issue, path, response)
  }

  async listIssueComments(ref: RepoRef, number: number): Promise<IssueComment[]> {
    const comments: IssueComment[] = []
    for (let page = 1; page <= MOST_COMMENT_PAGES; page++) {
      const batch = await this.json(
        IssueComments,
        `/repos/${ref.owner}/${ref.repo}/issues/${number}/comments?per_page=${PER_PAGE}&page=${page}`,
      )
      comments.push(...batch)
      if (batch.length < PER_PAGE) break
    }
    return comments
  }

  async createIssueComment(ref: RepoRef, number: number, body: string): Promise<IssueComment> {
    return this.json(IssueComment, `/repos/${ref.owner}/${ref.repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    })
  }

  async updateIssueComment(ref: RepoRef, commentId: number, body: string): Promise<IssueComment> {
    return this.json(IssueComment, `/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    })
  }

  async createReview(ref: RepoRef, number: number, review: CreateReview): Promise<{ id: number }> {
    return this.json(CreatedReview, `/repos/${ref.owner}/${ref.repo}/pulls/${number}/reviews`, {
      method: "POST",
      body: JSON.stringify(review),
    })
  }

  async createCheckRun(ref: RepoRef, run: CreateCheckRun): Promise<{ id: number }> {
    const { id } = await this.json(CheckRun, `/repos/${ref.owner}/${ref.repo}/check-runs`, {
      method: "POST",
      body: JSON.stringify(run),
    })
    return { id }
  }

  async updateCheckRun(ref: RepoRef, checkRunId: number, update: UpdateCheckRun): Promise<{ id: number }> {
    const { id } = await this.json(CheckRun, `/repos/${ref.owner}/${ref.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify(update),
    })
    return { id }
  }

  async getCollaboratorPermission(ref: RepoRef, username: string): Promise<string> {
    const data = await this.json(
      CollaboratorPermission,
      `/repos/${ref.owner}/${ref.repo}/collaborators/${encodeURIComponent(username)}/permission`,
    )
    return data.permission
  }

  private async json<Schema extends TSchema>(
    schema: Schema,
    path: string,
    init: RequestInit = {},
  ): Promise<Static<Schema>> {
    return this.parse(schema, path, await this.request(path, init))
  }

  private async parse<Schema extends TSchema>(
    schema: Schema,
    path: string,
    response: Response,
  ): Promise<Static<Schema>> {
    if (!response.ok) throw await this.error(response)
    const body: unknown = await response.json()
    if (Value.Check(schema, body)) return body
    const [first] = Value.Errors(schema, body)
    throw new Error(`GitHub ${path}: unexpected response at ${first?.instancePath || "/"}: ${first?.message}`)
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${this.token}`)
    if (!headers.has("accept")) headers.set("accept", "application/vnd.github+json")
    headers.set("x-github-api-version", "2022-11-28")
    headers.set("user-agent", "andabot")
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")
    const { fetchImpl } = this
    return fetchImpl(`${this.apiBase}${path}`, { ...init, headers })
  }

  private async error(response: Response): Promise<Error> {
    const text = await response.text()
    return new Error(`GitHub ${response.status} ${response.url}: ${text.slice(0, 500)}`)
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

export function canCommand(permission: string): boolean {
  return permission === "admin" || permission === "maintain" || permission === "write"
}
