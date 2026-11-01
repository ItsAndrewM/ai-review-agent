export function plural(count: number, noun: string, plurals = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plurals}`
}

export function were(count: number): "was" | "were" {
  return count === 1 ? "was" : "were"
}
