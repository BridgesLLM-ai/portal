import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  ContainedPathError,
  isPathContained,
  resolveContainedPath,
} from './containedPath';
import {
  desktopExecDetachedArgv,
  RD_USER,
} from '../utils/desktopEnv';

export const REMOTE_DESKTOP_OPEN_ROOT = '/var/lib/bridgesllm/remote-desktop-open';
export const REMOTE_DESKTOP_OPEN_MAX_FILE_BYTES = 256 * 1024 * 1024;
export const REMOTE_DESKTOP_OPEN_MAX_ENTRIES = 32;
export const REMOTE_DESKTOP_OPEN_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const REMOTE_DESKTOP_OPEN_TTL_MS = 60 * 60 * 1000;
const REMOTE_DESKTOP_OPEN_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

const MAX_SOURCE_PATH_BYTES = 4096;
const MAX_AGENT_LIST_ENTRIES = 1024;
const MAX_AGENT_ID_BYTES = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const OPENCLAW_AGENT_ID_VALID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const OPENCLAW_AGENT_ID_INVALID = /[^a-z0-9_-]+/g;
const REQUEST_DIRECTORY_PATTERN = /^[a-f0-9]{32}$/;
const RESERVATION_FILE = '.reservation';
const COPY_BUFFER_BYTES = 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.bash', '.c', '.cc', '.cfg', '.conf', '.cpp', '.css', '.csv', '.env', '.fish',
  '.go', '.h', '.hpp', '.htm', '.html', '.ini', '.java', '.js', '.json', '.jsonl',
  '.jsx', '.log', '.md', '.mjs', '.php', '.properties', '.py', '.rb', '.rs', '.sass',
  '.scss', '.sh', '.sql', '.svelte', '.svg', '.toml', '.ts', '.tsx', '.txt', '.vue',
  '.xml', '.yaml', '.yml', '.zsh',
]);
const TEXT_NAMES = new Set([
  '.editorconfig', '.gitattributes', '.gitignore', '.npmrc', 'dockerfile', 'makefile',
]);
const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.heic', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp',
]);

export type RemoteDesktopOpenSource = 'agent-workspace' | 'project';

export interface RemoteDesktopOpenPathInput {
  source: RemoteDesktopOpenSource;
  path: unknown;
  agent?: unknown;
  line?: unknown;
  column?: unknown;
  /** Exact, gateway-materialized Agent workspace from OpenClaw agents.list. */
  agentAuthority?: RemoteDesktopAgentAuthority;
  /** Exact, server-attested Project generation from the identity ledger. */
  projectAuthority?: RemoteDesktopProjectAuthority;
}

export interface RemoteDesktopAgentAuthority {
  agentId: string;
  resolvedWorkspace: string;
  isCurrent: () => Promise<boolean>;
}

export interface RemoteDesktopAgentWorkspaceSnapshot {
  agentId: string;
  resolvedWorkspace: string;
}

export interface RemoteDesktopProjectAuthority {
  identityId: string;
  generation: number;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  isCurrent: () => Promise<boolean>;
}

export interface RemoteDesktopOpenPathResult {
  ok: true;
  accepted: true;
  mode: 'snapshot';
  targetType: 'file';
}

export class RemoteDesktopOpenPathError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteDesktopOpenPathError';
  }
}

export interface RemoteDesktopOpenPathOptions {
  stagingRoot?: string;
  desktopUid?: number;
  desktopGid?: number;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  launch?: (executable: string, args: readonly string[], unitName: string) => void;
  /** Test-only race seam between lstat admission and O_NOFOLLOW open. */
  afterSourceAdmission?: (sourcePath: string) => void | Promise<void>;
}

type SourceAdmission = {
  sourcePath: string;
  sourceName: string;
  stat: fs.BigIntStats;
  authorityCheck?: () => void | Promise<void>;
};

type ActiveStagingDirectory = {
  directory: string;
  expiresAt: number;
};

type StagingUsage = {
  count: number;
  bytes: number;
  removed: number;
  activeDirectories: ActiveStagingDirectory[];
};

let stagingMutationTail: Promise<void> = Promise.resolve();
let stagingCleanupTimer: NodeJS.Timeout | undefined;

async function withStagingMutation<T>(operation: () => T | Promise<T>): Promise<T> {
  const previous = stagingMutationTail;
  let release!: () => void;
  stagingMutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function fail(statusCode: number, code: string, message: string): never {
  throw new RemoteDesktopOpenPathError(statusCode, code, message);
}

function parseOptionalInteger(value: unknown, name: string, minimum: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > 10_000_000) {
    fail(400, 'INVALID_POSITION', `${name} must be a safe integer of at least ${minimum}`);
  }
  return parsed;
}

