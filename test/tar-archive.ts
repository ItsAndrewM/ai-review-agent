const BLOCK = 512

const encoder = new TextEncoder()

export interface TarFileEntry {
  name: string
  body?: string
  bytes?: Uint8Array
  typeflag?: string
  prefix?: string
  longName?: "pax" | "gnu"
}

export interface TarGlobalEntry {
  global: Record<string, string>
}

export type TarEntry = TarFileEntry | TarGlobalEntry

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`
}

function headerBlock(name: string, size: number, typeflag: string, prefix: string): Uint8Array {
  const block = new Uint8Array(BLOCK)
  const write = (offset: number, text: string, max: number) => block.set(encoder.encode(text).subarray(0, max), offset)
  write(0, name, 100)
  write(100, octal(0o644, 8), 8)
  write(108, octal(0, 8), 8)
  write(116, octal(0, 8), 8)
  write(124, octal(size, 12), 12)
  write(136, octal(0, 12), 12)
  write(148, "        ", 8)
  write(156, typeflag, 1)
  write(257, "ustar\0", 6)
  write(263, "00", 2)
  write(345, prefix, 155)
  const checksum = block.reduce((sum, byte) => sum + byte, 0)
  write(148, `${checksum.toString(8).padStart(6, "0")}\0 `, 8)
  return block
}

function padded(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK)
  out.set(bytes)
  return out
}

function record(name: string, typeflag: string, body: Uint8Array): Uint8Array[] {
  return [headerBlock(name, body.length, typeflag, ""), padded(body)]
}

function paxLine(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`
  const restLength = encoder.encode(rest).length
  const digits = String(restLength + String(restLength).length).length
  return `${restLength + digits}${rest}`
}

function paxRecords(fields: Record<string, string>): Uint8Array {
  const lines = Object.entries(fields).map(([key, value]) => paxLine(key, value))
  return encoder.encode(lines.join(""))
}

function fileParts(entry: TarFileEntry): Uint8Array[] {
  const body = entry.bytes ?? encoder.encode(entry.body ?? "")
  const header = headerBlock(entry.name, body.length, entry.typeflag ?? "0", entry.prefix ?? "")
  const content = body.length === 0 ? [] : [padded(body)]
  if (entry.longName === "pax") {
    return [...record("PaxHeader/x", "x", paxRecords({ path: entry.name })), header, ...content]
  }
  if (entry.longName === "gnu") {
    return [...record("././@LongLink", "L", encoder.encode(`${entry.name}\0`)), header, ...content]
  }
  return [header, ...content]
}

function partsOf(entry: TarEntry): Uint8Array[] {
  if ("global" in entry) {
    return record("pax_global_header", "g", paxRecords(entry.global))
  }
  return fileParts(entry)
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function tarOf(entries: readonly TarEntry[]): Uint8Array {
  return concat([...entries.flatMap(partsOf), new Uint8Array(BLOCK * 2)])
}

export function streamOf(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize))
      offset += chunkSize
    },
  })
}
