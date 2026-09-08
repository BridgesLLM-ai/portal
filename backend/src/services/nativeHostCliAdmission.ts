import { createHash } from 'crypto';
import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import rawCatalog from '../config/nativeHostCliAdmissionCatalog.v1.json';

export type NativeHostCliId = 'codex' | 'claude-code' | 'clawhub';

export type NativeHostCliAdmissionErrorCode =
  | 'ABSENT'
  | 'INVALID_EXECUTABLE_PATH'
  | 'UNSUPPORTED_VERSION'
  | 'STATUS_ONLY_VERSION'
  | 'UNSUPPORTED_PLATFORM'
  | 'MAINTENANCE_ACTIVE'
  | 'DRIFT_DETECTED'
  | 'RACE_DETECTED'
  | 'BOUND_EXCEEDED'
  | 'CATALOG_INVALID'
  | 'IO_ERROR';

export class NativeHostCliAdmissionError extends Error {
  readonly code: NativeHostCliAdmissionErrorCode;
  readonly observedVersion: string | null;

  constructor(
    code: NativeHostCliAdmissionErrorCode,
    message: string,
    observedVersion: string | null = null,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'NativeHostCliAdmissionError';
    this.code = code;
    this.observedVersion = observedVersion;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export type NativeHostCliIdentity = Readonly<{
  toolId: NativeHostCliId;
  executablePath: string;
  packageName: string;
  version: string;
  fingerprint: string;
  checkedAt: string;
}>;

type CatalogLimits = Readonly<{
  maxEntries: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}>;

type CatalogSource = Readonly<{
  placement: string;
  packageName: string;
  version: string;
  tarball: string;
  integrity: string;
  sha256: string;
}>;

type CatalogPlatform = Readonly<{
  treeSha256: string;
  criticalFiles: Readonly<Record<string, string>>;
  hardlinkGroups: readonly (readonly string[])[];
  platformPackageRelative: string | null;
  platformPackageName: string | null;
  platformPackageVersion: string | null;
  platformBinRelative: string | null;
  sources: readonly CatalogSource[];
}>;

type CatalogVersion = Readonly<{
  admission: 'full' | 'status-only';
  statusReason?: string;
  rootIntegrity: string;
  rootSha256: string;
  platforms: Readonly<Record<string, CatalogPlatform>>;
}>;

type CatalogTool = Readonly<{
  packageName: string;
  packageRoot: string;
  binName: string;
  binRelative: string;
  executables: Readonly<Record<string, string>>;
  versions: Readonly<Record<string, CatalogVersion>>;
}>;

type AdmissionCatalog = Readonly<{
  schema: 'bridgesllm.native-host-cli-admission-catalog.v1';
  limits: CatalogLimits;
  tools: Readonly<Record<NativeHostCliId, CatalogTool>>;
}>;

type BigStat = Awaited<ReturnType<typeof fs.lstat>> & {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  uid: bigint;
  gid: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type ObservedEntry = Readonly<{
  relativePath: string;
  absolutePath: string;
  kind: 'directory' | 'file' | 'symlink';
  mode: number;
  size: number;
  sha256?: string;
  linkTarget?: string;
  stat: BigStat;
}>;

type TreeSnapshot = Readonly<{
  rootPath: string;
  rootStat: BigStat;
  digest: string;
  entries: ReadonlyMap<string, ObservedEntry>;
  inodePaths: ReadonlyMap<string, readonly string[]>;
}>;

type AdmissionHooks = Readonly<{
  afterInitialTreeScan?: () => void | Promise<void>;
}>;

type AdmissionContext = Readonly<{
  toolId: NativeHostCliId;
  executablePath: string;
  definition: CatalogTool;
  limits: CatalogLimits;
  platformKey: string;
  requiredUid: number;
  requiredGid: number;
  ancestorFloor: string;
  now: () => Date;
  hooks?: AdmissionHooks;
}>;

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const ALLOWED_TOOL_IDS = new Set<NativeHostCliId>(['codex', 'claude-code', 'clawhub']);
const PUBLIC_DEFAULT_EXECUTABLES: Readonly<Record<NativeHostCliId, string>> = Object.freeze({
  codex: '/usr/bin/codex',
  'claude-code': '/usr/bin/claude',
  clawhub: '/usr/bin/clawhub',
});
const NATIVE_CLI_BUNDLE_TRANSACTION_ROOT = '/var/lib/bridgesllm-installer/native-cli-bundle-v1';

function fail(
  code: NativeHostCliAdmissionErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new NativeHostCliAdmissionError(code, message, null, cause);
}

function nativeCliBundleFencePaths(): readonly string[] {
  const testOverride = process.env.NODE_ENV === 'test'
    ? process.env.BRIDGESLLM_NATIVE_CLI_BUNDLE_FENCE_ROOT
    : undefined;
  const root = typeof testOverride === 'string'
    && path.isAbsolute(testOverride)
    && path.normalize(testOverride) === testOverride
    ? testOverride
    : NATIVE_CLI_BUNDLE_TRANSACTION_ROOT;
  return Object.freeze([root, `${root}.terminal`, `${root}.terminal-intent.json`]);
}

async function assertNativeCliBundleIdle(): Promise<void> {
  for (const fencePath of nativeCliBundleFencePaths()) {
    try {
      await fs.lstat(fencePath);
    } catch (error: any) {
      if (error?.code === 'ENOENT') continue;
      fail(
        'MAINTENANCE_ACTIVE',
        'Native CLI execution is paused because compatibility maintenance state cannot be safely inspected.',
        error,
      );
    }
    fail(
      'MAINTENANCE_ACTIVE',
      'Native CLI execution is paused while the Portal compatibility bundle is being reconciled.',
    );
  }
}

async function attachObservedVersion<T>(
  observedVersion: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof NativeHostCliAdmissionError) {
      if (error.observedVersion === observedVersion) throw error;
      throw new NativeHostCliAdmissionError(error.code, error.message, observedVersion, error);
    }
    throw new NativeHostCliAdmissionError(
      'IO_ERROR',
      'Native CLI admission failed after its installed version was observed.',
      observedVersion,
      error,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function safeRelativePath(value: unknown, allowEmpty = false): value is string {
  if (typeof value !== 'string' || value.includes('\0') || path.isAbsolute(value)) return false;
  if (value === '') return allowEmpty;
  const normalized = path.posix.normalize(value);
  return normalized === value && value !== '.' && !value.startsWith('../');
}

function parseCatalog(input: unknown): AdmissionCatalog {
  try {
    if (!isPlainObject(input) || input.schema !== 'bridgesllm.native-host-cli-admission-catalog.v1') {
      fail('CATALOG_INVALID', 'Native CLI admission catalog schema is invalid.');
    }
    const limits = input.limits;
    if (
      !isPlainObject(limits)
      || !Number.isSafeInteger(limits.maxEntries)
      || !Number.isSafeInteger(limits.maxDepth)
      || !Number.isSafeInteger(limits.maxFileBytes)
      || !Number.isSafeInteger(limits.maxTotalBytes)
      || (limits.maxEntries as number) < 1
      || (limits.maxDepth as number) < 1
      || (limits.maxFileBytes as number) < 1
      || (limits.maxTotalBytes as number) < (limits.maxFileBytes as number)
    ) fail('CATALOG_INVALID', 'Native CLI admission catalog limits are invalid.');

    if (!isPlainObject(input.tools)) {
      fail('CATALOG_INVALID', 'Native CLI admission catalog tools are invalid.');
    }
    const toolKeys = Object.keys(input.tools).sort();
    if (toolKeys.join('\0') !== [...ALLOWED_TOOL_IDS].sort().join('\0')) {
      fail('CATALOG_INVALID', 'Native CLI admission catalog tool set is invalid.');
    }

    for (const toolId of ALLOWED_TOOL_IDS) {
      const tool = input.tools[toolId];
      if (
        !isPlainObject(tool)
        || typeof tool.packageName !== 'string'
        || typeof tool.packageRoot !== 'string'
        || !path.isAbsolute(tool.packageRoot)
        || path.normalize(tool.packageRoot) !== tool.packageRoot
        || typeof tool.binName !== 'string'
        || !safeRelativePath(tool.binRelative)
        || !isPlainObject(tool.executables)
        || !isPlainObject(tool.versions)
        || Object.keys(tool.versions).length < 1
      ) fail('CATALOG_INVALID', `Native CLI admission catalog tool ${toolId} is invalid.`);

      for (const [executablePath, linkTarget] of Object.entries(tool.executables)) {
        if (
          !path.isAbsolute(executablePath)
          || path.normalize(executablePath) !== executablePath
          || typeof linkTarget !== 'string'
          || linkTarget.length < 1
          || path.isAbsolute(linkTarget)
          || linkTarget.includes('\0')
        ) fail('CATALOG_INVALID', `Native CLI executable mapping for ${toolId} is invalid.`);
      }

      for (const [version, rawVersion] of Object.entries(tool.versions)) {
        if (
          !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
          || !isPlainObject(rawVersion)
          || (rawVersion.admission !== 'full' && rawVersion.admission !== 'status-only')
          || typeof rawVersion.rootIntegrity !== 'string'
          || !SRI_SHA512.test(rawVersion.rootIntegrity)
          || typeof rawVersion.rootSha256 !== 'string'
          || !HEX_SHA256.test(rawVersion.rootSha256)
          || !isPlainObject(rawVersion.platforms)
        ) fail('CATALOG_INVALID', `Native CLI catalog version ${toolId}@${version} is invalid.`);
        if (rawVersion.admission === 'status-only') {
          if (typeof rawVersion.statusReason !== 'string' || Object.keys(rawVersion.platforms).length !== 0) {
            fail('CATALOG_INVALID', `Status-only native CLI version ${toolId}@${version} is invalid.`);
          }
          continue;
        }
        if (Object.keys(rawVersion.platforms).length < 1) {
          fail('CATALOG_INVALID', `Admitted native CLI version ${toolId}@${version} has no platforms.`);
        }
        for (const [platformKey, rawPlatform] of Object.entries(rawVersion.platforms)) {
          if (
            !/^linux-(?:x64|arm64)-gnu$/.test(platformKey)
            || !isPlainObject(rawPlatform)
            || typeof rawPlatform.treeSha256 !== 'string'
            || !HEX_SHA256.test(rawPlatform.treeSha256)
            || !isPlainObject(rawPlatform.criticalFiles)
            || !Array.isArray(rawPlatform.hardlinkGroups)
            || !Array.isArray(rawPlatform.sources)
            || rawPlatform.sources.length < 1
          ) fail('CATALOG_INVALID', `Native CLI platform ${toolId}@${version}/${platformKey} is invalid.`);
          for (const [filePath, digest] of Object.entries(rawPlatform.criticalFiles)) {
            if (!safeRelativePath(filePath) || typeof digest !== 'string' || !HEX_SHA256.test(digest)) {
              fail('CATALOG_INVALID', `Native CLI critical-file authority for ${toolId} is invalid.`);
            }
          }
          for (const group of rawPlatform.hardlinkGroups) {
            if (!Array.isArray(group) || group.length < 2 || group.some((item) => !safeRelativePath(item))) {
              fail('CATALOG_INVALID', `Native CLI hardlink authority for ${toolId} is invalid.`);
            }
          }
          const nullableStrings = [
            rawPlatform.platformPackageRelative,
            rawPlatform.platformPackageName,
            rawPlatform.platformPackageVersion,
            rawPlatform.platformBinRelative,
          ];
          if (nullableStrings.some((item) => item !== null && typeof item !== 'string')) {
            fail('CATALOG_INVALID', `Native CLI platform identity for ${toolId} is invalid.`);
          }
          if (
            rawPlatform.platformPackageRelative !== null
            && !safeRelativePath(rawPlatform.platformPackageRelative)
          ) fail('CATALOG_INVALID', `Native CLI platform path for ${toolId} is invalid.`);
          if (
            rawPlatform.platformBinRelative !== null
            && !safeRelativePath(rawPlatform.platformBinRelative)
          ) fail('CATALOG_INVALID', `Native CLI platform binary for ${toolId} is invalid.`);
          for (const rawSource of rawPlatform.sources) {
            if (
              !isPlainObject(rawSource)
              || !safeRelativePath(rawSource.placement, true)
              || typeof rawSource.packageName !== 'string'
              || typeof rawSource.version !== 'string'
              || typeof rawSource.tarball !== 'string'
              || !rawSource.tarball.startsWith('https://registry.npmjs.org/')
              || typeof rawSource.integrity !== 'string'
              || !SRI_SHA512.test(rawSource.integrity)
              || typeof rawSource.sha256 !== 'string'
              || !HEX_SHA256.test(rawSource.sha256)
            ) fail('CATALOG_INVALID', `Native CLI source authority for ${toolId} is invalid.`);
          }
        }
      }
    }
    return deepFreeze(input as unknown as AdmissionCatalog);
  } catch (error) {
    if (error instanceof NativeHostCliAdmissionError) throw error;
    fail('CATALOG_INVALID', 'Native CLI admission catalog could not be parsed.', error);
  }
}

const CATALOG = parseCatalog(rawCatalog);

function statFingerprint(stat: BigStat): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].map(String).join(':');
}

function sameStat(left: BigStat, right: BigStat): boolean {
  return statFingerprint(left) === statFingerprint(right);
}

function numericMode(stat: BigStat): number {
  return Number(stat.mode & BigInt(0o7777));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function lstatBig(targetPath: string): Promise<BigStat> {
  return fs.lstat(targetPath, { bigint: true }) as unknown as BigStat;
}

async function assertSafeOwnership(
  targetPath: string,
  requiredUid: number,
  requiredGid: number,
  label: string,
  allowSymlinkMode = false,
): Promise<BigStat> {
  let stat: BigStat;
  try {
    stat = await lstatBig(targetPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') fail('DRIFT_DETECTED', `${label} is missing.`, error);
    fail('IO_ERROR', `${label} could not be inspected.`, error);
  }
  if (
    stat.uid !== BigInt(requiredUid)
    || stat.gid !== BigInt(requiredGid)
    || ((!allowSymlinkMode || !stat.isSymbolicLink()) && (numericMode(stat) & 0o022) !== 0)
  ) fail('DRIFT_DETECTED', `${label} ownership or permissions are unsafe.`);
  return stat;
}

async function assertSafeAncestorChain(
  targetPath: string,
  floor: string,
  requiredUid: number,
  requiredGid: number,
): Promise<void> {
  const absolute = path.resolve(targetPath);
  const absoluteFloor = path.resolve(floor);
  if (!isInside(absoluteFloor, absolute)) {
    fail('DRIFT_DETECTED', 'Native CLI path escapes its trusted ancestor floor.');
  }
  const relative = path.relative(absoluteFloor, absolute);
  const components = relative === '' ? [] : relative.split(path.sep);
  let current = absoluteFloor;
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component);
    const stat = await assertSafeOwnership(current, requiredUid, requiredGid, `Native CLI ancestor ${current}`);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('DRIFT_DETECTED', `Native CLI ancestor ${current} is not a real directory.`);
    }
  }
}

async function hashOpenFile(
  filePath: string,
  expected: BigStat,
  maximumBytes: number,
): Promise<string> {
  if (expected.size < 0n || expected.size > BigInt(maximumBytes)) {
    fail('BOUND_EXCEEDED', `Native CLI file ${filePath} exceeds the per-file byte limit.`);
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error: any) {
    if (error?.code === 'ELOOP') fail('DRIFT_DETECTED', `Native CLI file ${filePath} became a symlink.`, error);
    fail('IO_ERROR', `Native CLI file ${filePath} could not be opened.`, error);
  }
  try {
    const opened = await handle.stat({ bigint: true }) as unknown as BigStat;
    if (!sameStat(expected, opened) || !opened.isFile()) {
      fail('RACE_DETECTED', `Native CLI file ${filePath} changed before it was read.`);
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < Number(opened.size)) {
      const length = Math.min(buffer.length, Number(opened.size) - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) fail('RACE_DETECTED', `Native CLI file ${filePath} was truncated while read.`);
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true }) as unknown as BigStat;
    if (!sameStat(opened, after)) {
      fail('RACE_DETECTED', `Native CLI file ${filePath} changed while it was read.`);
    }
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}

function canonicalTreeLine(entry: ObservedEntry): string {
  if (entry.kind === 'directory') {
    return `d\0${entry.relativePath}\0${entry.mode.toString(8)}`;
  }
  if (entry.kind === 'symlink') {
    return `l\0${entry.relativePath}\0${entry.linkTarget ?? ''}`;
  }
  return `f\0${entry.relativePath}\0${entry.mode.toString(8)}\0${entry.size}\0${entry.sha256 ?? ''}`;
}

async function snapshotTree(
  root: string,
  limits: CatalogLimits,
  requiredUid: number,
  requiredGid: number,
): Promise<TreeSnapshot> {
  const rootStat = await assertSafeOwnership(root, requiredUid, requiredGid, 'Native CLI package root');
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('DRIFT_DETECTED', 'Native CLI package root is not a real directory.');
  }
  const rootRealPath = await fs.realpath(root).catch((error) => {
    fail('IO_ERROR', 'Native CLI package root could not be resolved.', error);
  });
  if (rootRealPath !== root) fail('DRIFT_DETECTED', 'Native CLI package root is not canonical.');