function normalizeSourcePath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    fail(400, 'INVALID_PATH', 'A file path is required');
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_SOURCE_PATH_BYTES || CONTROL_CHARACTERS.test(raw)) {
    fail(400, 'INVALID_PATH', 'The file path is invalid');
  }

  if (/^file:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      fail(400, 'INVALID_PATH', 'The file URL is invalid');
    }
    if (parsed.protocol !== 'file:' || (parsed.hostname && parsed.hostname !== 'localhost')) {
      fail(400, 'INVALID_PATH', 'The file URL is invalid');
    }
    try {
      const decoded = `${decodeURIComponent(parsed.pathname)}${parsed.hash}`;
      if (
        !decoded
        || Buffer.byteLength(decoded, 'utf8') > MAX_SOURCE_PATH_BYTES
        || CONTROL_CHARACTERS.test(decoded)
      ) {
        fail(400, 'INVALID_PATH', 'The file URL is invalid');
      }
      return decoded;
    } catch {
      fail(400, 'INVALID_PATH', 'The file URL has invalid escaping');
    }
  }
  return raw;
}

function rejectTraversal(rawPath: string): void {
  if (rawPath.split('/').some((segment) => segment === '..')) {
    fail(403, 'PATH_OUTSIDE_AUTHORITY', 'The file is outside the authorized workspace');
  }
}

function assertRootIsNarrow(root: string): void {
  const broadRoots = new Set([
    '/', '/etc', '/home', '/opt', '/root', '/root/.openclaw', '/tmp', '/usr', '/var',
  ]);
  if (broadRoots.has(root)) {
    fail(503, 'WORKSPACE_AUTHORITY_UNAVAILABLE', 'No safe agent workspace authority is available');
  }
}

function attestDirectoryRoot(rawRoot: string): string {
  if (typeof rawRoot !== 'string' || !path.isAbsolute(rawRoot) || CONTROL_CHARACTERS.test(rawRoot)) {
    fail(503, 'WORKSPACE_AUTHORITY_UNAVAILABLE', 'The workspace authority is invalid');
  }
  const resolved = path.resolve(rawRoot);
  assertRootIsNarrow(resolved);
  let entry: fs.BigIntStats;
  try {
    entry = fs.lstatSync(resolved, { bigint: true });
  } catch {
    fail(503, 'WORKSPACE_AUTHORITY_UNAVAILABLE', 'The workspace authority is unavailable');
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    fail(503, 'WORKSPACE_AUTHORITY_UNAVAILABLE', 'The workspace authority is unavailable');
  }
  const canonical = fs.realpathSync.native(resolved);
  if (canonical !== resolved) {
    fail(503, 'WORKSPACE_AUTHORITY_UNAVAILABLE', 'The workspace authority is not canonical');
  }
  return canonical;
}

// Keep this byte-for-byte compatible in behavior with OpenClaw 2026.7.1's
// normalizeAgentId. Workspace authority must be derived from the same agent
// identity that OpenClaw uses to execute the chat.
export function normalizeOpenClawAgentId(value: unknown): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return 'main';
  const lowered = trimmed.toLowerCase();
  if (OPENCLAW_AGENT_ID_VALID.test(trimmed)) return lowered;
  return lowered
    .replace(OPENCLAW_AGENT_ID_INVALID, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64) || 'main';
}

/**
 * Select one exact workspace from OpenClaw's materialized `agents.list` RPC.
 * Portal must never reinterpret openclaw.json itself: OpenClaw owns JSON5,
 * $include, environment substitution, profile, state-dir, home, and cwd
 * semantics. The RPC result is the only workspace authority accepted here.
 */
