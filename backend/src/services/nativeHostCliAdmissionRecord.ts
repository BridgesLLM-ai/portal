/**
 * Admission records: the second accept path for the npm host CLIs.
 *
 * The exact catalog (`config/nativeHostCliAdmissionCatalog.v1.json`) stays the
 * first accept path. A version the catalog does not list is admitted only by
 * a root-owned record proving that the installed tree is the official
 * release: the record binds the version to the npm registry tarball and its
 * integrity, says the registry signatures (and provenance where the publisher
 * ships it) were verified on a staged install, and carries the tree digest of
 * that staged install. Admission then requires the live tree to hash to the
 * same digest with the same walker the catalog uses.
 *
 * This module is pure: parsing, policy and comparisons only. Reading the file
 * safely lives in nativeHostCliAdmission.ts; writing lives in
 * nativeHostCliAdmissionRecordStore.ts.
 */
import { compareHarnessVersions } from '../agents/harnessVersionPolicy';

export const NATIVE_HOST_CLI_ADMISSION_RECORD_SCHEMA = 'bridgesllm.tools.admission.v1';
export const NATIVE_HOST_CLI_ADMISSION_RECORD_ROOT = '/var/lib/bridgesllm/tools/admission';
export const NATIVE_HOST_CLI_ADMISSION_RECORD_MAX_BYTES = 64 * 1024;
export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org/';

export type NativeHostCliRecordToolId = 'codex' | 'claude-code' | 'clawhub';

export type NativeHostCliRecordPolicy = Readonly<{
  /** Lowest version a record may admit; older versions are catalog-only. */
  floor: string;
  /** `required`: the record must say provenance was verified. */
  provenance: 'required' | 'unavailable';
  denylist: ReadonlyArray<Readonly<{ version: string; reason: string }>>;
}>;

/**
 * Floors are today's tested versions. Claude Code publishes no npm provenance
 * (registry signatures only, 2026-10-30); Codex and ClawHub do.
 */
export const NATIVE_HOST_CLI_RECORD_POLICY: Readonly<Record<NativeHostCliRecordToolId, NativeHostCliRecordPolicy>> = Object.freeze({
  codex: Object.freeze({ floor: '0.163.0', provenance: 'required', denylist: Object.freeze([]) }),
  'claude-code': Object.freeze({ floor: '2.1.309', provenance: 'unavailable', denylist: Object.freeze([]) }),
  clawhub: Object.freeze({ floor: '0.23.3', provenance: 'required', denylist: Object.freeze([]) }),
});

export const NATIVE_HOST_CLI_CATALOG_V1_SCHEMA = 'bridgesllm.native-host-cli-admission-catalog.v1';

export type NativeHostCliAdmissionRecordSource =
  | Readonly<{
      kind: 'npm-registry';
      tarball: string;
      /** Registry `dist.integrity` of the tarball (sha512 SRI). */
      integrity: string;
      /** `npm audit signatures` passed on the staged install. */
      signatures: 'verified';
      provenance: 'verified' | 'unavailable';
      verifier: 'npm-audit-signatures';
    }>
  | Readonly<{
      /**
       * Migrated from the exact catalog shipped in the signed release (DESIGN
       * h.3): the tree facts are the catalog's own, and the live tree matched
       * them when the record was written. Only `catalog-v1-migration` writes it.
       */
      kind: 'catalog-v1';
      tarball: string;
      integrity: string;
      catalogSchema: typeof NATIVE_HOST_CLI_CATALOG_V1_SCHEMA;
    }>;

export type NativeHostCliAdmissionRecord = Readonly<{
  schema: typeof NATIVE_HOST_CLI_ADMISSION_RECORD_SCHEMA;
  toolId: NativeHostCliRecordToolId;
  packageName: string;
  version: string;
  platform: string;
  packageRoot: string;
  /** Tree digest of the staged official install, same walker as the catalog. */
  treeSha256: string;
  criticalFiles: Readonly<Record<string, string>>;
  hardlinkGroups: readonly (readonly string[])[];
  platformPackageRelative: string | null;
  platformPackageName: string | null;
  platformPackageVersion: string | null;
  platformBinRelative: string | null;
  source: NativeHostCliAdmissionRecordSource;
  admittedAt: string;
  admittedBy: string;
}>;

/** What the record must agree with: the catalog's tool definition and the runtime. */
export type NativeHostCliRecordExpectation = Readonly<{
  toolId: NativeHostCliRecordToolId;
  packageName: string;
  packageRoot: string;
  platform: string;
}>;

export class NativeHostCliAdmissionRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeHostCliAdmissionRecordError';
  }
}

