import { describe, expect, it } from "vitest"
import { readTar, type TarFile } from "../src/repository/tar.ts"
import { concat, streamOf, tarOf, type TarEntry } from "./tar-archive.ts"

const decoder = new TextDecoder()

const ROOT = "o-r-abc"

const SHA = "0123456789abcdef0123456789abcdef01234567"

const longPath = `${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(25)}.ts`

interface ReadFile {
  path: string
  size: number
  body: string | undefined
}

const describeFile = (file: TarFile): ReadFile => ({
  path: file.path,
  size: file.size,
  body: file.body === undefined ? undefined : decoder.decode(file.body),
})

async function readAll(bytes: Uint8Array, maxBytes = 1_000_000, chunkSize = 4096): Promise<ReadFile[]> {
  const files: ReadFile[] = []
  for await (const file of readTar(streamOf(bytes, chunkSize), maxBytes)) {
    files.push(describeFile(file))
  }
  return files
}

describe("readTar", () => {
  it("yields regular files with the leading directory stripped", async () => {
    const archive = tarOf([
      { name: `${ROOT}/`, typeflag: "5" },
      { name: `${ROOT}/src/a.ts`, body: "abc" },
    ])

    expect(await readAll(archive)).toEqual([{ path: "src/a.ts", size: 3, body: "abc" }])
  })

  it("joins the ustar prefix field", async () => {
    const archive = tarOf([{ prefix: `${ROOT}/deep/dir`, name: "file.ts", body: "x" }])

    expect(await readAll(archive)).toEqual([{ path: "deep/dir/file.ts", size: 1, body: "x" }])
  })

  it("takes a long path from a pax x record", async () => {
    const archive = tarOf([{ name: `${ROOT}/${longPath}`, body: "x", longName: "pax" }])

    expect(longPath).toHaveLength(150)
    expect(await readAll(archive)).toEqual([{ path: longPath, size: 1, body: "x" }])
  })

  it("takes a long path from a GNU L record", async () => {
    const archive = tarOf([{ name: `${ROOT}/${longPath}`, body: "x", longName: "gnu" }])

    expect(await readAll(archive)).toEqual([{ path: longPath, size: 1, body: "x" }])
  })

  it("applies a pax path to the next entry only", async () => {
    const archive = tarOf([
      { name: `${ROOT}/${longPath}`, body: "x", longName: "pax" },
      { name: `${ROOT}/short.ts`, body: "y" },
    ])

    expect((await readAll(archive)).map((file) => file.path)).toEqual([longPath, "short.ts"])
  })

  it("ignores pax g records and symlinks", async () => {
    const archive = tarOf([{ global: { comment: SHA } }, { name: `${ROOT}/link`, typeflag: "2" }])

    expect(await readAll(archive)).toEqual([])
  })

  it("leaves out the body past maxBytes", async () => {
    const archive = tarOf([
      { name: `${ROOT}/big.txt`, body: "0123456789" },
      { name: `${ROOT}/small.txt`, body: "ok" },
    ])

    expect(await readAll(archive, 4)).toEqual([
      { path: "big.txt", size: 10, body: undefined },
      { path: "small.txt", size: 2, body: "ok" },
    ])
  })

  it("parses an archive split at every byte boundary", async () => {
    const entries: TarEntry[] = [
      { global: { comment: SHA } },
      { name: `${ROOT}/`, typeflag: "5" },
      { name: `${ROOT}/src/a.ts`, body: "abc" },
      { name: `${ROOT}/${longPath}`, body: "x".repeat(700), longName: "pax" },
      { name: `${ROOT}/big.bin`, body: "y".repeat(2000) },
      { name: `${ROOT}/${longPath}2`, body: "z", longName: "gnu" },
    ]
    const archive = tarOf(entries)
    const whole = await readAll(archive, 1000)

    expect(whole.map((file) => file.path)).toEqual(["src/a.ts", longPath, "big.bin", `${longPath}2`])
    expect(whole[2]).toEqual({ path: "big.bin", size: 2000, body: undefined })
    for (const chunkSize of [1, 7, 511, 512, 513]) {
      expect(await readAll(archive, 1000, chunkSize)).toEqual(whole)
    }
  })

  it("stops at the zero blocks", async () => {
    const garbage = new TextEncoder().encode("not a tar header ".repeat(100))
    const archive = concat([tarOf([{ name: `${ROOT}/a.ts`, body: "abc" }]), garbage])

    expect(await readAll(archive)).toEqual([{ path: "a.ts", size: 3, body: "abc" }])
  })

  it("fails on an archive that ends inside a file", async () => {
    const archive = tarOf([{ name: `${ROOT}/a.ts`, body: "abc" }])

    await expect(readAll(archive.subarray(0, 600))).rejects.toThrow("truncated")
  })
})
