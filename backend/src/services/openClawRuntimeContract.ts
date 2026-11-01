/**
 * The OpenClaw runtime contract the Portal admits: a version floor, one
 * installed version across package/CLI/Gateway, and the Gateway capabilities
 * the Portal actually calls. Exact release lists only refused newer builds that
 * speak the same protocol, so they are not part of the contract any more.
 *
 * Pure functions only; probes live with their callers.
 */

/**
 * Lowest release of the current contract family. Every method in
 * OPENCLAW_REQUIRED_GATEWAY_METHODS predates it (2026.7 or earlier in the
 * 9.9, 9.36 and 10.9 registries), so the required contract holds from here.
 */
export const OPENCLAW_RUNTIME_FLOOR = '2026.9.1';

/** Releases a Portal build was qualified on. Informational, plus the strict rollback switch. */
export const OPENCLAW_QUALIFIED_RELEASES: readonly string[] = Object.freeze([
  '2026.9.1', '2026.9.2', '2026.9.3', '2026.9.9', '2026.10.5', '2026.10.6',
]);

export type OpenClawReleaseDenylist = ReadonlyArray<Readonly<{ version: string; reason: string }>>;

/** Releases known to break the Portal. Data, not code: add an entry with its reason. */
export const OPENCLAW_RUNTIME_DENYLIST: OpenClawReleaseDenylist = Object.freeze([]);

/** The retained 2026.7.1 contract stays an exact tuple; it is not a moving target. */
export const OPENCLAW_LEGACY_CORE_PACKAGE_VERSION = '2026.7.1-2';
export const OPENCLAW_LEGACY_RUNTIME_VERSION = '2026.7.1';
const OPENCLAW_LEGACY_VERSIONS: ReadonlySet<string> = new Set([
  OPENCLAW_LEGACY_RUNTIME_VERSION,
  OPENCLAW_LEGACY_CORE_PACKAGE_VERSION,
]);

/** Protocol range the Portal offers in `connect` (minProtocol/maxProtocol). */
export const OPENCLAW_PORTAL_PROTOCOL_MIN = 3;
export const OPENCLAW_PORTAL_PROTOCOL_MAX = 4;

/** Core Gateway methods every OpenClaw chat, setup and session path needs. */
export const OPENCLAW_REQUIRED_GATEWAY_METHODS: readonly string[] = Object.freeze([
  'chat.send',
  'chat.history',
  'chat.abort',
  'sessions.list',
  'sessions.create',
  'sessions.patch',
  'sessions.describe',
  'sessions.delete',
  'sessions.subscribe',
  'sessions.messages.subscribe',
  'config.get',
  'config.patch',
  'agents.list',
  'models.list',
]);

/** Events the chat stream cannot work without. */
export const OPENCLAW_REQUIRED_GATEWAY_EVENTS: readonly string[] = Object.freeze([
  'chat',
  'agent',
  'sessions.changed',
]);

/**
 * Features whose Portal contract was first qualified above the global floor.
 * Above these, any release qualifies as long as the feature's methods exist.
 */
export const OPENCLAW_FEATURE_FLOORS = Object.freeze({
  // 2026.9.9 was the first build qualified for the stable Canvas document contract.
  inlineWidgets: '2026.9.9',
  // 2026.9.6 materializes `agents.entries.main` for a roster-less config.
  projectImplicitMainBootstrap: '2026.9.6',
});

export type OpenClawRuntimeFamily = 'legacy-2026.7.1' | 'current-2026.9.1';

interface ParsedOpenClawVersion {
  core: [number, number, number];
  /** `-2` style package republish of the same release. */
  revision: number | null;
  /** `-beta.5` style prerelease. */
  prerelease: string | null;
}

const OPENCLAW_VERSION_PATTERN = /^(\d{4})\.(\d{1,2})\.(\d{1,4})(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

export function parseOpenClawRelease(raw: unknown): ParsedOpenClawVersion | null {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(OPENCLAW_VERSION_PATTERN);
  if (!match) return null;
  const suffix = match[4] ?? null;
  const revision = suffix !== null && /^\d{1,4}$/.test(suffix) ? Number(suffix) : null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    revision,
    prerelease: suffix !== null && revision === null ? suffix : null,
  };
}

/**
 * Orders releases: a prerelease sorts before its release, a numeric package
 * revision after it. Unparseable input sorts below everything.
 */
