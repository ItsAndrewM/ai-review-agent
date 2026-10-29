import { describe, expect, it } from "vitest"
import {
  failureSummary,
  GitHubError,
  isTransient,
  softenUnlessTransient,
  TransientFailure,
} from "../src/github/errors.ts"

const failure = (status: number | undefined) => new GitHubError(`GitHub ${status} /x`, status, "/x")

describe("isTransient", () => {
  it("says yes to a 5xx, Cloudflare's 52x and a request that never got a status", () => {
    for (const status of [500, 502, 522, 525, undefined]) expect(isTransient(failure(status))).toBe(true)
  })

  it("says no to a 4xx, a 200 with errors, a plain error, and yes to a failure the host classified itself", () => {
    for (const status of [404, 422, 200]) expect(isTransient(failure(status))).toBe(false)
    expect(isTransient(new Error("GitHub 522 /x"))).toBe(false)
    expect(isTransient(new TransientFailure("approval: GitHub 525"))).toBe(true)
  })
})

describe("softenUnlessTransient", () => {
  it("throws a transient error back and returns on a final one", () => {
    expect(() => softenUnlessTransient(failure(522))).toThrow(GitHubError)
    expect(softenUnlessTransient(failure(404))).toBeUndefined()
    expect(softenUnlessTransient(new Error("parse"))).toBeUndefined()
  })
})

describe("failureSummary", () => {
  it("names the status and the path for a GitHub failure, never the body, and the message for anything else", () => {
    expect(
      failureSummary(
        new GitHubError("GitHub 522 https://api.github.com/x: <html>error</html>", 522, "/repos/o/r/pulls/88"),
      ),
    ).toBe("522 on /repos/o/r/pulls/88")
    expect(failureSummary(new GitHubError("GitHub /x: TypeError: fetch failed", undefined, "/x"))).toBe(
      "no response on /x",
    )
    expect(failureSummary(new TransientFailure("approval after thread_resolved"))).toBe(
      "approval after thread_resolved",
    )
  })
})
