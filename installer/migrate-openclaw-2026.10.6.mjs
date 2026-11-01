#!/usr/bin/env node

// Exact OpenClaw 2026.10.6 state custody for public retained-state updates.
//
// retained-2026.9.3 (state16/agent19), retained-2026.9.6 (18/23), and
// retained-2026.9.9 (19/24): snapshot all migration-owned authority before
// package replacement. Rehearse native leased migration and config validation
// on private copies, then migrate stopped authority to state20/agent25 under
// the durable full-state rollback snapshot. No Doctor/config rewrite runs.
// retained-2026.10.5 (20/25) is the immediate predecessor: 10.6 keeps the same
// state20/agent25 ladder (archive-derived), so its native maintenance re-verifies.
// retained-2026.10.6 maintenance requires the already-current20/25 schemas.
// fresh-only admits only the bounded gateway bootstrap, with exact10.6 identity.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const CONTRACT_VERSION = 2;
// Shared with installer/openclaw-migration-transaction.py MIGRATION_MANIFEST_MAX_BYTES.
const MIGRATION_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const REQUIRED_PACKAGE_NAME = 'openclaw';
const REQUIRED_PACKAGE_VERSION = '2026.10.6';
const REQUIRED_PACKAGE_COMMIT = 'fe06181dc5ecc01cf8904abbfc26925925efefbc';
const REQUIRED_NODE_ENGINE = '>=24.22.1 <25 || >=26.12.1';
const RETAINED_SOURCE_COMMITS = Object.freeze({
  '2026.9.3': '1391f7cd2d40ab5bbcf2f5f831d3a64f520e72d7',
  '2026.9.6': 'eb377ac59e6c9fd6c7705028034812becf00271b',
  '2026.9.9': 'bcfc88812a35243893585dbeca87ca41b48272ca',
  '2026.10.5': '1b58cb9a1b4f4353e1add63c8506db4d890962e8',
  '2026.10.6': REQUIRED_PACKAGE_COMMIT,
});
// Exact archive-derived public 9.3 schemas are state16/agent19; 9.6 uses18/23.
// The native 10.5 leased maintenance owner upgrades both to19/24.
const SOURCE_SCHEMAS = Object.freeze({
  'retained-2026.9.3': Object.freeze({ state: 16, agent: 19 }),
  'retained-2026.9.6': Object.freeze({ state: 18, agent: 23 }),
  'retained-2026.9.9': Object.freeze({ state: 19, agent: 24 }),
  'retained-2026.10.5': Object.freeze({ state: 20, agent: 25 }),
  // Archive-derived: 10.6 state (toVersion/supportedVersion 20) and agent
  // (toVersion/targetVersion 25) ladders are identical to 10.5.
  'retained-2026.10.6': Object.freeze({ state: 20, agent: 25 }),
});
const RETAINED_MODES = Object.keys(SOURCE_SCHEMAS);
const STATE_CONTENT_VERSION_KEY = 'state.schema.contentVersion';
const SNAPSHOT_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'];

function fail(message) {
  throw new Error(`OpenClaw ${REQUIRED_PACKAGE_VERSION} migration: ${message}`);
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['preflight', 'snapshot', 'prepare', 'restore', 'commit'].includes(command)) {
    fail('usage: migrate-openclaw-2026.10.6.mjs <preflight|snapshot|prepare|restore|commit> --manifest PATH [--state-dir PATH --config PATH --package-dir PATH] [--gateway-cgroup PATH]');
  }
  const values = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined) fail(`invalid argument: ${flag ?? ''}`);
    const name = flag.slice(2);
    if (!['manifest', 'state-dir', 'config', 'package-dir', 'gateway-cgroup'].includes(name) || values[name] !== undefined) {
      fail(`unsupported or repeated argument: ${flag}`);
    }
    values[name] = value;
  }
  if (!values.manifest) fail('--manifest is required');
  if (['preflight', 'snapshot', 'prepare'].includes(command) && (!values['state-dir'] || !values.config || !values['package-dir'])) {
    fail(`${command} requires --state-dir, --config, and --package-dir`);
  }
  for (const key of ['manifest', 'state-dir', 'config', 'package-dir', 'gateway-cgroup']) {
    const value = values[key];
    if (value !== undefined && (!path.isAbsolute(value) || path.normalize(value) !== value)) {
      fail(`--${key} must be a canonical absolute path`);
    }
  }
  if (values['gateway-cgroup'] !== undefined && command !== 'preflight') fail('--gateway-cgroup is only accepted by preflight');
  return values;
}

function lstatRegularFile(target, label) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file without a symlink: ${target}`);
  return stat;
}

function lstatDirectory(target, label) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a directory without a symlink: ${target}`);
  return stat;
}

function assertNoSymlinkComponents(target, allowMissingLeaf = false) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail(`refusing path through symlink: ${current}`);
    } catch (error) {
      if (error?.code === 'ENOENT' && allowMissingLeaf && index === parts.length - 1) return;
      throw error;
    }
  }
}

function assertSecureParent(target, label) {
  const parent = path.dirname(path.resolve(target));
  assertNoSymlinkComponents(parent);
  const stat = lstatDirectory(parent, `${label} parent`);
  if (stat.uid !== process.getuid()) fail(`${label} parent is not owned by the current user: ${parent}`);
  if ((stat.mode & 0o022) !== 0) fail(`${label} parent is group/world writable: ${parent}`);
  return parent;
}