  const entries = new Map<string, ObservedEntry>();
  const inodeHashes = new Map<string, string>();
  const inodePaths = new Map<string, string[]>();
  let totalBytes = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) fail('BOUND_EXCEEDED', 'Native CLI package tree exceeds its depth limit.');
    const before = await lstatBig(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      fail('RACE_DETECTED', `Native CLI directory ${directory} changed during traversal.`);
    }
    let children;
    try {
      children = (await fs.readdir(directory, { withFileTypes: true }))
        .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    } catch (error) {
      fail('IO_ERROR', `Native CLI directory ${directory} could not be read.`, error);
    }
    for (const child of children) {
      if (child.name.includes('\0') || child.name === '.' || child.name === '..') {
        fail('DRIFT_DETECTED', 'Native CLI package tree contains an invalid name.');
      }
      if (entries.size >= limits.maxEntries) {
        fail('BOUND_EXCEEDED', 'Native CLI package tree exceeds its entry limit.');
      }
      const absolutePath = path.join(directory, child.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      if (!safeRelativePath(relativePath) || relativePath.length > 4096) {
        fail('BOUND_EXCEEDED', 'Native CLI package tree contains an invalid or overlong path.');
      }
      const stat = await assertSafeOwnership(
        absolutePath,
        requiredUid,
        requiredGid,
        `Native CLI package entry ${relativePath}`,
        true,
      );
      if (stat.dev !== rootStat.dev) {
        fail('DRIFT_DETECTED', `Native CLI package entry ${relativePath} crosses a filesystem boundary.`);
      }
      const mode = numericMode(stat);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        entries.set(relativePath, Object.freeze({
          relativePath,
          absolutePath,
          kind: 'directory',
          mode,
          size: 0,
          stat,
        }));
        await walk(absolutePath, depth + 1);
        continue;
      }
      if (stat.isSymbolicLink()) {
        const firstTarget = await fs.readlink(absolutePath).catch((error) => {
          fail('IO_ERROR', `Native CLI symlink ${relativePath} could not be read.`, error);
        });
        if (path.isAbsolute(firstTarget) || firstTarget.includes('\0')) {
          fail('DRIFT_DETECTED', `Native CLI symlink ${relativePath} is unsafe.`);
        }
        const lexicalTarget = path.resolve(path.dirname(absolutePath), firstTarget);
        if (!isInside(root, lexicalTarget)) {
          fail('DRIFT_DETECTED', `Native CLI symlink ${relativePath} escapes the package root.`);
        }
        const realTarget = await fs.realpath(absolutePath).catch((error) => {
          fail('DRIFT_DETECTED', `Native CLI symlink ${relativePath} has no safe target.`, error);
        });
        if (!isInside(root, realTarget)) {
          fail('DRIFT_DETECTED', `Native CLI symlink ${relativePath} resolves outside the package root.`);
        }
        const after = await lstatBig(absolutePath);
        const secondTarget = await fs.readlink(absolutePath).catch((error) => {
          fail('RACE_DETECTED', `Native CLI symlink ${relativePath} changed during inspection.`, error);
        });
        if (!sameStat(stat, after) || firstTarget !== secondTarget) {
          fail('RACE_DETECTED', `Native CLI symlink ${relativePath} changed during inspection.`);
        }
        entries.set(relativePath, Object.freeze({
          relativePath,
          absolutePath,
          kind: 'symlink',
          mode,
          size: Number(stat.size),
          linkTarget: firstTarget,
          stat,
        }));
        continue;
      }
      if (!stat.isFile()) {
        fail('DRIFT_DETECTED', `Native CLI package entry ${relativePath} is a special file.`);
      }
      const inodeKey = `${stat.dev}:${stat.ino}`;
      let sha256 = inodeHashes.get(inodeKey);
      if (sha256 === undefined) {
        totalBytes += Number(stat.size);
        if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
          fail('BOUND_EXCEEDED', 'Native CLI package tree exceeds its total byte limit.');
        }
        sha256 = await hashOpenFile(absolutePath, stat, limits.maxFileBytes);
        inodeHashes.set(inodeKey, sha256);
      }
      const paths = inodePaths.get(inodeKey) ?? [];
      paths.push(relativePath);
      inodePaths.set(inodeKey, paths);
      entries.set(relativePath, Object.freeze({
        relativePath,
        absolutePath,
        kind: 'file',
        mode,
        size: Number(stat.size),
        sha256,
        stat,
      }));
    }
    const after = await lstatBig(directory);
    if (!sameStat(before, after)) {
      fail('RACE_DETECTED', `Native CLI directory ${directory} changed during traversal.`);
    }
  };

  await walk(root, 0);
  const digest = createHash('sha256');
  for (const entry of [...entries.values()].sort((left, right) => (
    Buffer.from(left.relativePath).compare(Buffer.from(right.relativePath))
  ))) {
    digest.update(canonicalTreeLine(entry));
    digest.update('\n');
  }
  return Object.freeze({
    rootPath: root,
    rootStat,
    digest: digest.digest('hex'),
    entries,
    inodePaths: new Map([...inodePaths.entries()].map(([key, values]) => [key, Object.freeze([...values].sort())])),
  });
}

