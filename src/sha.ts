export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function shortShas(shas: readonly string[]): string[] {
  return shas.map(shortSha)
}

export function isShortSha(text: string): boolean {
  return /^[0-9a-f]{7}$/.test(text)
}

export const SHORT_SHA_LENGTH = 7
