export interface Version {
  id: string
  timestamp: string
}

export function versionOf(metadata: { id: string; timestamp: string } | undefined): Version {
  return { id: metadata?.id ?? "", timestamp: metadata?.timestamp ?? "" }
}

export function isOlder(own: Version, caller: Version | undefined): boolean {
  if (!caller || own.id === caller.id) return false
  const ownAt = Date.parse(own.timestamp)
  const callerAt = Date.parse(caller.timestamp)
  return Number.isFinite(ownAt) && Number.isFinite(callerAt) && ownAt > callerAt
}
