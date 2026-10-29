export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly path: string,
  ) {
    super(message)
    this.name = "GitHubError"
  }
}

export class TransientFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TransientFailure"
  }
}

export function isTransient(error: Error): boolean {
  if (error instanceof TransientFailure) return true
  if (!(error instanceof GitHubError)) return false
  return error.status === undefined || (error.status >= 500 && error.status <= 599)
}

export function softenUnlessTransient(error: Error): void {
  if (isTransient(error)) throw error
}

export function errorOf(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

export function failureSummary(error: Error): string {
  if (!(error instanceof GitHubError)) return error.message
  return `${error.status ?? "no response"} on ${error.path}`
}
