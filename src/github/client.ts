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
  draft: Type.Optional(Type.Boolean()),
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
const CreatedReply = Type.Object({ id: Type.Integer() })
const CheckRun = Type.Object({ id: Type.Integer() })
const CollaboratorPermission = Type.Object({ permission: Type.String() })

const CheckRunsPage = Type.Object({
  total_count: Type.Integer(),
  check_runs: Type.Array(
    Type.Object({
      name: Type.String(),
      status: Type.String(),
      conclusion: Type.Union([Type.String(), Type.Null()]),
      app: Type.Union([Type.Object({ slug: Type.Optional(Type.String()) }), Type.Null()]),
    }),
  ),
})

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

const Tree = Type.Object({
  sha: Type.String(),
  truncated: Type.Boolean(),
  tree: Type.Array(
    Type.Object({
      path: Type.String(),
      type: Type.String(),
      sha: Type.String(),
      size: Type.Optional(Type.Integer()),
    }),
  ),
})

const TreeListingResponse = Type.Object({
  truncated: Type.Boolean(),
  tree: Type.Array(
    Type.Object({ path: Type.String(), mode: Type.String(), type: Type.String(), size: Type.Optional(Type.Integer()) }),
  ),
})

const BlobObject = Type.Object({
  text: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  isBinary: Type.Optional(Type.Boolean()),
  isTruncated: Type.Optional(Type.Boolean()),
})

const BlobTextsResponse = Type.Object({
  data: Type.Object({ repository: Type.Record(Type.String(), Type.Union([Type.Null(), BlobObject])) }),
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

const AddedReaction = Type.Object({
  data: Type.Object({ addReaction: Type.Object({ reaction: Type.Object({ content: Type.String() }) }) }),
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

const ADD_EYES_MUTATION = `mutation($subjectId: ID!) {
  addReaction(input: { subjectId: $subjectId, content: EYES }) { reaction { content } }
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

export interface CheckRunSummary {
  name: string
  status: string
  conclusion: string | null
  app: string | null
}

export interface TreeEntry {
  path: string
  type: "blob" | "tree"
  sha: string
  size?: number
}

export interface RepositoryTree {
  sha: string
  entries: readonly TreeEntry[]
  truncated: boolean
}

export interface ListedEntry {
  path: string
  type: "blob" | "tree" | "commit"
  mode: string
  size: number | undefined
}

export interface TreeListing {
  entries: readonly ListedEntry[]
  truncated: boolean
}

export interface BlobText {
  path: string
  text: string | undefined
}

type CheckRunNode = Static<typeof CheckRunsPage>["check_runs"][number]

type TreeNode = Static<typeof Tree>["tree"][number]

type ListedNode = Static<typeof TreeListingResponse>["tree"][number]

type BlobObject = Static<typeof BlobObject>

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
const BLOBS_PER_QUERY = 50
const MOST_CHECK_RUN_PAGES = 10

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

  async getIssueComment(ref: RepoRef, commentId: number): Promise<IssueComment> {
    return this.json(IssueComment, `/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}`)
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

  async listCheckRuns(ref: RepoRef, sha: string): Promise<CheckRunSummary[]> {
    const runs: CheckRunSummary[] = []
    for (let page = 1; page <= MOST_CHECK_RUN_PAGES; page++) {
      const batch = await this.json(
        CheckRunsPage,
        `/repos/${ref.owner}/${ref.repo}/commits/${sha}/check-runs?per_page=${PER_PAGE}&page=${page}`,
      )
      runs.push(...batch.check_runs.map(summarizeCheckRun))
      if (runs.length >= batch.total_count || batch.check_runs.length < PER_PAGE) return runs
    }
    throw new Error(`GitHub: more than ${MOST_CHECK_RUN_PAGES * PER_PAGE} check runs on ${sha}`)
  }

  async compareCommits(ref: RepoRef, base: string, head: string): Promise<Comparison> {
    const { status, files } = await this.json(
      ComparisonResponse,
      `/repos/${ref.owner}/${ref.repo}/compare/${base}...${head}`,
    )
    return { status, files: files ?? [] }
  }

  async getTree(ref: RepoRef, sha: string): Promise<RepositoryTree> {
    const listing = await this.json(Tree, `/repos/${ref.owner}/${ref.repo}/git/trees/${sha}?recursive=1`)
    return { sha: listing.sha, entries: listing.tree.flatMap(blobOrTree), truncated: listing.truncated }
  }

  async downloadTarball(ref: RepoRef, sha: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.request(`/repos/${ref.owner}/${ref.repo}/tarball/${sha}`)
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`GitHub tarball ${response.status}`)
    }
    return response.body
  }

  async getTreeListing(ref: RepoRef, sha: string): Promise<TreeListing> {
    const listing = await this.json(TreeListingResponse, `/repos/${ref.owner}/${ref.repo}/git/trees/${sha}?recursive=1`)
    return { entries: listing.tree.flatMap(listedEntry), truncated: listing.truncated }
  }

  async getBlobTexts(ref: RepoRef, sha: string, paths: readonly string[]): Promise<BlobText[]> {
    const texts: BlobText[] = []
    for (let start = 0; start < paths.length; start += BLOBS_PER_QUERY) {
      texts.push(...(await this.blobTextsBatch(ref, sha, paths.slice(start, start + BLOBS_PER_QUERY))))
    }
    return texts
  }

  private async blobTextsBatch(ref: RepoRef, sha: string, paths: readonly string[]): Promise<BlobText[]> {
    const expressions = Object.fromEntries(paths.map((path, index) => [`e${index}`, `${sha}:${path}`]))
    const variables = { owner: ref.owner, name: ref.repo, ...expressions }
    const { data } = await this.graphql(BlobTextsResponse, blobTextsQuery(paths.length), variables)
    return paths.map((path, index) => ({ path, text: readableText(data.repository[`f${index}`]) }))
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

  async addEyesReaction(subjectId: string): Promise<void> {
    await this.graphql(AddedReaction, ADD_EYES_MUTATION, { subjectId })
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
    const { fetchImpl } = this
    return fetchImpl(`${this.apiBase}${path}`, { ...init, headers })
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

function summarizeCheckRun({ name, status, conclusion, app }: CheckRunNode): CheckRunSummary {
  return { name, status, conclusion, app: app?.slug ?? null }
}

function blobOrTree({ path, type, sha, size }: TreeNode): TreeEntry[] {
  if (type !== "blob" && type !== "tree") return []
  return size === undefined ? [{ path, type, sha }] : [{ path, type, sha, size }]
}

function listedEntry({ path, mode, type, size }: ListedNode): ListedEntry[] {
  return type === "blob" || type === "tree" || type === "commit" ? [{ path, mode, type, size }] : []
}

function blobTextsQuery(count: number): string {
  const indexes = Array.from({ length: count }, (_, index) => index)
  const declarations = indexes.map((index) => `, $e${index}: String!`).join("")
  const fields = indexes
    .map((index) => `f${index}: object(expression: $e${index}) { ... on Blob { text isBinary isTruncated } }`)
    .join("\n    ")
  return `query($owner: String!, $name: String!${declarations}) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}`
}

function readableText(blob: BlobObject | null | undefined): string | undefined {
  if (!blob || blob.isBinary || blob.isTruncated) return undefined
  return blob.text ?? undefined
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

export function canCommand(permission: string): boolean {
  return permission === "admin" || permission === "maintain" || permission === "write"
}
