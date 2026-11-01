/**
 * Floor policy for harness CLIs that are not OpenClaw (OpenClaw uses CalVer
 * and its own contract in services/openClawRuntimeContract.ts).
 *
 * A floor-pinned harness is admitted at or above its floor unless the version
 * is deny-listed. What a newer version must still prove is its protocol: the
 * ACP `initialize` handshake (protocol version, agent identity, required
 * capabilities) runs before every session, and Ollama answers its HTTP API.
 * Exact version lists only refused newer builds that speak the same protocol.
 *
 * Pure functions only.
 */

export type HarnessVersionDenylist = Readonly<Record<string, ReadonlyArray<Readonly<{ version: string; reason: string }>>>>;

/** Versions known to break the Portal, per harness id. Data, not code: add an entry with its reason. */
export const HARNESS_VERSION_DENYLIST: HarnessVersionDenylist = Object.freeze({});

interface ParsedHarnessVersion {
  nums: [number, number, number];
  pre: Array<number | string> | null;
}

const HARNESS_VERSION_PATTERN = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,63}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;

export function parseHarnessVersion(raw: unknown): ParsedHarnessVersion | null {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(HARNESS_VERSION_PATTERN);
  if (!match) return null;
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : null,
  };
}

/** Semver order (a prerelease sorts before its release); null when either side is unreadable. */
export function compareHarnessVersions(left: unknown, right: unknown): number | null {
  const a = parseHarnessVersion(left);
  const b = parseHarnessVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.nums[index] !== b.nums[index]) return a.nums[index] < b.nums[index] ? -1 : 1;
  }
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const l = a.pre[index];
    const r = b.pre[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l !== typeof r) return typeof l === 'number' ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * Why `installed` is not admitted for `harnessId`, in plain words, or null
 * when it is: readable, not deny-listed, and at or above `floor`.
 */
export function harnessVersionRefusal(
  harnessId: string,
  installed: unknown,
  floor: string,
  denylist: HarnessVersionDenylist = HARNESS_VERSION_DENYLIST,
): string | null {
  const detected = typeof installed === 'string' && installed.trim() ? installed.trim() : 'unknown';
  const order = compareHarnessVersions(detected, floor);
  if (order === null) return `the installed version ${detected} could not be read`;
  const denial = (denylist[harnessId] || []).find((entry) => entry.version === detected.replace(/^v/, ''));
  if (denial) return `version ${detected} is refused by the Portal: ${denial.reason}`;
  if (order < 0) return `version ${detected} is older than the Portal's supported floor ${floor}`;
  return null;
}

/** True when `installed` is newer than the version the Portal tested (admitted, but unproven). */
export function harnessVersionIsNewerThanTested(installed: unknown, tested: string | undefined): boolean {
  if (!tested) return false;
  const order = compareHarnessVersions(installed, tested);
  return order !== null && order > 0;
}