// Stream through a fixed buffer: a whole-file read fails above Node's 2 GiB
// buffer limit, and retained agent databases and their backups can be larger.
function sha256File(target) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(target, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function sha256Content(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readJson(target, label) {
  lstatRegularFile(target, label);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) fail(`${label} root must be an object`);
  return parsed;
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeExclusive(target, content, mode = 0o600) {
  assertNoSymlinkComponents(target, true);
  const parent = assertSecureParent(target, 'output');
  const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(target, mode);
  fsyncDirectory(parent);
}

function writeAtomic(target, content, mode) {
  assertNoSymlinkComponents(target);
  const parent = assertSecureParent(target, 'atomic output');
  const temporary = path.join(parent, `.${path.basename(target)}.portal-oc99-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  writeExclusive(temporary, content, mode);
  try {
    fs.renameSync(temporary, target);
    fsyncDirectory(parent);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function copyExclusive(source, target, mode) {
  lstatRegularFile(source, 'backup source');
  assertNoSymlinkComponents(target, true);
  const parent = assertSecureParent(target, 'backup');
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const targetFd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const read = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      fs.writeSync(targetFd, buffer, 0, read);
    }
    fs.fsyncSync(targetFd);
  } finally {
    fs.closeSync(sourceFd);
    fs.closeSync(targetFd);
  }
  fs.chmodSync(target, mode);
  fsyncDirectory(parent);
}

function durableBoundary(label) {
  if (process.env.PORTAL_OPENCLAW_MIGRATION_KILL_AT !== label) return;
  process.kill(process.pid, 'SIGKILL');
}

function isSafeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !path.isAbsolute(value)
    && value !== '..'
    && !value.startsWith(`..${path.sep}`)
    && !value.split(path.sep).includes('..');
}

function statePathFromRelative(stateDir, relativePath) {
  if (!isSafeRelativePath(relativePath)) fail(`invalid state-relative path: ${String(relativePath)}`);
  const stateRoot = path.resolve(stateDir);
  const target = path.resolve(stateRoot, relativePath);
  if (target === stateRoot || !target.startsWith(`${stateRoot}${path.sep}`)) {
    fail(`state-relative path escaped the OpenClaw state directory: ${relativePath}`);
  }
  return target;
}

function makeDirectoryTree(target, mode = 0o700) {
  const missing = [];
  let cursor = path.resolve(target);
  while (!fs.existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) fail(`cannot resolve directory creation ancestor: ${target}`);
    cursor = parent;
  }
  assertNoSymlinkComponents(cursor);
  lstatDirectory(cursor, 'directory creation ancestor');
  for (const directory of missing.toReversed()) {
    fs.mkdirSync(directory, { mode: 0o700 });
    fsyncDirectory(path.dirname(directory));
  }
  fs.chmodSync(target, mode);
}

function createSecureDirectoryExclusive(directory) {
  assertNoSymlinkComponents(directory, true);
  const parent = assertSecureParent(directory, 'migration backup');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fsyncDirectory(parent);
}

function listAgentDirectories(stateDir) {
  const agentsDir = path.join(stateDir, 'agents');
  if (!fs.existsSync(agentsDir)) return [];
  assertNoSymlinkComponents(agentsDir);
  lstatDirectory(agentsDir, 'OpenClaw agents directory');
  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => {
      if (entry.isSymbolicLink()) fail(`OpenClaw agent directory is a symlink: ${entry.name}`);
      return entry.isDirectory();
    })
    .map((entry) => entry.name)
    .filter((agentId) => agentId.length > 0 && agentId !== '.' && agentId !== '..')
    .sort();
}

// The 10.6 runtime migrates the shared state database and every agent database
// on its first start. `state` and `devices` are whole roots here (not only their
// SQLite members) so a rollback cannot leave 10.6-only bookkeeping beside the
// restored predecessor databases.
function listManagedAuthorityRoots(stateDir) {
  const roots = ['cron', 'credentials', 'devices', 'identity', 'sessions', 'session-sqlite-migration-runs', 'state'];
  for (const agentId of [...new Set(['main', ...listAgentDirectories(stateDir)])]) {
    roots.push(
      path.join('agents', agentId, 'agent'),
      path.join('agents', agentId, 'sessions'),
      path.join('agents', agentId, 'session-sqlite-import-archive'),
    );
  }
  return roots.sort();
}

function isSqliteFileName(name) {
  return name.endsWith('.sqlite') || SNAPSHOT_SIDECAR_SUFFIXES.some((suffix) => name.endsWith(`.sqlite${suffix}`));
}

function listDirectSqliteFiles(directory, stateDir, results) {
  if (!fs.existsSync(directory)) return;
  assertNoSymlinkComponents(directory);
  lstatDirectory(directory, 'OpenClaw SQLite parent');
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!isSqliteFileName(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) fail(`OpenClaw SQLite path is not a regular file: ${path.join(directory, entry.name)}`);
    results.add(path.relative(stateDir, path.join(directory, entry.name)));
  }
}

function listOpenClawSqliteFiles(stateDir) {
  const results = new Set();
  listDirectSqliteFiles(stateDir, stateDir, results);
  listDirectSqliteFiles(path.join(stateDir, 'state'), stateDir, results);
  for (const agentId of listAgentDirectories(stateDir)) {
    listDirectSqliteFiles(path.join(stateDir, 'agents', agentId, 'agent'), stateDir, results);
  }
  return [...results].sort();
}

function isAgentCredentialRoot(relativeRoot) {
  return /^agents\/[^/]+\/agent$/.test(relativeRoot);
}

// The Codex binary owns its native runtime homes (CODEX_HOME), including the
// disposable command symlinks it creates under tmp/arg0/*. They are preserved in
// place, never copied, replaced, followed or treated as credential authority.
const INDEPENDENT_CODEX_HOME_PATTERNS = [
  ['codex-home'],
  ['harness-auth', 'codex', /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/],
];

function matchIndependentCodexHomePattern(relativeRoot, relativePath) {
  if (!isAgentCredentialRoot(relativeRoot)) return null;
  const prefix = `${relativeRoot}${path.sep}`;
  if (!relativePath.startsWith(prefix)) return null;
  const segments = relativePath.slice(prefix.length).split(path.sep);
  if (segments.some((segment) => segment.length === 0)) return null;
  for (const pattern of INDEPENDENT_CODEX_HOME_PATTERNS) {
    if (segments.length > pattern.length) continue;
    const matched = segments.every((segment, index) => {
      const expected = pattern[index];
      return expected instanceof RegExp ? expected.test(segment) : expected === segment;
    });
    if (matched) return segments.length === pattern.length ? 'home' : 'ancestor';
  }
  return null;
}

function isIndependentCodexHome(relativeRoot, relativePath) {
  return matchIndependentCodexHomePattern(relativeRoot, relativePath) === 'home';
}

function isIndependentCodexHomeAncestor(relativeRoot, relativePath) {
  return matchIndependentCodexHomePattern(relativeRoot, relativePath) === 'ancestor';
}

function assertIndependentCodexHomeBoundary(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) fail(`OpenClaw independent Codex home is a symlink: ${target}`);
  if (!stat.isDirectory()) fail(`OpenClaw independent Codex home is not a directory: ${target}`);
}

function collectAuthorityTree(stateDir, relativeRoot, entries, { hash = true } = {}) {
  const root = statePathFromRelative(stateDir, relativeRoot);
  if (!fs.existsSync(root)) return;
  const credentialTree = relativeRoot === 'credentials' || isAgentCredentialRoot(relativeRoot);
  const walk = (target, relativePath) => {
    if (isIndependentCodexHome(relativeRoot, relativePath)) {
      assertIndependentCodexHomeBoundary(target);
      return;
    }
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fail(`OpenClaw authority contains a symlink: ${target}`);
    if (stat.isDirectory()) {
      if (credentialTree && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) {
        fail('credential authority parent has unsafe ownership or permissions');
      }
      entries.push({ relativePath, kind: 'directory', mode: stat.mode & 0o777 });
      for (const child of fs.readdirSync(target).sort()) {
        walk(path.join(target, child), path.join(relativePath, child));
      }
      return;
    }
    if (!stat.isFile()) fail(`OpenClaw authority contains an unsupported filesystem entry: ${target}`);
    if (stat.uid !== process.getuid() || stat.nlink !== 1) {
      fail(`OpenClaw authority file has unsafe ownership or hard links: ${target}`);
    }
    entries.push({ relativePath, kind: 'file', mode: stat.mode & 0o777, sha256: hash ? sha256File(target) : null, size: stat.size });
  };
  walk(root, relativeRoot);
}

function snapshotAuthority(stateDir, manifestPath) {
  const backupRoot = `${manifestPath}.authority-before`;
  const filesRoot = path.join(backupRoot, 'files');
  createSecureDirectoryExclusive(backupRoot);
  createSecureDirectoryExclusive(filesRoot);
  const managedRoots = listManagedAuthorityRoots(stateDir).map((relativePath) => ({
    relativePath,
    existed: fs.existsSync(statePathFromRelative(stateDir, relativePath)),
  }));
  const entries = [];
  for (const root of managedRoots) {
    if (root.existed) collectAuthorityTree(stateDir, root.relativePath, entries);
  }
  const covered = (relativePath) => managedRoots.some((root) => root.existed
    && (relativePath === root.relativePath || relativePath.startsWith(`${root.relativePath}${path.sep}`)));
  const sqliteRelativePaths = listOpenClawSqliteFiles(stateDir);
  for (const relativePath of sqliteRelativePaths) {
    if (covered(relativePath)) continue;
    const source = statePathFromRelative(stateDir, relativePath);
    const stat = lstatRegularFile(source, 'OpenClaw SQLite file');
    if (stat.uid !== process.getuid() || stat.nlink !== 1) {
      fail(`OpenClaw SQLite file has unsafe ownership or hard links: ${source}`);
    }
    entries.push({ relativePath, kind: 'file', mode: stat.mode & 0o777, sha256: sha256File(source), size: stat.size, sqlite: true });
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const snapshotBytes = entries
    .filter((entry) => entry.kind === 'file')
    .reduce((total, entry) => total + BigInt(entry.size), 0n);
  const filesystem = fs.statfsSync(backupRoot, { bigint: true });
  const availableBytes = filesystem.bavail * filesystem.bsize;
  // One durable backup plus one disposable copied-state preflight, plus 512 MiB
  // for SQLite staging, manifests and filesystem metadata.
  const requiredBytes = (snapshotBytes * 2n) + (512n * 1024n * 1024n);
  if (availableBytes < requiredBytes) {
    fail(`insufficient free space for the OpenClaw state snapshot and copied-state preflight (${String(availableBytes)} < ${String(requiredBytes)} bytes)`);
  }
  let fileIndex = 0;
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    fileIndex += 1;
    const backupPath = path.join(filesRoot, `${String(fileIndex).padStart(6, '0')}.before`);
    const source = statePathFromRelative(stateDir, entry.relativePath);
    copyExclusive(source, backupPath, entry.mode);
    if (sha256File(source) !== entry.sha256 || sha256File(backupPath) !== entry.sha256) {
      fail(`OpenClaw authority changed while being snapshotted: ${source}`);
    }
    entry.backupPath = backupPath;
  }
  // Recheck the whole generation after the last copy: the DB/WAL/SHM members are
  // consistent as a set or the snapshot is refused.
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const source = statePathFromRelative(stateDir, entry.relativePath);
    if (!fs.existsSync(source) || sha256File(source) !== entry.sha256) {
      fail(`OpenClaw authority changed during the snapshot generation: ${source}`);
    }
  }
  const inventorySha256 = sha256Content(JSON.stringify({
    managedRoots, entries, sqliteRelativePaths, snapshotBytes: String(snapshotBytes),
  }));
  fsyncDirectory(filesRoot);
  fsyncDirectory(backupRoot);
  return { backupRoot, managedRoots, entries, sqliteRelativePaths, snapshotBytes: String(snapshotBytes), inventorySha256 };
}

function validateAuthoritySnapshot(snapshot, stateDir, manifestPath) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.managedRoots) || !Array.isArray(snapshot.entries)
    || !Array.isArray(snapshot.sqliteRelativePaths) || typeof snapshot.backupRoot !== 'string'
    || typeof snapshot.inventorySha256 !== 'string' || !/^\d+$/.test(snapshot.snapshotBytes || '')) {
    fail('migration manifest has an invalid authority snapshot');
  }
  const expectedBackupRoot = path.resolve(`${manifestPath}.authority-before`);
  if (path.resolve(snapshot.backupRoot) !== expectedBackupRoot) fail('authority snapshot belongs to another migration generation');
  const inventorySha256 = sha256Content(JSON.stringify({
    managedRoots: snapshot.managedRoots,
    entries: snapshot.entries,
    sqliteRelativePaths: snapshot.sqliteRelativePaths,
    snapshotBytes: snapshot.snapshotBytes,
  }));
  if (inventorySha256 !== snapshot.inventorySha256) fail('authority snapshot inventory hash drifted');
  const rootPaths = new Set();
  for (const root of snapshot.managedRoots) {
    if (!isRecord(root) || !isSafeRelativePath(root.relativePath) || typeof root.existed !== 'boolean'
      || rootPaths.has(root.relativePath)) {
      fail('authority snapshot contains an invalid or duplicate managed root');
    }
    rootPaths.add(root.relativePath);
    statePathFromRelative(stateDir, root.relativePath);
  }
  for (const relativePath of snapshot.sqliteRelativePaths) {
    if (!isSafeRelativePath(relativePath)) fail('authority snapshot contains an invalid SQLite path');
    statePathFromRelative(stateDir, relativePath);
  }
  const seen = new Set();
  for (const entry of snapshot.entries) {
    if (!isRecord(entry) || !isSafeRelativePath(entry.relativePath)
      || !['directory', 'file'].includes(entry.kind) || !Number.isInteger(entry.mode)
      || seen.has(entry.relativePath)) {
      fail('authority snapshot contains an invalid or duplicate entry');
    }
    seen.add(entry.relativePath);
    statePathFromRelative(stateDir, entry.relativePath);
    if (entry.kind === 'file') {
      if (typeof entry.sha256 !== 'string' || typeof entry.backupPath !== 'string') fail('authority snapshot file entry is incomplete');
      const backupPath = path.resolve(entry.backupPath);
      if (path.dirname(backupPath) !== path.join(expectedBackupRoot, 'files')) fail('authority snapshot file escaped the generation backup');
      assertNoSymlinkComponents(backupPath);
      lstatRegularFile(backupPath, 'authority snapshot file');
      if (sha256File(backupPath) !== entry.sha256) fail(`authority snapshot file hash drifted: ${entry.relativePath}`);
    }
  }
  return snapshot;
}

function removeAuthorityPath(target, stateDir) {
  const stateRoot = path.resolve(stateDir);
  const resolved = path.resolve(target);
  if (resolved === stateRoot || !resolved.startsWith(`${stateRoot}${path.sep}`)) fail(`refusing to remove path outside OpenClaw state: ${resolved}`);
  if (!fs.existsSync(resolved)) return;
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) fail(`refusing to remove symlinked OpenClaw authority: ${resolved}`);
  fs.rmSync(resolved, { recursive: stat.isDirectory(), force: false });
  fsyncDirectory(path.dirname(resolved));
}

// Bind mounts can share st_dev with their parent: use mountinfo, not st_dev.
// Keep the mounted directory (and its ancestors) only when the sealed inventory
// requires it. An absent-before root or a mounted file is never cleanup authority.
function authorityMountCustody(snapshot, stateDir) {
  const rootPath = path.resolve(stateDir);
  const affected = (target) => snapshot.managedRoots.some((root) => {
    const managed = statePathFromRelative(rootPath, root.relativePath);
    return target === managed || target.startsWith(`${managed}${path.sep}`);
  }) || snapshot.sqliteRelativePaths.some((relative) => target === statePathFromRelative(rootPath, relative));
  const read = () => fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')
    .map((line) => {
      const fields = line.split(' ');
      const target = fields[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
      return { target, record: line };
    }).filter(({ target }) => target && affected(target)).sort((a, b) => a.target.localeCompare(b.target));
  const mounts = read();
  const entries = new Map(snapshot.entries.map((entry) => [entry.relativePath, entry]));
  const pinned = mounts.map((mount) => {
    const relative = path.relative(rootPath, mount.target);
    if (entries.get(relative)?.kind !== 'directory') fail(`mounted authority is not a sealed directory: ${relative}`);
    assertNoSymlinkComponents(mount.target);
    const stat = lstatDirectory(mount.target, 'mounted authority');
    return { ...mount, dev: stat.dev, ino: stat.ino };
  });
  return {
    keep: (target) => pinned.some((mount) => mount.target === target || mount.target.startsWith(`${target}${path.sep}`)),
    verify: () => {
      if (JSON.stringify(read()) !== JSON.stringify(mounts)) fail('authority mount topology changed during restore');
      for (const mount of pinned) {
        const stat = fs.lstatSync(mount.target);
        if (!stat.isDirectory() || stat.dev !== mount.dev || stat.ino !== mount.ino) fail('authority mount identity changed during restore');
      }
    },
  };
}

function removeManagedAuthorityRoot(stateDir, relativeRoot, custody) {
  const target = statePathFromRelative(stateDir, relativeRoot);
  if (!fs.existsSync(target)) return;
  assertNoSymlinkComponents(target);
  const prune = (current, relativePath) => {
    custody.verify();
    if (isIndependentCodexHome(relativeRoot, relativePath)) {
      assertIndependentCodexHomeBoundary(current);
      return;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail(`refusing to remove symlinked OpenClaw authority: ${current}`);
    if (!stat.isDirectory()) {
      removeAuthorityPath(current, stateDir);
      durableBoundary('authority-entry-removed');
      return;
    }
    for (const child of fs.readdirSync(current).sort()) prune(path.join(current, child), path.join(relativePath, child));
    custody.verify();
    if (!custody.keep(current) && fs.readdirSync(current).length === 0) fs.rmdirSync(current);
    fsyncDirectory(path.dirname(current));
  };
  prune(target, relativeRoot);
}

function materializeAuthoritySnapshot(snapshot, sourceStateDir, targetStateDir, replace = false) {
  validateAuthoritySnapshot(snapshot, sourceStateDir, snapshot.backupRoot.slice(0, -'.authority-before'.length));
  const custody = replace ? authorityMountCustody(snapshot, targetStateDir) : { verify: () => {}, keep: () => false };
  makeDirectoryTree(targetStateDir, 0o700);
  if (replace) {
    // Validate all existing trees before deleting any member; excluded native
    // Codex homes remain outside this authority exactly as before.
    for (const root of snapshot.managedRoots) collectAuthorityTree(targetStateDir, root.relativePath, []);
    for (const root of snapshot.managedRoots) removeManagedAuthorityRoot(targetStateDir, root.relativePath, custody);
    for (const relativePath of listOpenClawSqliteFiles(targetStateDir)) {
      custody.verify();
      removeAuthorityPath(statePathFromRelative(targetStateDir, relativePath), targetStateDir);
    }
  }
  const directories = snapshot.entries
    .filter((entry) => entry.kind === 'directory')
    .sort((left, right) => left.relativePath.split(path.sep).length - right.relativePath.split(path.sep).length);
  for (const entry of directories) makeDirectoryTree(statePathFromRelative(targetStateDir, entry.relativePath), entry.mode);
  for (const entry of snapshot.entries.filter((item) => item.kind === 'file')) {
    custody.verify();
    const target = statePathFromRelative(targetStateDir, entry.relativePath);
    const parent = path.dirname(target);
    if (!fs.existsSync(parent)) makeDirectoryTree(parent, 0o700);
    else {
      assertNoSymlinkComponents(parent);
      lstatDirectory(parent, 'authority materialization parent');
    }
    if (fs.existsSync(target)) {
      if (!replace) fail(`authority materialization target already exists: ${target}`);
      removeAuthorityPath(target, targetStateDir);
    }
    copyExclusive(entry.backupPath, target, entry.mode);
    if (sha256File(target) !== entry.sha256) fail(`authority restore hash mismatch: ${entry.relativePath}`);
    durableBoundary('authority-entry-restored');
  }
  for (const root of snapshot.managedRoots) {
    const target = statePathFromRelative(targetStateDir, root.relativePath);
    if (!root.existed && fs.existsSync(target)) removeManagedAuthorityRoot(targetStateDir, root.relativePath, custody);
  }
  custody.verify();
  fsyncDirectory(targetStateDir);
}

function verifyRestoredAuthority(snapshot, stateDir) {
  const expectedManaged = new Map(snapshot.entries
    .filter((entry) => snapshot.managedRoots.some((root) => root.existed
      && (entry.relativePath === root.relativePath || entry.relativePath.startsWith(`${root.relativePath}${path.sep}`))))
    .map((entry) => [entry.relativePath, entry]));
  const currentManagedEntries = [];
  for (const root of snapshot.managedRoots) {
    const exists = fs.existsSync(statePathFromRelative(stateDir, root.relativePath));
    if (exists !== root.existed) fail(`restored authority root existence mismatch: ${root.relativePath}`);
    if (root.existed) collectAuthorityTree(stateDir, root.relativePath, currentManagedEntries);
  }
  if (currentManagedEntries.length !== expectedManaged.size) fail('restored authority tree contains missing or extra entries');
  for (const current of currentManagedEntries) {
    const expected = expectedManaged.get(current.relativePath);
    if (!expected || current.kind !== expected.kind || current.mode !== expected.mode
      || (current.kind === 'file' && current.sha256 !== expected.sha256)) {
      fail(`restored authority tree mismatch: ${current.relativePath}`);
    }
  }
  for (const entry of snapshot.entries.filter((item) => item.kind === 'file')) {
    const target = statePathFromRelative(stateDir, entry.relativePath);
    if (!fs.existsSync(target) || sha256File(target) !== entry.sha256) fail(`restored authority byte mismatch: ${entry.relativePath}`);
  }
  const expectedSqlite = new Set(snapshot.sqliteRelativePaths);
  for (const relativePath of listOpenClawSqliteFiles(stateDir)) {
    if (!expectedSqlite.has(relativePath)) fail(`rollback left a post-upgrade SQLite file: ${relativePath}`);
  }
}

function removePreflightTree(target) {
  if (!fs.existsSync(target)) return;
  assertNoSymlinkComponents(target);
  const stat = lstatDirectory(target, 'migration preflight directory');
  if (stat.uid !== process.getuid()) fail(`migration preflight directory is not owned by the current user: ${target}`);
  fs.rmSync(target, { recursive: true, force: false });
  fsyncDirectory(path.dirname(target));
}

// Stopping one systemd unit is not proof that another CLI/setup process has
// closed the same WAL/SHM set. Even read-only SQLite connections can rewrite
// SHM. Refuse before snapshot or rollback; never weaken the saved byte checks.
// Holders are named (process, command, cgroup) but never signalled.
function sqliteHolders(stateDir) {
  const identities = new Map(listOpenClawSqliteFiles(stateDir).map((relative) => {
    const stat = fs.statSync(statePathFromRelative(stateDir, relative));
    return [`${stat.dev}:${stat.ino}`, relative];
  }));
  const holders = [];
  if (identities.size === 0) return holders;
  const read = (target) => { try { return fs.readFileSync(target, 'utf8'); } catch { return ''; } };
  for (const pid of fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)) {
    let descriptors;
    try { descriptors = fs.readdirSync(`/proc/${pid}/fd`); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    for (const descriptor of descriptors) {
      let stat;
      try { stat = fs.statSync(`/proc/${pid}/fd/${descriptor}`); }
      catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
      const relativePath = stat.isFile() ? identities.get(`${stat.dev}:${stat.ino}`) : undefined;
      if (relativePath === undefined) continue;
      const cgroup = (read(`/proc/${pid}/cgroup`).split('\n').find((line) => line.startsWith('0::')) || '').slice(3);
      holders.push({ pid: Number(pid), command: read(`/proc/${pid}/comm`).trim().slice(0, 64), cgroup, relativePath });
      break;
    }
  }
  return holders;
}

function describeSqliteHolders(holders) {
  return holders.map((holder) => `process ${holder.pid} (${holder.command || 'unknown'}, cgroup ${holder.cgroup || 'unknown'}) holds ${holder.relativePath}`).join('; ');
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// A short-lived diagnostic started before maintenance began may still finish
// its read; wait a bounded time for holders to exit, then refuse with their
// identities. Long-lived external readers must be paused by their owner.
function assertNoSqliteUsers(stateDir, { exclude = () => false, graceMs = readerGraceMs() } = {}) {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const holders = sqliteHolders(stateDir).filter((holder) => !exclude(holder));
    if (holders.length === 0) return;
    if (Date.now() >= deadline) {
      fail(`OpenClaw SQLite authority is still open: ${describeSqliteHolders(holders)}. Stop or pause that process's service (for example with systemctl stop <unit>) and retry; maintenance never terminates external readers`);
    }
    sleepSync(Math.min(1000, Math.max(1, deadline - Date.now())));
  }
}

function readerGraceMs() {
  const configured = process.env.PORTAL_OPENCLAW_MIGRATION_READER_GRACE_MS;
  if (configured === undefined) return 60_000;
  if (!/^\d{1,6}$/.test(configured)) fail('PORTAL_OPENCLAW_MIGRATION_READER_GRACE_MS must be a millisecond count');
  return Number(configured);
}

// SQLite re-applies the database owner to its WAL when root opens it, which
// moves only ctime. Everything else, including the exact bytes, must hold.
function sqliteFileIdentity(target) {
  if (!fs.existsSync(target)) return null;
  const stat = fs.lstatSync(target, { bigint: true });
  if (!stat.isFile()) fail(`OpenClaw SQLite path is not a regular file: ${target}`);
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, sha256File(target)].join(':');
}

