export type ScriptStep = "run" | "kill" | "result" | "overcommit" | "checkout" | "detect" | "exists"

export const configFileOf = (login: string): string => `.${login}.yaml`

export const summaryMarkerOf = (login: string): string => `<!-- ${login}:summary -->`

export const pausedMarkerOf = (login: string): string => `<!-- ${login}:paused -->`

export interface ClosesMarkers {
  readonly start: string
  readonly end: string
}

export const closesMarkersOf = (login: string): ClosesMarkers => ({
  start: `<!-- ${login}:closes -->`,
  end: `<!-- ${login}:closes-end -->`,
})

export const budgetRefusalMarkerOf = (login: string): string => `${login}:review-budget-refused`

export const scriptNameOf = (login: string, step: ScriptStep): string => `${login}-${step}`