export function selectOpenClawAgentWorkspace(
  rawAgents: unknown,
  rawAgentId: unknown,
): RemoteDesktopAgentWorkspaceSnapshot {
  if (typeof rawAgentId !== 'string' || !rawAgentId.trim()) {
    fail(400, 'INVALID_AGENT', 'An exact Agent workspace identity is required');
  }
  const rawAgentIdentity = rawAgentId.trim();
  if (
    Buffer.byteLength(rawAgentIdentity, 'utf8') > MAX_AGENT_ID_BYTES
    || CONTROL_CHARACTERS.test(rawAgentIdentity)
  ) {
    fail(400, 'INVALID_AGENT', 'The Agent workspace identity is invalid');
  }
  if (!Array.isArray(rawAgents) || rawAgents.length > MAX_AGENT_LIST_ENTRIES) {
    fail(503, 'WORKSPACE_AUTHORITY_UNAVAILABLE', 'The OpenClaw Agent authority is unavailable');
  }

  const requestedAgentId = normalizeOpenClawAgentId(rawAgentIdentity);
  const seenAgentIds = new Set<string>();
  let selected: RemoteDesktopAgentWorkspaceSnapshot | undefined;
  for (const rawEntry of rawAgents) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      fail(503, 'WORKSPACE_AUTHORITY_UNAVAILABLE', 'The OpenClaw Agent authority is unavailable');
    }
    const rawId = (rawEntry as Record<string, unknown>).id;
    if (
      typeof rawId !== 'string'
      || !rawId.trim()
      || Buffer.byteLength(rawId.trim(), 'utf8') > MAX_AGENT_ID_BYTES
      || CONTROL_CHARACTERS.test(rawId)
    ) {
      fail(503, 'WORKSPACE_AUTHORITY_UNAVAILABLE', 'The OpenClaw Agent authority is unavailable');
    }
    const id = normalizeOpenClawAgentId(rawId);
    if (seenAgentIds.has(id)) {
      fail(503, 'WORKSPACE_AUTHORITY_UNAVAILABLE', 'The OpenClaw Agent authority is ambiguous');
    }
    seenAgentIds.add(id);
    if (id !== requestedAgentId) continue;

    const rawWorkspace = (rawEntry as Record<string, unknown>).workspace;
    if (typeof rawWorkspace !== 'string') {
      fail(503, 'WORKSPACE_AUTHORITY_UNAVAILABLE', 'The OpenClaw Agent workspace is unavailable');
    }
    const resolvedWorkspace = rawWorkspace.trim();
    if (
      !resolvedWorkspace
      || Buffer.byteLength(resolvedWorkspace, 'utf8') > MAX_SOURCE_PATH_BYTES
      || CONTROL_CHARACTERS.test(resolvedWorkspace)
      || !path.isAbsolute(resolvedWorkspace)
      || path.resolve(resolvedWorkspace) !== resolvedWorkspace
    ) {
      fail(503, 'WORKSPACE_AUTHORITY_UNAVAILABLE', 'The OpenClaw Agent workspace is invalid');
    }
    selected = { agentId: id, resolvedWorkspace };
  }
  if (!selected) {
    fail(503, 'WORKSPACE_AUTHORITY_UNAVAILABLE', 'The requested OpenClaw Agent is unavailable');
  }
  return selected;
}