// Once no process holds the authority, let SQLite itself bring every existing
// WAL index (-shm) to its steady state through read-only connections. Read-only
// connections never checkpoint or write the database or WAL; a stale index left
// by an unclean shutdown is rebuilt, and a second read must leave it unchanged.
// The sealed snapshot then still compares every DB/WAL/SHM byte exactly.
function prepareQuiescentSqliteIndexes(stateDir) {
  let prepared = 0;
  for (const relativePath of listOpenClawSqliteFiles(stateDir).filter((name) => name.endsWith('.sqlite'))) {
    const database = statePathFromRelative(stateDir, relativePath);
    const shm = `${database}-shm`;
    if (!fs.existsSync(shm) || fs.existsSync(`${database}-journal`)) continue;
    const before = [database, `${database}-wal`, shm].map((target) => fs.existsSync(target));
    const stable = () => [sqliteFileIdentity(database), sqliteFileIdentity(`${database}-wal`)].join('|');
    const identity = stable();
    const read = () => {
      const connection = new DatabaseSync(database, { readOnly: true });
      try { connection.prepare('SELECT count(*) AS tables FROM sqlite_master').get(); } finally { connection.close(); }
    };
    read();
    const first = sha256File(shm);
    read();
    const after = [database, `${database}-wal`, shm].map((target) => fs.existsSync(target));
    if (stable() !== identity || JSON.stringify(after) !== JSON.stringify(before)) {
      fail(`read-only SQLite preparation changed ${relativePath} or its WAL; refusing to snapshot`);
    }
    if (sha256File(shm) !== first) fail(`the SQLite shared-memory index for ${relativePath} is not stable; another reader may be active`);
    prepared += 1;
  }
  return prepared;
}

