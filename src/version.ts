/**
 * Which build is running. After a deploy, Cloudflare releases the Worker and
 * its Durable Objects eventually, so for seconds to minutes a new Worker can
 * call an object still running the previous build.
 */

export interface Version {
  id: string;
  /** When the version was created, ISO 8601. */
  timestamp: string;
}

export function versionOf(metadata: { id: string; timestamp: string } | undefined): Version {
  return { id: metadata?.id ?? "", timestamp: metadata?.timestamp ?? "" };
}

/** True when `own` is a build created before `caller`'s. Unknown versions are never older. */
export function isOlder(own: Version, caller: Version | undefined): boolean {
  if (!caller || own.id === caller.id) return false;
  const ownAt = Date.parse(own.timestamp);
  const callerAt = Date.parse(caller.timestamp);
  return Number.isFinite(ownAt) && Number.isFinite(callerAt) && ownAt < callerAt;
}
