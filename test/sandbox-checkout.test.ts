import { describe, expect, it } from "vitest"
import {
  checkoutArgv,
  detectArgv,
  installArgv,
  overcommitArgv,
  MAX_CHECKOUT_KIB,
  parseCheckout,
  parseManager,
  REPO_DIR,
  repositoryUrl,
} from "../src/sandbox/checkout.ts"
import type { RunOutcome } from "../src/sandbox/run.ts"

const exited = (exitCode: number, tail: string): RunOutcome => ({ outcome: "exited", exitCode, tail, cut: false })
const timedOut: RunOutcome = { outcome: "timeout", tail: "", cut: false }

describe("repositoryUrl", () => {
  it("names the base repository over HTTPS, which the outbound handler authenticates", () => {
    expect(repositoryUrl({ installationId: 1, owner: "ItsAndrewM", repo: "ai-review-agent", number: 7 })).toBe(
      "https://github.com/ItsAndrewM/ai-review-agent.git",
    )
  })
})

describe("checkoutArgv", () => {
  it("fetches the sha itself, shallow, into the repository directory, and checks HEAD against it", () => {
    const argv = checkoutArgv("https://github.com/o/r.git", "abc123")
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"])
    expect(argv.slice(3)).toEqual(["andabot-checkout", "https://github.com/o/r.git", "abc123"])
    const script = argv[2] ?? ""
    expect(script).toContain(`git init -q ${REPO_DIR}`)
    expect(script).toContain('git fetch -q --depth 1 "$1" "$2"')
    expect(script).toContain('[ "$(git rev-parse HEAD)" = "$2" ]')
    expect(script).toContain("kib=$(du -sk")
  })
})

describe("parseCheckout", () => {
  it("reads the size from a clean exit", () => {
    expect(parseCheckout(exited(0, "kib=1234\n"))).toEqual({ kind: "ok", kib: 1234 })
  })

  it("refuses a checkout over the cap", () => {
    expect(parseCheckout(exited(0, `kib=${MAX_CHECKOUT_KIB + 1}\n`))).toEqual({
      kind: "failed",
      reason: `checkout is ${MAX_CHECKOUT_KIB + 1} KiB, over the cap of ${MAX_CHECKOUT_KIB}`,
    })
  })

  it("reports a timeout and a failed exit by its last line", () => {
    expect(parseCheckout(timedOut)).toEqual({ kind: "failed", reason: "checkout timed out" })
    expect(parseCheckout(exited(1, "fatal: could not read\nhead is def, not abc123\n"))).toEqual({
      kind: "failed",
      reason: "head is def, not abc123",
    })
  })

  it("treats a clean exit without a size line as a failure", () => {
    expect(parseCheckout(exited(0, "")).kind).toBe("failed")
  })
})

describe("overcommitArgv", () => {
  it("asks the kernel to always overcommit, since oxlint's JS-plugin allocator reserves 6 GiB that heuristic overcommit refuses on a 4 GiB instance", () => {
    const argv = overcommitArgv()
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"])
    expect(argv[2]).toContain("echo 1 > /proc/sys/vm/overcommit_memory")
    expect(argv[3]).toBe("andabot-overcommit")
  })
})

describe("detectArgv and parseManager", () => {
  it("prints the manager the lockfile names, pnpm before npm", () => {
    const script = detectArgv()[2] ?? ""
    expect(script).toContain("pnpm-lock.yaml")
    expect(script).toContain("package-lock.json")
    expect(script.indexOf("pnpm-lock.yaml")).toBeLessThan(script.indexOf("package-lock.json"))
  })

  it("reads pnpm and npm, and anything else as none, yarn included", () => {
    expect(parseManager(exited(0, "pnpm\n"))).toBe("pnpm")
    expect(parseManager(exited(0, "npm\n"))).toBe("npm")
    expect(parseManager(exited(0, "none\n"))).toBe("none")
    expect(parseManager(exited(0, "yarn\n"))).toBe("none")
    expect(parseManager(exited(1, ""))).toBe("none")
    expect(parseManager(timedOut)).toBe("none")
  })
})

describe("installArgv", () => {
  it("installs from the lockfile with lifecycle scripts off", () => {
    expect(installArgv("pnpm")).toEqual(["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"])
    expect(installArgv("npm")).toEqual(["npm", "ci", "--ignore-scripts"])
  })
})