function assertGatewayStopped(stateDir) {
  assertNoSqliteUsers(stateDir);
  const testRoot = process.env.PORTAL_OPENCLAW_MIGRATION_TEST_ROOT;
  if (testRoot) {
    const root = fs.realpathSync(testRoot);
    const state = fs.realpathSync(stateDir);
    if (state !== root && !state.startsWith(`${root}${path.sep}`)) fail('test state directory is outside PORTAL_OPENCLAW_MIGRATION_TEST_ROOT');
    return;
  }
  const result = spawnSync('systemctl', ['is-active', '--quiet', 'openclaw-gateway'], { stdio: 'ignore' });
  if (result.status === 0) fail('openclaw-gateway must be stopped before OpenClaw state custody changes');
}

function buildEnvironment(stateDir, configPath) {
  const env = {
    ...process.env,
    HOME: path.dirname(stateDir),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_OAUTH_DIR: path.join(stateDir, 'credentials'),
    OPENCLAW_SUPPRESS_NOTES: '1',
  };
  delete env.OPENCLAW_AGENT_DIR;
  delete env.PI_CODING_AGENT_DIR;
  return env;
}

function packageIdentity(packageDir) {
  assertNoSymlinkComponents(packageDir);
  lstatDirectory(packageDir, 'OpenClaw package');
  const pkg = readJson(path.join(packageDir, 'package.json'), 'OpenClaw package.json');
  const build = readJson(path.join(packageDir, 'dist', 'build-info.json'), 'OpenClaw build-info.json');
  return { name: pkg.name, version: pkg.version, engine: pkg.engines?.node, buildVersion: build.version, commit: build.commit };
}

function validatePackage(packageDir) {
  const identity = packageIdentity(packageDir);
  if (identity.name !== REQUIRED_PACKAGE_NAME || identity.version !== REQUIRED_PACKAGE_VERSION
    || identity.buildVersion !== REQUIRED_PACKAGE_VERSION || identity.commit !== REQUIRED_PACKAGE_COMMIT
    || identity.engine !== REQUIRED_NODE_ENGINE) {
    fail(`package is not the admitted ${REQUIRED_PACKAGE_VERSION} build`);
  }
  const cli = path.join(packageDir, 'openclaw.mjs');
  lstatRegularFile(cli, 'OpenClaw CLI');
  return cli;
}

function assertRetainedSourcePackage(packageDir) {
  const identity = packageIdentity(packageDir);
  if (identity.name !== REQUIRED_PACKAGE_NAME || identity.buildVersion !== identity.version
    || identity.commit !== RETAINED_SOURCE_COMMITS[identity.version]) {
    fail('retained state requires an exact supported 9.3, 9.6, 9.9, 10.5 or 10.6 build');
  }
  return identity;
}

// The agent database registry is relative to the standard state root. A custom
// agentDir would keep authority this custody cannot restore; refuse it. An
// entry's explicit agentDir is admitted only when it is exactly the directory
// native resolution would choose without it: <state>/agents/<id>/agent for a
// canonical lower-case id. Both resolve identically, so custody is unchanged.
function defaultEquivalentAgentDir(stateDir, id, agentDir) {
  return typeof agentDir === 'string'
    && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)
    && path.isAbsolute(agentDir)
    && path.normalize(agentDir) === agentDir
    && agentDir === path.join(stateDir, 'agents', id, 'agent');
}

function assertStandardAgentLayout(config, stateDir) {
  const agents = isRecord(config.agents) ? config.agents : {};
  if ('list' in agents) fail('the retained configuration still carries a legacy agents.list roster');
  if (isRecord(agents.defaults) && agents.defaults.agentDir !== undefined) {
    fail('agents.defaults.agentDir is outside the supported standard state layout');
  }
  for (const [id, entry] of Object.entries(isRecord(agents.entries) ? agents.entries : {})) {
    if (isRecord(entry) && entry.agentDir !== undefined && !defaultEquivalentAgentDir(stateDir, id, entry.agentDir)) {
      fail(`agents.entries.${id}.agentDir is outside the supported standard state layout`);
    }
  }
}

// Read schema versions only from private copies; never open live databases.
function copiedDatabaseVersion(entries, relativePath, preflightRoot, label) {
  const main = entries.find((entry) => entry.kind === 'file' && entry.relativePath === relativePath);
  if (!main) return null;
  const directory = path.join(preflightRoot, 'schema', crypto.randomBytes(8).toString('hex'));
  makeDirectoryTree(directory, 0o700);
  const target = path.join(directory, path.basename(relativePath));
  copyExclusive(main.backupPath, target, 0o600);
  for (const suffix of SNAPSHOT_SIDECAR_SUFFIXES) {
    const sidecar = entries.find((entry) => entry.kind === 'file' && entry.relativePath === `${relativePath}${suffix}`);
    if (sidecar) copyExclusive(sidecar.backupPath, `${target}${suffix}`, 0o600);
  }
  const database = new DatabaseSync(target);
  try {
    const userVersion = Number(database.prepare('PRAGMA user_version').get().user_version);
    let contentVersion = userVersion;
    if (label === 'state') {
      const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state'").get();
      if (table) {
        const row = database.prepare('SELECT value_json FROM config_machine_state WHERE state_key = ?').get(STATE_CONTENT_VERSION_KEY);
        if (row) {
          const recorded = JSON.parse(row.value_json);
          if (!Number.isSafeInteger(recorded) || recorded < 0) fail('retained shared-state content version is invalid');
          contentVersion = Math.max(userVersion, recorded);
        }
      }
    }
    return { userVersion, contentVersion };
  } finally {
    database.close();
  }
}

