import { describe, expect, it } from "vitest"
import { GitHubClient } from "../src/github/client.ts"
import { SnapshotUnavailable } from "../src/repository/load-snapshot.ts"
import { leftOutText, loadedFields, snapshotFailure, snapshotSource } from "../src/repository/snapshot-host.ts"

const record = {
  sha: "0123456789abcdef",
  files: 1200,
  bytes: 3_400_000,
  gapFilled: 12,
  leftOut: { lfs: 1, binary: 30, too_large: 0 },
  capped: false,
  treeTruncated: true,
}

describe("loadedFields", () => {
  it("logs the snapshot's numbers with a short head and the left-out counts as one sorted field", () => {
    expect(loadedFields(54, record, 8_200)).toEqual({
      number: 54,
      head: "0123456",
      files: 1200,
      bytes: 3_400_000,
      leftOut: "binary=30,lfs=1",
      gapFilled: 12,
      capped: false,
      treeTruncated: true,
      ms: 8_200,
    })
  })

  it("says none when nothing was left out, so the field is never missing from the log", () => {
    expect(leftOutText({})).toBe("none")
    expect(leftOutText({ binary: 0 })).toBe("none")
  })
})

describe("snapshotFailure", () => {
  it("names the step GitHub refused, so the model is told what could not be read", () => {
    expect(snapshotFailure(new SnapshotUnavailable("tarball", "404"))).toEqual({
      step: "tarball",
      reason: "the repository's tarball could not be read from GitHub",
    })
    expect(snapshotFailure(new SnapshotUnavailable("tree", "500")).step).toBe("tree")
  })

  it("files any other error under the load step", () => {
    expect(snapshotFailure(new Error("SQLITE_FULL"))).toEqual({
      step: "load",
      reason: "the repository's files could not be loaded",
    })
  })
})

describe("snapshotSource", () => {
  it("asks GitHub for the pull request's repository at the sha the load names", async () => {
    const urls: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(new Request(input).url)
      return Response.json({ sha: "abc", truncated: false, tree: [] })
    }
    const source = snapshotSource(new GitHubClient("token", "https://api.github.com", fetchImpl), {
      owner: "acme",
      repo: "app",
    })
    await source.listing("abc")
    expect(urls).toEqual(["https://api.github.com/repos/acme/app/git/trees/abc?recursive=1"])
  })
})