function resolveContainedRegularFile(root: string, candidate: string): SourceAdmission {
  const resolvedCandidate = path.resolve(candidate);
  if (!isPathContained(root, resolvedCandidate) || resolvedCandidate === root) {
    fail(403, 'PATH_OUTSIDE_AUTHORITY', 'The file is outside the authorized workspace');
  }
  const relative = path.relative(root, resolvedCandidate).split(path.sep).join('/');
  let sourcePath: string;
  try {
    sourcePath = resolveContainedPath(root, relative, { mustExist: true, kind: 'file' });
  } catch (error: any) {
    if (error instanceof ContainedPathError) {
      if (/does not exist/i.test(error.message)) {
        fail(404, 'FILE_NOT_FOUND', 'The linked file no longer exists');
      }
      if (/Symbolic links/i.test(error.message)) {
        fail(422, 'SYMLINK_REJECTED', 'Linked files cannot pass through symbolic links');
      }
      if (/regular file/i.test(error.message)) {
        fail(422, 'NOT_REGULAR_FILE', 'Only regular files can be opened on Remote Desktop');
      }
      fail(403, 'PATH_OUTSIDE_AUTHORITY', 'The file is outside the authorized workspace');
    }
    if (error?.code === 'ENOENT') fail(404, 'FILE_NOT_FOUND', 'The linked file no longer exists');
    throw error;
  }

  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(sourcePath, { bigint: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') fail(404, 'FILE_NOT_FOUND', 'The linked file no longer exists');
    throw error;
  }
  if (stat.isSymbolicLink()) fail(422, 'SYMLINK_REJECTED', 'Symbolic links cannot be opened on Remote Desktop');
  if (!stat.isFile()) fail(422, 'NOT_REGULAR_FILE', 'Only regular files can be opened on Remote Desktop');
  if (stat.size > BigInt(REMOTE_DESKTOP_OPEN_MAX_FILE_BYTES)) {
    fail(413, 'FILE_TOO_LARGE', 'The linked file is too large to open on Remote Desktop');
  }
  return { sourcePath, sourceName: path.basename(sourcePath), stat };
}

function resolveAgentSource(
  rawPath: string,
  agentId: unknown,
  authority: RemoteDesktopAgentAuthority | undefined,
): SourceAdmission {
  if (typeof agentId !== 'string' || !agentId.trim()) {
    fail(400, 'INVALID_AGENT', 'An exact Agent workspace identity is required');
  }
  if (!authority) {
    fail(403, 'AGENT_AUTHORITY_REQUIRED', 'An authorized Agent workspace is required');
  }
  const requestedAgentId = normalizeOpenClawAgentId(agentId);
  if (
    authority.agentId !== requestedAgentId
    || typeof authority.resolvedWorkspace !== 'string'
    || typeof authority.isCurrent !== 'function'
  ) {
    fail(409, 'AGENT_AUTHORITY_CHANGED', 'The Agent workspace authority changed; reload and try again');
  }

  rejectTraversal(rawPath);
  const root = attestDirectoryRoot(authority.resolvedWorkspace);
  if (root !== authority.resolvedWorkspace) {
    fail(409, 'AGENT_AUTHORITY_CHANGED', 'The Agent workspace authority changed; reload and try again');
  }
  const rootStat = fs.lstatSync(root, { bigint: true });
  const candidate = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(root, rawPath.replace(/^(?:\.\/)+/, ''));
  if (!isPathContained(root, candidate) || root === candidate) {
    fail(403, 'PATH_OUTSIDE_AUTHORITY', 'The file is outside the authorized Agent workspace');
  }
  const admission = resolveContainedRegularFile(root, candidate);
  admission.authorityCheck = async () => {
    let current = false;
    try {
      current = await authority.isCurrent();
    } catch {
      current = false;
    }
    if (!current) {
      fail(409, 'AGENT_AUTHORITY_CHANGED', 'The Agent workspace authority changed; reload and try again');
    }
    const currentRoot = attestDirectoryRoot(authority.resolvedWorkspace);
    const currentStat = fs.lstatSync(currentRoot, { bigint: true });
    if (
      currentRoot !== root
      || currentStat.dev !== rootStat.dev
      || currentStat.ino !== rootStat.ino
      || currentStat.birthtimeNs !== rootStat.birthtimeNs
    ) {
      fail(409, 'AGENT_AUTHORITY_CHANGED', 'The Agent workspace authority changed; reload and try again');
    }
  };
  return admission;
}

function assertExactProjectAuthority(authority: RemoteDesktopProjectAuthority): string {
  if (
    typeof authority.identityId !== 'string'
    || !authority.identityId
    || !Number.isSafeInteger(authority.generation)
    || authority.generation < 1
    || typeof authority.isCurrent !== 'function'
  ) {
    fail(409, 'PROJECT_AUTHORITY_CHANGED', 'The Project authority changed; reload and try again');
  }
  const projectRoot = attestDirectoryRoot(authority.canonicalRoot);
  const stat = fs.lstatSync(projectRoot, { bigint: true });
  if (
    projectRoot !== authority.canonicalRoot
    || stat.dev.toString() !== authority.rootDevice
    || stat.ino.toString() !== authority.rootInode
    || stat.birthtimeNs.toString() !== authority.rootBirthtimeNs
  ) {
    fail(409, 'PROJECT_AUTHORITY_CHANGED', 'The Project authority changed; reload and try again');
  }
  return projectRoot;
}

async function assertCurrentProjectAuthority(authority: RemoteDesktopProjectAuthority): Promise<void> {
  assertExactProjectAuthority(authority);
  if (!await authority.isCurrent()) {
    fail(409, 'PROJECT_AUTHORITY_CHANGED', 'The Project authority changed; reload and try again');
  }
  assertExactProjectAuthority(authority);
}

function resolveProjectSource(
  rawPath: string,
  authority: RemoteDesktopProjectAuthority | undefined,
): SourceAdmission {
  if (!authority) {
    fail(403, 'PROJECT_AUTHORITY_REQUIRED', 'An authorized Project is required');
  }
  const projectRoot = assertExactProjectAuthority(authority);
  rejectTraversal(rawPath);

  let relative: string;
  if (rawPath === '/workspace/project' || rawPath === '/workspace/project/') {
    fail(422, 'NOT_REGULAR_FILE', 'Only regular files can be opened on Remote Desktop');
  } else if (rawPath.startsWith('/workspace/project/')) {
    relative = rawPath.slice('/workspace/project/'.length);
  } else if (path.isAbsolute(rawPath)) {
    const candidate = path.resolve(rawPath);
    if (!isPathContained(projectRoot, candidate) || candidate === projectRoot) {
      fail(403, 'PATH_OUTSIDE_AUTHORITY', 'The file is outside the authorized Project');
    }
    relative = path.relative(projectRoot, candidate).split(path.sep).join('/');
  } else {
    relative = rawPath.replace(/^(?:\.\/)+/, '');
  }
  if (!relative) fail(422, 'NOT_REGULAR_FILE', 'Only regular files can be opened on Remote Desktop');
  const admission = resolveContainedRegularFile(projectRoot, path.join(projectRoot, relative));
  admission.authorityCheck = () => assertCurrentProjectAuthority(authority);
  return admission;
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function resolveDesktopNumericIdentity(options: RemoteDesktopOpenPathOptions): { uid: number; gid: number } {
  if (Number.isSafeInteger(options.desktopUid) && Number.isSafeInteger(options.desktopGid)) {
    return { uid: options.desktopUid!, gid: options.desktopGid! };
  }
  try {
    const uid = Number(execFileSync('/usr/bin/id', ['-u', RD_USER], { encoding: 'utf8' }).trim());
    const gid = Number(execFileSync('/usr/bin/id', ['-g', RD_USER], { encoding: 'utf8' }).trim());
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1 || gid < 1) throw new Error('invalid id');
    return { uid, gid };
  } catch {
    fail(503, 'REMOTE_DESKTOP_UNAVAILABLE', 'The Remote Desktop account is unavailable');
  }
}

function ensureStagingRoot(stagingRoot: string, desktopGid: number): void {
  const resolvedRoot = path.resolve(stagingRoot);
  const parent = path.dirname(resolvedRoot);
  let parentStat: fs.BigIntStats;
  try {
    parentStat = fs.lstatSync(parent, { bigint: true });
  } catch {
    fail(503, 'STAGING_UNAVAILABLE', 'The Remote Desktop handoff parent is unavailable');
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || parentStat.uid !== 0n || (parentStat.mode & 0o022n) !== 0n) {
    fail(503, 'STAGING_UNAVAILABLE', 'The Remote Desktop handoff parent is not trusted');
  }
  if (fs.realpathSync.native(parent) !== parent) {
    fail(503, 'STAGING_UNAVAILABLE', 'The Remote Desktop handoff parent is not canonical');
  }

  try {
    fs.mkdirSync(resolvedRoot, { mode: 0o710 });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const rootStat = fs.lstatSync(resolvedRoot, { bigint: true });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || rootStat.uid !== 0n) {
    fail(503, 'STAGING_UNAVAILABLE', 'The Remote Desktop handoff directory is not trusted');
  }
  fs.chownSync(resolvedRoot, 0, desktopGid);
  fs.chmodSync(resolvedRoot, 0o710);
  const finalStat = fs.lstatSync(resolvedRoot, { bigint: true });
  if (finalStat.uid !== 0n || finalStat.gid !== BigInt(desktopGid) || (finalStat.mode & 0o777n) !== 0o710n) {
    fail(503, 'STAGING_UNAVAILABLE', 'The Remote Desktop handoff directory could not be secured');
  }
}

function removeExactStagingDirectory(directory: string, desktopGid: number): void {
  let directoryStat: fs.BigIntStats;
  try {
    directoryStat = fs.lstatSync(directory, { bigint: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (
    directoryStat.isSymbolicLink()
    || !directoryStat.isDirectory()
    || directoryStat.uid !== 0n
    || directoryStat.gid !== BigInt(desktopGid)
    || (directoryStat.mode & 0o777n) !== 0o750n
  ) {
    fail(503, 'STAGING_INTEGRITY', 'A Remote Desktop handoff entry failed attestation');
  }
  for (const entry of fs.readdirSync(directory)) {
    const entryPath = path.join(directory, entry);
    const stat = fs.lstatSync(entryPath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== 0n) {
      fail(503, 'STAGING_INTEGRITY', 'A Remote Desktop handoff file failed attestation');
    }
    fs.unlinkSync(entryPath);
  }
  fs.rmdirSync(directory);
}

function readReservationBytes(filePath: string): number {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.uid !== 0n
    || stat.gid !== 0n
    || stat.nlink !== 1n
    || (stat.mode & 0o777n) !== 0o400n
    || stat.size > 64n
  ) {
    fail(503, 'STAGING_INTEGRITY', 'A Remote Desktop handoff reservation failed attestation');
  }
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > REMOTE_DESKTOP_OPEN_MAX_FILE_BYTES) {
    fail(503, 'STAGING_INTEGRITY', 'A Remote Desktop handoff reservation is invalid');
  }
  return parsed;
}

function inspectStagingUsage(stagingRoot: string, desktopGid: number, now: number): StagingUsage {
  const admitted: Array<ActiveStagingDirectory & { bytes: number }> = [];
  for (const name of fs.readdirSync(stagingRoot)) {
    if (!REQUEST_DIRECTORY_PATTERN.test(name)) {
      fail(503, 'STAGING_INTEGRITY', 'The Remote Desktop handoff directory contains an unknown entry');
    }
    const directory = path.join(stagingRoot, name);
    const stat = fs.lstatSync(directory, { bigint: true });
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || stat.uid !== 0n
      || stat.gid !== BigInt(desktopGid)
      || (stat.mode & 0o777n) !== 0o750n
    ) {
      fail(503, 'STAGING_INTEGRITY', 'A Remote Desktop handoff entry failed attestation');
    }
    const entries = fs.readdirSync(directory);
    const hasReservation = entries.includes(RESERVATION_FILE);
    if (entries.length > 2 || (!hasReservation && entries.length > 1)) {
      fail(503, 'STAGING_INTEGRITY', 'A Remote Desktop handoff entry has an invalid shape');
    }
    let entryBytes = 0;
    let reservedBytes = 0;
    for (const entry of entries) {
      const entryPath = path.join(directory, entry);
      if (entry === RESERVATION_FILE) {
        reservedBytes = readReservationBytes(entryPath);
        continue;
      }
      const fileStat = fs.lstatSync(entryPath, { bigint: true });
      if (
        fileStat.isSymbolicLink()
        || !fileStat.isFile()
        || fileStat.uid !== 0n
        || fileStat.nlink !== 1n
        || (fileStat.mode & 0o777n) !== 0o440n
        || fileStat.size > BigInt(REMOTE_DESKTOP_OPEN_MAX_FILE_BYTES)
      ) {
        fail(503, 'STAGING_INTEGRITY', 'A Remote Desktop handoff file failed attestation');
      }
      const expectedFinalGid = fileStat.gid === BigInt(desktopGid);
      const expectedInProgressGid = hasReservation && fileStat.gid === 0n;
      if (!expectedFinalGid && !expectedInProgressGid) {
        fail(503, 'STAGING_INTEGRITY', 'A Remote Desktop handoff file failed ownership attestation');
      }
      entryBytes += Number(fileStat.size);
    }
    // A completed handoff has exactly one immutable snapshot. Empty and
    // reservation-only directories are admitted solely so a crash between
    // allocation/copy steps can be retired by the same bounded TTL.
    if (!hasReservation && entries.length > 0) {
      const snapshot = fs.lstatSync(path.join(directory, entries[0]), { bigint: true });
      if (snapshot.gid !== BigInt(desktopGid)) {
        fail(503, 'STAGING_INTEGRITY', 'A completed Remote Desktop handoff has invalid ownership');
      }
    }
    admitted.push({
      directory,
      expiresAt: Number(stat.mtimeMs) + REMOTE_DESKTOP_OPEN_TTL_MS,
      bytes: Math.max(entryBytes, reservedBytes),
    });
  }

  // Validate the entire managed tree before removing anything. An unknown or
  // drifted later entry must never allow a partial best-effort deletion.
  let removed = 0;
  const activeDirectories: ActiveStagingDirectory[] = [];
  let bytes = 0;
  for (const record of admitted) {
    if (now >= record.expiresAt) {
      removeExactStagingDirectory(record.directory, desktopGid);
      removed += 1;
      continue;
    }
    activeDirectories.push({ directory: record.directory, expiresAt: record.expiresAt });
    bytes += record.bytes;
  }
  return {
    count: activeDirectories.length,
    bytes,
    removed,
    activeDirectories,
  };
}

function safeSnapshotName(sourceName: string): string {
  if (sourceName === RESERVATION_FILE) return `file-${sourceName}`;
  if (Buffer.byteLength(sourceName, 'utf8') <= 180) return sourceName;
  const extension = path.extname(sourceName).slice(0, 24);
  return `${crypto.createHash('sha256').update(sourceName).digest('hex').slice(0, 24)}${extension}`;
}

function createReservation(
  stagingRoot: string,
  expectedBytes: number,
  desktopGid: number,
  now: number,
  randomBytes: (size: number) => Buffer,
): string {
  ensureStagingRoot(stagingRoot, desktopGid);
  const usage = inspectStagingUsage(stagingRoot, desktopGid, now);
  if (usage.count >= REMOTE_DESKTOP_OPEN_MAX_ENTRIES
    || usage.bytes + expectedBytes > REMOTE_DESKTOP_OPEN_MAX_TOTAL_BYTES) {
    fail(429, 'STAGING_CAPACITY', 'Remote Desktop file handoff capacity is temporarily full');
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const requestId = randomBytes(16).toString('hex');
    if (!REQUEST_DIRECTORY_PATTERN.test(requestId)) continue;
    const directory = path.join(stagingRoot, requestId);
    try {
      fs.mkdirSync(directory, { mode: 0o750 });
    } catch (error: any) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    fs.chownSync(directory, 0, desktopGid);
    fs.chmodSync(directory, 0o750);
    const reservationPath = path.join(directory, RESERVATION_FILE);
    const reservationFd = fs.openSync(
      reservationPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
      0o400,
    );
    try {
      fs.writeFileSync(reservationFd, String(expectedBytes));
      fs.fsyncSync(reservationFd);
    } finally {
      fs.closeSync(reservationFd);
    }
    fs.chownSync(reservationPath, 0, 0);
    fs.chmodSync(reservationPath, 0o400);
    return directory;
  }
  fail(503, 'STAGING_UNAVAILABLE', 'A Remote Desktop handoff could not be allocated');
}

function classifyLaunch(sourceName: string, sourceMode: bigint, stagedPath: string, line?: number, column?: number) {
  const lowerName = sourceName.toLowerCase();
  const extension = path.extname(lowerName);
  const executable = (sourceMode & 0o111n) !== 0n || extension === '.desktop';
  if (!executable && (TEXT_EXTENSIONS.has(extension) || TEXT_NAMES.has(lowerName) || lowerName.startsWith('.env.'))) {
    const args = ['--disable-server'];
    if (line !== undefined) args.push(`--line=${line}`);
    if (column !== undefined) args.push(`--column=${column}`);
    args.push(stagedPath);
    return { executable: '/usr/bin/mousepad', args };
  }
  if (!executable && IMAGE_EXTENSIONS.has(extension)) {
    return { executable: '/usr/bin/ristretto', args: [stagedPath] };
  }
  if (!executable && extension === '.pdf') {
    return { executable: '/usr/bin/xdg-open', args: [stagedPath] };
  }
  return { executable: '/usr/bin/thunar', args: [stagedPath] };
}

function parseMissingFileLocation(rawPath: string): { path: string; line?: number; column?: number } | null {
  const lineAndColumn = rawPath.match(/^(.*):([1-9]\d{0,7}):(\d{1,8})$/);
  if (lineAndColumn?.[1]) {
    return {
      path: lineAndColumn[1],
      line: Number(lineAndColumn[2]),
      column: Number(lineAndColumn[3]),
    };
  }
  const lineOnly = rawPath.match(/^(.*):([1-9]\d{0,7})$/);
  if (lineOnly?.[1]) {
    return {
      path: lineOnly[1],
      line: Number(lineOnly[2]),
    };
  }
  const anchor = rawPath.match(/^(.*)#L([1-9]\d{0,7})(?:C(\d{1,8}))?$/i);
  if (anchor?.[1]) {
    return {
      path: anchor[1],
      line: Number(anchor[2]),
      column: anchor[3] === undefined ? undefined : Number(anchor[3]),
    };
  }
  return null;
}

async function copyAdmittedFile(admission: SourceAdmission, stagedPath: string): Promise<void> {
  const sourceFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const destinationFlags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0);
  let source: fs.promises.FileHandle | undefined;
  let destination: fs.promises.FileHandle | undefined;
  try {
    source = await fs.promises.open(admission.sourcePath, sourceFlags);
    const openedStat = await source.stat({ bigint: true });
    if (!openedStat.isFile() || !sameFileIdentity(admission.stat, openedStat)) {
      fail(409, 'SOURCE_CHANGED', 'The linked file changed while it was being opened');
    }
    destination = await fs.promises.open(stagedPath, destinationFlags, 0o440);
    const expectedBytes = Number(openedStat.size);
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, Math.max(expectedBytes, 1)));
    let offset = 0;
    while (offset < expectedBytes) {
      const length = Math.min(buffer.length, expectedBytes - offset);
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead < 1) fail(409, 'SOURCE_CHANGED', 'The linked file changed while it was copied');
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, offset + written);
        if (result.bytesWritten < 1) throw new Error('Remote Desktop snapshot write made no progress');
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await destination.sync();
    const settledStat = await source.stat({ bigint: true });
    if (!sameFileIdentity(openedStat, settledStat)) {
      fail(409, 'SOURCE_CHANGED', 'The linked file changed while it was copied');
    }
  } finally {
    await destination?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
  }
}