function assertRetainedSchemas(snapshot, preflightRoot, mode) {
  const expected = SOURCE_SCHEMAS[mode];
  const state = copiedDatabaseVersion(snapshot.entries, path.join('state', 'openclaw.sqlite'), preflightRoot, 'state');
  if (!state) fail('the retained shared-state database is missing');
  if (state.contentVersion !== expected.state) {
    fail(`the retained shared-state schema is ${state.contentVersion}, not the supported ${expected.state}`);
  }
  const agents = {};
  for (const entry of snapshot.entries) {
    const match = /^agents\/([^/]+)\/agent\/((?:incognito-)?openclaw-agent\.sqlite)$/.exec(entry.relativePath);
    if (entry.kind !== 'file' || !match) continue;
    const version = copiedDatabaseVersion(snapshot.entries, entry.relativePath, preflightRoot, 'agent');
    if (version.userVersion !== expected.agent) {
      fail(`agent ${match[1]} database ${match[2]} schema is ${version.userVersion}, not the supported ${expected.agent}`);
    }
    agents[`${match[1]}/${match[2]}`] = version.userVersion;
  }
  return { state: state.contentVersion, agents };
}

// npm installs leave ordinary relative links (node_modules/.bin/*, deduplicated
// packages) inside a plugin payload. The private copy links to the validated
// intra-plugin target using a portable relative path, never source-root-dependent
// link text. Absolute, dangling, escaping and plugin-directory links still refuse.
function pluginPayloadLink(from, source) {
  const parts = path.relative(source, from).split(path.sep);
  const target = fs.readlinkSync(from);
  if (parts.length < 2 || !target || path.isAbsolute(target)) fail(`OpenClaw plugin payload contains a symlink: ${from}`);
  const pluginRoot = fs.realpathSync(path.join(source, parts[0]));
  let resolved;
  try { resolved = fs.realpathSync(from); } catch { fail(`OpenClaw plugin payload link does not resolve: ${from}`); }
  if (!resolved.startsWith(`${pluginRoot}${path.sep}`)) fail(`OpenClaw plugin payload link escapes its plugin: ${from}`);
  // A source-confined link may climb to / and return to the source by name.
  // Keeping that text after relocation would read live state from the rehearsal.
  return path.relative(path.dirname(from), resolved);
}

// With preflightStateDir null this only applies the copy rules and measures.
function copyPluginPayloads(sourceStateDir, preflightStateDir) {
  const source = path.join(sourceStateDir, 'extensions');
  if (!fs.existsSync(source)) return preflightStateDir ? 0 : { files: 0, bytes: 0n };
  assertNoSymlinkComponents(source);
  lstatDirectory(source, 'OpenClaw extensions directory');
  let files = 0;
  let bytes = 0n;
  const walk = (from, to) => {
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) {
      const target = pluginPayloadLink(from, source);
      if (to) fs.symlinkSync(target, to);
      return;
    }
    if (stat.isDirectory()) {
      if (to) makeDirectoryTree(to, stat.mode & 0o755);
      for (const child of fs.readdirSync(from).sort()) walk(path.join(from, child), to && path.join(to, child));
      return;
    }
    if (!stat.isFile()) fail(`OpenClaw plugin payload contains an unsupported entry: ${from}`);
    if (to) copyExclusive(from, to, stat.mode & 0o755);
    files += 1;
    bytes += BigInt(stat.size);
  };
  walk(source, preflightStateDir && path.join(preflightStateDir, 'extensions'));
  return preflightStateDir ? files : { files, bytes };
}

// The copied shared database carries the native installed-plugin index (10.5
// and 10.6 share its writer), which records global plugins under the live
// extensions root. The 10.6 reader then finds one plugin id at its persisted
// live path and at its copied discovery path and refuses a valid configuration.
// Only in the private copy, rebase the native location fields (plugin rows,
// diagnostics, install records) that resolve inside the payload root copied
// above. The mapping is one-to-one, so genuine duplicates still refuse; npm,
// bundled, workspace and external paths, every hash, free text and the
// identity-bound source-admission receipts stay exact.
const PLUGIN_INDEX_PATH_KEYS = new Set(['rootDir', 'source', 'setupSource', 'manifestPath', 'installPath', 'sourcePath']);

function rebaseCopiedPluginIndex(sourceStateDir, preflightStateDir) {
  const database = statePathFromRelative(preflightStateDir, path.join('state', 'openclaw.sqlite'));
  if (!fs.existsSync(database)) return 0;
  const from = path.resolve(sourceStateDir, 'extensions');
  const to = path.resolve(preflightStateDir, 'extensions');
  let rebased = 0;
  const rebase = (value, key) => {
    if (typeof value === 'string') {
      if (!PLUGIN_INDEX_PATH_KEYS.has(key) || !path.isAbsolute(value)) return value;
      const resolved = path.resolve(value);
      if (resolved !== from && !resolved.startsWith(`${from}${path.sep}`)) return value;
      rebased += 1;
      return `${to}${resolved.slice(from.length)}`;
    }
    if (Array.isArray(value)) return value.map((item) => rebase(item));
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value)
      .map(([name, item]) => [name, name === 'sourceAdmissions' ? item : rebase(item, name)]));
  };
  const connection = new DatabaseSync(database);
  try {
    const table = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state'").get();
    if (!table) return 0;
    const row = connection.prepare('SELECT value_json FROM config_machine_state WHERE state_key = ?').get('plugins.installedIndex');
    if (!row || typeof row.value_json !== 'string') return 0;
    // An unreadable index is the reader's own missing/invalid case; leave it.
    let value;
    try { value = JSON.parse(row.value_json); } catch { return 0; }
    const relocated = rebase(value);
    if (rebased > 0) {
      connection.prepare('UPDATE config_machine_state SET value_json = ? WHERE state_key = ?')
        .run(JSON.stringify(relocated), 'plugins.installedIndex');
    }
    return rebased;
  } finally {
    connection.close();
  }
}

// Report setting paths only: upstream validation messages can quote values.
function issuePaths(issues) {
  return issues.map((issue) => (isRecord(issue) && typeof issue.path === 'string'
    && /^[a-zA-Z0-9_.[\]"-]{1,160}$/.test(issue.path) ? issue.path : '<unclassified>'));
}

function runCopiedConfigValidation(cli, snapshot, sourceStateDir, configPath, preflightRoot) {
  const preflightStateDir = path.join(preflightRoot, 'state');
  const preflightConfigPath = path.join(preflightRoot, 'openclaw.json');
  makeDirectoryTree(preflightStateDir, 0o700);
  materializeAuthoritySnapshot(snapshot, sourceStateDir, preflightStateDir, false);
  const pluginFiles = copyPluginPayloads(sourceStateDir, preflightStateDir);
  const pluginIndexReferencesRebased = rebaseCopiedPluginIndex(sourceStateDir, preflightStateDir);
  copyExclusive(configPath, preflightConfigPath, 0o600);
  const result = spawnSync(process.execPath, [cli, 'config', 'validate', '--json'], {
    encoding: 'utf8', env: buildEnvironment(preflightStateDir, preflightConfigPath), maxBuffer: 16 * 1024 * 1024, timeout: 180_000,
  });
  if (result.error) fail(`copied-state config validation could not run: ${result.error.message}`);
  let report;
  try { report = JSON.parse(String(result.stdout || '').trim()); } catch { report = null; }
  if (!isRecord(report)) fail(`copied-state config validation returned no JSON report (exit ${String(result.status)})`);
  const issues = Array.isArray(report.issues) ? report.issues : [];
  if (report.valid !== true || result.status !== 0) {
    const paths = issuePaths(issues);
    fail(`the ${REQUIRED_PACKAGE_VERSION} CLI rejected the retained configuration on a copied state${paths.length ? ` (${paths.join(', ')})` : ''}; nothing was migrated and Doctor was not run`);
  }
  const warnings = [...(Array.isArray(report.warnings) ? report.warnings : []), ...issues];
  return { valid: true, pluginPayloadFiles: pluginFiles, pluginIndexReferencesRebased, warningPaths: issuePaths(warnings) };
}

function assertManifestBytesWithinContract(bytes, manifestPath) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) fail(`migration manifest size is not measurable: ${manifestPath}`);
  if (bytes > MIGRATION_MANIFEST_MAX_BYTES) {
    fail(`migration manifest is ${bytes} bytes, above the ${MIGRATION_MANIFEST_MAX_BYTES}-byte recovery contract (${manifestPath})`);
  }
}

function writeManifest(manifestPath, manifest, replace = false) {
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  assertManifestBytesWithinContract(Buffer.byteLength(content, 'utf8'), manifestPath);
  if (!replace) writeExclusive(manifestPath, content, 0o600);
  else writeAtomic(manifestPath, content, 0o600);
}

function readManifest(manifestPath) {
  assertManifestBytesWithinContract(lstatRegularFile(manifestPath, 'Portal OpenClaw migration manifest').size, manifestPath);
  const manifest = readJson(manifestPath, 'Portal OpenClaw migration manifest');
  if (manifest.contractVersion !== CONTRACT_VERSION || manifest.packageName !== REQUIRED_PACKAGE_NAME
    || manifest.packageVersion !== REQUIRED_PACKAGE_VERSION
    || ![...RETAINED_MODES, 'fresh-only'].includes(manifest.mode)) {
    fail('migration manifest has the wrong contract, package version or mode');
  }
  for (const key of ['generationId', 'manifestPath', 'stateDir', 'configPath', 'packageDir', 'configBackupPath', 'configBeforeSha256', 'phase']) {
    if (typeof manifest[key] !== 'string' || !manifest[key]) fail(`migration manifest is missing ${key}`);
  }
  if (path.resolve(manifest.manifestPath) !== path.resolve(manifestPath)
    || manifest.configPath !== path.join(manifest.stateDir, 'openclaw.json')
    || manifest.configBackupPath !== `${manifestPath}.openclaw.json.before`
    || !Array.isArray(manifest.cronAuthorityFiles) || manifest.cronAuthorityFiles.length !== 0
    || manifest.bootMetadata !== null) {
    fail('migration manifest identity drifted');
  }
  if (!['preparing', 'prepared', 'restored', 'committed'].includes(manifest.state)) {
    fail(`migration manifest has an invalid state: ${String(manifest.state)}`);
  }
  if (RETAINED_MODES.includes(manifest.mode)) {
    validateAuthoritySnapshot(manifest.authoritySnapshot, manifest.stateDir, manifestPath);
  } else if (manifest.authoritySnapshot?.backupRoot !== `${manifestPath}.authority-before`
    || JSON.stringify(manifest.authoritySnapshot?.entries) !== '[]') {
    fail('fresh migration manifest carries retained authority');
  }
  return manifest;
}

function snapshot(args) {
  const source = assertRetainedSourcePackage(args['package-dir']);
  return sealSnapshot(args, `retained-${source.version}`);
}

function treeBytes(root) {
  if (!fs.existsSync(root)) return 0n;
  let bytes = 0n;
  const walk = (target) => {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) for (const child of fs.readdirSync(target)) walk(path.join(target, child));
    else if (stat.isFile()) bytes += BigInt(stat.size);
  };
  walk(root);
  return bytes;
}

