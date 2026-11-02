export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function isShortSha(text: string): boolean {
  return /^[0-9a-f]{8}$/.test(text)
}
