export interface TarFile {
  path: string
  size: number
  body: Uint8Array | undefined
}

interface TarHeader {
  path: string
  size: number
  typeflag: string
}

const BLOCK = 512

const MAX_METADATA_BYTES = 1_048_576

const NAME_RECORD_FLAGS = ["x", "L"]

const REGULAR_FLAGS = ["0", "\0"]

const CHECKSUM_START = 148

const CHECKSUM_END = 156

const SPACE = 0x20

const NEWLINE = 0x0a

const OCTAL_FIELD = /^ *([0-7]+)[ \0]*$/

const DECIMAL = /^[0-9]+$/

const decoder = new TextDecoder()

const paddedSize = (size: number): number => Math.ceil(size / BLOCK) * BLOCK

const truncated = (): Error => new Error("tar archive is truncated")

const malformedPax = (): Error => new Error("tar pax record is malformed")

const isZero = (block: Uint8Array): boolean => block.every((byte) => byte === 0)

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end))
}

function octal(field: Uint8Array): number | undefined {
  const digits = OCTAL_FIELD.exec(decoder.decode(field))?.[1]
  return digits === undefined ? undefined : Number.parseInt(digits, 8)
}

function parseSize(field: Uint8Array): number {
  const size = octal(field)
  if (size === undefined) {
    throw new Error("tar header has an unreadable size")
  }
  return size
}

function checksumMatches(block: Uint8Array): boolean {
  let sum = 0
  for (const [index, byte] of block.entries()) {
    sum += index >= CHECKSUM_START && index < CHECKSUM_END ? SPACE : byte
  }
  return octal(block.subarray(CHECKSUM_START, CHECKSUM_END)) === sum
}

function parseHeader(block: Uint8Array): TarHeader {
  if (!checksumMatches(block)) {
    throw new Error("tar header checksum doesn't match")
  }
  const name = cString(block.subarray(0, 100))
  const prefix = cString(block.subarray(345, 500))
  return {
    path: prefix === "" ? name : `${prefix}/${name}`,
    size: parseSize(block.subarray(124, 136)),
    typeflag: String.fromCharCode(block[156] ?? 0),
  }
}

interface PaxRecord {
  field: string
  end: number
}

function paxRecord(body: Uint8Array, offset: number): PaxRecord {
  const space = body.indexOf(SPACE, offset)
  if (space < 0) {
    throw malformedPax()
  }
  const digits = decoder.decode(body.subarray(offset, space))
  const end = offset + Number.parseInt(digits, 10)
  if (!DECIMAL.test(digits) || end <= space + 1 || end > body.length || body[end - 1] !== NEWLINE) {
    throw malformedPax()
  }
  const field = decoder.decode(body.subarray(space + 1, end - 1))
  if (!field.includes("=")) {
    throw malformedPax()
  }
  return { field, end }
}

function paxPath(body: Uint8Array): string | undefined {
  let path: string | undefined
  for (let offset = 0; offset < body.length;) {
    const { field, end } = paxRecord(body, offset)
    path = field.startsWith("path=") ? field.slice("path=".length) : path
    offset = end
  }
  return path
}

const namedBy = (typeflag: string, body: Uint8Array): string | undefined =>
  typeflag === "x" ? paxPath(body) : cString(body)

const withoutRootDirectory = (path: string): string => path.slice(path.indexOf("/") + 1)

class TarSource {
  private readonly chunks: Uint8Array[] = []
  private queued = 0
  private ended = false

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async header(): Promise<TarHeader | undefined> {
    const block = await this.take(BLOCK)
    if (!isZero(block)) {
      return parseHeader(block)
    }
    if (!isZero(await this.take(BLOCK))) {
      throw new Error("tar archive has a lone zero block")
    }
    return undefined
  }

  async take(count: number): Promise<Uint8Array> {
    await this.fill(count)
    if (this.queued < count) {
      throw truncated()
    }
    const out = new Uint8Array(count)
    let filled = 0
    while (filled < count) {
      const chunk = this.chunks[0]
      if (chunk === undefined) {
        throw truncated()
      }
      const used = Math.min(chunk.length, count - filled)
      out.set(chunk.subarray(0, used), filled)
      filled += used
      this.consume(used)
    }
    return out
  }

  async discard(count: number): Promise<void> {
    for (let remaining = count; remaining > 0;) {
      await this.fill(1)
      if (this.queued === 0) {
        throw truncated()
      }
      const used = Math.min(remaining, this.queued)
      this.consume(used)
      remaining -= used
    }
  }

  async close(): Promise<void> {
    this.chunks.length = 0
    this.queued = 0
    await this.reader.cancel()
  }

  private consume(count: number): void {
    this.queued -= count
    for (let remaining = count; remaining > 0;) {
      const chunk = this.chunks[0]
      if (chunk === undefined) {
        return
      }
      if (chunk.length > remaining) {
        this.chunks[0] = chunk.subarray(remaining)
        return
      }
      remaining -= chunk.length
      this.chunks.shift()
    }
  }

  private async fill(count: number): Promise<void> {
    while (this.queued < count && !this.ended) {
      const { done, value } = await this.reader.read()
      if (done) {
        this.ended = true
      } else {
        this.chunks.push(value)
        this.queued += value.length
      }
    }
  }
}

async function readMetadata(source: TarSource, header: TarHeader): Promise<string | undefined> {
  if (header.size > MAX_METADATA_BYTES) {
    throw new Error("tar metadata record is too large")
  }
  const body = await source.take(paddedSize(header.size))
  return namedBy(header.typeflag, body.subarray(0, header.size))
}

async function readFile(source: TarSource, header: TarHeader, path: string, maxBytes: number): Promise<TarFile> {
  const { size } = header
  if (size > maxBytes) {
    await source.discard(paddedSize(size))
    return { path, size, body: undefined }
  }
  const padded = await source.take(paddedSize(size))
  return { path, size, body: padded.subarray(0, size) }
}

export async function* readTar(stream: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<TarFile> {
  const source = new TarSource(stream.getReader())
  try {
    let namedPath: string | undefined
    for (let header = await source.header(); header !== undefined; header = await source.header()) {
      if (NAME_RECORD_FLAGS.includes(header.typeflag)) {
        namedPath = await readMetadata(source, header)
        continue
      }
      if (REGULAR_FLAGS.includes(header.typeflag)) {
        yield await readFile(source, header, withoutRootDirectory(namedPath ?? header.path), maxBytes)
      } else {
        await source.discard(paddedSize(header.size))
      }
      namedPath = undefined
    }
  } finally {
    await source.close()
  }
}