async function verifySnapshotStable(snapshot: TreeSnapshot): Promise<void> {
  const assertRootStable = async (): Promise<void> => {
    const after = await lstatBig(snapshot.rootPath).catch((error) => {
      fail('RACE_DETECTED', 'Native CLI package root disappeared before admission.', error);
    });
    if (!sameStat(snapshot.rootStat, after)) {
      fail('RACE_DETECTED', 'Native CLI package root changed before admission.');
    }
  };

  await assertRootStable();
  for (const entry of snapshot.entries.values()) {
    const after = await lstatBig(entry.absolutePath).catch((error) => {
      fail('RACE_DETECTED', `Native CLI package entry ${entry.relativePath} disappeared.`, error);
    });
    if (!sameStat(entry.stat, after)) {
      fail('RACE_DETECTED', `Native CLI package entry ${entry.relativePath} changed before admission.`);
    }
    if (entry.kind === 'symlink') {
      const linkTarget = await fs.readlink(entry.absolutePath).catch((error) => {
        fail('RACE_DETECTED', `Native CLI symlink ${entry.relativePath} changed before admission.`, error);
      });
      if (linkTarget !== entry.linkTarget) {
        fail('RACE_DETECTED', `Native CLI symlink ${entry.relativePath} changed before admission.`);
      }
    }
  }
  await assertRootStable();
}

