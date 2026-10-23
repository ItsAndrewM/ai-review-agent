import { describe, expect, it, vi } from "vitest"
import type { BlobText, ListedEntry, TreeListing } from "../src/github/client.ts"
import {
  ADD_BATCH_BYTES,
  ADD_BATCH_FILES,
  GAP_BATCH_BYTES,
  GAP_BATCH_FILES,
  loadSnapshot,
  type SnapshotSource,
} from "../src/repository/load-snapshot.ts"
import {
  MAX_FILE_BYTES,
  MemorySnapshotFiles,
  SNAPSHOT_LIMITS,
  type SnapshotLimits,
} from "../src/repository/snapshot.ts"
import { streamOf, tarOf, type TarEntry } from "./tar-archive.ts"

const SHA = "abc123"

const encoder = new TextEncoder()

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = streamOf(bytes, 4_096).pipeThrough(new CompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function gzippedTarball(entries: readonly TarEntry[]): Promise<Uint8Array> {
  return gzip(tarOf(entries))
}

function resetAfter(bytes: Uint8Array, count: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, count))
      controller.error(new Error("connection reset"))
    },
  })
}

const file = (name: string, body: string): TarEntry => ({ name: `owner-repo-${SHA}/${name}`, body })

const blob = (path: string, size = 10): ListedEntry => ({ path, type: "blob", mode: "100644", size })

interface Fake {
  source: SnapshotSource
  blobCalls: string[][]
  tarballCalls: number
}

interface FakeOptions {
  tarballs: (() => Promise<ReadableStream<Uint8Array>>)[]
  listing?: () => Promise<TreeListing>
  blobs?: (paths: readonly string[]) => BlobText[]
}

function fakeSource(options: FakeOptions): Fake {
  const fake: Fake = {
    blobCalls: [],
    tarballCalls: 0,
    source: {
      async tarball() {
        const open = options.tarballs[Math.min(fake.tarballCalls, options.tarballs.length - 1)]
        fake.tarballCalls += 1
        if (open === undefined) {
          throw new Error("no tarball")
        }
        return open()
      },
      listing: options.listing ?? (async () => ({ entries: [], truncated: false })),
      async blobs(_sha, paths) {
        fake.blobCalls.push([...paths])
        return options.blobs?.(paths) ?? paths.map((path) => ({ path, text: `text of ${path}\n` }))
      },
    },
  }
  return fake
}

async function tarballOf(entries: readonly TarEntry[]): Promise<() => Promise<ReadableStream<Uint8Array>>> {
  const bytes = await gzippedTarball(entries)
  return async () => streamOf(bytes, 700)
}

const lowered = (limits: Partial<SnapshotLimits>): SnapshotLimits => ({ ...SNAPSHOT_LIMITS, ...limits })

