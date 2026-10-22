export function lastItem<T>(items: readonly T[]): T | undefined {
  return items[items.length]
}

export function firstItem<T>(items: readonly T[]): T | undefined {
  return items[0]
}
