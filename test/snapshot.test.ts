import { describe, expect, it } from "vitest"
import { classify, MemorySnapshotFiles, type SnapshotRecord } from "../src/repository/snapshot.ts"

const encoder = new TextEncoder()

const record = {
  sha: "abc123",
  files: 2,
  bytes: 30,
  gapFilled: 0,
  leftOut: { binary: 1 },
  capped: false,
  treeTruncated: false,
} satisfies SnapshotRecord

function bytesWithNulAt(index: number): Uint8Array {
  const bytes = new Uint8Array(10_000).fill(97)
  bytes[index] = 0
  return bytes
}

describe("classify", () => {
  it("calls ordinary source text", () => {
    expect(classify(encoder.encode("export const a = 1\n"))).toBe("text")
  })

  it("calls a file with a NUL byte near the start binary", () => {
    expect(classify(bytesWithNulAt(100))).toBe("binary")
  })

  it("calls a file whose first NUL byte is past 8,192 bytes text", () => {
    expect(classify(bytesWithNulAt(9_000))).toBe("text")
  })

  it("recognises a git LFS pointer", () => {
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n"
    expect(classify(encoder.encode(pointer))).toBe("lfs")
  })
})

describe("MemorySnapshotFiles", () => {
  it("a snapshot reads back its files and left-out reasons", () => {
    const snapshot = new MemorySnapshotFiles()
    snapshot.begin("abc123")
    snapshot.add([
      { path: "src/a.ts", content: "const a = 1\n" },
      { path: "src/b.ts", content: "const b = 2\n" },
    ])
    snapshot.leaveOut([
      { path: "logo.png", reason: "binary" },
      { path: "vendor/big.js", reason: "too_large" },
    ])
    snapshot.finish(record)

    expect(snapshot.read("src/a.ts")).toBe("const a = 1\n")
    expect(snapshot.read("logo.png")).toBeUndefined()
    expect(snapshot.has("src/b.ts")).toBe(true)
    expect(snapshot.has("logo.png")).toBe(false)
    expect(snapshot.reasonFor("logo.png")).toBe("binary")
    expect(snapshot.reasonFor("src/a.ts")).toBeUndefined()
    expect([...snapshot.files()].map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect([...snapshot.leftOut()]).toEqual([
      { path: "logo.png", reason: "binary" },
      { path: "vendor/big.js", reason: "too_large" },
    ])
    expect(snapshot.record()).toEqual(record)
  })

  it("adding a path again replaces its content", () => {
    const snapshot = new MemorySnapshotFiles()
    snapshot.begin("abc123")
    snapshot.add([{ path: "a.ts", content: "old" }])
    snapshot.add([{ path: "a.ts", content: "new" }])
    expect(snapshot.read("a.ts")).toBe("new")
    expect([...snapshot.files()]).toHaveLength(1)
  })

  it("lists file paths sorted without reading contents", () => {
    const snapshot = new MemorySnapshotFiles()
    snapshot.begin("abc123")
    snapshot.add([
      { path: "src/b.ts", content: "b" },
      { path: "README.md", content: "r" },
      { path: "src/a.ts", content: "a" },
    ])
    snapshot.leaveOut([{ path: "logo.png", reason: "binary" }])
    expect([...snapshot.paths()]).toEqual(["README.md", "src/a.ts", "src/b.ts"])
  })

  it("record is undefined until finish, and after begin", () => {
    const snapshot = new MemorySnapshotFiles()
    expect(snapshot.record()).toBeUndefined()
    snapshot.begin("abc123")
    expect(snapshot.record()).toBeUndefined()
    snapshot.finish(record)
    expect(snapshot.record()).toEqual(record)
    snapshot.begin("def456")
    expect(snapshot.record()).toBeUndefined()
  })

  it("begin clears the files and the left-out paths", () => {
    const snapshot = new MemorySnapshotFiles()
    snapshot.begin("abc123")
    snapshot.add([{ path: "a.ts", content: "a" }])
    snapshot.leaveOut([{ path: "b.png", reason: "binary" }])
    snapshot.begin("def456")
    expect(snapshot.has("a.ts")).toBe(false)
    expect(snapshot.reasonFor("b.png")).toBeUndefined()
    expect([...snapshot.files()]).toEqual([])
    expect([...snapshot.leftOut()]).toEqual([])
  })

  it("drop reports whether there was anything", () => {
    const snapshot = new MemorySnapshotFiles()
    snapshot.begin("abc123")
    snapshot.add([{ path: "a.ts", content: "a" }])
    snapshot.finish(record)
    expect(snapshot.drop()).toBe(true)
    expect(snapshot.drop()).toBe(false)
    expect(snapshot.record()).toBeUndefined()
    expect(snapshot.has("a.ts")).toBe(false)
  })
})
