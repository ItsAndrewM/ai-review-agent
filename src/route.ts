/**
 * Which webhook deliveries become work for a pull request's object, and
 * what work. Pure, so it is tested without a Worker.
 */

import type { Incoming, PullRequestKey } from "./pull-request.ts";

interface Repository {
  name: string;
  owner: { login: string };
}

interface WebhookPayload {
  action?: string;
  installation?: { id: number };
  repository?: Repository;
  sender?: { login: string; type: string };
  pull_request?: { number: number; draft: boolean; head: { sha: string } };
  issue?: { number: number; pull_request?: unknown };
  comment?: { id: number; body: string; user: { login: string; type: string } };
}

export type Routed = { kind: "handle"; incoming: Incoming } | { kind: "ignore"; reason: string };

const REVIEW_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);

export function routeWebhook(eventName: string, payload: WebhookPayload, deliveryId: string, botLogin: string): Routed {
  if (payload.sender?.type === "Bot") return ignore("sent by a bot");
  const installationId = payload.installation?.id;
  const repository = payload.repository;
  if (installationId === undefined || !repository) return ignore("no installation or repository");
  const base = { installationId, owner: repository.owner.login, repo: repository.name };

  if (eventName === "pull_request" && payload.pull_request) {
    const action = payload.action ?? "";
    if (!REVIEW_ACTIONS.has(action)) return ignore(`pull_request ${action}`);
    if (payload.pull_request.draft) return ignore("draft pull request");
    const key: PullRequestKey = { ...base, number: payload.pull_request.number };
    return { kind: "handle", incoming: { kind: "review", key, deliveryId, headSha: payload.pull_request.head.sha, full: false } };
  }

  if (eventName === "issue_comment" && payload.comment && payload.issue) {
    if (payload.action !== "created") return ignore(`issue_comment ${payload.action ?? ""}`);
    if (!payload.issue.pull_request) return ignore("comment on an issue, not a pull request");
    if (!new RegExp(`(?:^|\\s)@${botLogin}(?![\\w-])`, "i").test(payload.comment.body)) return ignore("no mention");
    const key: PullRequestKey = { ...base, number: payload.issue.number };
    return {
      kind: "handle",
      incoming: { kind: "comment", key, deliveryId, author: payload.comment.user.login, body: payload.comment.body }
    };
  }

  return ignore(`event ${eventName}`);
}

export function objectName(key: PullRequestKey): string {
  return `${key.installationId}/${key.owner}/${key.repo}#${key.number}`;
}

function ignore(reason: string): Routed {
  return { kind: "ignore", reason };
}
