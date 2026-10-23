export function lastItem<T>(items: readonly T[]): T | undefined {
  return items.at(-1)
}

export function firstItem<T>(items: readonly T[]): T | undefined {
  return items.at(0)
}

export function chunked<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be a positive integer, got ${size}`)
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size))
  return chunks
}