describe("loadSnapshot", () => {
  it("keeps text files and records binary, LFS and large ones", async () => {
    const lfs = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9\n"
    const fake = fakeSource({
      tarballs: [
        await tarballOf([
          file("src/a.ts", "export const a = 1\n"),
          file("src/b.ts", "export const b = 2\n"),
          file("logo.png", "PNG\0data"),
          file("model.bin", "bytes\0"),
          file("asset.dat", lfs),
          file("big.js", "x".repeat(200)),
        ]),
      ],
    })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA, lowered({ maxFileBytes: 100 }))

    expect(record).toEqual({
      sha: SHA,
      files: 2,
      bytes: 38,
      gapFilled: 0,
      leftOut: { binary: 2, lfs: 1, too_large: 1 },
      capped: false,
      treeTruncated: false,
    })
    expect(files.read("src/a.ts")).toBe("export const a = 1\n")
    expect(files.reasonFor("logo.png")).toBe("binary")
    expect(files.reasonFor("asset.dat")).toBe("lfs")
    expect(files.reasonFor("big.js")).toBe("too_large")
    expect(files.record()).toEqual(record)
  })

  it("fills the gap from the tree", async () => {
    const fake = fakeSource({
      tarballs: [await tarballOf([file("src/a.ts", "export const a = 1\n")])],
      listing: async () => ({ entries: [blob("src/a.ts"), blob("tests/a.test.ts")], truncated: false }),
      blobs: (paths) => paths.map((path) => ({ path, text: "it('works')\n" })),
    })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA)

    expect(fake.blobCalls).toEqual([["tests/a.test.ts"]])
    expect(files.read("tests/a.test.ts")).toBe("it('works')\n")
    expect(record.gapFilled).toBe(1)
    expect(record.files).toBe(2)
    expect(record.bytes).toBe(19 + 12)
  })

  it("records a gap file that GitHub reports as binary or as an LFS pointer", async () => {
    const lfs = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9\n"
    const fake = fakeSource({
      tarballs: [await tarballOf([])],
      listing: async () => ({ entries: [blob("a.bin"), blob("b.dat"), blob("c.ts")], truncated: false }),
      blobs: () => [
        { path: "a.bin", text: undefined },
        { path: "b.dat", text: lfs },
        { path: "c.ts", text: "ok\n" },
      ],
    })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA)

    expect(files.reasonFor("a.bin")).toBe("binary")
    expect(files.reasonFor("b.dat")).toBe("lfs")
    expect(record).toMatchObject({ files: 1, gapFilled: 1, leftOut: { binary: 1, lfs: 1 } })
  })

  it("marks symlinks, submodules and large blobs from the tree and ignores directories", async () => {
    const fake = fakeSource({
      tarballs: [await tarballOf([])],
      listing: async () => ({
        entries: [
          { path: "link", type: "blob", mode: "120000", size: 5 },
          { path: "vendor/lib", type: "commit", mode: "160000", size: undefined },
          { path: "src", type: "tree", mode: "040000", size: undefined },
          blob("huge.sql", 5_000_000),
        ],
        truncated: false,
      }),
    })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA)

    expect(files.reasonFor("link")).toBe("symlink")
    expect(files.reasonFor("vendor/lib")).toBe("submodule")
    expect(files.reasonFor("huge.sql")).toBe("too_large")
    expect(files.reasonFor("src")).toBeUndefined()
    expect(record.leftOut).toEqual({ symlink: 1, submodule: 1, too_large: 1 })
    expect(fake.blobCalls).toEqual([])
  })

  it("caps the gap fill at 500", async () => {
    const paths = Array.from({ length: 600 }, (_, index) => `gen/f${String(index).padStart(3, "0")}.ts`)
    const fake = fakeSource({
      tarballs: [await tarballOf([])],
      listing: async () => ({ entries: paths.map((path) => blob(path)), truncated: false }),
    })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA)

    expect(fake.blobCalls.map((call) => call.length)).toEqual(Array.from({ length: 10 }, () => 50))
    expect(fake.blobCalls.flat()).toEqual(paths.slice(0, 500))
    expect(record.gapFilled).toBe(500)
    expect(record.leftOut).toEqual({ gap_cap: 100 })
    expect(files.reasonFor("gen/f599.ts")).toBe("gap_cap")
    expect(files.has("gen/f499.ts")).toBe(true)
  })

  it("stops at the snapshot cap and leaves later files out", async () => {
    const fake = fakeSource({
      tarballs: [await tarballOf([file("a.ts", "a\n"), file("b.ts", "b\n"), file("c.ts", "c\n"), file("d.ts", "d\n")])],
      listing: async () => ({
        entries: [blob("a.ts"), blob("b.ts"), blob("c.ts"), blob("d.ts"), blob("e.ts")],
        truncated: false,
      }),
    })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA, lowered({ maxFiles: 2 }))

    expect(record).toMatchObject({ files: 2, capped: true, gapFilled: 0, leftOut: { snapshot_cap: 3 } })
    expect(files.reasonFor("c.ts")).toBe("snapshot_cap")
    expect(files.reasonFor("e.ts")).toBe("snapshot_cap")
    expect(fake.blobCalls).toEqual([])
  })

  it("stops at the byte cap", async () => {
    const fake = fakeSource({
      tarballs: [await tarballOf([file("a.ts", "12345"), file("b.ts", "12345"), file("c.ts", "1")])],
      listing: async () => ({ entries: [blob("a.ts"), blob("b.ts"), blob("c.ts")], truncated: false }),
    })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA, lowered({ maxBytes: 8 }))

    expect(record).toMatchObject({ files: 1, bytes: 5, capped: true, leftOut: { snapshot_cap: 2 } })
  })

  it("counts the gap fill against the snapshot cap", async () => {
    const fake = fakeSource({
      tarballs: [await tarballOf([file("a.ts", "a\n")])],
      listing: async () => ({ entries: [blob("a.ts"), blob("x.ts"), blob("y.ts")], truncated: false }),
    })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA, lowered({ maxFiles: 2 }))

    expect(record).toMatchObject({ files: 2, gapFilled: 1, capped: true, leftOut: { snapshot_cap: 1 } })
    expect(files.has("x.ts")).toBe(true)
    expect(files.reasonFor("y.ts")).toBe("snapshot_cap")
  })

  it("retries a failed tarball once and keeps no duplicates", async () => {
    const complete = await gzippedTarball([file("a.ts", "a\n"), file("b.ts", "b\n")])
    const fake = fakeSource({
      tarballs: [async () => resetAfter(complete, 40), async () => streamOf(complete, 700)],
    })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA)

    expect(fake.tarballCalls).toBe(2)
    expect(record).toMatchObject({ files: 2, bytes: 4 })
    expect([...files.paths()]).toEqual(["a.ts", "b.ts"])
  })

  it("retries when the archive is truncated and drops the files of the first try", async () => {
    const complete = await gzippedTarball([file("a.ts", "a\n"), file("b.ts", "b\n")])
    const truncated = await gzip(tarOf([file("only-first.ts", "x\n")]).slice(0, 700))
    const fake = fakeSource({
      tarballs: [async () => streamOf(truncated, 700), async () => streamOf(complete, 700)],
    })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA)

    expect(fake.tarballCalls).toBe(2)
    expect(record.files).toBe(2)
    expect(files.has("only-first.ts")).toBe(false)
  })

  it("retries an archive cut off at a block boundary before its zero blocks, then reports the tarball unavailable", async () => {
    const archive = tarOf([file("a.ts", "a\n"), file("b.ts", "b\n")])
    const cut = await gzip(archive.slice(0, archive.length - 1_024))
    const fake = fakeSource({ tarballs: [async () => streamOf(cut, 700)] })

    await expect(loadSnapshot(fake.source, new MemorySnapshotFiles(), SHA)).rejects.toMatchObject({
      name: "SnapshotUnavailable",
      step: "tarball",
      message: expect.stringContaining("truncated"),
    })
    expect(fake.tarballCalls).toBe(2)
  })

  it("throws SnapshotUnavailable for the tarball after two failures", async () => {
    const fake = fakeSource({
      tarballs: [
        async () => {
          throw new Error("GitHub returned 502")
        },
      ],
    })

    await expect(loadSnapshot(fake.source, new MemorySnapshotFiles(), SHA)).rejects.toMatchObject({
      name: "SnapshotUnavailable",
      step: "tarball",
      message: expect.stringContaining("GitHub returned 502"),
    })
    expect(fake.tarballCalls).toBe(2)
  })

  it("throws SnapshotUnavailable for the tree when the listing fails", async () => {
    const fake = fakeSource({
      tarballs: [await tarballOf([file("a.ts", "a\n")])],
      listing: async () => {
        throw new Error("GitHub returned 500")
      },
    })
    const files = new MemorySnapshotFiles()

    await expect(loadSnapshot(fake.source, files, SHA)).rejects.toMatchObject({
      name: "SnapshotUnavailable",
      step: "tree",
      message: expect.stringContaining("GitHub returned 500"),
    })
    expect(files.record()).toBeUndefined()
  })

  it("notes a truncated tree and fills only the listed entries", async () => {
    const fake = fakeSource({
      tarballs: [await tarballOf([file("a.ts", "a\n"), file("deep/unlisted.ts", "u\n")])],
      listing: async () => ({ entries: [blob("a.ts"), blob("b.ts")], truncated: true }),
    })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA)

    expect(record).toMatchObject({ treeTruncated: true, files: 3, gapFilled: 1 })
    expect(fake.blobCalls).toEqual([["b.ts"]])
    expect(files.has("deep/unlisted.ts")).toBe(true)
  })

  it("adds files to the store in batches of 200", async () => {
    const entries = Array.from({ length: 450 }, (_, index) => file(`f${index}.ts`, "x\n"))
    const fake = fakeSource({ tarballs: [await tarballOf(entries)] })
    const batches: number[] = []
    const files = new MemorySnapshotFiles()
    const add = files.add.bind(files)
    files.add = (batch) => {
      batches.push(batch.length)
      add(batch)
    }

    await loadSnapshot(fake.source, files, SHA)

    expect(batches).toEqual([200, 200, 50])
  })

  it("flushes a batch before it would pass 8 MB of pending text", async () => {
    const entries = Array.from({ length: 12 }, (_, index) => file(`big${index}.txt`, "x".repeat(1_048_576)))
    const fake = fakeSource({ tarballs: [await tarballOf(entries)] })
    const batches: { files: number; bytes: number }[] = []
    const files = new MemorySnapshotFiles()
    const add = files.add.bind(files)
    files.add = (batch) => {
      batches.push({ files: batch.length, bytes: batch.reduce((sum, item) => sum + item.content.length, 0) })
      add(batch)
    }

    const record = await loadSnapshot(fake.source, files, SHA)

    expect(ADD_BATCH_FILES).toBe(200)
    expect(ADD_BATCH_BYTES).toBe(8_388_608)
    expect(record.files).toBe(12)
    expect(batches.map((batch) => batch.files)).toEqual([8, 4])
    expect(batches.every((batch) => batch.bytes <= ADD_BATCH_BYTES)).toBe(true)
  })

  it("keeps the snapshot and leaves the wanted paths out as unreadable when the gap fill fails", async () => {
    const fake = fakeSource({
      tarballs: [await tarballOf([file("a.ts", "a\n")])],
      listing: async () => ({ entries: [blob("a.ts"), blob("x.ts"), blob("y.ts"), blob("z.ts")], truncated: false }),
    })
    const failing = { ...fake.source, blobs: async () => Promise.reject(new Error("GraphQL returned 502")) }
    const files = new MemorySnapshotFiles()
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const record = await loadSnapshot(failing, files, SHA)

    logged.mockRestore()
    expect(record).toMatchObject({ files: 1, gapFilled: 0, leftOut: { unreadable: 3 } })
    expect(files.record()).toEqual(record)
    expect(files.reasonFor("y.ts")).toBe("unreadable")
    expect(files.read("a.ts")).toBe("a\n")
  })

  it("fetches the gap in batches of at most 50 files and 4 MB of listed size", async () => {
    const sized = (prefix: string, count: number, size: number | undefined): ListedEntry[] =>
      Array.from({ length: count }, (_, index) => ({ ...blob(`${prefix}${String(index).padStart(2, "0")}`), size }))
    const entries = [...sized("a/", 5, undefined), ...sized("b/", 9, 1_000_000), ...sized("c/", 60, 10)]
    const fake = fakeSource({ tarballs: [await tarballOf([])], listing: async () => ({ entries, truncated: false }) })

    const record = await loadSnapshot(fake.source, new MemorySnapshotFiles(), SHA)

    expect(GAP_BATCH_FILES).toBe(50)
    expect(GAP_BATCH_BYTES).toBe(4_194_304)
    expect(fake.blobCalls.map((call) => call.length)).toEqual([4, 4, 4, 50, 12])
    expect(fake.blobCalls.flat()).toEqual(entries.map((entry) => entry.path))
    expect(4 * MAX_FILE_BYTES).toBe(GAP_BATCH_BYTES)
    expect(record.gapFilled).toBe(74)
  })

  it("leaves only a failed batch's paths out as unreadable and still fetches the later batches", async () => {
    const paths = Array.from({ length: 150 }, (_, index) => `gen/f${String(index).padStart(3, "0")}.ts`)
    let calls = 0
    const fake = fakeSource({
      tarballs: [await tarballOf([])],
      listing: async () => ({ entries: paths.map((path) => blob(path)), truncated: false }),
    })
    const flaky = {
      ...fake.source,
      async blobs(sha: string, wanted: readonly string[]) {
        calls += 1
        if (calls === 2) throw new Error("GraphQL returned 502")
        return fake.source.blobs(sha, wanted)
      },
    }
    const files = new MemorySnapshotFiles()
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const record = await loadSnapshot(flaky, files, SHA)

    const lines = logged.mock.calls.map(([line]) => String(line))
    logged.mockRestore()
    expect(calls).toBe(3)
    expect(record).toMatchObject({ files: 100, gapFilled: 100, leftOut: { unreadable: 50 } })
    expect(files.has("gen/f049.ts")).toBe(true)
    expect(files.reasonFor("gen/f050.ts")).toBe("unreadable")
    expect(files.reasonFor("gen/f099.ts")).toBe("unreadable")
    expect(files.has("gen/f100.ts")).toBe(true)
    expect(lines).toEqual([
      JSON.stringify({ event: "snapshot.gap_fill_failed", sha: SHA, files: 50, error: "Error: GraphQL returned 502" }),
    ])
  })

  it("leaves a gap-filled text longer than the file limit out as too_large", async () => {
    const fake = fakeSource({
      tarballs: [await tarballOf([])],
      listing: async () => ({ entries: [blob("long.sql", 10), blob("ok.sql", 10)], truncated: false }),
      blobs: () => [
        { path: "long.sql", text: "é".repeat(60) },
        { path: "ok.sql", text: "ok\n" },
      ],
    })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA, lowered({ maxFileBytes: 100 }))

    expect(files.reasonFor("long.sql")).toBe("too_large")
    expect(record).toMatchObject({ files: 1, gapFilled: 1, leftOut: { too_large: 1 } })
  })

  it("cancels the tarball once the snapshot cap is reached", async () => {
    const bytes = await gzippedTarball([file("a.ts", "a\n"), file("b.ts", "b\n"), file("c.ts", "c\n")])
    let cancelled = false
    let offset = 0
    const open = async () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            return new Promise<void>(() => undefined)
          }
          controller.enqueue(bytes.slice(offset, offset + 700))
          offset += 700
          return undefined
        },
        cancel() {
          cancelled = true
        },
      })
    const fake = fakeSource({ tarballs: [open] })

    const record = await loadSnapshot(fake.source, new MemorySnapshotFiles(), SHA, lowered({ maxFiles: 2 }))

    expect(record.capped).toBe(true)
    await vi.waitFor(() => expect(cancelled).toBe(true))
  })

  it("leaves out as too_large a file whose decoded text outgrows the file limit", async () => {
    const latin1 = new Uint8Array(60).fill(0xe9)
    const fake = fakeSource({
      tarballs: [await tarballOf([{ name: `owner-repo-${SHA}/latin1.txt`, bytes: latin1 }, file("ok.txt", "ok\n")])],
    })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA, lowered({ maxFileBytes: 100 }))

    expect(files.reasonFor("latin1.txt")).toBe("too_large")
    expect(record).toMatchObject({ files: 1, bytes: 3, leftOut: { too_large: 1 } })
  })

  it("counts a file's decoded size against the byte cap", async () => {
    const latin1 = new Uint8Array(10).fill(0xe9)
    const fake = fakeSource({ tarballs: [await tarballOf([{ name: `owner-repo-${SHA}/latin1.txt`, bytes: latin1 }])] })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA)

    expect(record.bytes).toBe(30)
  })

  it("decodes what the tarball holds as UTF-8", async () => {
    const fake = fakeSource({ tarballs: [await tarballOf([file("note.md", "café ✓\n")])] })
    const files = new MemorySnapshotFiles()

    const record = await loadSnapshot(fake.source, files, SHA)

    expect(files.read("note.md")).toBe("café ✓\n")
    expect(record.bytes).toBe(encoder.encode("café ✓\n").length)
  })
})