function nearestExistingDirectory(target) {
  let cursor = path.resolve(target);
  while (!fs.existsSync(cursor)) cursor = path.dirname(cursor);
  return cursor;
}

// Read-only, while the gateway still runs: every predictable condition the
// stopped snapshot/prepare would refuse is checked first, so a refusal never
// costs a gateway stop. Nothing is hashed, copied, written or signalled.
function preflight(args) {
  const stateDir = args['state-dir'];
  const configPath = args.config;
  const manifestPath = args.manifest;
  if (configPath !== path.join(stateDir, 'openclaw.json')) fail('config path is not the standard state config');
  if (fs.existsSync(manifestPath)) fail('preflight runs only before a migration generation exists');
  assertNoSymlinkComponents(stateDir);
  lstatDirectory(stateDir, 'OpenClaw state directory');
  assertNoSymlinkComponents(configPath);
  const configStat = lstatRegularFile(configPath, 'OpenClaw config');
  if (configStat.uid !== process.getuid() || configStat.nlink !== 1) fail('OpenClaw config is not a single file owned by the current user');
  const source = assertRetainedSourcePackage(args['package-dir']);
  assertStandardAgentLayout(readJson(configPath, 'OpenClaw config'), stateDir);
  const roots = listManagedAuthorityRoots(stateDir).filter((relative) => fs.existsSync(statePathFromRelative(stateDir, relative)));
  const entries = [];
  for (const relative of roots) collectAuthorityTree(stateDir, relative, entries, { hash: false });
  const covered = (relative) => roots.some((root) => relative === root || relative.startsWith(`${root}${path.sep}`));
  for (const relative of listOpenClawSqliteFiles(stateDir)) {
    if (covered(relative)) continue;
    const stat = lstatRegularFile(statePathFromRelative(stateDir, relative), 'OpenClaw SQLite file');
    if (stat.uid !== process.getuid() || stat.nlink !== 1) fail(`OpenClaw SQLite file has unsafe ownership or hard links: ${relative}`);
    entries.push({ kind: 'file', size: stat.size });
  }
  const snapshotBytes = entries.filter((entry) => entry.kind === 'file').reduce((total, entry) => total + BigInt(entry.size), 0n);
  const payload = copyPluginPayloads(stateDir, null);
  // The durable snapshot, its copied-state rehearsal and the payload copy use
  // the manifest filesystem; the stable-plugin rollback copy of the managed
  // npm tree is written beside the state.
  const backupDirectory = nearestExistingDirectory(path.dirname(manifestPath));
  const free = (target) => { const value = fs.statfsSync(target, { bigint: true }); return value.bavail * value.bsize; };
  const backupRequired = (snapshotBytes * 2n) + payload.bytes + (512n * 1024n * 1024n);
  const npmRequired = treeBytes(path.join(stateDir, 'npm'));
  const shared = fs.statSync(backupDirectory).dev === fs.statSync(stateDir).dev;
  const space = shared
    ? [[backupDirectory, backupRequired + npmRequired]]
    : [[backupDirectory, backupRequired], [stateDir, npmRequired]];
  for (const [target, required] of space) {
    const available = free(target);
    if (available < required) {
      fail(`insufficient free space on ${target} for the OpenClaw snapshot, copied-state rehearsal and plugin rollback (${String(available)} < ${String(required)} bytes); nothing was stopped or changed`);
    }
  }
  // The running gateway's own unit may hold its databases; any other holder
  // must be paused by its owner before the gateway is stopped.
  const gatewayCgroup = args['gateway-cgroup'];
  assertNoSqliteUsers(stateDir, {
    exclude: (holder) => gatewayCgroup !== undefined
      && (holder.cgroup === gatewayCgroup || holder.cgroup.startsWith(`${gatewayCgroup}/`)),
  });
  return {
    state: 'preflight-passed', phase: 'preflight', mode: `retained-${source.version}`, generationId: null,
    snapshotBytes: String(snapshotBytes), pluginPayloadFiles: payload.files,
  };
}

function sealSnapshot(args, mode) {
  const stateDir = args['state-dir'];
  const configPath = args.config;
  const packageDir = args['package-dir'];
  const manifestPath = args.manifest;
  if (configPath !== path.join(stateDir, 'openclaw.json')) fail('config path is not the standard state config');
  assertNoSymlinkComponents(stateDir);
  lstatDirectory(stateDir, 'OpenClaw state directory');
  assertNoSymlinkComponents(configPath);
  const configStat = lstatRegularFile(configPath, 'OpenClaw config');
  if (configStat.uid !== process.getuid() || configStat.nlink !== 1) fail('OpenClaw config is not a single file owned by the current user');
  assertGatewayStopped(stateDir);
  if (fs.existsSync(manifestPath)) {
    const existing = readManifest(manifestPath);
    if (existing.mode !== mode || existing.stateDir !== stateDir
      || existing.configPath !== configPath || existing.packageDir !== packageDir) {
      fail('existing migration manifest belongs to different snapshot arguments');
    }
    if (['prepared', 'committed', 'restored'].includes(existing.state)) return existing;
    if (existing.state === 'preparing' && existing.phase === 'snapshot-complete') {
      if (sha256File(configPath) !== existing.configBeforeSha256) fail('config changed after the snapshot');
      verifyRestoredAuthority(existing.authoritySnapshot, stateDir);
      return existing;
    }
    fail(`migration generation is incomplete at ${existing.phase}; restore it before retrying`);
  }
  // retained-2026.9.6 snapshots the exact predecessor before package
  // replacement; retained-2026.10.6 is same-version maintenance.
  const source = assertRetainedSourcePackage(packageDir);
  if (`retained-${source.version}` !== mode) fail('snapshot mode differs from the source package');
  assertSecureParent(manifestPath, 'migration manifest');
  assertStandardAgentLayout(readJson(configPath, 'OpenClaw config'), stateDir);
  const prepared = prepareQuiescentSqliteIndexes(stateDir);
  if (prepared > 0) process.stderr.write(`prepared ${prepared} SQLite shared-memory index(es) read-only before the snapshot\n`);
  assertNoSqliteUsers(stateDir, { graceMs: 0 });
  const configBackupPath = `${manifestPath}.openclaw.json.before`;
  copyExclusive(configPath, configBackupPath, 0o600);
  const configBeforeSha256 = sha256File(configPath);
  if (sha256File(configBackupPath) !== configBeforeSha256) fail('OpenClaw config backup hash mismatch');
  const authoritySnapshot = snapshotAuthority(stateDir, manifestPath);
  if (sha256File(configPath) !== configBeforeSha256) fail('OpenClaw config changed during the authority snapshot');
  const manifest = {
    contractVersion: CONTRACT_VERSION,
    packageName: REQUIRED_PACKAGE_NAME,
    packageVersion: REQUIRED_PACKAGE_VERSION,
    mode,
    sourcePackage: { version: source.version, commit: source.commit },
    state: 'preparing',
    phase: 'snapshot-complete',
    createdAt: new Date().toISOString(),
    generationId: crypto.randomUUID(),
    manifestPath,
    stateDir,
    configPath,
    packageDir,
    configBackupPath,
    configBeforeSha256,
    configMode: configStat.mode & 0o777,
    authoritySnapshot,
    authorityRestoreRequired: true,
    bootMetadata: null,
    cronAuthorityFiles: [],
    preflight: null,
  };
  // Fsynced before the package is replaced or any 10.6 code runs.
  writeManifest(manifestPath, manifest);
  durableBoundary('snapshot-complete');
  return manifest;
}