async function removeReservationDirectory(directory: string, desktopGid: number): Promise<void> {
  await withStagingMutation(() => removeExactStagingDirectory(directory, desktopGid));
}

function scheduleStagingDirectoryCleanup(
  directory: string,
  desktopGid: number,
  delayMs: number,
): void {
  const cleanupTimer = setTimeout(() => {
    void removeReservationDirectory(directory, desktopGid).catch(() => undefined);
  }, Math.max(1, delayMs));
  cleanupTimer.unref?.();
}

async function inspectConfiguredStagingRoot(
  options: RemoteDesktopOpenPathOptions = {},
): Promise<StagingUsage> {
  const stagingRoot = path.resolve(options.stagingRoot || REMOTE_DESKTOP_OPEN_ROOT);
  try {
    fs.lstatSync(stagingRoot);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return { count: 0, bytes: 0, removed: 0, activeDirectories: [] };
    }
    throw error;
  }
  const { gid: desktopGid } = resolveDesktopNumericIdentity(options);
  const now = (options.now || Date.now)();
  return withStagingMutation(() => {
    ensureStagingRoot(stagingRoot, desktopGid);
    return inspectStagingUsage(stagingRoot, desktopGid, now);
  });
}

export async function cleanupRemoteDesktopOpenPathSnapshots(
  options: RemoteDesktopOpenPathOptions = {},
): Promise<{ removed: number; retained: number; retainedBytes: number }> {
  const usage = await inspectConfiguredStagingRoot(options);
  return {
    removed: usage.removed,
    retained: usage.count,
    retainedBytes: usage.bytes,
  };
}

