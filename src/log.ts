/**
 * One JSON line per event, which Workers Logs indexes field by field.
 */

export type LogFields = Record<string, unknown>

export function log(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ event, ...fields }))
}

export function logError(event: string, fields: LogFields = {}): void {
  console.error(JSON.stringify({ event, ...fields }))
}

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
