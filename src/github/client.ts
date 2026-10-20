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

const ChangedFiles = Type.Array(ChangedFile)
const IssueComments = Type.Array(IssueComment)
const CreatedReview = Type.Object({ id: Type.Integer() })
const CreatedReply = Type.Object({ id: Type.Integer() })
const CheckRun = Type.Object({ id: Type.Integer() })
const CollaboratorPermission = Type.Object({ permission: Type.String() })

const SideValue = Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")])

const ComparisonResponse = Type.Object({
  status: Type.Union([
    Type.Literal("ahead"),
    Type.Literal("behind"),
    Type.Literal("diverged"),
    Type.Literal("identical"),
  ]),
  files: Type.Optional(ChangedFiles),
})

const PullRequestComments = Type.Array(
  Type.Object({
    id: Type.Integer(),
    pull_request_review_id: Type.Union([Type.Integer(), Type.Null()]),
    path: Type.String(),
    line: Type.Union([Type.Integer(), Type.Null()]),
    side: Type.Union([SideValue, Type.Null()]),
  }),
)

const ThreadNode = Type.Object({
  id: Type.String(),
  isResolved: Type.Boolean(),
  isOutdated: Type.Boolean(),
  path: Type.String(),
  line: Type.Union([Type.Integer(), Type.Null()]),
  diffSide: SideValue,
  comments: Type.Object({
    nodes: Type.Array(
      Type.Object({
        databaseId: Type.Integer(),
        body: Type.String(),
        author: Type.Union([Type.Object({ login: Type.String(), __typename: Type.String() }), Type.Null()]),
      }),
    ),
  }),
})

const ReviewThreadsPage = Type.Object({
  data: Type.Object({
    repository: Type.Object({
      pullRequest: Type.Object({
        reviewThreads: Type.Object({
          pageInfo: Type.Object({ hasNextPage: Type.Boolean(), endCursor: Type.Union([Type.String(), Type.Null()]) }),
          nodes: Type.Array(ThreadNode),
        }),
      }),
    }),
  }),
})

const ResolvedThread = Type.Object({
  data: Type.Object({ resolveReviewThread: Type.Object({ thread: Type.Object({ id: Type.String() }) }) }),
})

const GraphQLErrors = Type.Object({ errors: Type.Array(Type.Object({ message: Type.String() })) })

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved isOutdated path line diffSide comments(first: 1) { nodes { databaseId body author { login __typename } } } }
      }
    }
  }
}`

const RESOLVE_THREAD_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`

export type CompareStatus = Static<typeof ComparisonResponse>["status"]

export interface Comparison {
  status: CompareStatus
  files: ChangedFile[]
}

export interface PostedComment {
  id: number
  reviewId: number
  path: string
  line: number | null
  side: Side | null
}

export interface ReviewThread {
  id: string
  resolved: boolean
  outdated: boolean
  path: string
  line: number | null
  side: Side
  firstCommentId: number
  firstCommentBody: string
  authorLogin: string | null
  authorIsBot: boolean
}

type GraphQLVariables = Record<string, string | number | null>

