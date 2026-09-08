import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getOpenClawSetupReadiness,
  QUALIFIED_OPENCLAW_NATIVE_PATCHES,
  type OpenClawSetupReadiness,
} from './openclawSetupReadiness';

export type OpenClawRetirementRuntimeFamily =
  | 'legacy-2026.7.1'
  | 'current-2026.9.1';

export type LegacyOpenClawSessionPrivacyTarget = Readonly<{
  stateRoot: string;
  sessionsDir: string;
  registryPath: string;
  sessionFile: string;
}>;

type PrivacyLimits = Readonly<{
  maxRegistryBytes: number;
  maxRegistryEntries: number;
  maxDirectoryEntries: number;
  maxArtifacts: number;
  maxArtifactBytes: number;
  maxTotalArtifactBytes: number;
}>;

export type LegacyOpenClawSessionPrivacyHooks = Readonly<{
  afterOpen?(filePath: string): void;
  afterQuarantine?(sourcePath: string, quarantinePath: string): void;
  afterUnlink?(filePath: string): void;
}>;

export type LegacyOpenClawSessionPrivacyOptions = Readonly<{
  stateRoot?: string;
  expectedUid?: number;
  expectedGid?: number;
  limits?: Partial<PrivacyLimits>;
  hooks?: LegacyOpenClawSessionPrivacyHooks;
}>;

export type OpenClawRetirementSessionIdentity = Readonly<{
  agentId: string;
  sessionKey: string;
  sessionId: string;
}>;

type BoundFile = Readonly<{
  path: string;
  name: string;
  kind: 'transcript' | 'trajectory' | 'pointer';
  size: number;
  quarantined: boolean;
}>;