export function compareOpenClawReleases(left: unknown, right: unknown): number {
  const a = parseOpenClawRelease(left);
  const b = parseOpenClawRelease(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  const rank = (version: ParsedOpenClawVersion) => (version.prerelease !== null ? -1 : version.revision !== null ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
  if (a.revision !== null && b.revision !== null && a.revision !== b.revision) return a.revision < b.revision ? -1 : 1;
  if (a.prerelease !== null && b.prerelease !== null && a.prerelease !== b.prerelease) {
    return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
  }
  return 0;
}

export function openClawReleaseDenial(
  version: unknown,
  denylist: OpenClawReleaseDenylist = OPENCLAW_RUNTIME_DENYLIST,
): string | null {
  const normalized = typeof version === 'string' ? version.trim() : '';
  return denylist.find((entry) => entry.version === normalized)?.reason ?? null;
}

/** Rollback switch: `PORTAL_OPENCLAW_STRICT_TUPLES=1` admits only qualified releases again. */
export function openClawStrictTuplesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PORTAL_OPENCLAW_STRICT_TUPLES === '1';
}

export function isLegacyOpenClawVersion(version: unknown): boolean {
  return typeof version === 'string' && OPENCLAW_LEGACY_VERSIONS.has(version.trim());
}

/** At or above `floor` (default: the contract floor) and not deny-listed. */
export function openClawVersionMeetsFloor(
  version: unknown,
  floor: string = OPENCLAW_RUNTIME_FLOOR,
  denylist: OpenClawReleaseDenylist = OPENCLAW_RUNTIME_DENYLIST,
): boolean {
  return parseOpenClawRelease(version) !== null
    && compareOpenClawReleases(version, floor) >= 0
    && openClawReleaseDenial(version, denylist) === null;
}

/**
 * Why `version` is outside the current family, in plain words, or null when
 * the family admits it. One rule for every caller: readable, not deny-listed,
 * at or above the floor, and qualified when the strict rollback is on.
 */
export function openClawCurrentFamilyRefusal(
  version: unknown,
  env: NodeJS.ProcessEnv = process.env,
  denylist: OpenClawReleaseDenylist = OPENCLAW_RUNTIME_DENYLIST,
): string | null {
  const detected = typeof version === 'string' && version.trim() ? version.trim() : 'unknown';
  if (parseOpenClawRelease(version) === null) return `OpenClaw version ${detected} could not be read.`;
  const denial = openClawReleaseDenial(version, denylist);
  if (denial) return `OpenClaw ${detected} is refused by the Portal: ${denial}`;
  if (compareOpenClawReleases(version, OPENCLAW_RUNTIME_FLOOR) < 0) {
    return `OpenClaw ${detected} is older than the supported floor ${OPENCLAW_RUNTIME_FLOOR}.`;
  }
  if (openClawStrictTuplesEnabled(env) && !OPENCLAW_QUALIFIED_RELEASES.includes(detected)) {
    return `Strict tested-release mode admits only ${OPENCLAW_QUALIFIED_RELEASES.join(', ')}; detected ${detected}.`;
  }
  return null;
}

export function openClawCurrentFamilyAdmits(
  version: unknown,
  env: NodeJS.ProcessEnv = process.env,
  denylist: OpenClawReleaseDenylist = OPENCLAW_RUNTIME_DENYLIST,
): boolean {
  return openClawCurrentFamilyRefusal(version, env, denylist) === null;
}

export function openClawRuntimeFamilyForVersion(
  version: unknown,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawRuntimeFamily | null {
  if (isLegacyOpenClawVersion(version)) return 'legacy-2026.7.1';
  return openClawCurrentFamilyAdmits(version, env) ? 'current-2026.9.1' : null;
}

/**
 * The CLI and the running Gateway must be the installed package. A package
 * republish (`2026.7.1-2`) may report its release (`2026.7.1`); nothing else
 * may differ, so a stale listener or a second install is still refused.
 */
export function openClawRuntimeMatchesPackage(runtimeVersion: unknown, packageVersion: unknown): boolean {
  if (typeof runtimeVersion !== 'string' || typeof packageVersion !== 'string') return false;
  const runtime = runtimeVersion.trim();
  const pkg = packageVersion.trim();
  if (!runtime || !pkg) return false;
  if (runtime === pkg) return true;
  const parsed = parseOpenClawRelease(pkg);
  return parsed !== null && parsed.revision !== null && runtime === pkg.replace(/-\d{1,4}$/, '');
}

export interface OpenClawGatewayContractEvaluation {
  ok: boolean;
  protocol: number | null;
  missingMethods: string[];
  missingEvents: string[];
  issue: string | null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Checks a `hello-ok` payload (or its parsed capabilities) against the required contract. */
export function evaluateOpenClawGatewayContract(hello: {
  protocol?: unknown;
  methods?: unknown;
  events?: unknown;
} | null | undefined): OpenClawGatewayContractEvaluation {
  const protocol = typeof hello?.protocol === 'number' && Number.isInteger(hello.protocol) ? hello.protocol : null;
  const methods = new Set(stringList(hello?.methods));
  const events = new Set(stringList(hello?.events));
  const missingMethods = OPENCLAW_REQUIRED_GATEWAY_METHODS.filter((method) => !methods.has(method));
  const missingEvents = OPENCLAW_REQUIRED_GATEWAY_EVENTS.filter((event) => !events.has(event));
  const protocolOk = protocol !== null
    && protocol >= OPENCLAW_PORTAL_PROTOCOL_MIN
    && protocol <= OPENCLAW_PORTAL_PROTOCOL_MAX;
  const problems = [
    ...(protocolOk ? [] : [`protocol ${protocol ?? 'unknown'} is outside ${OPENCLAW_PORTAL_PROTOCOL_MIN}-${OPENCLAW_PORTAL_PROTOCOL_MAX}`]),
    ...(missingMethods.length ? [`missing methods ${missingMethods.join(', ')}`] : []),
    ...(missingEvents.length ? [`missing events ${missingEvents.join(', ')}`] : []),
  ];
  return {
    ok: problems.length === 0,
    protocol,
    missingMethods,
    missingEvents,
    issue: problems.length ? `The OpenClaw Gateway does not provide the Portal contract: ${problems.join('; ')}.` : null,
  };
}
