export function lastItem<T>(items: readonly T[]): T | undefined {
  return items[items.length]
}