const LEGACY_CORE_VERSION = '2026.7.1-2';
const LEGACY_RUNTIME_VERSIONS = new Set(['2026.7.1', LEGACY_CORE_VERSION]);
const LEGACY_CODEX_VERSION = '2026.7.1-1';
const CURRENT_VERSIONS = new Set(QUALIFIED_OPENCLAW_NATIVE_PATCHES);
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARCHIVE_TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z`;
const CHECKPOINT_ID = String.raw`[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}`;
const MAX_PATH_BYTES = 4096;
const MAX_NAME_BYTES = 255;
const HEADER_READ_BYTES = 64 * 1024;
const DEFAULT_LIMITS: PrivacyLimits = Object.freeze({
  maxRegistryBytes: 32 * 1024 * 1024,
  maxRegistryEntries: 50_000,
  maxDirectoryEntries: 100_000,
  maxArtifacts: 512,
  maxArtifactBytes: 512 * 1024 * 1024,
  maxTotalArtifactBytes: 2 * 1024 * 1024 * 1024,
});

export class OpenClawLegacySessionPrivacyError extends Error {
  readonly code = 'OPENCLAW_LEGACY_SESSION_PRIVACY_INTEGRITY';

  constructor(message: string) {
    super(message);
    this.name = 'OpenClawLegacySessionPrivacyError';
  }
}

function fail(message: string): never {
  throw new OpenClawLegacySessionPrivacyError(message);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validRuntimeVersion(
  value: string | null,
  expected: ReadonlySet<string>,
): boolean {
  return typeof value === 'string' && expected.has(value);
}

/**
 * Re-validates the exact tuple rather than trusting a family label copied from
 * one probe. Retirement is destructive, so a mixed CLI/package/Gateway tuple
 * is an integrity failure even when another feature could limp along.
 */
export function resolveExactOpenClawRetirementRuntimeFamily(
  readiness: OpenClawSetupReadiness,
): OpenClawRetirementRuntimeFamily {
  if (
    readiness.testedPairReady === true
    && readiness.authenticatedRpc === true
    && readiness.testedRuntimeFamily === 'legacy-2026.7.1'
    && readiness.corePackageVersion === LEGACY_CORE_VERSION
    && validRuntimeVersion(readiness.version, LEGACY_RUNTIME_VERSIONS)
    && validRuntimeVersion(readiness.runningVersion, LEGACY_RUNTIME_VERSIONS)
    && readiness.codexPluginVersion === LEGACY_CODEX_VERSION
    && readiness.codexPluginInstallSpec === `@openclaw/codex@${LEGACY_CODEX_VERSION}`
  ) return 'legacy-2026.7.1';

  if (
    readiness.testedPairReady === true
    && readiness.authenticatedRpc === true
    && readiness.testedRuntimeFamily === 'current-2026.9.1'
    && validRuntimeVersion(readiness.corePackageVersion, CURRENT_VERSIONS)
    && readiness.version === readiness.corePackageVersion
    && readiness.runningVersion === readiness.corePackageVersion
    && readiness.codexPluginVersion === readiness.corePackageVersion
    && readiness.codexPluginInstallSpec === `@openclaw/codex@${readiness.corePackageVersion}`
  ) return 'current-2026.9.1';

  fail('OpenClaw does not match an exact Portal-qualified retirement runtime tuple');
}

export async function attestOpenClawRetirementRuntimeFamily(): Promise<OpenClawRetirementRuntimeFamily> {
  const readiness = await getOpenClawSetupReadiness({}, { force: true });
  return resolveExactOpenClawRetirementRuntimeFamily(readiness);
}

function normalizedStateRoot(value: string): string {
  const resolved = path.resolve(value);
  if (
    !path.isAbsolute(value)
    || resolved !== value
    || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
    || /[\u0000-\u001f\u007f]/.test(value)
  ) fail('OpenClaw state root is not an absolute normalized path');
  return resolved;
}

function validateIdentity(identity: OpenClawRetirementSessionIdentity): void {
  if (!SAFE_AGENT_ID.test(identity.agentId)) fail('OpenClaw retirement agent identity is invalid');
  if (!SAFE_SESSION_ID.test(identity.sessionId)) fail('OpenClaw retirement session identity is invalid');
  if (
    identity.sessionKey !== identity.sessionKey.trim()
    || !identity.sessionKey.startsWith(`agent:${identity.agentId}:`)
    || identity.sessionKey.length > 2048
    || /[\u0000-\u001f\u007f]/.test(identity.sessionKey)
  ) fail('OpenClaw retirement session key is invalid');
}

function identityPath(
  input: OpenClawRetirementSessionIdentity,
  options: LegacyOpenClawSessionPrivacyOptions = {},
) {
  validateIdentity(input);
  const standardStateRoot = path.join(process.env.HOME || os.homedir() || '/root', '.openclaw');
  const stateRoot = normalizedStateRoot(
    options.stateRoot
      || process.env.OPENCLAW_STATE_DIR
      || standardStateRoot,
  );
  if (options.stateRoot === undefined && stateRoot !== path.resolve(standardStateRoot)) {
    fail('Legacy OpenClaw retirement requires the standard state root');
  }
  const sessionsDir = path.join(stateRoot, 'agents', input.agentId, 'sessions');
  return Object.freeze({
    stateRoot,
    sessionsDir,
    registryPath: path.join(sessionsDir, 'sessions.json'),
    sessionFile: path.join(sessionsDir, `${input.sessionId}.jsonl`),
  });
}

function effectiveOwners(options: LegacyOpenClawSessionPrivacyOptions): { uid: number; gid: number } {
  return {
    uid: options.expectedUid ?? 0,
    gid: options.expectedGid ?? 0,
  };
}

function effectiveLimits(options: LegacyOpenClawSessionPrivacyOptions): PrivacyLimits {
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...(options.limits || {}) });
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) fail(`OpenClaw privacy bound ${key} is invalid`);
  }
  return limits;
}

function statMode(stat: fs.BigIntStats): number {
  return Number(stat.mode & 0o7777n);
}

function assertSafeDirectory(
  directory: string,
  owners: { uid: number; gid: number },
  label: string,
): void {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch {
    fail(`${label} is unavailable`);
  }
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || Number(stat.uid) !== owners.uid
    || Number(stat.gid) !== owners.gid
    || (statMode(stat) & 0o022) !== 0
  ) fail(`${label} is not a root-owned private real directory`);
  let real = '';
  try {
    real = fs.realpathSync(directory);
  } catch {
    fail(`${label} real path could not be verified`);
  }
  if (real !== directory) fail(`${label} path identity is not canonical`);
}

function assertSafeDirectoryChain(
  target: LegacyOpenClawSessionPrivacyTarget,
  owners: { uid: number; gid: number },
): void {
  assertSafeDirectory(target.stateRoot, owners, 'OpenClaw state root');
  assertSafeDirectory(path.join(target.stateRoot, 'agents'), owners, 'OpenClaw agents root');
  assertSafeDirectory(
    path.join(target.stateRoot, 'agents', path.basename(path.dirname(target.sessionsDir))),
    owners,
    'OpenClaw agent root',
  );
  assertSafeDirectory(target.sessionsDir, owners, 'OpenClaw sessions root');
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.mode === right.mode;
}

function assertSafeRegularStat(
  stat: fs.BigIntStats,
  owners: { uid: number; gid: number },
  maxBytes: number,
  label: string,
): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1n
    || Number(stat.uid) !== owners.uid
    || Number(stat.gid) !== owners.gid
    || stat.size < 0n
    || stat.size > BigInt(maxBytes)
    || (statMode(stat) & 0o022) !== 0
  ) fail(`${label} is not a bounded root-owned, non-linked regular file`);
}

function openVerifiedFile(
  filePath: string,
  owners: { uid: number; gid: number },
  maxBytes: number,
  label: string,
  hooks?: LegacyOpenClawSessionPrivacyHooks,
): { fd: number; stat: fs.BigIntStats } {
  if (Buffer.byteLength(filePath, 'utf8') > MAX_PATH_BYTES) fail(`${label} path is too long`);
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(filePath, { bigint: true });
  } catch {
    fail(`${label} disappeared during inspection`);
  }
  assertSafeRegularStat(before, owners, maxBytes, label);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow) || noFollow <= 0) fail('O_NOFOLLOW is unavailable');
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch {
    fail(`${label} could not be opened without following links`);
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    assertSafeRegularStat(opened, owners, maxBytes, label);
    if (!sameFileIdentity(before, opened)) fail(`${label} identity changed while opening`);
    hooks?.afterOpen?.(filePath);
    const rebound = fs.lstatSync(filePath, { bigint: true });
    if (!sameFileIdentity(opened, rebound)) fail(`${label} path changed after descriptor binding`);
    return { fd, stat: opened };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readWholeBoundedFile(
  filePath: string,
  owners: { uid: number; gid: number },
  maxBytes: number,
  label: string,
): string {
  const opened = openVerifiedFile(filePath, owners, maxBytes, label);
  try {
    const size = Number(opened.stat.size);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(opened.fd, buffer, offset, size - offset, offset);
      if (count <= 0) fail(`${label} ended before its attested size`);
      offset += count;
    }
    const after = fs.fstatSync(opened.fd, { bigint: true });
    if (
      !sameFileIdentity(opened.stat, after)
      || opened.stat.size !== after.size
      || opened.stat.mtimeNs !== after.mtimeNs
    ) fail(`${label} changed while it was read`);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(opened.fd);
  }
}

class UniqueJsonKeyScanner {
  private index = 0;
  private nodes = 0;

  constructor(private readonly source: string) {}

  scan(): void {
    this.skipSpace();
    this.value(0);
    this.skipSpace();
    if (this.index !== this.source.length) fail('OpenClaw registry contains trailing JSON data');
  }

  private bump(depth: number): void {
    this.nodes += 1;
    if (depth > 64 || this.nodes > 1_000_000) fail('OpenClaw registry JSON is too complex');
  }

  private skipSpace(): void {
    while (/\s/u.test(this.source[this.index] || '')) this.index += 1;
  }

  private string(): string {
    const start = this.index;
    if (this.source[this.index] !== '"') fail('OpenClaw registry JSON string is malformed');
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.index));
        } catch {
          fail('OpenClaw registry JSON string is malformed');
        }
      }
      if (character === '\\') {
        this.index += 1;
        const escape = this.source[this.index];
        if (!escape || !/^["\\/bfnrtu]$/.test(escape)) fail('OpenClaw registry JSON escape is malformed');
        if (escape === 'u') {
          const hex = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-f]{4}$/i.test(hex)) fail('OpenClaw registry JSON unicode escape is malformed');
          this.index += 4;
        }
      } else if (character.charCodeAt(0) < 0x20) {
        fail('OpenClaw registry JSON contains a control character');
      }
      this.index += 1;
    }
    fail('OpenClaw registry JSON string is unterminated');
  }

  private value(depth: number): void {
    this.bump(depth);
    this.skipSpace();
    const character = this.source[this.index];
    if (character === '{') return this.object(depth + 1);
    if (character === '[') return this.array(depth + 1);
    if (character === '"') {
      this.string();
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (this.source.startsWith(literal, this.index)) {
        this.index += literal.length;
        return;
      }
    }
    const number = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) fail('OpenClaw registry JSON value is malformed');
    this.index += number[0].length;
  }

  private object(depth: number): void {
    this.index += 1;
    this.skipSpace();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return;
    }
    const keys = new Set<string>();
    while (this.index < this.source.length) {
      this.skipSpace();
      const key = this.string();
      if (keys.has(key)) fail(`OpenClaw registry JSON repeats key ${JSON.stringify(key)}`);
      keys.add(key);
      this.skipSpace();
      if (this.source[this.index] !== ':') fail('OpenClaw registry JSON object is malformed');
      this.index += 1;
      this.value(depth);
      this.skipSpace();
      const separator = this.source[this.index];
      if (separator === '}') {
        this.index += 1;
        return;
      }
      if (separator !== ',') fail('OpenClaw registry JSON object is malformed');
      this.index += 1;
    }
    fail('OpenClaw registry JSON object is unterminated');
  }

  private array(depth: number): void {
    this.index += 1;
    this.skipSpace();
    if (this.source[this.index] === ']') {
      this.index += 1;
      return;
    }
    while (this.index < this.source.length) {
      this.value(depth);
      this.skipSpace();
      const separator = this.source[this.index];
      if (separator === ']') {
        this.index += 1;
        return;
      }
      if (separator !== ',') fail('OpenClaw registry JSON array is malformed');
      this.index += 1;
    }
    fail('OpenClaw registry JSON array is unterminated');
  }
}

function parseUniqueJsonObject(raw: string, label: string): Record<string, unknown> {
  new UniqueJsonKeyScanner(raw).scan();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${label} is not valid JSON`);
  }
  if (!plainObject(parsed)) fail(`${label} is not a JSON object`);
  return parsed;
}