// These exact exports belong to the admitted npm build, not a discovery/glob
// interface. Run them in a child with the selected state environment established
// before module import; importing against the parent environment is unsafe.
function runNativeAgentMigration(packageDir, stateDir, configPath, snapshot) {
  const nativeModules = {
    'openclaw-agent-db-maintenance-lease-CbW3zwY9.mjs': '32a2a057bc2fb29cbae8ea0e7ace7716d5150266cb53df8150b4babc7b172141',
    'openclaw-agent-db-maintenance-3hQWEmQn.mjs': '07775753bd1b9a454e61fd96354973c4d234c204bd852b2f7e13e5350a99620b',
  };
  for (const [name, digest] of Object.entries(nativeModules)) {
    const filename = path.join(packageDir, 'dist', name);
    assertNoSymlinkComponents(filename);
    lstatRegularFile(filename, 'native migration module');
    if (sha256File(filename) !== digest) fail('native migration module differs from the admitted 10.6 build');
  }
  const targets = snapshot.entries.flatMap((entry) => {
    const match = /^agents\/([^/]+)\/agent\/((?:incognito-)?openclaw-agent\.sqlite)$/.exec(entry.relativePath);
    if (entry.kind !== 'file' || !match) return [];
    const pathname = path.join(stateDir, entry.relativePath);
    assertNoSymlinkComponents(pathname);
    lstatRegularFile(pathname, 'retained agent database');
    return [{ agentId: match[1], pathname }];
  });
  const program = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    import { DatabaseSync } from 'node:sqlite';
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const load = (name) => import(pathToFileURL(path.join(input.packageDir, 'dist', name)).href);
    const { t: withLease } = await load('openclaw-agent-db-maintenance-lease-CbW3zwY9.mjs');
    const { r: migrate, t: assertCurrent } = await load('openclaw-agent-db-maintenance-3hQWEmQn.mjs');
    const migrated = [];
    await withLease({ env: process.env }, async (maintenance) => {
      for (const target of input.targets) {
        maintenance.assertOwned();
        await migrate(target, maintenance);
        const database = new DatabaseSync(target.pathname, { readOnly: true });
        try { assertCurrent(database, target); } finally { database.close(); }
        migrated.push(target.agentId + '/' + path.basename(target.pathname));
      }
      maintenance.assertOwned();
    });
    fs.writeSync(3, JSON.stringify({ version: 25, migrated }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    input: JSON.stringify({ packageDir, targets }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: buildEnvironment(stateDir, configPath), maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000, killSignal: 'SIGKILL',
  });
  // Native diagnostics can include retained data. Do not echo child output.
  if (result.error || result.status !== 0) fail(`native leased agent migration failed (exit ${String(result.status)}); restore the retained snapshot before retrying`);
  let report;
  try { report = JSON.parse(String(result.output[3]).trim()); } catch { report = null; }
  const expected = targets.map((target) => `${target.agentId}/${path.basename(target.pathname)}`);
  if (!isRecord(report) || report.version !== 25 || JSON.stringify(report.migrated) !== JSON.stringify(expected)) {
    fail('native leased agent migration returned an incomplete result; restore before retrying');
  }
  return { owner: 'native-leased-agent-maintenance', version: 25, agents: expected };
}

function prepareRetained(args, existing) {
  if (existing.state !== 'preparing') return existing;
  if (existing.phase !== 'snapshot-complete') fail('retained preparation was interrupted; restore the snapshot before retrying');
  const { stateDir, configPath, manifestPath, authoritySnapshot } = existing;
  if (args['state-dir'] !== stateDir || args.config !== configPath || args['package-dir'] !== existing.packageDir) {
    fail('prepare arguments differ from the sealed snapshot');
  }
  assertGatewayStopped(stateDir);
  const cli = validatePackage(existing.packageDir);
  if (sha256File(configPath) !== existing.configBeforeSha256) fail('config changed after the snapshot; refusing to prepare');
  verifyRestoredAuthority(authoritySnapshot, stateDir);
  const preflightRoot = `${manifestPath}.preflight`;
  if (fs.existsSync(preflightRoot)) removePreflightTree(preflightRoot);
  createSecureDirectoryExclusive(preflightRoot);
  let preflight;
  try {
    const schemas = assertRetainedSchemas(authoritySnapshot, preflightRoot, existing.mode);
    const config = runCopiedConfigValidation(cli, authoritySnapshot, stateDir, configPath, preflightRoot);
    const agentMigration = existing.mode !== 'retained-2026.10.6'
      ? runNativeAgentMigration(existing.packageDir, path.join(preflightRoot, 'state'), path.join(preflightRoot, 'openclaw.json'), authoritySnapshot)
      : null;
    preflight = { schemas, config, agentMigration, doctor: false, liveStateMutated: false };
  } finally {
    removePreflightTree(preflightRoot);
  }
  // Live authority must be byte-identical after the copied-state preflight.
  verifyRestoredAuthority(authoritySnapshot, stateDir);
  if (sha256File(configPath) !== existing.configBeforeSha256) fail('config changed during the copied-state preflight');
  let agentMigration = null;
  if (existing.mode !== 'retained-2026.10.6') {
    assertGatewayStopped(stateDir);
    writeManifest(manifestPath, { ...existing, phase: 'agent-migration-armed', preflight }, true);
    durableBoundary('agent-migration-armed');
    agentMigration = runNativeAgentMigration(existing.packageDir, stateDir, configPath, authoritySnapshot);
    if (sha256File(configPath) !== existing.configBeforeSha256) fail('config changed during native agent migration; restore before retrying');
    durableBoundary('agent-migration-complete');
  }
  const prepared = {
    ...existing,
    state: 'prepared',
    phase: 'prepared',
    preparedAt: new Date().toISOString(),
    configAfterSha256: existing.configBeforeSha256,
    preflight,
    agentMigration,
    liveMigrationOwner: existing.mode !== 'retained-2026.10.6' ? 'native-leased-agent-maintenance' : 'none',
  };
  writeManifest(manifestPath, prepared, true);
  durableBoundary('prepared');
  return prepared;
}

function assertConfigOnlyBootstrapDatabase(filename, configPath) {
  const stat = lstatRegularFile(filename, 'bootstrap SQLite database');
  if ((stat.mode & 0o777) !== 0o600 || stat.size > 16 * 1024 * 1024 || stat.uid !== process.getuid() || stat.nlink !== 1) {
    fail('bootstrap SQLite database metadata is unsafe');
  }
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    // A sanity bound around the 10.5/10.6 schema (132 declared tables); the row checks
    // below are the clean-state proof.
    if (tables.length < 100 || tables.length > 160) fail('bootstrap SQLite schema changed');
    const expected = new Set(['schema_meta', 'config_machine_state', 'config_health_entries', 'diagnostic_events']);
    for (const { name } of tables) {
      if (typeof name !== 'string') fail('bootstrap SQLite table name is unsafe');
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const count = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get().count);
      if (!expected.has(name) && count !== 0) fail(`retained OpenClaw SQLite authority is unsupported: ${name}`);
      if (expected.has(name) && name !== 'schema_meta' && (count < 1 || count > (name === 'diagnostic_events' ? 128 : 2))) {
        fail(`bootstrap SQLite ${name} rows changed`);
      }
    }
    for (const name of expected) {
      if (!tables.some((table) => table.name === name)) fail(`bootstrap SQLite ${name} table is missing`);
    }
    const machineKeys = database.prepare('SELECT state_key, value_json FROM config_machine_state').all();
    for (const row of machineKeys) {
      if (row.state_key === 'config.lastTouchedAt') continue;
      if (row.state_key === STATE_CONTENT_VERSION_KEY && row.value_json === '19') continue;
      fail('bootstrap SQLite machine state changed');
    }
    if (!machineKeys.some((row) => row.state_key === 'config.lastTouchedAt')) fail('bootstrap SQLite machine state changed');
    const health = database.prepare('SELECT config_path FROM config_health_entries').all();
    if (health.length !== 1 || health[0].config_path !== configPath) fail('bootstrap SQLite config health path changed');
    for (const event of database.prepare('SELECT scope, event_key FROM diagnostic_events').all()) {
      if (event.scope === 'config-snapshot' && event.event_key === 'latest') continue;
      if (event.scope === 'config-audit' && typeof event.event_key === 'string'
        && /:config\.write:[0-9a-f-]{36}$/u.test(event.event_key)) continue;
      fail('bootstrap SQLite contains non-config diagnostic authority');
    }
  } finally {
    database.close();
  }
}

