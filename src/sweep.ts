import { GitHubClient, type OpenPullRequest, type RepoRef } from "./github/client.ts"
import { errorText, log, logError } from "./log.ts"
import type { PullRequestKey } from "./records.ts"
import type { SweepIncoming, SweepOutcome } from "./review/sweep-decision.ts"
import { shortSha } from "./sha.ts"

export const SWEEP_WINDOW_MS = 86_400_000

export const SWEEP_FLOOR_MS = 300_000

export interface SweepGitHub {
  installations(): Promise<number[]>
  repositories(installationId: number): Promise<RepoRef[]>
  openPullRequests(installationId: number, ref: RepoRef, since: number): Promise<OpenPullRequest[]>
}

export type SweepHandOff = (incoming: SweepIncoming) => Promise<SweepOutcome>

export interface SweepReport {
  installations: number
  repositories: number
  pulls: number
  found: number
}

interface Sweep {
  github: SweepGitHub
  handOff: SweepHandOff
  now: number
  report: SweepReport
}

export async function runSweep(github: SweepGitHub, handOff: SweepHandOff, now: number): Promise<SweepReport> {
  const startedAt = Date.now()
  const sweep: Sweep = { github, handOff, now, report: { installations: 0, repositories: 0, pulls: 0, found: 0 } }
  try {
    for (const installationId of await github.installations()) await sweepInstallation(sweep, installationId)
  } catch (cause) {
    logError("sweep.failed", { error: errorText(cause) })
  }
  log("sweep.done", { ...sweep.report, ms: Date.now() - startedAt })
  return sweep.report
}

async function sweepInstallation(sweep: Sweep, installationId: number): Promise<void> {
  sweep.report.installations++
  let repositories: RepoRef[]
  try {
    repositories = await sweep.github.repositories(installationId)
  } catch (cause) {
    logError("sweep.failed", { installation: installationId, error: errorText(cause) })
    return
  }
  for (const ref of repositories) await sweepRepository(sweep, installationId, ref)
}

async function sweepRepository(sweep: Sweep, installationId: number, ref: RepoRef): Promise<void> {
  sweep.report.repositories++
  let pulls: OpenPullRequest[]
  try {
    pulls = await sweep.github.openPullRequests(installationId, ref, sweep.now - SWEEP_WINDOW_MS)
  } catch (cause) {
    logError("sweep.failed", { repo: repoName(ref), error: errorText(cause) })
    return
  }
  const settled = pulls.filter(({ updatedAt }) => sweep.now - updatedAt >= SWEEP_FLOOR_MS)
  for (const pull of settled) await sweepPull(sweep, { installationId, ...ref, number: pull.number }, pull)
}

async function sweepPull(sweep: Sweep, key: PullRequestKey, pull: OpenPullRequest): Promise<void> {
  sweep.report.pulls++
  const repo = repoName(key)
  let outcome: SweepOutcome
  try {
    outcome = await sweep.handOff(sweepIncoming(key, pull))
  } catch (cause) {
    logError("sweep.failed", { repo, number: pull.number, error: errorText(cause) })
    return
  }
  if (outcome.kind === "known") return
  sweep.report.found++
  const reason = outcome.kind === "reviewed" ? "unreviewed" : outcome.kind
  log("sweep.found", { repo, number: pull.number, head: shortSha(pull.headSha), reason })
}

export function sweepIncoming(key: PullRequestKey, pull: OpenPullRequest): SweepIncoming {
  return {
    kind: "review",
    key,
    deliveryId: `sweep:${pull.headSha}`,
    headSha: pull.headSha,
    full: false,
    sweep: { draft: pull.draft, baseRef: pull.baseRef, title: pull.title },
  }
}

export function sweepGitHub(
  appJwt: string,
  token: (installationId: number) => Promise<string>,
  userAgent: string,
  apiBase?: string,
): SweepGitHub {
  const clients = new Map<number, Promise<GitHubClient>>()
  const installation = (installationId: number): Promise<GitHubClient> => {
    const known = clients.get(installationId)
    if (known !== undefined) return known
    const client = token(installationId).then((minted) => new GitHubClient(minted, userAgent, apiBase))
    clients.set(installationId, client)
    return client
  }
  return {
    installations: () => new GitHubClient(appJwt, userAgent, apiBase).listInstallations(),
    repositories: async (installationId) => (await installation(installationId)).listInstallationRepositories(),
    openPullRequests: async (installationId, ref, since) =>
      (await installation(installationId)).listOpenPullRequests(ref, since),
  }
}

function repoName({ owner, repo }: RepoRef): string {
  return `${owner}/${repo}`
}