type ThreadsPage = Static<typeof ReviewThreadsPage>["data"]["repository"]["pullRequest"]["reviewThreads"]

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
const MOST_THREAD_PAGES = 5

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = "https://api.github.com",
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

  async compareCommits(ref: RepoRef, base: string, head: string): Promise<Comparison> {
    const { status, files } = await this.json(
      ComparisonResponse,
      `/repos/${ref.owner}/${ref.repo}/compare/${base}...${head}`,
    )
    return { status, files: files ?? [] }
  }

  async listReviewComments(ref: RepoRef, number: number, reviewId: number): Promise<PostedComment[]> {
    const comments: PostedComment[] = []
    for (let page = 1; page <= MOST_COMMENT_PAGES; page++) {
      const batch = await this.json(
        PullRequestComments,
        `/repos/${ref.owner}/${ref.repo}/pulls/${number}/comments?per_page=${PER_PAGE}&page=${page}`,
      )
      for (const { id, pull_request_review_id, path, line, side } of batch) {
        if (pull_request_review_id === reviewId) comments.push({ id, reviewId, path, line, side })
      }
      if (batch.length < PER_PAGE) break
    }
    return comments
  }

  async replyToReviewComment(ref: RepoRef, number: number, commentId: number, body: string): Promise<{ id: number }> {
    const { id } = await this.json(
      CreatedReply,
      `/repos/${ref.owner}/${ref.repo}/pulls/${number}/comments/${commentId}/replies`,
      { method: "POST", body: JSON.stringify({ body }) },
    )
    return { id }
  }

  async listReviewThreads(ref: RepoRef, number: number): Promise<ReviewThread[]> {
    const threads: ReviewThread[] = []
    let cursor: string | null = null
    for (let page = 1; page <= MOST_THREAD_PAGES; page++) {
      const { pageInfo, nodes } = await this.reviewThreadsPage(ref, number, cursor)
      threads.push(...nodes.flatMap(flattenThread))
      if (!pageInfo.hasNextPage) return threads
      cursor = pageInfo.endCursor
    }
    throw new Error(`GitHub GraphQL: more than ${MOST_THREAD_PAGES * PER_PAGE} review threads`)
  }

  private async reviewThreadsPage(ref: RepoRef, number: number, cursor: string | null): Promise<ThreadsPage> {
    const variables = { owner: ref.owner, name: ref.repo, number, cursor }
    return (await this.graphql(ReviewThreadsPage, REVIEW_THREADS_QUERY, variables)).data.repository.pullRequest
      .reviewThreads
  }

  async resolveReviewThread(threadId: string): Promise<void> {
    await this.graphql(ResolvedThread, RESOLVE_THREAD_MUTATION, { threadId })
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
    const response = await this.request(path, init)
    if (!response.ok) throw await this.error(response)
    const body: unknown = await response.json()
    if (Value.Check(schema, body)) return body
    const [first] = Value.Errors(schema, body)
    throw new Error(`GitHub ${path}: unexpected response at ${first?.instancePath || "/"}: ${first?.message}`)
  }

  private async graphql<Schema extends TSchema>(
    schema: Schema,
    query: string,
    variables: GraphQLVariables,
  ): Promise<Static<Schema>> {
    const response = await this.request("/graphql", { method: "POST", body: JSON.stringify({ query, variables }) })
    if (!response.ok) throw await this.error(response)
    const body: unknown = await response.json()
    if (Value.Check(GraphQLErrors, body)) {
      throw new Error(`GitHub GraphQL: ${body.errors.map((error) => error.message).join("; ")}`)
    }
    if (Value.Check(schema, body)) return body
    const [first] = Value.Errors(schema, body)
    throw new Error(`GitHub GraphQL: unexpected response at ${first?.instancePath || "/"}: ${first?.message}`)
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${this.token}`)
    if (!headers.has("accept")) headers.set("accept", "application/vnd.github+json")
    headers.set("x-github-api-version", "2022-11-28")
    headers.set("user-agent", "andabot")
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")
    return fetch(`${this.apiBase}${path}`, { ...init, headers })
  }

  private async error(response: Response): Promise<Error> {
    const text = await response.text()
    return new Error(`GitHub ${response.status} ${response.url}: ${text.slice(0, 500)}`)
  }
}

function flattenThread(node: Static<typeof ThreadNode>): ReviewThread[] {
  const [first] = node.comments.nodes
  if (!first) return []
  return [
    {
      id: node.id,
      resolved: node.isResolved,
      outdated: node.isOutdated,
      path: node.path,
      line: node.line,
      side: node.diffSide,
      firstCommentId: first.databaseId,
      firstCommentBody: first.body,
      authorLogin: first.author?.login ?? null,
      authorIsBot: first.author?.__typename === "Bot",
    },
  ]
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

export function canCommand(permission: string): boolean {
  return permission === "admin" || permission === "maintain" || permission === "write"
}