// Same clean-install contract as the 9.6 helper: only installer bootstrap
// config, an empty storage scaffold and a config-only native bootstrap exist.
function assertFreshState(stateDir, configPath) {
  assertNoSymlinkComponents(stateDir);
  const stat = lstatDirectory(stateDir, 'state directory');
  if (stat.uid !== process.getuid()) fail('state directory is unsafe');
  const names = fs.readdirSync(stateDir).sort();
  const scaffold = ['agents', 'memory', 'state'];
  const presentScaffold = names.filter((name) => scaffold.includes(name));
  const hasBootstrap = names.includes('config-journal-fingerprint.key') || names.includes('openclaw.json.bak');
  if (hasBootstrap && (!names.includes('config-journal-fingerprint.key')
    || !names.includes('openclaw.json.bak') || !names.includes('state'))) {
    fail('incomplete native config bootstrap is unsupported');
  }
  if (presentScaffold.length && JSON.stringify(presentScaffold) !== JSON.stringify(scaffold)
    && !(hasBootstrap && JSON.stringify(presentScaffold) === '["state"]')) {
    fail('partial OpenClaw storage scaffold is unsupported');
  }
  for (const name of names) {
    if (name === 'openclaw.json' || name === 'config-journal-fingerprint.key' || name === 'openclaw.json.bak') continue;
    if (name !== 'media' && !scaffold.includes(name)) fail(`retained OpenClaw state is unsupported: ${name}`);
    const directory = path.join(stateDir, name);
    assertNoSymlinkComponents(directory);
    const metadata = lstatDirectory(directory, `${name} directory`);
    if (metadata.uid !== process.getuid() || (metadata.mode & 0o022)) fail(`${name} directory is unsafe`);
    if (name === 'state' && hasBootstrap) {
      const members = fs.readdirSync(directory).filter((member) => !SNAPSHOT_SIDECAR_SUFFIXES.some((suffix) => member === `openclaw.sqlite${suffix}`));
      if (JSON.stringify(members) !== '["openclaw.sqlite"]') fail('native config bootstrap state contains extra authority');
      assertConfigOnlyBootstrapDatabase(path.join(directory, 'openclaw.sqlite'), configPath);
    } else if (name !== 'media' && fs.readdirSync(directory).length) {
      fail(`retained OpenClaw state is unsupported: ${name}`);
    }
  }
  if (!names.includes('openclaw.json')) fail('fresh gateway config is missing');
  const config = lstatRegularFile(configPath, 'fresh gateway config');
  if (config.size > 1024 * 1024 || (config.mode & 0o077) !== 0 || config.uid !== process.getuid()) fail('fresh gateway config is unsafe');
  const value = readJson(configPath, 'fresh gateway config');
  if (typeof value.gateway?.auth?.token !== 'string' || !value.gateway.auth.token
    || value.gateway?.auth?.mode !== 'token' || value.gateway?.port !== 18789) {
    fail('fresh gateway config does not match the installer bootstrap contract');
  }
  if (hasBootstrap) {
    const key = lstatRegularFile(path.join(stateDir, 'config-journal-fingerprint.key'), 'config fingerprint key');
    if ((key.mode & 0o777) !== 0o600 || key.size !== 32) fail('config fingerprint key changed');
    const backupPath = path.join(stateDir, 'openclaw.json.bak');
    const backup = lstatRegularFile(backupPath, 'native bootstrap config backup');
    if ((backup.mode & 0o777) !== 0o600 || backup.size > 1024 * 1024) fail('native bootstrap config backup is unsafe');
    const before = readJson(backupPath, 'native bootstrap config backup');
    if (before?.gateway?.port !== 18789 || before?.gateway?.auth?.mode !== 'token'
      || before.gateway.auth.token !== value.gateway.auth.token) {
      fail('native config bootstrap backup does not match the installer gateway');
    }
  }
}

function prepareFresh(args) {
  const stateDir = args['state-dir'];
  const configPath = args.config;
  const packageDir = args['package-dir'];
  const manifestPath = args.manifest;
  if (configPath !== path.join(stateDir, 'openclaw.json')) fail('config path is not the standard state config');
  validatePackage(packageDir);
  assertFreshState(stateDir, configPath);
  assertSecureParent(manifestPath, 'migration manifest');
  const value = {
    contractVersion: CONTRACT_VERSION,
    packageName: REQUIRED_PACKAGE_NAME,
    packageVersion: REQUIRED_PACKAGE_VERSION,
    mode: 'fresh-only',
    state: 'prepared',
    phase: 'prepared',
    createdAt: new Date().toISOString(),
    generationId: crypto.randomUUID(),
    manifestPath,
    stateDir,
    configPath,
    packageDir,
    configBackupPath: `${manifestPath}.openclaw.json.before`,
    configBeforeSha256: sha256File(configPath),
    configAfterSha256: null,
    authoritySnapshot: { backupRoot: `${manifestPath}.authority-before`, entries: [] },
    authorityRestoreRequired: false,
    bootMetadata: null,
    cronAuthorityFiles: [],
  };
  writeManifest(manifestPath, value);
  return value;
}

// Only installer bootstrap names and an empty scaffold can be a clean install;
// anything else is retained runtime state and gets snapshot custody instead.
function freshStateCandidate(stateDir) {
  assertNoSymlinkComponents(stateDir);
  lstatDirectory(stateDir, 'state directory');
  const allowed = new Set(['openclaw.json', 'config-journal-fingerprint.key', 'openclaw.json.bak', 'agents', 'memory', 'state', 'media']);
  const names = fs.readdirSync(stateDir);
  if (names.some((name) => !allowed.has(name))) return false;
  for (const name of ['agents', 'memory']) {
    const directory = path.join(stateDir, name);
    if (fs.existsSync(directory) && fs.lstatSync(directory).isDirectory() && fs.readdirSync(directory).length) return false;
  }
  return true;
}

function prepare(args) {
  const manifestPath = args.manifest;
  if (fs.existsSync(manifestPath)) {
    const existing = readManifest(manifestPath);
    if (RETAINED_MODES.includes(existing.mode)) return prepareRetained(args, existing);
    if (existing.stateDir !== args['state-dir'] || existing.packageDir !== args['package-dir']
      || existing.state !== 'prepared' || sha256File(existing.configPath) !== existing.configBeforeSha256) {
      fail('existing preparation does not match this clean state');
    }
    return existing;
  }
  validatePackage(args['package-dir']);
  if (freshStateCandidate(args['state-dir'])) return prepareFresh(args);
  return prepareRetained(args, sealSnapshot(args, 'retained-2026.10.6'));
}

function restore(args) {
  const manifestPath = args.manifest;
  let manifest = readManifest(manifestPath);
  if (manifest.state === 'restored') {
    if (RETAINED_MODES.includes(manifest.mode)) {
      if (sha256File(manifest.configPath) !== manifest.configBeforeSha256) fail('restored config changed after rollback');
      verifyRestoredAuthority(manifest.authoritySnapshot, manifest.stateDir);
    }
    return manifest;
  }
  if (!['preparing', 'prepared'].includes(manifest.state)) fail(`cannot restore migration in state ${String(manifest.state)}`);
  if (manifest.mode === 'fresh-only') {
    // This helper never mutated state. The outer fresh-install rollback owns
    // removal of its newly created config, package, plugins and gateway unit.
    manifest = { ...manifest, state: 'restored', phase: 'restored', restoredAt: new Date().toISOString() };
    writeManifest(manifestPath, manifest, true);
    return manifest;
  }
  assertGatewayStopped(manifest.stateDir);
  lstatRegularFile(manifest.configPath, 'OpenClaw config');
  lstatRegularFile(manifest.configBackupPath, 'OpenClaw config backup');
  if (sha256File(manifest.configBackupPath) !== manifest.configBeforeSha256) {
    fail('OpenClaw config backup hash no longer matches the migration manifest');
  }
  // Inner plugin/bridge layers restore their own config writes first. A config
  // that still differs from the snapshot is a change this custody cannot
  // attribute; refuse rather than silently overwrite it.
  if (manifest.phase !== 'restore-armed' && manifest.phase !== 'authority-restored'
    && sha256File(manifest.configPath) !== manifest.configBeforeSha256) {
    fail('OpenClaw config changed after the snapshot; refusing automatic overwrite during rollback');
  }
  // After a 10.6 start the databases are migrated (19/24) and may hold writes
  // accepted inside the fenced window: they are replaced as a matched set.
  manifest = { ...manifest, phase: 'restore-armed', restoreArmedAt: manifest.restoreArmedAt ?? new Date().toISOString() };
  writeManifest(manifestPath, manifest, true);
  durableBoundary('restore-armed');
  materializeAuthoritySnapshot(manifest.authoritySnapshot, manifest.stateDir, manifest.stateDir, true);
  removePreflightTree(`${manifestPath}.preflight`);
  manifest = { ...manifest, phase: 'authority-restored' };
  writeManifest(manifestPath, manifest, true);
  durableBoundary('authority-restored');
  if (sha256File(manifest.configPath) !== manifest.configBeforeSha256) {
    writeAtomic(manifest.configPath, fs.readFileSync(manifest.configBackupPath, 'utf8'), manifest.configMode);
  }
  if (sha256File(manifest.configPath) !== manifest.configBeforeSha256) fail('OpenClaw config restore hash mismatch');
  verifyRestoredAuthority(manifest.authoritySnapshot, manifest.stateDir);
  manifest = { ...manifest, phase: 'config-restored' };
  writeManifest(manifestPath, manifest, true);
  durableBoundary('config-restored');
  const restored = { ...manifest, state: 'restored', phase: 'restored', restoredAt: new Date().toISOString(), exactAuthorityRestore: true };
  writeManifest(manifestPath, restored, true);
  durableBoundary('restored');
  return restored;
}

function commit(args) {
  const manifestPath = args.manifest;
  const manifest = readManifest(manifestPath);
  if (manifest.state === 'committed') {
    if (sha256File(manifest.configPath) !== manifest.finalConfigSha256) fail('committed config changed after migration commit');
    return manifest;
  }
  if (manifest.state !== 'prepared') fail(`cannot commit migration in state ${String(manifest.state)}`);
  lstatRegularFile(manifest.configPath, 'OpenClaw config');
  const armed = { ...manifest, phase: 'commit-armed', finalConfigSha256: sha256File(manifest.configPath) };
  writeManifest(manifestPath, armed, true);
  durableBoundary('commit-armed');
  const committed = { ...armed, state: 'committed', phase: 'committed', committedAt: new Date().toISOString() };
  writeManifest(manifestPath, committed, true);
  durableBoundary('committed');
  return committed;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = args.command === 'preflight' ? preflight(args)
    : args.command === 'snapshot' ? snapshot(args)
      : args.command === 'prepare' ? prepare(args)
        : args.command === 'restore' ? restore(args) : commit(args);
  const measured = args.command === 'preflight'
    ? { snapshotBytes: result.snapshotBytes, pluginPayloadFiles: result.pluginPayloadFiles } : {};
  process.stdout.write(`${JSON.stringify({ state: result.state, phase: result.phase, mode: result.mode, generationId: result.generationId, ...measured })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
