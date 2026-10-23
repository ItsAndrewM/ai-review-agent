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

const decoder = new TextDecoder()

const paddedSize = (size: number): number => Math.ceil(size / BLOCK) * BLOCK

const truncated = (): Error => new Error("tar archive is truncated")

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end))
}

function parseSize(field: Uint8Array): number {
  const size = Number.parseInt(cString(field).trim(), 8)
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("tar header has an unreadable size")
  }
  return size
}

function parseHeader(block: Uint8Array): TarHeader {
  const name = cString(block.subarray(0, 100))
  const prefix = cString(block.subarray(345, 500))
  return {
    path: prefix === "" ? name : `${prefix}/${name}`,
    size: parseSize(block.subarray(124, 136)),
    typeflag: String.fromCharCode(block[156] ?? 0),
  }
}

function paxPath(body: Uint8Array): string | undefined {
  let path: string | undefined
  for (let offset = 0; offset < body.length;) {
    const space = body.indexOf(0x20, offset)
    const length = Number.parseInt(decoder.decode(body.subarray(offset, Math.max(space, offset))), 10)
    if (space < 0 || !(length > space - offset + 1)) {
      throw new Error("tar pax record is malformed")
    }
    const field = decoder.decode(body.subarray(space + 1, offset + length - 1))
    path = field.startsWith("path=") ? field.slice("path=".length) : path
    offset += length
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
    await this.fill(BLOCK)
    if (this.queued === 0) {
      return undefined
    }
    const block = await this.take(BLOCK)
    return block.every((byte) => byte === 0) ? undefined : parseHeader(block)
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
