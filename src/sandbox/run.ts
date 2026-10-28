export const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt"

export const TRUST_ENV = {
  NODE_EXTRA_CA_CERTS: CA_PATH,
  GIT_SSL_CAINFO: CA_PATH,
  CURL_CA_BUNDLE: CA_PATH,
  SSL_CERT_FILE: CA_PATH,
} as const

export const DEFAULT_TAIL_BYTES = 8 * 1024

export const MAX_TAIL_BYTES = 50 * 1024

export const RUNS_DIR = "/workspace/runs"

const RUN_SCRIPT = `dir=$1; shift
mkdir -p "$dir"
setsid sh -c 'echo "$$" >"$0/pid"; exec "$@"' "$dir" "$@" >"$dir/output" 2>&1
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`

const killScript = (signal: KillSignal) => `[ -f "$1/pid" ] || exit 0
read -r pid <"$1/pid" && kill -s ${signal} -- "-$pid"`

export type KillSignal = "TERM" | "KILL"

const RESULT_SCRIPT = `cat "$1/exit-code" 2>/dev/null || echo none
stat -c %s "$1/output" 2>/dev/null || echo 0
tail -c "$2" "$1/output" 2>/dev/null`

export function runDir(id: string): string {
  return `${RUNS_DIR}/${id}`
}

export function runArgv(dir: string, command: readonly string[]): string[] {
  return ["/bin/sh", "-c", RUN_SCRIPT, "andabot-run", dir, ...command]
}

export function killArgv(dir: string, signal: KillSignal): string[] {
  return ["/bin/sh", "-c", killScript(signal), "andabot-kill", dir]
}

export function resultArgv(dir: string, tailBytes: number): string[] {
  return ["/bin/sh", "-c", RESULT_SCRIPT, "andabot-result", dir, String(tailBytes)]
}

export function removeArgv(dir: string): string[] {
  return ["rm", "-rf", dir]
}

export function tailBytesOf(requested: number | undefined): number {
  if (requested === undefined || !Number.isSafeInteger(requested) || requested <= 0) return DEFAULT_TAIL_BYTES
  return Math.min(requested, MAX_TAIL_BYTES)
}

export type RunOutcome =
  | { readonly outcome: "exited"; readonly exitCode: number; readonly tail: string; readonly cut: boolean }
  | { readonly outcome: "timeout"; readonly tail: string; readonly cut: boolean }

export function parseResult(output: Uint8Array, tailBytes: number): RunOutcome {
  const [exitLine, rest] = splitLine(output)
  const [sizeLine, tailBytesOut] = splitLine(rest)
  const tail = new TextDecoder().decode(tailBytesOut)
  const cut = Number(sizeLine) > tailBytes
  const exitCode = Number(exitLine)
  if (exitLine === "none" || !Number.isInteger(exitCode)) return { outcome: "timeout", tail, cut }
  return { outcome: "exited", exitCode, tail, cut }
}

function splitLine(bytes: Uint8Array): [string, Uint8Array] {
  const newline = bytes.indexOf(10)
  if (newline === -1) return [new TextDecoder().decode(bytes), new Uint8Array()]
  return [new TextDecoder().decode(bytes.subarray(0, newline)), bytes.subarray(newline + 1)]
}