function inspectRegistry(
  input: OpenClawRetirementSessionIdentity,
  target: LegacyOpenClawSessionPrivacyTarget,
  options: LegacyOpenClawSessionPrivacyOptions,
  expected: 'present' | 'absent',
): void {
  const owners = effectiveOwners(options);
  const limits = effectiveLimits(options);
  const raw = readWholeBoundedFile(
    target.registryPath,
    owners,
    limits.maxRegistryBytes,
    'OpenClaw session registry',
  );
  const registry = parseUniqueJsonObject(raw, 'OpenClaw session registry');
  const entries = Object.entries(registry);
  if (entries.length > limits.maxRegistryEntries) fail('OpenClaw session registry entry bound exceeded');

  const foldedTarget = input.sessionKey.toLocaleLowerCase('en-US');
  const caseCollisions = entries.filter(([key]) => (
    key !== input.sessionKey && key.toLocaleLowerCase('en-US') === foldedTarget
  ));
  if (caseCollisions.length > 0) fail('OpenClaw session registry contains ambiguous key casing');

  const sessionIdOwners: string[] = [];
  for (const [key, value] of entries) {
    if (
      !key
      || key.length > 2048
      || /[\u0000-\u001f\u007f]/.test(key)
      || !plainObject(value)
    ) fail('OpenClaw session registry contains a malformed entry');
    if (value.sessionId === input.sessionId) sessionIdOwners.push(key);
  }
  if (sessionIdOwners.some((key) => key !== input.sessionKey)) {
    fail('OpenClaw session registry contains duplicate transcript authority');
  }

  const entry = registry[input.sessionKey];
  if (expected === 'absent') {
    if (entry !== undefined || sessionIdOwners.length !== 0) {
      fail('OpenClaw session registry entry remains after deletion');
    }
    return;
  }
  if (!plainObject(entry) || entry.sessionId !== input.sessionId) {
    fail('OpenClaw session registry identity does not match the retirement manifest');
  }
  const sessionFile = typeof entry.sessionFile === 'string' && entry.sessionFile.trim()
    ? path.resolve(target.sessionsDir, entry.sessionFile.trim())
    : target.sessionFile;
  if (sessionFile !== target.sessionFile) {
    fail('OpenClaw session uses a custom or out-of-root transcript layout');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function artifactPatterns(sessionId: string) {
  const id = escapeRegExp(sessionId);
  const transcript = new RegExp(
    `^${id}(?:\\.checkpoint\\.${CHECKPOINT_ID})?\\.jsonl(?:\\.(?:deleted|reset|bak)\\.${ARCHIVE_TIMESTAMP})?$`,
  );
  const quarantine = new RegExp(
    `^\\.portal-retire-${id}-(transcript|trajectory|pointer)-[a-f0-9]{32}$`,
  );
  return { transcript, quarantine };
}

function classifyArtifact(
  sessionId: string,
  name: string,
): { kind: BoundFile['kind']; quarantined: boolean } | 'unknown-related' | null {
  const patterns = artifactPatterns(sessionId);
  const quarantine = patterns.quarantine.exec(name);
  if (quarantine) {
    return {
      kind: quarantine[1] as BoundFile['kind'],
      quarantined: true,
    };
  }
  if (patterns.transcript.test(name)) return { kind: 'transcript', quarantined: false };
  if (name === `${sessionId}.trajectory.jsonl`) return { kind: 'trajectory', quarantined: false };
  if (name === `${sessionId}.trajectory-path.json`) return { kind: 'pointer', quarantined: false };
  if (
    name.startsWith(`${sessionId}.jsonl`)
    || name.startsWith(`${sessionId}.checkpoint.`)
    || name.startsWith(`${sessionId}.trajectory`)
    || name.startsWith(`${sessionId}-topic-`)
    || name.startsWith(`.portal-retire-${sessionId}-`)
  ) return 'unknown-related';
  return null;
}

function firstNonEmptyLine(
  filePath: string,
  owners: { uid: number; gid: number },
  maxBytes: number,
  label: string,
): Record<string, unknown> {
  const opened = openVerifiedFile(filePath, owners, maxBytes, label);
  try {
    const buffer = Buffer.alloc(Math.min(Number(opened.stat.size), HEADER_READ_BYTES));
    const bytesRead = fs.readSync(opened.fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString('utf8')
      .split(/\r?\n/u)
      .find((candidate) => candidate.trim())?.trim();
    if (!line) fail(`${label} has no identity header`);
    return parseUniqueJsonObject(line, `${label} identity header`);
  } finally {
    fs.closeSync(opened.fd);
  }
}

function validateArtifact(
  input: OpenClawRetirementSessionIdentity,
  target: LegacyOpenClawSessionPrivacyTarget,
  artifact: BoundFile,
  options: LegacyOpenClawSessionPrivacyOptions,
): void {
  const owners = effectiveOwners(options);
  const limits = effectiveLimits(options);
  if (artifact.kind === 'pointer') {
    const pointer = parseUniqueJsonObject(
      readWholeBoundedFile(artifact.path, owners, Math.min(limits.maxArtifactBytes, 64 * 1024), 'OpenClaw trajectory pointer'),
      'OpenClaw trajectory pointer',
    );
    if (
      !exactKeys(pointer, ['traceSchema', 'schemaVersion', 'sessionId', 'runtimeFile'])
      || pointer.traceSchema !== 'openclaw-trajectory-pointer'
      || pointer.schemaVersion !== 1
      || pointer.sessionId !== input.sessionId
      || pointer.runtimeFile !== path.join(path.dirname(artifact.path), `${input.sessionId}.trajectory.jsonl`)
    ) fail('OpenClaw trajectory pointer identity is ambiguous');
    return;
  }
  const header = firstNonEmptyLine(
    artifact.path,
    owners,
    limits.maxArtifactBytes,
    artifact.kind === 'transcript' ? 'OpenClaw transcript artifact' : 'OpenClaw trajectory artifact',
  );
  if (artifact.kind === 'transcript') {
    if (header.type !== 'session' || header.id !== input.sessionId) {
      fail('OpenClaw transcript artifact header does not match the retirement manifest');
    }
    return;
  }
  if (
    header.traceSchema !== 'openclaw-trajectory'
    || header.schemaVersion !== 1
    || header.source !== 'runtime'
    || header.sessionId !== input.sessionId
  ) fail('OpenClaw trajectory artifact header does not match the retirement manifest');
}

function discoverArtifacts(
  input: OpenClawRetirementSessionIdentity,
  target: LegacyOpenClawSessionPrivacyTarget,
  options: LegacyOpenClawSessionPrivacyOptions,
): BoundFile[] {
  const limits = effectiveLimits(options);
  const owners = effectiveOwners(options);
  const directories = [target.sessionsDir];
  const legacySessionsDir = path.join(target.stateRoot, 'sessions');
  try {
    fs.lstatSync(legacySessionsDir);
    assertSafeDirectory(legacySessionsDir, owners, 'OpenClaw legacy sessions root');
    directories.push(legacySessionsDir);
  } catch (error: any) {
    if (error instanceof OpenClawLegacySessionPrivacyError) throw error;
    if (error?.code !== 'ENOENT') fail('OpenClaw legacy sessions root could not be verified');
  }

  const artifacts: BoundFile[] = [];
  let totalBytes = 0;
  let totalDirectoryEntries = 0;
  for (const directory of directories) {
    let directoryEntries: fs.Dirent[];
    try {
      directoryEntries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      fail('OpenClaw sessions root could not be inventoried');
    }
    totalDirectoryEntries += directoryEntries.length;
    if (totalDirectoryEntries > limits.maxDirectoryEntries) {
      fail('OpenClaw sessions directory inventory bound exceeded');
    }
    for (const entry of directoryEntries) {
      if (Buffer.byteLength(entry.name, 'utf8') > MAX_NAME_BYTES) {
        fail('OpenClaw sessions directory contains an overlong name');
      }
      const classified = classifyArtifact(input.sessionId, entry.name);
      if (classified === null) continue;
      if (classified === 'unknown-related') {
        fail('OpenClaw session has an unrecognized privacy artifact');
      }
      const artifactPath = path.join(directory, entry.name);
      let stat: fs.BigIntStats;
      try {
        stat = fs.lstatSync(artifactPath, { bigint: true });
      } catch {
        fail('OpenClaw privacy artifact changed during inventory');
      }
      assertSafeRegularStat(stat, owners, limits.maxArtifactBytes, 'OpenClaw privacy artifact');
      const size = Number(stat.size);
      totalBytes += size;
      if (totalBytes > limits.maxTotalArtifactBytes) fail('OpenClaw privacy artifact byte bound exceeded');
      artifacts.push(Object.freeze({
        path: artifactPath,
        name: entry.name,
        kind: classified.kind,
        size,
        quarantined: classified.quarantined,
      }));
    }
  }
  if (artifacts.length > limits.maxArtifacts) fail('OpenClaw privacy artifact count bound exceeded');
  for (const artifact of artifacts) validateArtifact(input, target, artifact, options);
  return artifacts.sort((left, right) => left.name.localeCompare(right.name));
}

function fsyncDirectory(directory: string): void {
  const noFollow = fs.constants.O_NOFOLLOW;
  const directoryFlag = fs.constants.O_DIRECTORY;
  if (!Number.isInteger(noFollow) || !Number.isInteger(directoryFlag)) {
    fail('Secure directory descriptor flags are unavailable');
  }
  let fd: number;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | noFollow | directoryFlag);
  } catch {
    fail('OpenClaw sessions directory could not be opened for durability');
  }
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function deleteBoundArtifact(
  input: OpenClawRetirementSessionIdentity,
  target: LegacyOpenClawSessionPrivacyTarget,
  artifact: BoundFile,
  options: LegacyOpenClawSessionPrivacyOptions,
): void {
  const owners = effectiveOwners(options);
  const limits = effectiveLimits(options);
  const opened = openVerifiedFile(
    artifact.path,
    owners,
    limits.maxArtifactBytes,
    'OpenClaw privacy artifact',
    options.hooks,
  );
  const artifactDirectory = path.dirname(artifact.path);
  if (
    artifactDirectory !== target.sessionsDir
    && artifactDirectory !== path.join(target.stateRoot, 'sessions')
  ) fail('OpenClaw privacy artifact escaped its attested sessions roots');
  let deletionPath = artifact.path;
  try {
    if (!artifact.quarantined) {
      const quarantineName = `.portal-retire-${input.sessionId}-${artifact.kind}-${crypto.randomBytes(16).toString('hex')}`;
      const quarantinePath = path.join(artifactDirectory, quarantineName);
      fs.renameSync(artifact.path, quarantinePath);
      fsyncDirectory(artifactDirectory);
      options.hooks?.afterQuarantine?.(artifact.path, quarantinePath);
      const rebound = fs.lstatSync(quarantinePath, { bigint: true });
      if (!sameFileIdentity(opened.stat, rebound)) {
        fail('OpenClaw privacy artifact changed at the quarantine boundary');
      }
      deletionPath = quarantinePath;
    }
    const current = fs.lstatSync(deletionPath, { bigint: true });
    if (!sameFileIdentity(opened.stat, current)) {
      fail('OpenClaw privacy artifact changed before unlink');
    }
    fs.unlinkSync(deletionPath);
    fsyncDirectory(artifactDirectory);
    options.hooks?.afterUnlink?.(deletionPath);
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function resolveLegacyOpenClawSessionPrivacyTarget(
  input: OpenClawRetirementSessionIdentity,
  options: LegacyOpenClawSessionPrivacyOptions = {},
): LegacyOpenClawSessionPrivacyTarget {
  const target = identityPath(input, options);
  assertSafeDirectoryChain(target, effectiveOwners(options));
  return target;
}

/** Captures the only legacy layout Portal is prepared to delete. */
export function captureLegacyOpenClawSessionPrivacyTarget(
  input: OpenClawRetirementSessionIdentity,
  options: LegacyOpenClawSessionPrivacyOptions = {},
): LegacyOpenClawSessionPrivacyTarget {
  const target = resolveLegacyOpenClawSessionPrivacyTarget(input, options);
  inspectRegistry(input, target, options, 'present');
  discoverArtifacts(input, target, options);
  return target;
}

export function buildOpenClawRetirementIdentityAttestation(input: {
  identity: OpenClawRetirementSessionIdentity;
  family: OpenClawRetirementRuntimeFamily;
  legacySessionFile?: string;
}): Readonly<Record<string, string>> {
  validateIdentity(input.identity);
  if (input.family === 'legacy-2026.7.1') {
    const sessionFile = String(input.legacySessionFile || '').trim();
    if (!sessionFile || !path.isAbsolute(sessionFile) || path.resolve(sessionFile) !== sessionFile) {
      fail('Legacy OpenClaw retirement transcript identity is missing');
    }
    return Object.freeze({
      ...input.identity,
      retirementRuntimeFamily: input.family,
      hardDeleteContract: 'portal-legacy-file-hard-delete-v1',
      sessionFile,
    });
  }
  if (input.legacySessionFile !== undefined) {
    fail('Current OpenClaw retirement identity carried a legacy transcript path');
  }
  return Object.freeze({
    ...input.identity,
    retirementRuntimeFamily: input.family,
    hardDeleteContract: 'gateway-atomic-no-archive-v1',
  });
}

export async function hardDeleteLegacyOpenClawSessionPrivacyArtifacts(input: {
  identity: OpenClawRetirementSessionIdentity;
  archivedPaths: readonly string[];
  options?: LegacyOpenClawSessionPrivacyOptions;
}): Promise<void> {
  const options = input.options || {};
  const target = resolveLegacyOpenClawSessionPrivacyTarget(input.identity, options);
  inspectRegistry(input.identity, target, options, 'absent');
  const artifacts = discoverArtifacts(input.identity, target, options);
  const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  const returned = new Set<string>();
  const limits = effectiveLimits(options);
  if (input.archivedPaths.length > limits.maxArtifacts) fail('OpenClaw returned archive count bound exceeded');
  for (const archivedPath of input.archivedPaths) {
    if (
      typeof archivedPath !== 'string'
      || !path.isAbsolute(archivedPath)
      || path.resolve(archivedPath) !== archivedPath
      || returned.has(archivedPath)
      || !byPath.has(archivedPath)
      || byPath.get(archivedPath)?.kind !== 'transcript'
    ) fail('OpenClaw returned an unbound transcript archive path');
    returned.add(archivedPath);
  }
  for (const artifact of artifacts) deleteBoundArtifact(input.identity, target, artifact, options);
  inspectRegistry(input.identity, target, options, 'absent');
  if (discoverArtifacts(input.identity, target, options).length !== 0) {
    fail('OpenClaw privacy artifacts remain after deletion');
  }
  fsyncDirectory(target.sessionsDir);
  const legacySessionsDir = path.join(target.stateRoot, 'sessions');
  if (fs.existsSync(legacySessionsDir)) fsyncDirectory(legacySessionsDir);
}

export function assertLegacyOpenClawSessionPrivacyAbsent(
  input: OpenClawRetirementSessionIdentity,
  options: LegacyOpenClawSessionPrivacyOptions = {},
): void {
  const target = resolveLegacyOpenClawSessionPrivacyTarget(input, options);
  inspectRegistry(input, target, options, 'absent');
  if (discoverArtifacts(input, target, options).length !== 0) {
    fail('OpenClaw privacy artifacts remain after retirement');
  }
}