function invalid(message: string): never {
  throw new NativeHostCliAdmissionRecordError(message);
}

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const PLATFORM_KEY = /^linux-(?:x64|arm64)-gnu$/;
const ADMITTED_BY = /^(?:(?:run|requalify):[A-Za-z0-9][A-Za-z0-9._-]{0,63}|catalog-v1-migration)$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const PLAIN_VERSION = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;
const RECORD_KEYS = [
  'schema', 'toolId', 'packageName', 'version', 'platform', 'packageRoot', 'treeSha256', 'criticalFiles',
  'hardlinkGroups', 'platformPackageRelative', 'platformPackageName', 'platformPackageVersion',
  'platformBinRelative', 'source', 'admittedAt', 'admittedBy',
] as const;
const SOURCE_KEYS = ['kind', 'tarball', 'integrity', 'signatures', 'provenance', 'verifier'] as const;
const CATALOG_SOURCE_KEYS = ['kind', 'tarball', 'integrity', 'catalogSchema'] as const;
const CATALOG_MIGRATION_AUTHOR = 'catalog-v1-migration';
const MAX_CRITICAL_FILES = 64;
const MAX_HARDLINK_GROUPS = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${label} has unexpected or missing fields`);
  }
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && !value.startsWith('/')
    && !/[\u0000-\u001f\u007f\\]/.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function nullableString(value: unknown, test: (candidate: string) => boolean, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !test(value)) invalid(`${label} is invalid`);
  return value;
}

/** npm's own tarball URL for `name@version` on the official registry. */
export function officialNpmTarballUrl(packageName: string, version: string): string {
  const file = packageName.startsWith('@') ? packageName.split('/')[1] : packageName;
  return `${NPM_REGISTRY_ORIGIN}${packageName}/-/${file}-${version}.tgz`;
}

/**
 * Why a record may not admit `version` for `toolId`, in plain words, or null:
 * a plain release version, at or above the record floor, not deny-listed.
 */
export function nativeHostCliRecordVersionRefusal(
  toolId: NativeHostCliRecordToolId,
  version: unknown,
  policy: Readonly<Record<NativeHostCliRecordToolId, NativeHostCliRecordPolicy>> = NATIVE_HOST_CLI_RECORD_POLICY,
): string | null {
  const rule = policy[toolId];
  if (!rule) return `${toolId} has no admission-record policy`;
  if (typeof version !== 'string' || !PLAIN_VERSION.test(version)) {
    return `${toolId} version ${String(version || 'unknown')} is not a plain release version`;
  }
  const denial = rule.denylist.find((entry) => entry.version === version);
  if (denial) return `${toolId} ${version} is refused by the Portal: ${denial.reason}`;
  const order = compareHarnessVersions(version, rule.floor);
  if (order === null || order < 0) return `${toolId} ${version} is older than the admission-record floor ${rule.floor}`;
  return null;
}

/**
 * Strictly parses a record and checks it against the catalog definition, the
 * runtime platform and the record policy. Anything unexpected is refused.
 */
export function parseNativeHostCliAdmissionRecord(
  raw: unknown,
  expected: NativeHostCliRecordExpectation,
  policy: Readonly<Record<NativeHostCliRecordToolId, NativeHostCliRecordPolicy>> = NATIVE_HOST_CLI_RECORD_POLICY,
): NativeHostCliAdmissionRecord {
  if (!isPlainObject(raw)) invalid('admission record is not a JSON object');
  exactKeys(raw, RECORD_KEYS, 'admission record');
  if (raw.schema !== NATIVE_HOST_CLI_ADMISSION_RECORD_SCHEMA) invalid('admission record schema is not supported');
  if (raw.toolId !== expected.toolId) invalid(`admission record is for ${String(raw.toolId)}, not ${expected.toolId}`);
  if (raw.packageName !== expected.packageName) invalid('admission record package name does not match the catalog');
  if (raw.packageRoot !== expected.packageRoot) invalid('admission record package root does not match the catalog');
  if (typeof raw.platform !== 'string' || !PLATFORM_KEY.test(raw.platform)) invalid('admission record platform is invalid');
  if (raw.platform !== expected.platform) invalid(`admission record is for ${raw.platform}, not ${expected.platform}`);
  const refusal = nativeHostCliRecordVersionRefusal(expected.toolId, raw.version, policy);
  if (refusal) invalid(refusal);
  const version = raw.version as string;
  if (typeof raw.treeSha256 !== 'string' || !HEX_SHA256.test(raw.treeSha256)) invalid('admission record tree digest is invalid');

  if (!isPlainObject(raw.criticalFiles)) invalid('admission record critical files are invalid');
  const criticalEntries = Object.entries(raw.criticalFiles);
  if (criticalEntries.length > MAX_CRITICAL_FILES) invalid('admission record lists too many critical files');
  for (const [relativePath, digest] of criticalEntries) {
    if (!safeRelativePath(relativePath) || typeof digest !== 'string' || !HEX_SHA256.test(digest)) {
      invalid('admission record critical file entry is invalid');
    }
  }

  if (!Array.isArray(raw.hardlinkGroups) || raw.hardlinkGroups.length > MAX_HARDLINK_GROUPS) {
    invalid('admission record hard-link groups are invalid');
  }
  const hardlinkGroups = (raw.hardlinkGroups as unknown[]).map((group) => {
    if (!Array.isArray(group) || group.length < 2 || group.length > 64 || !group.every(safeRelativePath)) {
      invalid('admission record hard-link group is invalid');
    }
    if (new Set(group).size !== group.length) invalid('admission record hard-link group repeats a path');
    return Object.freeze([...group].sort()) as readonly string[];
  });

  const platformPackageRelative = nullableString(raw.platformPackageRelative, safeRelativePath, 'admission record platform package path');
  const platformPackageName = nullableString(raw.platformPackageName, (value) => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value), 'admission record platform package name');
  const platformPackageVersion = nullableString(raw.platformPackageVersion, (value) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value), 'admission record platform package version');
  const platformBinRelative = nullableString(raw.platformBinRelative, safeRelativePath, 'admission record platform binary path');
  const platformFields = [platformPackageRelative, platformPackageName, platformPackageVersion, platformBinRelative];
  if (platformFields.some((value) => value === null) && platformFields.some((value) => value !== null)) {
    invalid('admission record platform package authority is incomplete');
  }

  if (typeof raw.admittedAt !== 'string' || !ISO_INSTANT.test(raw.admittedAt) || Number.isNaN(Date.parse(raw.admittedAt))) {
    invalid('admission record time is invalid');
  }
  if (typeof raw.admittedBy !== 'string' || !ADMITTED_BY.test(raw.admittedBy)) invalid('admission record author is invalid');
  const migrated = raw.admittedBy === CATALOG_MIGRATION_AUTHOR;

  if (!isPlainObject(raw.source)) invalid('admission record source is invalid');
  const source = raw.source;
  if (source.kind === 'catalog-v1') {
    exactKeys(source, CATALOG_SOURCE_KEYS, 'admission record source');
    if (!migrated) invalid('only the catalog migration may write a catalog-sourced record');
    if (source.catalogSchema !== NATIVE_HOST_CLI_CATALOG_V1_SCHEMA) invalid('admission record catalog schema is not supported');
  } else {
    exactKeys(source, SOURCE_KEYS, 'admission record source');
    if (source.kind !== 'npm-registry') invalid('admission record source must be the npm registry');
    if (migrated) invalid('the catalog migration may only write catalog-sourced records');
    if (source.signatures !== 'verified') invalid('admission record does not prove verified registry signatures');
    if (source.verifier !== 'npm-audit-signatures') invalid('admission record verifier is not supported');
    if (source.provenance !== 'verified' && source.provenance !== 'unavailable') invalid('admission record provenance is invalid');
    if (policy[expected.toolId].provenance === 'required' && source.provenance !== 'verified') {
      invalid(`${expected.toolId} publishes provenance, and the record does not prove it was verified`);
    }
  }
  if (source.tarball !== officialNpmTarballUrl(expected.packageName, version)) {
    invalid('admission record tarball is not the official npm registry tarball for this version');
  }
  if (typeof source.integrity !== 'string' || !SRI_SHA512.test(source.integrity)) invalid('admission record integrity is not a sha512 digest');

  return Object.freeze({
    schema: NATIVE_HOST_CLI_ADMISSION_RECORD_SCHEMA,
    toolId: expected.toolId,
    packageName: expected.packageName,
    version,
    platform: expected.platform,
    packageRoot: expected.packageRoot,
    treeSha256: raw.treeSha256,
    criticalFiles: Object.freeze(Object.fromEntries(criticalEntries)) as Readonly<Record<string, string>>,
    hardlinkGroups: Object.freeze(hardlinkGroups),
    platformPackageRelative,
    platformPackageName,
    platformPackageVersion,
    platformBinRelative,
    source: source.kind === 'catalog-v1'
      ? Object.freeze({
          kind: 'catalog-v1' as const,
          tarball: source.tarball as string,
          integrity: source.integrity as string,
          catalogSchema: NATIVE_HOST_CLI_CATALOG_V1_SCHEMA,
        })
      : Object.freeze({
          kind: 'npm-registry' as const,
          tarball: source.tarball as string,
          integrity: source.integrity as string,
          signatures: 'verified' as const,
          provenance: source.provenance as 'verified' | 'unavailable',
          verifier: 'npm-audit-signatures' as const,
        }),
    admittedAt: raw.admittedAt,
    admittedBy: raw.admittedBy,
  });
}

/** Rollback switch: `PORTAL_NATIVE_CLI_ADMISSION_RECORDS=0` turns the record path off (catalog only). */
export function nativeHostCliAdmissionRecordsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PORTAL_NATIVE_CLI_ADMISSION_RECORDS !== '0';
}