/**
 * Reconcile crash residue at boot and keep a bounded retry sweep alive. Fresh
 * snapshots retain their original one-hour deadline; a backend restart never
 * silently converts an ephemeral handoff into durable sensitive storage.
 */
export async function startRemoteDesktopOpenPathCleanup(): Promise<void> {
  if (stagingCleanupTimer) return;
  stagingCleanupTimer = setInterval(() => {
    void cleanupRemoteDesktopOpenPathSnapshots().catch((error: any) => {
      console.warn(
        '[Remote Desktop] staged file cleanup remains fail-closed:',
        error?.code || error?.name || 'UnknownError',
      );
    });
  }, REMOTE_DESKTOP_OPEN_SWEEP_INTERVAL_MS);
  stagingCleanupTimer.unref?.();

  const usage = await inspectConfiguredStagingRoot();
  if (usage.activeDirectories.length === 0) return;
  const { gid: desktopGid } = resolveDesktopNumericIdentity({});
  const now = Date.now();
  for (const active of usage.activeDirectories) {
    scheduleStagingDirectoryCleanup(
      active.directory,
      desktopGid,
      active.expiresAt - now + 1000,
    );
  }
}

export function stopRemoteDesktopOpenPathCleanup(): void {
  if (stagingCleanupTimer) clearInterval(stagingCleanupTimer);
  stagingCleanupTimer = undefined;
}

