import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { readTar, type TarFile } from "../src/repository/tar.ts"
import { concat, streamOf, tarOf, withHeaderField, type TarEntry } from "./tar-archive.ts"

setFlagsFromString("--expose-gc")

const collectGarbage: () => void = runInNewContext("gc")

const BLOCK = 512

const SIZE_FIELD = 124

const ZERO_DIGIT = "0".charCodeAt(0)

const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0))

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

  it("fails on an archive cut off at a block boundary before its zero blocks, as a truncated download is", async () => {
    const archive = tarOf([{ name: `${ROOT}/a.ts`, body: "abc" }])

    await expect(readAll(archive.subarray(0, archive.length - 2 * BLOCK))).rejects.toThrow("truncated")
    await expect(readAll(archive.subarray(0, archive.length - BLOCK))).rejects.toThrow("truncated")
  })

  it("fails on a lone zero block followed by more entries", async () => {
    const first = tarOf([{ name: `${ROOT}/a.ts`, body: "abc" }])
    const archive = concat([
      first.subarray(0, first.length - 2 * BLOCK),
      new Uint8Array(BLOCK),
      tarOf([{ name: `${ROOT}/b.ts`, body: "b" }]),
    ])

    await expect(readAll(archive)).rejects.toThrow("lone zero block")
  })

  it("rejects a header whose checksum doesn't match its bytes", async () => {
    const archive = tarOf([{ name: `${ROOT}/a.ts`, body: "abc" }])
    const renamed = archive.slice()
    renamed[ROOT.length + 2] = "x".charCodeAt(0)
    const checksumEdited = archive.slice()
    const lastDigit = 153
    checksumEdited[lastDigit] = checksumEdited[lastDigit] === ZERO_DIGIT ? ZERO_DIGIT + 1 : ZERO_DIGIT

    await expect(readAll(renamed)).rejects.toThrow("checksum")
    await expect(readAll(checksumEdited)).rejects.toThrow("checksum")
  })

  it.each([
    ["trailing junk", "00000000003x"],
    ["junk after the terminator", "0000000003\0x"],
    ["a digit that isn't octal", "00000000009\0"],
    ["no digits", "\0\0\0\0\0\0\0\0\0\0\0\0"],
    ["base-256", "\x80\0\0\0\0\0\0\0\0\0\0\x03"],
  ])("rejects a size field with %s", async (_label, field) => {
    const archive = withHeaderField(tarOf([{ name: `${ROOT}/a.ts`, body: "abc" }]), 0, SIZE_FIELD, field)

    await expect(readAll(archive)).rejects.toThrow("unreadable size")
  })

  it("reads a size field padded with spaces", async () => {
    const archive = withHeaderField(tarOf([{ name: `${ROOT}/a.ts`, body: "abc" }]), 0, SIZE_FIELD, "         3 ")

    expect(await readAll(archive)).toEqual([{ path: "a.ts", size: 3, body: "abc" }])
  })

  it.each([
    ["a length past the record's end", "99 path=x\n"],
    ["a length that isn't decimal", "1x path=x\n"],
    ["no space after the length", "11path=abc\n"],
    ["no newline at the record's end", "10 path=abc"],
    ["a length too short for its key", "3 path=x\n"],
  ])("rejects a pax record with %s", async (_label, rawPax) => {
    const archive = tarOf([{ rawPax }, { name: `${ROOT}/a.ts`, body: "abc" }])

    await expect(readAll(archive)).rejects.toThrow("pax record is malformed")
  })

  it("lets each chunk of a skipped entry go before reading the next, so a large one is never held in memory", async () => {
    const chunkSize = 65_536
    const chunkCount = 32
    const header = tarOf([{ name: `${ROOT}/big.bin`, bytes: new Uint8Array(chunkSize * chunkCount) }]).slice(0, BLOCK)
    const tail = tarOf([{ name: `${ROOT}/after.ts`, body: "after" }])
    const skipped: WeakRef<Uint8Array>[] = []
    const alive = { now: 0, most: 0 }
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          await nextMacrotask()
          collectGarbage()
          alive.now = skipped.filter((chunk) => chunk.deref() !== undefined).length
          alive.most = Math.max(alive.most, alive.now)
          pulls += 1
          if (pulls === 1) {
            controller.enqueue(header)
          } else if (pulls <= chunkCount + 1) {
            const chunk = new Uint8Array(chunkSize)
            skipped.push(new WeakRef(chunk))
            controller.enqueue(chunk)
          } else if (pulls === chunkCount + 2) {
            controller.enqueue(tail)
          } else {
            controller.close()
          }
        },
      },
      { highWaterMark: 0 },
    )
    const files: ReadFile[] = []
    for await (const file of readTar(stream, 1_000)) files.push(describeFile(file))

    expect(files).toEqual([
      { path: "big.bin", size: chunkSize * chunkCount, body: undefined },
      { path: "after.ts", size: 5, body: "after" },
    ])
    expect(skipped).toHaveLength(chunkCount)
    expect(alive.most).toBe(0)
  })
})
