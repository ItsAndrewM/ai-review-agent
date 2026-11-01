import { scriptNameOf } from "../names.ts"
import type { PullRequestKey } from "../records.ts"
import type { RunOutcome } from "./run.ts"

export const REPO_DIR = "/workspace/repo"

export const MAX_CHECKOUT_KIB = 524_288

export const STEP_TIMEOUT_MS = 300_000

const CHECKOUT_SCRIPT = `rm -rf ${REPO_DIR} && git init -q ${REPO_DIR} && cd ${REPO_DIR} || exit 1
git fetch -q --depth 1 "$1" "$2" && git -c advice.detachedHead=false checkout -q FETCH_HEAD || exit 1
[ "$(git rev-parse HEAD)" = "$2" ] || { echo "head is $(git rev-parse HEAD 2>/dev/null), not $2"; exit 1; }
echo "kib=$(du -sk ${REPO_DIR} | cut -f1)"`

const DETECT_SCRIPT = `cd ${REPO_DIR} || exit 1
if [ -f pnpm-lock.yaml ]; then echo pnpm; elif [ -f package-lock.json ]; then echo npm; else echo none; fi`

const OVERCOMMIT_SCRIPT = "echo 1 > /proc/sys/vm/overcommit_memory"

export function overcommitArgv(botLogin: string): string[] {
  return ["/bin/sh", "-c", OVERCOMMIT_SCRIPT, scriptNameOf(botLogin, "overcommit")]
}

export function repositoryUrl(key: PullRequestKey): string {
  return `https://github.com/${key.owner}/${key.repo}.git`
}

export function checkoutArgv(url: string, sha: string, botLogin: string): string[] {
  return ["/bin/sh", "-c", CHECKOUT_SCRIPT, scriptNameOf(botLogin, "checkout"), url, sha]
}

export type CheckoutResult =
  | { readonly kind: "ok"; readonly kib: number }
  | { readonly kind: "failed"; readonly reason: string }

export function lastLine(text: string): string {
  const lines = text.trim().split("\n")
  return lines[lines.length - 1] ?? ""
}

export function parseCheckout(outcome: RunOutcome): CheckoutResult {
  if (outcome.outcome === "timeout") return { kind: "failed", reason: "checkout timed out" }
  const last = lastLine(outcome.tail)
  if (outcome.exitCode !== 0) return { kind: "failed", reason: last || `checkout exited ${outcome.exitCode}` }
  const size = /^kib=(\d+)$/.exec(last)
  if (size === null) return { kind: "failed", reason: "checkout reported no size" }
  const kib = Number(size[1])
  if (kib > MAX_CHECKOUT_KIB)
    return { kind: "failed", reason: `checkout is ${kib} KiB, over the cap of ${MAX_CHECKOUT_KIB}` }
  return { kind: "ok", kib }
}

export const MANAGERS = ["pnpm", "npm", "none"] as const

export type Manager = (typeof MANAGERS)[number]

export function detectArgv(botLogin: string): string[] {
  return ["/bin/sh", "-c", DETECT_SCRIPT, scriptNameOf(botLogin, "detect")]
}

export function parseManager(outcome: RunOutcome): Manager {
  if (outcome.outcome !== "exited" || outcome.exitCode !== 0) return "none"
  const name = outcome.tail.trim()
  return name === "pnpm" || name === "npm" ? name : "none"
}

export function installArgv(manager: "pnpm" | "npm"): string[] {
  return manager === "pnpm"
    ? ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]
    : ["npm", "ci", "--ignore-scripts"]
}