export async function openRemoteDesktopPath(
  input: RemoteDesktopOpenPathInput,
  options: RemoteDesktopOpenPathOptions = {},
): Promise<RemoteDesktopOpenPathResult> {
  if (input.source !== 'agent-workspace' && input.source !== 'project') {
    fail(400, 'INVALID_SOURCE', 'The file source is invalid');
  }
  let rawPath = normalizeSourcePath(input.path);
  let line = parseOptionalInteger(input.line, 'line', 1);
  let column = parseOptionalInteger(input.column, 'column', 0);
  const resolveAdmission = (candidate: string) => input.source === 'agent-workspace'
    ? resolveAgentSource(candidate, input.agent, input.agentAuthority)
    : resolveProjectSource(candidate, input.projectAuthority);
  let admission: SourceAdmission;
  try {
    // Linux permits colons and #L fragments in literal filenames. Always try
    // the exact linked path before interpreting an editor-style location.
    admission = resolveAdmission(rawPath);
  } catch (error) {
    const location = error instanceof RemoteDesktopOpenPathError && error.code === 'FILE_NOT_FOUND'
      ? parseMissingFileLocation(rawPath)
      : null;
    if (!location) throw error;
    rawPath = location.path;
    line ??= parseOptionalInteger(location.line, 'line', 1);
    column ??= parseOptionalInteger(location.column, 'column', 0);
    admission = resolveAdmission(rawPath);
  }
  await admission.authorityCheck?.();
  const expectedBytes = Number(admission.stat.size);
  const { gid: desktopGid } = resolveDesktopNumericIdentity(options);
  const stagingRoot = path.resolve(options.stagingRoot || REMOTE_DESKTOP_OPEN_ROOT);
  const now = options.now || Date.now;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const launch = options.launch || desktopExecDetachedArgv;

  const requestDirectory = await withStagingMutation(() => createReservation(
    stagingRoot,
    expectedBytes,
    desktopGid,
    now(),
    randomBytes,
  ));
  const stagedPath = path.join(requestDirectory, safeSnapshotName(admission.sourceName));
  try {
    await options.afterSourceAdmission?.(admission.sourcePath);
    await admission.authorityCheck?.();
    await copyAdmittedFile(admission, stagedPath);
    await admission.authorityCheck?.();
    fs.chownSync(stagedPath, 0, desktopGid);
    fs.chmodSync(stagedPath, 0o440);
    const snapshotStat = fs.lstatSync(stagedPath, { bigint: true });
    if (
      snapshotStat.isSymbolicLink()
      || !snapshotStat.isFile()
      || snapshotStat.uid !== 0n
      || snapshotStat.gid !== BigInt(desktopGid)
      || (snapshotStat.mode & 0o777n) !== 0o440n
      || snapshotStat.size !== admission.stat.size
    ) {
      fail(503, 'STAGING_INTEGRITY', 'The Remote Desktop snapshot failed attestation');
    }
    fs.unlinkSync(path.join(requestDirectory, RESERVATION_FILE));

    const command = classifyLaunch(admission.sourceName, admission.stat.mode, stagedPath, line, column);
    const unitName = `bridgesllm-open-path-${path.basename(requestDirectory)}.service`;
    try {
      launch(command.executable, command.args, unitName);
    } catch {
      fail(503, 'REMOTE_DESKTOP_UNAVAILABLE', 'Remote Desktop did not accept the file viewer');
    }

    scheduleStagingDirectoryCleanup(
      requestDirectory,
      desktopGid,
      REMOTE_DESKTOP_OPEN_TTL_MS + 1000,
    );
    return { ok: true, accepted: true, mode: 'snapshot', targetType: 'file' };
  } catch (error) {
    await removeReservationDirectory(requestDirectory, desktopGid).catch(() => undefined);
    throw error;
  }
}
