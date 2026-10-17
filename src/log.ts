type LogValue = string | number | boolean | undefined

export type LogFields = Record<string, LogValue>

export function log(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ event, ...fields }))
}

export function logError(event: string, fields: LogFields = {}): void {
  console.error(JSON.stringify({ event, ...fields }))
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
}
