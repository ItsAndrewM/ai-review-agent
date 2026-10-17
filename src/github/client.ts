/**
 * The slice of GitHub's REST API the reviewer uses, over `fetch` with an
 * installation token. Every method names its endpoint so the permission it
 * needs is easy to trace: Pull requests write, Contents read, Issues write.
 */

import type { ChangedFile, Side } from "./diff.ts";

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  state: string;
  html_url: string;
  user: { login: string; type: string };
  base: { ref: string; sha: string; repo: { full_name: string } };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  changed_files: number;
  additions: number;
  deletions: number;
  labels: { name: string }[];
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string; type: string };
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface ReviewComment {
  path: string;
  body: string;
  line: number;
  side: Side;
  start_line?: number;
  start_side?: Side;
}

export interface CreateReview {
  commit_id: string;
  event: ReviewEvent;
  body: string;
  comments: ReviewComment[];
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = "https://api.github.com"
  ) {}

  async getPullRequest(ref: RepoRef, number: number): Promise<PullRequestInfo> {
    return this.json(`/repos/${ref.owner}/${ref.repo}/pulls/${number}`);
  }

  /** Every changed file with its patch, paginated. GitHub lists at most 3000. */
  async listPullRequestFiles(ref: RepoRef, number: number): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.json<ChangedFile[]>(
        `/repos/${ref.owner}/${ref.repo}/pulls/${number}/files?per_page=100&page=${page}`
      );
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return files;
  }

  /** A file's text at a ref. Undefined when it does not exist there. Capped at 1 MB by GitHub. */
  async getFileContent(ref: RepoRef, path: string, gitRef: string): Promise<string | undefined> {
    const response = await this.request(
      `/repos/${ref.owner}/${ref.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(gitRef)}`,
      { headers: { accept: "application/vnd.github.raw+json" } }
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw await this.error(response);
    return response.text();
  }

  async listIssueComments(ref: RepoRef, number: number): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.json<IssueComment[]>(
        `/repos/${ref.owner}/${ref.repo}/issues/${number}/comments?per_page=100&page=${page}`
      );
      comments.push(...batch);
      if (batch.length < 100) break;
    }
    return comments;
  }

  async createIssueComment(ref: RepoRef, number: number, body: string): Promise<IssueComment> {
    return this.json(`/repos/${ref.owner}/${ref.repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body })
    });
  }

  async updateIssueComment(ref: RepoRef, commentId: number, body: string): Promise<IssueComment> {
    return this.json(`/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ body })
    });
  }

  async createReview(ref: RepoRef, number: number, review: CreateReview): Promise<{ id: number }> {
    return this.json(`/repos/${ref.owner}/${ref.repo}/pulls/${number}/reviews`, {
      method: "POST",
      body: JSON.stringify(review)
    });
  }

  /** "admin" | "maintain" | "write" | "triage" | "read" | "none". */
  async getCollaboratorPermission(ref: RepoRef, username: string): Promise<string> {
    const data = await this.json<{ permission: string }>(
      `/repos/${ref.owner}/${ref.repo}/collaborators/${encodeURIComponent(username)}/permission`
    );
    return data.permission;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<T>;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (!headers.has("accept")) headers.set("accept", "application/vnd.github+json");
    headers.set("x-github-api-version", "2022-11-28");
    headers.set("user-agent", "andabot");
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetch(`${this.apiBase}${path}`, { ...init, headers });
  }

  private async error(response: Response): Promise<Error> {
    const text = await response.text();
    return new Error(`GitHub ${response.status} ${response.url}: ${text.slice(0, 500)}`);
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function canCommand(permission: string): boolean {
  return permission === "admin" || permission === "maintain" || permission === "write";
}