function parsePackageJson(bytes: Buffer, label: string): Record<string, unknown> {
  if (bytes.length < 2 || bytes.length > 1024 * 1024 || bytes.includes(0)) {
    fail('DRIFT_DETECTED', `${label} is not a bounded JSON document.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail('DRIFT_DETECTED', `${label} is not valid JSON.`, error);
  }
  if (!isPlainObject(parsed)) fail('DRIFT_DETECTED', `${label} is not a JSON object.`);
  return parsed;
}

async function readSnapshotFile(snapshot: TreeSnapshot, relativePath: string): Promise<Buffer> {
  const entry = snapshot.entries.get(relativePath);
  if (!entry || entry.kind !== 'file') {
    fail('DRIFT_DETECTED', `Native CLI package member ${relativePath} is missing or not a file.`);
  }
  try {
    return await fs.readFile(entry.absolutePath);
  } catch (error) {
    fail('IO_ERROR', `Native CLI package member ${relativePath} could not be read.`, error);
  }
}

function expectedBinMapping(packageJson: Record<string, unknown>, binName: string, binRelative: string): boolean {
  const bin = packageJson.bin;
  if (typeof bin === 'string') return binName === packageJson.name && bin === binRelative;
  return isPlainObject(bin) && Object.keys(bin).every((key) => typeof bin[key] === 'string')
    && bin[binName] === binRelative;
}

function verifyHardlinks(snapshot: TreeSnapshot, allowedGroups: readonly (readonly string[])[]): void {
  const allowed = new Set(allowedGroups.map((group) => [...group].sort().join('\0')));
  const observedLinked = new Set<string>();
  for (const paths of snapshot.inodePaths.values()) {
    const first = snapshot.entries.get(paths[0]);
    if (!first) continue;
    const linkCount = Number(first.stat.nlink);
    if (linkCount === 1 && paths.length === 1) continue;
    if (linkCount !== paths.length) {
      fail('DRIFT_DETECTED', 'Native CLI package has a hardlink outside its admitted tree.');
    }
    const group = [...paths].sort().join('\0');
    if (!allowed.has(group)) {
      fail('DRIFT_DETECTED', 'Native CLI package has an unapproved hardlink group.');
    }
    observedLinked.add(group);
  }
  // Approved groups are optional because Claude explicitly falls back to a copy
  // when the package and executable destinations cannot be hardlinked.
  for (const group of observedLinked) {
    if (!allowed.has(group)) fail('DRIFT_DETECTED', 'Native CLI hardlink authority is invalid.');
  }
}

function runtimePlatformKey(): string {
  if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
    fail('UNSUPPORTED_PLATFORM', `Native host CLIs are not admitted on ${process.platform}/${process.arch}.`);
  }
  const report = typeof process.report?.getReport === 'function'
    ? process.report.getReport() as unknown as { header?: { glibcVersionRuntime?: unknown } }
    : null;
  if (!report || typeof report.header?.glibcVersionRuntime !== 'string') {
    fail('UNSUPPORTED_PLATFORM', 'Native host CLIs require the supported GNU/Linux runtime.');
  }
  return `linux-${process.arch}-gnu`;
}

async function attestWithContext(context: AdmissionContext): Promise<NativeHostCliIdentity> {
  const expectedLink = context.definition.executables[context.executablePath];
  if (expectedLink === undefined) {
    fail('INVALID_EXECUTABLE_PATH', `Executable path ${context.executablePath} is not admitted for ${context.toolId}.`);
  }
  await assertSafeAncestorChain(
    path.dirname(context.executablePath),
    context.ancestorFloor,
    context.requiredUid,
    context.requiredGid,
  );

  let executableStat: BigStat;
  try {
    executableStat = await lstatBig(context.executablePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') fail('ABSENT', `${context.toolId} is not installed.`, error);
    fail('IO_ERROR', `${context.toolId} executable could not be inspected.`, error);
  }
  if (
    !executableStat.isSymbolicLink()
    || executableStat.uid !== BigInt(context.requiredUid)
    || executableStat.gid !== BigInt(context.requiredGid)
  ) fail('DRIFT_DETECTED', `${context.toolId} executable is not the expected root-owned symlink.`);
  const firstLink = await fs.readlink(context.executablePath).catch((error) => {
    fail('IO_ERROR', `${context.toolId} executable symlink could not be read.`, error);
  });
  if (firstLink !== expectedLink) {
    fail('DRIFT_DETECTED', `${context.toolId} executable symlink target does not match the catalog.`);
  }
  const expectedTarget = path.join(context.definition.packageRoot, context.definition.binRelative);
  const lexicalTarget = path.resolve(path.dirname(context.executablePath), firstLink);
  if (lexicalTarget !== expectedTarget) {
    fail('DRIFT_DETECTED', `${context.toolId} executable does not resolve to its canonical package.`);
  }

  await assertSafeAncestorChain(
    context.definition.packageRoot,
    context.ancestorFloor,
    context.requiredUid,
    context.requiredGid,
  );
  const packageRealPath = await fs.realpath(context.definition.packageRoot).catch((error) => {
    fail('DRIFT_DETECTED', `${context.toolId} package root cannot be resolved.`, error);
  });
  if (packageRealPath !== context.definition.packageRoot) {
    fail('DRIFT_DETECTED', `${context.toolId} package root is not canonical.`);
  }

  const initialPackageJsonPath = path.join(context.definition.packageRoot, 'package.json');
  let packageJsonBytes: Buffer;
  try {
    packageJsonBytes = await fs.readFile(initialPackageJsonPath);
  } catch (error) {
    fail('DRIFT_DETECTED', `${context.toolId} package metadata is missing.`, error);
  }
  const packageJson = parsePackageJson(packageJsonBytes, `${context.toolId} package metadata`);
  if (packageJson.name !== context.definition.packageName) {
    fail('DRIFT_DETECTED', `${context.toolId} package name does not match the catalog.`);
  }
  if (typeof packageJson.version !== 'string') {
    fail('DRIFT_DETECTED', `${context.toolId} package version is invalid.`);
  }
  const observedVersion = packageJson.version;
  return attachObservedVersion(observedVersion, async () => {
    const version = context.definition.versions[observedVersion];
    if (!version) {
      fail('UNSUPPORTED_VERSION', `${context.toolId} ${observedVersion} is not an admitted version.`);
    }
    if (version.admission === 'status-only') {
      fail('STATUS_ONLY_VERSION', version.statusReason ?? `${context.toolId} ${observedVersion} is status-only.`);
    }
    if (!expectedBinMapping(packageJson, context.definition.binName, context.definition.binRelative)) {
      fail('DRIFT_DETECTED', `${context.toolId} package bin mapping does not match the catalog.`);
    }
    const platform = version.platforms[context.platformKey];
    if (!platform) {
      fail('UNSUPPORTED_PLATFORM', `${context.toolId} ${observedVersion} is not admitted on ${context.platformKey}.`);
    }

    const snapshot = await snapshotTree(
      context.definition.packageRoot,
      context.limits,
      context.requiredUid,
      context.requiredGid,
    );
    if (snapshot.digest !== platform.treeSha256) {
      fail('DRIFT_DETECTED', `${context.toolId} package tree does not match the signed catalog.`);
    }
    for (const [relativePath, expectedDigest] of Object.entries(platform.criticalFiles)) {
      const entry = snapshot.entries.get(relativePath);
      if (!entry || entry.kind !== 'file' || entry.sha256 !== expectedDigest) {
        fail('DRIFT_DETECTED', `${context.toolId} critical package member ${relativePath} does not match the catalog.`);
      }
    }

    const observedPackageJson = parsePackageJson(
      await readSnapshotFile(snapshot, 'package.json'),
      `${context.toolId} package metadata`,
    );
    if (
      observedPackageJson.name !== context.definition.packageName
      || observedPackageJson.version !== observedVersion
      || !expectedBinMapping(observedPackageJson, context.definition.binName, context.definition.binRelative)
    ) fail('RACE_DETECTED', `${context.toolId} package metadata changed during admission.`);

    if (platform.platformPackageRelative !== null) {
      const platformPackagePath = `${platform.platformPackageRelative}/package.json`;
      const platformPackageJson = parsePackageJson(
        await readSnapshotFile(snapshot, platformPackagePath),
        `${context.toolId} platform package metadata`,
      );
      if (
        platformPackageJson.name !== platform.platformPackageName
        || platformPackageJson.version !== platform.platformPackageVersion
      ) fail('DRIFT_DETECTED', `${context.toolId} platform package identity does not match the catalog.`);
      if (platform.platformBinRelative === null) {
        fail('CATALOG_INVALID', `${context.toolId} platform binary authority is incomplete.`);
      }
      const platformBinary = snapshot.entries.get(
        `${platform.platformPackageRelative}/${platform.platformBinRelative}`,
      );
      if (!platformBinary || platformBinary.kind !== 'file' || (platformBinary.mode & 0o111) === 0) {
        fail('DRIFT_DETECTED', `${context.toolId} platform binary is missing or not executable.`);
      }
    }

    verifyHardlinks(snapshot, platform.hardlinkGroups);
    if (context.hooks?.afterInitialTreeScan) await context.hooks.afterInitialTreeScan();
    await verifySnapshotStable(snapshot);

    const executableAfter = await lstatBig(context.executablePath).catch((error) => {
      fail('RACE_DETECTED', `${context.toolId} executable disappeared during admission.`, error);
    });
    const secondLink = await fs.readlink(context.executablePath).catch((error) => {
      fail('RACE_DETECTED', `${context.toolId} executable changed during admission.`, error);
    });
    if (!sameStat(executableStat, executableAfter) || secondLink !== firstLink) {
      fail('RACE_DETECTED', `${context.toolId} executable changed during admission.`);
    }

    const fingerprint = createHash('sha256').update(JSON.stringify({
      schema: CATALOG.schema,
      toolId: context.toolId,
      executablePath: context.executablePath,
      executableTarget: firstLink,
      packageName: context.definition.packageName,
      version: observedVersion,
      platform: context.platformKey,
      treeSha256: snapshot.digest,
    })).digest('hex');
    return Object.freeze({
      toolId: context.toolId,
      executablePath: context.executablePath,
      packageName: context.definition.packageName,
      version: observedVersion,
      fingerprint,
      checkedAt: context.now().toISOString(),
    });
  });
}

export async function attestNativeHostCli(
  toolId: NativeHostCliId,
  executablePath = PUBLIC_DEFAULT_EXECUTABLES[toolId],
): Promise<NativeHostCliIdentity> {
  if (!ALLOWED_TOOL_IDS.has(toolId) || typeof executablePath !== 'string') {
    fail('INVALID_EXECUTABLE_PATH', 'Native CLI tool or executable path is invalid.');
  }
  const definition = CATALOG.tools[toolId];
  if (!definition || definition.executables[executablePath] === undefined) {
    fail('INVALID_EXECUTABLE_PATH', `Executable path ${executablePath} is not admitted for ${toolId}.`);
  }
  try {
    await assertNativeCliBundleIdle();
    return await attestWithContext(Object.freeze({
      toolId,
      executablePath,
      definition,
      limits: CATALOG.limits,
      platformKey: runtimePlatformKey(),
      requiredUid: 0,
      requiredGid: 0,
      ancestorFloor: path.parse(executablePath).root,
      now: () => new Date(),
    }));
  } catch (error) {
    if (error instanceof NativeHostCliAdmissionError) throw error;
    fail('IO_ERROR', `${toolId} could not be safely admitted.`, error);
  }
}

export const __nativeHostCliAdmissionTest = Object.freeze({
  parseCatalog,
  snapshotTree,
  attestWithContext,
  canonicalTreeLine,
  verifyHardlinks,
  runtimePlatformKey,
  catalog: CATALOG,
});
