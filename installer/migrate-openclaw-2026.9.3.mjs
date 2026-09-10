#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const CONTRACT_VERSION = 2;
const REQUIRED_PACKAGE_NAME = 'openclaw';
const REQUIRED_PACKAGE_VERSION = '2026.9.3';
const AGENT_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/i;
const CRON_LEGACY_REPAIR_SHA256 = '25837476017e1909270fc20835c7a5ac05a836aa7a7c2a7399faf5f586cb4d60';
const CRON_RUNTIME_POLICY_SHA256 = 'c709e49cfd85b6e111e2a708d8fbfb8af4b5f0d6ddf0d9b3783ef892b7ee04a8';
const SHARED_STATE_SCHEMA_REPAIR_SHA256 = '2412f313b3d3c01c499714d1566c9e5602c9b13a224bd5f9e55482a463fa8145';
const SNAPSHOT_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'];

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function blockedKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['snapshot', 'prepare', 'restore', 'commit'].includes(command)) {
    fail('usage: migrate-openclaw-2026.9.3.mjs <snapshot|prepare|restore|commit> --manifest PATH [--state-dir PATH --config PATH --package-dir PATH]');
  }
  const values = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined) fail(`invalid argument: ${flag ?? ''}`);
    const name = flag.slice(2);
    if (!['manifest', 'state-dir', 'config', 'package-dir'].includes(name) || values[name] !== undefined) {
      fail(`unsupported or repeated argument: ${flag}`);
    }
    values[name] = value;
  }
  if (!values.manifest) fail('--manifest is required');
  if (['snapshot', 'prepare'].includes(command) && (!values['state-dir'] || !values.config || !values['package-dir'])) {
    fail('prepare requires --state-dir, --config, and --package-dir');
  }
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

function sha256File(target) {
  return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
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
  const temporary = path.join(parent, `.${path.basename(target)}.portal-oc91-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
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
    // Filesystem discovery must not silently omit an older or externally
    // created agent merely because its id exceeds the current config schema.
    .filter((agentId) => agentId.length > 0 && agentId !== '.' && agentId !== '..')
    .sort();
}

function listManagedAuthorityRoots(stateDir) {
  const roots = ['cron', 'sessions', 'session-sqlite-migration-runs', 'identity', 'credentials'];
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
// disposable command symlinks it creates under tmp/arg0/* and its plugin clones
// under .tmp/*. Two such homes live inside an agent credential root:
//   agents/<id>/agent/codex-home                       (plugin-managed home)
//   agents/<id>/agent/harness-auth/codex/<binding-id>  (harness auth binding home)
// The pinned auth importer never reads or writes either of them. They are
// neither copied into the auth rehearsal nor replaced during credential
// rollback; their bytes, link targets and inodes are preserved in place. Every
// other path inside the credential root, including siblings under harness-auth,
// keeps the strict no-symlink snapshot contract.
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

// harness-auth and harness-auth/codex are ordinary snapshot directories that can
// hold independent homes beneath them; rollback must descend instead of
// removing them wholesale.
function isIndependentCodexHomeAncestor(relativeRoot, relativePath) {
  return matchIndependentCodexHomePattern(relativeRoot, relativePath) === 'ancestor';
}

// An independent home is skipped, never followed, opened, or altered. The skip
// is only defined for a real directory in that position; a symlink or plain
// file there is an ambiguous shape and is refused before any snapshot arms.
function assertIndependentCodexHomeBoundary(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) fail(`OpenClaw independent Codex home is a symlink: ${target}`);
  if (!stat.isDirectory()) fail(`OpenClaw independent Codex home is not a directory: ${target}`);
}

function collectAuthorityTree(stateDir, relativeRoot, entries) {
  const root = statePathFromRelative(stateDir, relativeRoot);
  if (!fs.existsSync(root)) return;
  const credentialTree = relativeRoot === 'credentials'
    || isAgentCredentialRoot(relativeRoot);
  const walk = (target, relativePath) => {
    if (isIndependentCodexHome(relativeRoot, relativePath)) {
      assertIndependentCodexHomeBoundary(target);
      return;
    }
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fail(`OpenClaw authority contains a symlink: ${target}`);
    if (stat.isDirectory()) {
      // Refuse insecure auth parents before a snapshot can arm rollback. A
      // preflight refusal must not attempt reconstruction into an unsafe owner.
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
    entries.push({
      relativePath,
      kind: 'file',
      mode: stat.mode & 0o777,
      sha256: sha256File(target),
      size: stat.size,
    });
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
    entries.push({
      relativePath,
      kind: 'file',
      mode: stat.mode & 0o777,
      sha256: sha256File(source),
      size: stat.size,
      sqlite: true,
    });
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const snapshotBytes = entries
    .filter((entry) => entry.kind === 'file')
    .reduce((total, entry) => total + BigInt(entry.size), 0n);
  const filesystem = fs.statfsSync(backupRoot, { bigint: true });
  const availableBytes = filesystem.bavail * filesystem.bsize;
  // One durable backup plus one disposable copied-state rehearsal must fit
  // before the live target can be mutated. Keep an additional 512 MiB for
  // SQLite staging/manifests and filesystem metadata.
  const requiredBytes = (snapshotBytes * 2n) + (512n * 1024n * 1024n);
  if (availableBytes < requiredBytes) {
    fail(`insufficient free space for OpenClaw migration snapshot and copied-state preflight (${String(availableBytes)} < ${String(requiredBytes)} bytes)`);
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
  // Recheck the complete generation after the last copy. This makes the
  // snapshot WAL-aware as a set: a writer cannot change an earlier DB/WAL/SHM
  // member while a later member is copied without invalidating the snapshot.
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const source = statePathFromRelative(stateDir, entry.relativePath);
    if (!fs.existsSync(source) || sha256File(source) !== entry.sha256) {
      fail(`OpenClaw authority changed during the snapshot generation: ${source}`);
    }
  }
  const inventorySha256 = sha256Content(JSON.stringify({
    managedRoots,
    entries,
    sqliteRelativePaths,
    snapshotBytes: String(snapshotBytes),
  }));
  fsyncDirectory(filesRoot);
  fsyncDirectory(backupRoot);
  return {
    backupRoot,
    managedRoots,
    entries,
    sqliteRelativePaths,
    snapshotBytes: String(snapshotBytes),
    inventorySha256,
  };
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
      if (!backupPath.startsWith(`${expectedBackupRoot}${path.sep}`)) fail('authority snapshot file escaped the generation backup');
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

function removeManagedAuthorityRoot(stateDir, relativeRoot) {
  const target = statePathFromRelative(stateDir, relativeRoot);
  if (!isAgentCredentialRoot(relativeRoot) || !fs.existsSync(target)) {
    removeAuthorityPath(target, stateDir);
    return;
  }
  assertNoSymlinkComponents(target);
  lstatDirectory(target, 'credential rollback owner');
  // Do not move, unlink, chmod, recreate or follow an independent runtime.
  // Preserve its directory inode and every byte/link even during cold rollback.
  // Directories that may hold one (harness-auth, harness-auth/codex) are
  // emptied entry by entry so the preserved home keeps its exact ancestors.
  const prune = (directory, relativeDirectory) => {
    for (const child of fs.readdirSync(directory)) {
      const relativePath = path.join(relativeDirectory, child);
      const childTarget = statePathFromRelative(stateDir, relativePath);
      if (isIndependentCodexHome(relativeRoot, relativePath)) {
        assertIndependentCodexHomeBoundary(childTarget);
        continue;
      }
      if (isIndependentCodexHomeAncestor(relativeRoot, relativePath)
        && !fs.lstatSync(childTarget).isSymbolicLink()
        && fs.lstatSync(childTarget).isDirectory()) {
        prune(childTarget, relativePath);
        continue;
      }
      removeAuthorityPath(childTarget, stateDir);
    }
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    fsyncDirectory(path.dirname(directory));
  };
  prune(target, relativeRoot);
}

function materializeAuthoritySnapshot(snapshot, sourceStateDir, targetStateDir, replace = false) {
  validateAuthoritySnapshot(snapshot, sourceStateDir, `${snapshot.backupRoot.slice(0, -'.authority-before'.length)}`);
  makeDirectoryTree(targetStateDir, 0o700);
  if (replace) {
    for (const root of snapshot.managedRoots) {
      removeManagedAuthorityRoot(targetStateDir, root.relativePath);
    }
    for (const relativePath of listOpenClawSqliteFiles(targetStateDir)) {
      removeAuthorityPath(statePathFromRelative(targetStateDir, relativePath), targetStateDir);
    }
  }
  const directories = snapshot.entries
    .filter((entry) => entry.kind === 'directory')
    .sort((left, right) => left.relativePath.split(path.sep).length - right.relativePath.split(path.sep).length);
  for (const entry of directories) {
    const target = statePathFromRelative(targetStateDir, entry.relativePath);
    makeDirectoryTree(target, entry.mode);
  }
  for (const entry of snapshot.entries.filter((item) => item.kind === 'file')) {
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
  }
  for (const root of snapshot.managedRoots) {
    const target = statePathFromRelative(targetStateDir, root.relativePath);
    if (!root.existed && fs.existsSync(target)) removeManagedAuthorityRoot(targetStateDir, root.relativePath);
  }
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
  const expectedFiles = new Map(snapshot.entries
    .filter((entry) => entry.kind === 'file')
    .map((entry) => [entry.relativePath, entry.sha256]));
  for (const [relativePath, expectedSha256] of expectedFiles) {
    const target = statePathFromRelative(stateDir, relativePath);
    if (!fs.existsSync(target) || sha256File(target) !== expectedSha256) fail(`restored authority byte mismatch: ${relativePath}`);
  }
  const expectedSqlite = new Set(snapshot.sqliteRelativePaths);
  for (const relativePath of listOpenClawSqliteFiles(stateDir)) {
    if (!expectedSqlite.has(relativePath)) fail(`rollback left a post-upgrade SQLite file: ${relativePath}`);
  }
}

function collectAuthorityFingerprint(stateDir) {
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
  for (const relativePath of listOpenClawSqliteFiles(stateDir)) {
    if (covered(relativePath)) continue;
    const target = statePathFromRelative(stateDir, relativePath);
    const stat = lstatRegularFile(target, 'OpenClaw SQLite fingerprint file');
    if (stat.uid !== process.getuid() || stat.nlink !== 1) {
      fail(`OpenClaw SQLite fingerprint target has unsafe ownership or hard links: ${target}`);
    }
    entries.push({
      relativePath,
      kind: 'file',
      mode: stat.mode & 0o777,
      sha256: sha256File(target),
      size: stat.size,
      sqlite: true,
    });
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { managedRoots, entries };
}

function fingerprintAuthority(stateDir) {
  return sha256Content(JSON.stringify(collectAuthorityFingerprint(stateDir)));
}

// SQLite page/WAL layout is not application authority. A committed plugin-index
// write followed by its exact rollback can change it. Keep the byte guard as the
// fast path; only a newly sealed prepared generation can use this fallback.
// Read private copies (never live read connections, which can alter WAL/SHM).
// OpenClaw memory databases contain vec0 virtual tables. Reading them through
// plain SQLite loses the module and cannot prove their contents. Load only the
// exact upstream 0.1.9 Linux extension, copied to private staging after checking
// its immutable bytes; never load an extension named by a database or config.
function stageQualifiedSqliteVec(packageDir, temporary) {
  if (!packageDir || process.platform !== 'linux') return null;
  const identities = {
    x64: { size: 159816, sha256: '5923730861b86c707cca5602b5f91092f9e52a46706dbc6e269fd4bb9c4498e8' },
    arm64: { size: 156520, sha256: '0b84cbd06418ca3040827deddd650539be05be0f657952426b926c8606217437' },
  };
  const identity = identities[process.arch];
  if (!identity) return null;
  const packageName = `sqlite-vec-linux-${process.arch}`;
  const candidates = [
    path.join(packageDir, 'node_modules', packageName, 'vec0.so'),
    path.join(path.dirname(packageDir), packageName, 'vec0.so'),
  ];
  for (const candidate of candidates) {
    let observed;
    try { observed = fs.lstatSync(candidate); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    assertSecureParent(candidate, 'SQLite vector extension');
    if (!observed.isFile() || observed.isSymbolicLink()) fail('SQLite vector extension is not a regular file');
    const fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes;
    try {
      const stat = fs.fstatSync(fd);
      if (stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0
        || stat.size !== identity.size || stat.dev !== observed.dev || stat.ino !== observed.ino) {
        fail('SQLite vector extension has unsafe ownership, permissions, size, or identity');
      }
      bytes = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
    if (bytes.length !== identity.size || sha256Content(bytes) !== identity.sha256) {
      fail('SQLite vector extension differs from the qualified upstream artifact');
    }
    const target = path.join(temporary, 'vec0.so');
    writeExclusive(target, bytes, 0o500);
    return { path: target, sha256: identity.sha256 };
  }
  return null;
}

function fingerprintAuthorityContents(stateDir, configPath = null, receiptPath = null, packageDir = null) {
  const generation = collectAuthorityFingerprint(stateDir);
  const physical = sha256Content(JSON.stringify(generation));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-sqlite-authority-'));
  fs.chmodSync(temporary, 0o700);
  const databases = [];
  const ignored = new Set();
  try {
    for (const entry of generation.entries) {
      if (entry.kind !== 'file' || !entry.relativePath.endsWith('.sqlite')) continue;
      const source = statePathFromRelative(stateDir, entry.relativePath);
      const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const header = Buffer.alloc(16);
      try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
      // Non-SQLite authority remains byte-exact, including any adjacent files.
      if (!header.equals(Buffer.from('SQLite format 3\0'))) continue;
      const target = path.join(temporary, String(databases.length) + '.sqlite');
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
      for (const suffix of SNAPSHOT_SIDECAR_SUFFIXES) {
        const sidecar = generation.entries.find((candidate) =>
          candidate.relativePath === entry.relativePath + suffix);
        if (!sidecar) continue;
        if (sidecar.kind !== 'file' || (sidecar.mode & ~entry.mode) !== 0
          || (suffix === '-journal' && sidecar.size !== 0)) {
          fail('SQLite authority has unsafe sidecar permissions or an unresolved journal');
        }
        fs.copyFileSync(statePathFromRelative(stateDir, sidecar.relativePath),
          target + suffix, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target + suffix, 0o600);
        ignored.add(sidecar.relativePath);
      }
      databases.push({ target, relativePath: entry.relativePath });
    }
    const sqliteVec = stageQualifiedSqliteVec(packageDir, temporary);
    const result = spawnSync('python3', ['-c', String.raw`
import hashlib, json, re, sqlite3, struct, sys
from pathlib import Path
def encode(value):
    if value is None: return ["null"]
    if isinstance(value, int): return ["integer", str(value)]
    if isinstance(value, float): return ["real", struct.pack(">d", value).hex()]
    if isinstance(value, bytes): return ["blob", value.hex()]
    if isinstance(value, str): return ["text", value]
    raise ValueError("unsupported SQLite value")
def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()
def identifier(name):
    return '"' + name.replace('"', '""') + '"'
request = json.load(sys.stdin)
digests = []
bookkeeping = []
for database in request["databases"]:
    filename = database["target"]
    connection = sqlite3.connect(Path(filename).as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        extension = request.get("sqliteVec")
        if extension:
            extension_path = Path(extension["path"])
            if hashlib.sha256(extension_path.read_bytes()).hexdigest() != extension["sha256"]:
                raise ValueError("SQLite vector extension changed after staging")
            connection.enable_load_extension(True)
            try:
                connection.load_extension(str(extension_path))
            finally:
                connection.enable_load_extension(False)
            if connection.execute("SELECT vec_version()").fetchone() != ("v0.1.9",):
                raise ValueError("unqualified SQLite vector extension version")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        if list(connection.execute("PRAGMA quick_check")) != [("ok",)]:
            raise ValueError("invalid SQLite authority")
        schema = list(connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name,tbl_name,sql"))
        without_rowid = {row[1]: bool(row[4]) for row in connection.execute("PRAGMA table_list")}
        tables = []
        table_names = {row[1] for row in schema if row[0] == "table"}
        primary_columns = {row[1] for row in connection.execute("PRAGMA table_info(schema_meta)")} if "schema_meta" in table_names else set()
        primary = connection.execute("SELECT role,schema_version,agent_id,app_version FROM schema_meta WHERE meta_key='primary'").fetchone() if request.get("configPath") is not None and {"role", "schema_version", "agent_id", "app_version", "meta_key"} <= primary_columns else None
        # These are generated config-observation receipts, not config, plugin
        # policy, messages or sessions. Only the pinned shared/global database
        # and exact authored config path can use this separate fallback.
        receipts_allowed = (request.get("configPath") is not None
            and database["relativePath"] == "state/openclaw.sqlite"
            and connection.execute("PRAGMA user_version").fetchone() == (16,)
            and primary == ("global", 16, None, "2026.9.3"))
        def generated_receipt(name, values):
            if not receipts_allowed: return None
            if name == "config_machine_state" and values.get("state_key") == "config.lastTouchedAt":
                timestamp = json.loads(values["value_json"])
                if not isinstance(timestamp, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", timestamp):
                    raise ValueError("invalid machine config timestamp")
                return "omit"
            if name == "config_health_entries" and values.get("config_path") != request["configPath"]:
                return "health-observed-at"
            if name == "config_health_entries" and values.get("config_path") == request["configPath"]:
                for key in ("last_known_good_json", "last_promoted_good_json"):
                    if values.get(key) is not None and not isinstance(json.loads(values[key]), dict):
                        raise ValueError("invalid config health receipt")
                return "omit"
            if name == "diagnostic_events" and values.get("scope") in ("config-audit", "config-snapshot"):
                payload = json.loads(values["payload_json"])
                if not isinstance(payload, dict) or payload.get("configPath") != request["configPath"]: return None
                if values["scope"] == "config-audit":
                    if payload.get("source") != "config-io" or payload.get("event") not in ("config.write", "config.observe", "config.external"): return None
                elif set(payload) != {"configPath", "rawHash", "fingerprintedAuthoredConfig"}: return None
                return "omit"
            if name == "schema_meta" and values.get("meta_key") == "state-migrations":
                if (values.get("role"), values.get("schema_version"), values.get("agent_id")) != ("global", 3, None): return None
                cursor = values.get("app_version")
                if not isinstance(cursor, str) or not re.fullmatch(r"2026\.9\.3\n3\n\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n[A-Za-z0-9_-]{43}\n[A-Za-z0-9_-]{43}\n[a-f0-9]{64}", cursor):
                    raise ValueError("unqualified runtime migration receipt")
                return "omit"
            return None
        for name, in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            column_info = list(connection.execute("PRAGMA table_xinfo(" + identifier(name) + ")"))
            names = [row[1] for row in column_info if row[6] != 1]
            columns = {row[1].lower() for row in column_info}
            projection = "*"
            has_rowid = not without_rowid[name]
            if has_rowid:
                alias = next((key for key in ("rowid", "_rowid_", "oid") if key not in columns), None)
                if alias is None: raise ValueError("unobservable SQLite row identity")
                projection = alias + ",*"
            rows = []
            for row in connection.execute("SELECT " + projection + " FROM " + identifier(name)):
                values = dict(zip(names, row[1:] if has_rowid else row))
                kind = generated_receipt(name, values)
                if kind:
                    bookkeeping.append([database["relativePath"], name, [encode(value) for value in row]])
                    if kind == "omit": continue
                    row = list(row)
                    row[names.index("updated_at_ms") + int(has_rowid)] = None
                rows.append(digest([encode(value) for value in row]))
            rows.sort()
            tables.append([name, len(rows), digest(rows)])
        metadata = [(key, connection.execute("PRAGMA " + key).fetchone()[0])
                    for key in ("user_version", "application_id", "encoding")]
        digests.append(digest([metadata, schema, tables]))
    finally:
        connection.close()
print(json.dumps({"digests": digests, "bookkeeping": bookkeeping}))
`], {
      input: JSON.stringify({ databases, configPath, sqliteVec }),
      encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) fail('unable to verify SQLite authority contents');
    const { digests, bookkeeping } = JSON.parse(result.stdout);
    if (!Array.isArray(digests) || digests.length !== databases.length
      || digests.some((digest) => !/^[a-f0-9]{64}$/.test(digest))) {
      fail('invalid SQLite authority content receipt');
    }
    if (fingerprintAuthority(stateDir) !== physical) {
      fail('OpenClaw authority changed while verifying SQLite contents');
    }
    if (receiptPath !== null) {
      // Preserve generated observation history before rollback replaces the
      // database. The root-only evidence is never emitted in command output.
      const receiptContent = JSON.stringify({ schema: 1, configPath, records: bookkeeping }) + '\n';
      assertNoSymlinkComponents(receiptPath, true);
      let existing;
      try { existing = fs.lstatSync(receiptPath); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (existing) {
        if (!existing.isFile() || existing.uid !== process.getuid() || existing.nlink !== 1
          || (existing.mode & 0o777) !== 0o600 || fs.readFileSync(receiptPath, 'utf8') !== receiptContent) {
          fail('existing runtime bookkeeping evidence differs from this rollback');
        }
      } else {
        writeExclusive(receiptPath, receiptContent, 0o600);
      }
    }
    const contentHashes = new Map(databases.map((entry, index) => [entry.relativePath, digests[index]]));
    return sha256Content(JSON.stringify({
      managedRoots: generation.managedRoots,
      entries: generation.entries.filter((entry) => !ignored.has(entry.relativePath)).map((entry) => {
        if (!contentHashes.has(entry.relativePath)) return entry;
        const { size, sha256, ...identity } = entry;
        return { ...identity, sqliteContentsSha256: contentHashes.get(entry.relativePath) };
      }),
    }));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function normalizeAgentId(value) {
  return String(value).trim().toLowerCase();
}

async function withMigrationEnvironment(env, operation) {
  const keys = ['HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'OPENCLAW_OAUTH_DIR', 'OPENCLAW_SUPPRESS_NOTES'];
  const prior = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    return await operation();
  } finally {
    for (const key of keys) {
      const value = prior.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function migrateAgentRoster(config, actions) {
  if (config.agents === undefined) return;
  if (!isRecord(config.agents)) fail('agents must be an object');
  const agents = config.agents;
  const ownsList = Object.prototype.hasOwnProperty.call(agents, 'list');
  const ownsEntries = Object.prototype.hasOwnProperty.call(agents, 'entries');
  if (ownsList && ownsEntries) fail('agents.list and agents.entries are both present; refusing an ambiguous roster migration');
  if (ownsEntries) {
    if (!isRecord(agents.entries)) fail('agents.entries must be an object');
    if (Object.keys(agents.entries).length === 0) {
      if (agents.ownership === 'explicit') return;
      agents.entries = { main: {} };
      actions.push('materialized-implicit-main-agent');
      return;
    }
    let markedDefaults = 0;
    let consumedDefaultMarkers = 0;
    for (const [agentId, entry] of Object.entries(agents.entries)) {
      if (!AGENT_ID_PATTERN.test(agentId) || blockedKey(agentId) || !isRecord(entry)) {
        fail(`agents.entries contains an invalid entry: ${agentId}`);
      }
      if (Object.prototype.hasOwnProperty.call(entry, 'id')) fail(`agents.entries.${agentId} still contains the retired id field`);
      if (Object.prototype.hasOwnProperty.call(entry, 'default')) {
        if (typeof entry.default !== 'boolean') {
          fail(`agents.entries.${agentId}.default must be a boolean legacy marker`);
        }
        if (entry.default === true) markedDefaults += 1;
        delete entry.default;
        consumedDefaultMarkers += 1;
      }
    }
    if (markedDefaults > 1) fail(`agents.entries contains ${markedDefaults} legacy default agents`);
    if (Object.keys(agents.entries).length > 1 && markedDefaults === 0 && agents.ownership !== 'explicit') {
      fail('multi-agent entries roster has no legacy default and no agents.ownership="explicit" marker');
    }
    if (consumedDefaultMarkers > 0) actions.push('removed-agents.entries-default-markers');
    return;
  }
  if (ownsList && !Array.isArray(agents.list)) fail('agents.list must be an array');
  // Legacy 7.1 resolves both an omitted list and [] to the implicit main
  // agent. Preserve that behavior without creating explicit owners.
  if (!ownsList || agents.list.length === 0) {
    if (ownsList) {
      delete agents.list;
      actions.push('removed-empty-agents.list');
    }
    if (agents.ownership === 'explicit') return;
    agents.entries = { main: {} };
    actions.push('materialized-implicit-main-agent');
    return;
  }
  const entries = Object.create(null);
  const normalizedIds = new Set();
  let markedDefaults = 0;
  for (const rawEntry of agents.list) {
    if (!isRecord(rawEntry)) fail('agents.list contains a non-object entry');
    const id = typeof rawEntry.id === 'string' ? rawEntry.id.trim() : '';
    const normalized = normalizeAgentId(id);
    if (!id || !AGENT_ID_PATTERN.test(id) || blockedKey(id)) fail(`agents.list contains an invalid id: ${id || '<missing>'}`);
    if (normalizedIds.has(normalized)) fail(`agents.list contains duplicate normalized id: ${normalized}`);
    normalizedIds.add(normalized);
    if (Object.prototype.hasOwnProperty.call(rawEntry, 'default')) {
      if (typeof rawEntry.default !== 'boolean') fail(`agents.list.${id}.default must be a boolean legacy marker`);
      if (rawEntry.default === true) markedDefaults += 1;
    }
    const { id: ignored, default: ignoredDefault, ...entry } = rawEntry;
    entries[id] = entry;
  }
  if (markedDefaults > 1) fail(`agents.list contains ${markedDefaults} default agents`);
  if (Object.keys(entries).length > 1 && markedDefaults === 0 && agents.ownership !== 'explicit') {
    fail('multi-agent roster has no default and no agents.ownership="explicit" marker');
  }
  agents.entries = entries;
  delete agents.list;
  actions.push('agents.list->agents.entries');
}

function removeRetiredCliBackends(config, actions) {
  const defaults = config.agents?.defaults;
  if (!isRecord(defaults) || !Object.prototype.hasOwnProperty.call(defaults, 'cliBackends')) return;
  if (!isRecord(defaults.cliBackends)) fail('agents.defaults.cliBackends has an unsupported shape');
  delete defaults.cliBackends;
  actions.push('removed-agents.defaults.cliBackends');
}

function removeRetiredCodexTimeouts(config, actions) {
  const appServer = config.plugins?.entries?.codex?.config?.appServer;
  if (appServer === undefined) return;
  if (!isRecord(appServer)) fail('Codex appServer settings must be an object');
  for (const key of ['turnCompletionIdleTimeoutMs', 'postToolRawAssistantCompletionIdleTimeoutMs']) {
    if (Object.prototype.hasOwnProperty.call(appServer, key)) {
      delete appServer[key];
      actions.push(`removed-plugins.entries.codex.config.appServer.${key}`);
    }
  }
}

function removeOpenProseReferences(config, actions) {
  const plugins = config.plugins;
  if (!isRecord(plugins)) return;
  if (isRecord(plugins.entries) && Object.prototype.hasOwnProperty.call(plugins.entries, 'open-prose')) {
    delete plugins.entries['open-prose'];
    actions.push('removed-plugins.entries.open-prose');
  }
  for (const key of ['allow', 'deny']) {
    if (plugins[key] === undefined) continue;
    if (!Array.isArray(plugins[key]) || !plugins[key].every((value) => typeof value === 'string')) {
      fail(`plugins.${key} has an unsupported shape`);
    }
    const filtered = plugins[key].filter((value) => value !== 'open-prose');
    if (filtered.length !== plugins[key].length) {
      plugins[key] = filtered;
      actions.push(`removed-open-prose-from-plugins.${key}`);
    }
  }
}

function removeRetiredMetadata(config, actions) {
  if (!isRecord(config.meta) || !Object.prototype.hasOwnProperty.call(config.meta, 'lastTouchedAt')) return;
  if (typeof config.meta.lastTouchedAt !== 'string') fail('meta.lastTouchedAt has an unsupported shape');
  delete config.meta.lastTouchedAt;
  actions.push('removed-meta.lastTouchedAt');
}

function inspectLegacyCodexRefs(value, location = '$', hits = []) {
  if (typeof value === 'string') {
    if (/^(?:codex|openai-codex)\//i.test(value.trim())) hits.push(location);
    return hits;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectLegacyCodexRefs(entry, `${location}[${index}]`, hits));
    return hits;
  }
  if (!isRecord(value)) return hits;
  for (const [key, entry] of Object.entries(value)) {
    if (blockedKey(key)) fail(`blocked object key found at ${location}`);
    if (/^(?:codex|openai-codex)\//i.test(key.trim())) hits.push(`${location}.${key}`);
    inspectLegacyCodexRefs(entry, `${location}.${key}`, hits);
  }
  return hits;
}

async function loadCodexRouteContract(packageDir) {
  // OpenClaw exposes no targeted CLI for the 9.1 Codex config/session-route
  // rewrite. The only public wrapper is the broad Doctor repair mode, which Portal is
  // prohibited from invoking. Keep this narrow private import package-pinned;
  // session SQLite itself always goes through the supported subcommands below.
  const distDir = path.join(packageDir, 'dist');
  assertNoSymlinkComponents(distDir);
  lstatDirectory(distDir, 'OpenClaw dist directory');
  const candidates = fs.readdirSync(distDir)
    .filter((entry) => /^codex-route-warnings-[A-Za-z0-9_-]+\.m?js$/.test(entry))
    .filter((entry) => fs.readFileSync(path.join(distDir, entry), 'utf8').includes('maybeRepairCodexRoutes as r'));
  if (candidates.length !== 1) fail(`expected one OpenClaw Codex route contract bundle, found ${candidates.length}`);
  const target = path.join(distDir, candidates[0]);
  lstatRegularFile(target, 'OpenClaw Codex route contract');
  const module = await import(pathToFileURL(target).href);
  if (typeof module.r !== 'function' || typeof module.a !== 'function') {
    fail('OpenClaw Codex route contract exports are missing');
  }
  return {
    repairConfig: module.r,
    repairSessions: module.a,
  };
}

async function migrateSharedStateSchema(packageDir, env) {
  const databasePath = path.join(env.OPENCLAW_STATE_DIR, 'state', 'openclaw.sqlite');
  if (!fs.existsSync(databasePath)) return { changes: 0, migrations: [] };
  assertNoSymlinkComponents(databasePath);
  const databaseStat = lstatRegularFile(databasePath, 'OpenClaw shared state database');
  if (databaseStat.uid !== process.getuid() || databaseStat.nlink !== 1
    || (databaseStat.mode & 0o022) !== 0) {
    fail('OpenClaw shared state database has unsafe ownership, links, or permissions');
  }
  // The 7.1 shared registry/audit schema cannot be opened by the 9.1 CLI.
  // Use only upstream's hash-pinned SQLite schema migration, never the broad
  // Doctor repair/config flow. The caller owns a stopped-writer snapshot and
  // arms rollback before this function can mutate live state.
  const distDir = path.join(packageDir, 'dist');
  assertNoSymlinkComponents(distDir);
  lstatDirectory(distDir, 'OpenClaw dist directory');
  const fixturePackage = process.env.PORTAL_OPENCLAW_MIGRATION_TEST_PACKAGE_DIR
    && path.resolve(packageDir) === path.resolve(process.env.PORTAL_OPENCLAW_MIGRATION_TEST_PACKAGE_DIR);
  const fixtureHash = process.env.PORTAL_OPENCLAW_TEST_STATE_SCHEMA_SHA256 || '';
  const expectedHash = fixturePackage && /^[a-f0-9]{64}$/.test(fixtureHash)
    ? fixtureHash : SHARED_STATE_SCHEMA_REPAIR_SHA256;
  const candidates = fs.readdirSync(distDir)
    .filter((entry) => /^openclaw-state-db-[A-Za-z0-9_-]+\.m?js$/.test(entry))
    .filter((entry) => {
      const target = path.join(distDir, entry);
      lstatRegularFile(target, 'OpenClaw shared state schema bundle');
      return sha256File(target) === expectedHash
        && fs.readFileSync(target, 'utf8').includes('repairOpenClawStateDatabaseSchemaIfNeeded as s');
    });
  if (candidates.length !== 1) fail('expected one hash-pinned OpenClaw shared state schema bundle');
  const contract = await import(pathToFileURL(path.join(distDir, candidates[0])).href);
  if (typeof contract.s !== 'function' || typeof contract.O !== 'function') {
    fail('OpenClaw shared state schema contract exports are missing');
  }
  return withMigrationEnvironment(env, async () => {
    const options = { path: databasePath, env };
    const before = contract.O(options);
    if (!Array.isArray(before) || before.some((entry) => !isRecord(entry) || typeof entry.kind !== 'string')) {
      fail('OpenClaw shared state schema inspection returned an invalid result');
    }
    const result = await contract.s(options);
    if (!isRecord(result) || !Array.isArray(result.changes)
      || !Array.isArray(result.warnings) || result.warnings.length > 0) {
      fail('OpenClaw shared state schema migration could not prove a canonical database');
    }
    const remaining = contract.O(options);
    if (!Array.isArray(remaining) || remaining.length > 0) {
      fail('OpenClaw shared state schema migration left pending transitions');
    }
    return { changes: result.changes.length, migrations: before.map((entry) => entry.kind) };
  });
}


// OpenClaw 9.3 no longer imports credential JSON at ordinary CLI startup.
// Invoke only its pinned auth-store importer, never the general Doctor repair.
// All candidate owners must be inside the stopped-writer authority snapshot;
// copied-state rehearsal cannot resolve configured paths back into live state.
async function migrateAuthProfileStores(packageDir, config, env, sourceStateDir = env.OPENCLAW_STATE_DIR) {
  const stateDir = path.resolve(env.OPENCLAW_STATE_DIR);
  const sourceRoot = path.resolve(sourceStateDir);
  const cfg = structuredClone(config);
  for (const [id, entry] of Object.entries(cfg.agents?.entries ?? {})) {
    if (!isRecord(entry) || entry.agentDir === undefined) continue;
    if (typeof entry.agentDir !== 'string') fail('invalid auth owner directory');
    const configured = entry.agentDir.startsWith('~/')
      ? path.join(path.dirname(sourceRoot), entry.agentDir.slice(2)) : path.resolve(entry.agentDir);
    const expected = path.join(sourceRoot, 'agents', id, 'agent');
    if (configured !== expected) fail('custom auth owner is outside the snapshotted conventional agent directory');
    entry.agentDir = path.join(stateDir, 'agents', id, 'agent');
  }
  const agentIds = [...new Set(['main', ...listAgentDirectories(stateDir), ...Object.keys(cfg.agents?.entries ?? {})])];
  if (agentIds.some((id) => !isSafeRelativePath(id) || id.includes(path.sep) || id === '.')) {
    fail('invalid conventional auth owner id');
  }
  const sourcePaths = [
    path.join(stateDir, 'credentials', 'oauth.json'),
    ...agentIds.flatMap((id) => ['auth-profiles.json', 'auth-state.json', 'auth.json']
      .map((name) => path.join(stateDir, 'agents', id, 'agent', name))),
  ];
  // lstat, not existsSync: dangling links are never treated as missing input.
  let sourceCount = 0;
  const emptyProfileSources = new Map();
  const emptyProfileStub = (target) => {
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || before.size > 4096) return null;
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      if (before.ino !== after.ino || before.dev !== after.dev || before.ctimeMs !== after.ctimeMs
        || before.size !== after.size) fail('empty auth stub changed during inspection');
      let value;
      try { value = JSON.parse(bytes.toString('utf8')); } catch { return null; }
      // Reject duplicate keys or discarded payloads, not merely JSON.parse's last value.
      const compact = bytes.toString('utf8').replace(/\s/g, '');
      if (!['{"version":2,"profiles":{}}', '{"profiles":{},"version":2}'].includes(compact)) return null;
      if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'profiles,version'
        || value.version !== 2 || !isRecord(value.profiles) || Object.keys(value.profiles).length !== 0) return null;
      return { sha256: sha256Content(bytes), dev: before.dev, ino: before.ino, ctimeMs: before.ctimeMs, mode: before.mode };
    } finally { fs.closeSync(fd); }
  };
  for (const target of sourcePaths) {
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assertNoSymlinkComponents(target);
    let parent = path.dirname(target);
    while (parent === stateDir || parent.startsWith(`${stateDir}${path.sep}`)) {
      const owner = lstatDirectory(parent, 'credential authority parent');
      if (owner.uid !== process.getuid() || (owner.mode & 0o022) !== 0) {
        fail('credential authority parent has unsafe ownership or permissions');
      }
      parent = path.dirname(parent);
    }
    const fileMode = stat.mode & 0o777;
    const directParent = lstatDirectory(path.dirname(target), 'legacy credential owner');
    // Earlier OpenClaw writes auth profiles as 0644 inside its root-only 0700
    // agent directory. The private directory is the read boundary; retain that
    // exact legacy layout without opening it or rewriting the original file.
    const privateLegacyFile = fileMode === 0o644 && (directParent.mode & 0o777) === 0o700;
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1
      || ((fileMode & 0o077) !== 0 && !privateLegacyFile)) {
      fail('legacy auth input has unsafe ownership, links, or permissions');
    }
    sourceCount += 1;
    // Older integrations may leave this empty v2 stub after SQLite migration.
    // It carries neither credentials nor state; validate its permissions first
    // and never infer authentication from it or erase it to manufacture a pass.
    if (path.basename(target) === 'auth-profiles.json') {
      const identity = emptyProfileStub(target);
      if (identity) emptyProfileSources.set(target, {
        identity,
        priorArchives: new Set(fs.readdirSync(path.dirname(target))),
      });
    }
  }
  if (sourceCount === emptyProfileSources.size) return { sources: 0, changes: 0 };
  const distDir = path.join(packageDir, 'dist');
  const select = (prefix, expectedHash, marker) => {
    const candidates = fs.readdirSync(distDir).filter((name) => name.startsWith(prefix) && /\.m?js$/.test(name))
      .filter((name) => {
        const target = path.join(distDir, name);
        lstatRegularFile(target, 'auth migration implementation');
        return sha256File(target) === expectedHash && fs.readFileSync(target, 'utf8').includes(marker);
      });
    if (candidates.length !== 1) fail('expected one exact hash-pinned OpenClaw auth migration contract');
    return path.join(distDir, candidates[0]);
  };
  const migrationPath = select('doctor-auth-flat-profiles-', '79261e66ac596f6d4d6ba5927bedcafde434b07ca47da9bf491313195af49e35',
    'maybeMigrateAuthProfileJsonStoresToSqlite as n');
  const pathsPath = select('doctor-auth-legacy-paths-', 'da658202ed37bfc4791949c9488479098c2956fab0eb39a6ac7b6da6ee37b757',
    'listAuthProfileRepairCandidates as t');
  const databasePath = select('openclaw-agent-db-', '66353da03e50995d3a5d269cf5fe4d93be48243cc9c2aecfaefba1120c9e1375',
    'closeOpenClawAgentDatabasesAsync as E');
  return withMigrationEnvironment(env, async () => {
    const database = await import(pathToFileURL(databasePath).href);
    if (typeof database.E !== 'function') fail('auth migration handle-settlement export is missing');
    const contract = await import(pathToFileURL(migrationPath).href);
    const paths = await import(pathToFileURL(pathsPath).href);
    if (typeof contract.n !== 'function' || typeof paths.t !== 'function') fail('auth migration exports are missing');
    const candidates = paths.t(cfg, env);
    if (!Array.isArray(candidates)) fail('auth migration candidate inventory is invalid');
    const allowed = new Set(agentIds.map((id) => path.join(stateDir, 'agents', id, 'agent', 'auth-profiles.json')));
    for (const candidate of candidates) {
      if (!isRecord(candidate) || !allowed.has(candidate.authPath)) {
        // An absent conventional owner is harmless only if it has no files to
        // import. Refuse it here rather than letting upstream create unowned state.
        fail('auth migration candidate escaped the snapshotted agent owners');
      }
    }
    const beforeConfig = JSON.stringify(cfg);
    let result;
    try {
      result = await contract.n({ cfg, env, prompter: { confirmAutoFix: async () => true } });
    } finally {
      // The upstream importer holds a process-local writer lease. Settle its
      // own handles before sealing authority; never ignore or delete lease rows.
      await database.E(stateDir);
    }
    const allowedEmptyWarnings = new Set();
    const unchangedEmptySources = new Set();
    const displayPaths = (target) => {
      const home = path.resolve(env.HOME);
      return [target, ...(target.startsWith(`${home}${path.sep}`) ? [`~${target.slice(home.length)}`] : [])];
    };
    for (const [target, prior] of emptyProfileSources) {
      if (fs.existsSync(target)) {
        const current = emptyProfileStub(target);
        if (!current || JSON.stringify(current) !== JSON.stringify(prior.identity)) {
          fail('empty auth stub changed during credential migration');
        }
        unchangedEmptySources.add(target);
        for (const display of displayPaths(target)) {
          allowedEmptyWarnings.add(`Left auth profile JSON in place for ${display} because no importable auth profiles or state were found.`);
        }
      } else {
        // With real credentials in another owner, the pinned upstream importer
        // may archive the empty stub. Accept its warning only after separately
        // verifying that exact empty input in one new, private-parent archive.
        const archives = fs.readdirSync(path.dirname(target))
          .filter((name) => name.startsWith(`${path.basename(target)}.migrated-`) && !prior.priorArchives.has(name))
          .map((name) => path.join(path.dirname(target), name));
        if (archives.length !== 1) fail('empty auth stub archive is missing or ambiguous');
        const archived = emptyProfileStub(archives[0]);
        if (!archived || archived.sha256 !== prior.identity.sha256
          || archived.mode !== prior.identity.mode) fail('empty auth stub archive does not preserve its input');
        for (const display of displayPaths(target)) for (const archive of displayPaths(archives[0])) {
          allowedEmptyWarnings.add(`Archived unparseable auth profile input without import for ${display} (${archive}).`);
        }
      }
    }
    if (!isRecord(result) || !Array.isArray(result.detected) || !Array.isArray(result.changes)
      || !Array.isArray(result.warnings) || result.warnings.some((warning) => !allowedEmptyWarnings.has(warning))) {
      // Upstream warnings may contain credential material or private paths.
      fail('OpenClaw credential migration failed verification; original authority must be restored');
    }
    if (JSON.stringify(cfg) !== beforeConfig || result.configChanged === true) {
      fail('credential migration requires an additional configuration transition');
    }
    if (sourcePaths.some((target) => fs.existsSync(target) && !unchangedEmptySources.has(target))) {
      fail('credential migration left legacy auth inputs behind');
    }
    return { sources: sourceCount - emptyProfileSources.size, changes: result.changes.length };
  });
}

async function loadCronMigrationContract(packageDir) {
  // Cron JSON -> shared-SQLite and runtime-policy repair likewise has no
  // targeted public subcommand in 2026.9.1. Import only the exact hash-pinned
  // implementation bundles; never the broad Doctor repair flow.
  const distDir = path.join(packageDir, 'dist');
  const testPackage = process.env.PORTAL_OPENCLAW_MIGRATION_TEST_PACKAGE_DIR
    ? path.resolve(packageDir) === path.resolve(process.env.PORTAL_OPENCLAW_MIGRATION_TEST_PACKAGE_DIR)
    : false;
  const select = (prefix, markers, expectedSha256, label) => {
    const testHashName = label === 'cron legacy repair'
      ? 'PORTAL_OPENCLAW_TEST_CRON_LEGACY_SHA256'
      : 'PORTAL_OPENCLAW_TEST_CRON_POLICY_SHA256';
    const allowedHash = testPackage
      && /^[a-f0-9]{64}$/.test(process.env[testHashName] || '')
      ? process.env[testHashName]
      : expectedSha256;
    const candidates = fs.readdirSync(distDir)
      .filter((entry) => entry.startsWith(prefix) && /\.m?js$/.test(entry))
      .filter((entry) => {
        const text = fs.readFileSync(path.join(distDir, entry), 'utf8');
        return markers.every((marker) => text.includes(marker));
      })
      .filter((entry) => sha256File(path.join(distDir, entry)) === allowedHash);
    if (candidates.length !== 1) fail(`expected one hash-pinned OpenClaw ${label} bundle, found ${candidates.length}`);
    const target = path.join(distDir, candidates[0]);
    lstatRegularFile(target, `OpenClaw ${label} bundle`);
    return target;
  };
  const legacyTarget = select(
    'legacy-repair-',
    [
      'collectCronCodexRuntimePolicyTargetsReadOnly',
      'loadLegacyCronRepairState',
      'applyLegacyCronStoreRepair',
    ],
    CRON_LEGACY_REPAIR_SHA256,
    'cron legacy repair',
  );
  const policyTarget = select(
    'runtime-policy-migration-',
    ['repairCronCodexRuntimePolicies', 'planCronCodexRefRewriteAgainstPersistedConfig'],
    CRON_RUNTIME_POLICY_SHA256,
    'cron runtime policy',
  );
  const [legacy, policy] = await Promise.all([
    import(pathToFileURL(legacyTarget).href),
    import(pathToFileURL(policyTarget).href),
  ]);
  if (typeof legacy.n !== 'function' || typeof legacy.r !== 'function'
    || typeof legacy.t !== 'function' || typeof policy.n !== 'function') {
    fail('OpenClaw cron migration contract exports are missing');
  }
  return {
    collectTargets: legacy.n,
    inspectState: legacy.r,
    applyState: legacy.t,
    repairRuntimePolicy: policy.n,
  };
}

async function migrateConfig(config, packageDir, env, sourceStateDir = env.OPENCLAW_STATE_DIR) {
  const actions = [];
  const legacyOwner = Array.isArray(config.agents?.list)
    ? config.agents.list.find((entry) => isRecord(entry) && entry.default === true)?.id
    : (isRecord(config.agents?.entries) ? Object.entries(config.agents.entries).find(([, entry]) => isRecord(entry) && entry.default === true)?.[0] : undefined);
  migrateAgentRoster(config, actions);
  if (Object.keys(config.agents?.entries ?? {}).length > 1 && config.agents.ownership !== 'explicit') {
    // A validated legacy default becomes explicit per-surface ownership in
    // 9.1. Retain its heartbeat, system, auth, session and channel roles using
    // the pinned upstream migration; dropping the marker alone is invalid.
    if (typeof legacyOwner !== 'string') fail('multi-agent migration lost its legacy owner');
    const dist = path.join(packageDir, 'dist');
    const fixture = process.env.PORTAL_OPENCLAW_MIGRATION_TEST_PACKAGE_DIR
      && path.resolve(process.env.PORTAL_OPENCLAW_MIGRATION_TEST_PACKAGE_DIR) === path.resolve(packageDir);
    const override = process.env.PORTAL_OPENCLAW_TEST_ROSTER_MIGRATION_SHA256 || '';
    const expected = fixture && /^[a-f0-9]{64}$/.test(override) ? override
      : '3cd0e0e3f6c85d2736d62d3eae1421de4f40a9ec810f6adb55729cc81b1e4a86';
    const matches = fs.readdirSync(dist).filter((name) => name.startsWith('legacy.roster-') && /\.m?js$/.test(name))
      .filter((name) => sha256File(path.join(dist, name)) === expected);
    if (matches.length !== 1) fail('expected one hash-pinned legacy agent ownership bundle');
    const contract = await import(pathToFileURL(path.join(dist, matches[0])).href);
    if (typeof contract.i !== 'function') fail('legacy ownership migration export missing');
    const roles = contract.i(config, legacyOwner, { materializeWorkspace: true,
      env: { ...env, OPENCLAW_STATE_DIR: sourceStateDir }, homedir: () => path.dirname(sourceStateDir) });
    if (!isRecord(roles) || !isRecord(roles.config) || !Array.isArray(roles.insertedPaths)) fail('legacy ownership migration returned an invalid result');
    config = roles.config;
    config.agents.ownership = 'explicit';
    actions.push('materialized-legacy-default-agent-roles');
  }
  removeRetiredCliBackends(config, actions);
  removeRetiredCodexTimeouts(config, actions);
  removeOpenProseReferences(config, actions);
  removeRetiredMetadata(config, actions);
  const [contract, cronContract] = await Promise.all([
    loadCodexRouteContract(packageDir),
    loadCronMigrationContract(packageDir),
  ]);
  const cronState = await withMigrationEnvironment(
    env,
    () => cronContract.inspectState({ cfg: config, env, readOnly: true }),
  );
  if (!isRecord(cronState)) fail('OpenClaw cron migration state could not be inspected');
  const cronTargets = await withMigrationEnvironment(
    env,
    () => cronContract.collectTargets({ cfg: config }),
  );
  if (!isRecord(cronTargets) || !Array.isArray(cronTargets.targets)
    || !Array.isArray(cronTargets.warnings) || cronTargets.warnings.length > 0) {
    fail('OpenClaw Codex cron migration planning failed');
  }
  const repaired = contract.repairConfig({ cfg: config, shouldRepair: true, env });
  if (!isRecord(repaired) || !isRecord(repaired.cfg) || !Array.isArray(repaired.changes)) {
    fail('OpenClaw Codex route config repair returned an invalid result');
  }
  const legacyCodexRefs = inspectLegacyCodexRefs(repaired.cfg);
  if (legacyCodexRefs.length > 0) {
    fail(`OpenClaw Codex route repair left legacy refs behind: ${legacyCodexRefs.slice(0, 5).join(', ')}`);
  }
  if (repaired.changes.length > 0) actions.push(`openclaw-codex-route-repair:${repaired.changes.length}`);
  const cronPolicy = cronContract.repairRuntimePolicy({
    cfg: repaired.cfg,
    targets: cronTargets.targets,
  });
  if (!isRecord(cronPolicy) || !isRecord(cronPolicy.config)
    || !Array.isArray(cronPolicy.changes) || !Array.isArray(cronPolicy.warnings)
    || !Array.isArray(cronPolicy.blockedTargets)
    || cronPolicy.warnings.length > 0 || cronPolicy.blockedTargets.length > 0) {
    fail('OpenClaw Codex cron runtime-policy migration could not be proven safe');
  }
  if (cronPolicy.changes.length > 0) actions.push(`openclaw-codex-cron-runtime-policy:${cronPolicy.changes.length}`);
  return {
    config: cronPolicy.config,
    actions,
    contract,
    cron: {
      contract: cronContract,
      state: cronState,
      targets: cronTargets.targets,
      migrationNeeded: cronState.legacyStoreDetected === true,
    },
  };
}

function validatePackage(packageDir) {
  assertNoSymlinkComponents(packageDir);
  lstatDirectory(packageDir, 'OpenClaw package');
  const pkg = readJson(path.join(packageDir, 'package.json'), 'OpenClaw package.json');
  if (pkg.name !== REQUIRED_PACKAGE_NAME || pkg.version !== REQUIRED_PACKAGE_VERSION) {
    fail(`expected ${REQUIRED_PACKAGE_NAME}@${REQUIRED_PACKAGE_VERSION}, found ${String(pkg.name)}@${String(pkg.version)}`);
  }
  const cli = path.join(packageDir, 'openclaw.mjs');
  lstatRegularFile(cli, 'OpenClaw CLI');
  return cli;
}

function runOpenClaw(cli, args, env, timeoutMs = 180_000) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs,
  });
  if (result.error) fail(`OpenClaw command failed: ${result.error.message}`);
  let report;
  try { report = JSON.parse(String(result.stdout || '').trim()); } catch {}
  // The pinned session CLI exits 1 even for a completed metadata-only import.
  // Its structured report still has to pass assertReport immediately below.
  const sessionWarningExit = result.status === 1 && args[0] === 'doctor'
    && args[1] === '--session-sqlite' && ['dry-run', 'import'].includes(args[2])
    && isRecord(report) && report.mode === args[2];
  if (result.status !== 0 && !sessionWarningExit) {
    fail(`OpenClaw ${args.slice(0, 3).join(' ')} command exited ${String(result.status)}`);
  }
  if (!isRecord(report)) fail('OpenClaw command did not return a JSON object');
  return report;
}

function normalizeRuntimeMetadata(cli, env) {
  // In 9.1, `plugins list` skips the configuration/state-migration guard and
  // only derives a read-only index. Explicit refresh runs ordinary CLI startup
  // migrations and persists the registry before this transaction seals its
  // prepared baseline. No packages are installed and no gateway is started.
  const report = runOpenClaw(cli, ['plugins', 'registry', '--refresh', '--json'], env);
  if (report.refreshed !== true || report.state !== 'fresh'
    || !Array.isArray(report.differences) || report.differences.length !== 0
    || !isRecord(report.registry) || !Array.isArray(report.registry.plugins)
    || report.registry.plugins.some((entry) => !isRecord(entry))) {
    fail('OpenClaw runtime metadata normalization did not verify a fresh persisted registry');
  }
  return { command: 'plugins registry --refresh --json', entries: report.registry.plugins.length };
}

// Gateway startup has two additional legacy authorities that ordinary CLI
// inspection does not import. Use only these pinned upstream implementations;
// do not invoke the broad Doctor repair flow or rotate a canonical identity.
async function loadBootStateContract(packageDir) {
  const dist = path.join(packageDir, 'dist');
  const fixture = process.env.PORTAL_OPENCLAW_MIGRATION_TEST_PACKAGE_DIR
    && path.resolve(process.env.PORTAL_OPENCLAW_MIGRATION_TEST_PACKAGE_DIR) === path.resolve(packageDir);
  const select = (prefix, expectedHash, fixtureKey) => {
    const override = process.env[fixtureKey] || '';
    const hash = fixture && /^[a-f0-9]{64}$/.test(override) ? override : expectedHash;
    const matches = fs.readdirSync(dist).filter((name) => name.startsWith(prefix) && /\.m?js$/.test(name))
      .filter((name) => sha256File(path.join(dist, name)) === hash);
    if (matches.length !== 1) fail('expected one hash-pinned OpenClaw boot-state migration bundle');
    const target = path.join(dist, matches[0]);
    assertNoSymlinkComponents(target); lstatRegularFile(target, 'boot-state bundle');
    return target;
  };
  const workspaceTarget = select('state-migrations.doctor-',
    '3c8df079a9a74d89694411ad6b3fc94938a534886e2f6f4db0d2f611a3019327', 'PORTAL_OPENCLAW_TEST_WORKSPACE_MIGRATION_SHA256');
  const deviceTarget = select('state-migrations.device-identity-',
    '60356f5351b26bee549a913347b7e62e0cbb911235e69f9c4c26b2765aa07f63', 'PORTAL_OPENCLAW_TEST_DEVICE_MIGRATION_SHA256');
  // Workspace's targeted functions are private in this exact release. Expose
  // them in memory with unchanged bodies and absolute import resolution. Never
  // patch installed/generated package bytes or execute unrelated Doctor steps.
  const require = createRequire(pathToFileURL(workspaceTarget));
  const source = fs.readFileSync(workspaceTarget, 'utf8').replace(
    /^import (.*?)(?:from )?"([^"]+)";$/gm, (whole, _prefix, spec) => {
      const url = spec.startsWith('node:') ? spec : pathToFileURL(spec.startsWith('.')
        ? path.resolve(path.dirname(workspaceTarget), spec) : require.resolve(spec)).href;
      return whole.replace(`"${spec}"`, JSON.stringify(url));
    });
  const workspace = await import('data:text/javascript;base64,' + Buffer.from(source
    + '\nexport {detectLegacyWorkspaceState as portalDetect, migrateLegacyWorkspaceState as portalMigrate};\n').toString('base64'));
  const device = await import(pathToFileURL(deviceTarget).href);
  if (typeof workspace.portalDetect !== 'function' || typeof workspace.portalMigrate !== 'function'
    || typeof device.n !== 'function' || typeof device.t !== 'function') fail('boot-state migration exports missing');
  return { detectWorkspace: workspace.portalDetect, migrateWorkspace: workspace.portalMigrate,
    detectDevice: device.n, migrateDevice: device.t };
}

function bootMetadataFile(target, maximum = 65536) {
  assertNoSymlinkComponents(target, true);
  if (!fs.existsSync(target)) return null;
  const stat = lstatRegularFile(target, 'legacy workspace metadata');
  if (stat.uid !== process.getuid() || stat.nlink !== 1 || stat.size > maximum) {
    fail('legacy workspace metadata ownership, link count or size is unsafe');
  }
  assertSecureParent(target, 'legacy workspace metadata');
  return { sha256: sha256File(target), mode: stat.mode & 0o777, size: stat.size };
}

function validateBootSource(source) {
  if (!isRecord(source) || !['setup', 'attestation'].includes(source.kind)
    || !/^[a-f0-9]{64}$/.test(source.workspaceKey || '') || !Number.isInteger(source.priority)
    || !path.isAbsolute(source.sourcePath || '') || path.resolve(source.sourcePath) !== source.sourcePath
    || !path.isAbsolute(source.rootDir || '') || !isSafeRelativePath(source.relativePath)
    || path.resolve(source.rootDir, source.relativePath) !== source.sourcePath) fail('invalid workspace migration source');
  const name = path.basename(source.sourcePath);
  if (source.kind === 'setup' && name !== 'openclaw-workspace-state.json'
    && !(name === 'workspace-state.json' && path.basename(path.dirname(source.sourcePath)) === '.openclaw')) {
    fail('workspace setup migration escaped the legacy metadata paths');
  }
  if (source.kind === 'attestation' && !name.endsWith('.attested')) fail('invalid workspace attestation path');
  assertNoSymlinkComponents(source.rootDir);
  assertSecureParent(source.sourcePath, 'workspace source');
  if (source.workspaceDir !== undefined) {
    if (typeof source.workspaceDir !== 'string' || !path.isAbsolute(source.workspaceDir)
      || source.workspaceAliasPath !== source.workspaceDir
      || sha256Content(source.workspaceDir.normalize('NFC')) !== source.workspaceKey) {
      fail('workspace identity is not a canonical unaliased path');
    }
    assertNoSymlinkComponents(source.workspaceDir);
  }
}

async function snapshotBootMetadata(contract, config, manifest, env) {
  const detected = await withMigrationEnvironment(env, () => contract.detectWorkspace({
    cfg: config, stateDir: manifest.stateDir, env, homedir: () => path.dirname(manifest.stateDir),
    doctorOnlyStateMigrations: true,
  }));
  if (!isRecord(detected) || !Array.isArray(detected.sources)
    || detected.hasLegacy !== (detected.sources.length > 0) || detected.sources.length > 1024) fail('invalid workspace migration detection');
  const sources = detected.sources;
  const backupRoot = path.join(manifest.authoritySnapshot.backupRoot, 'boot-files');
  createSecureDirectoryExclusive(backupRoot);
  const entries = [];
  for (const source of sources) {
    validateBootSource(source);
    for (const target of [source.sourcePath, `${source.sourcePath}.doctor-importing`]) {
      if (entries.some((entry) => entry.path === target)) fail('duplicate workspace migration path');
      const before = bootMetadataFile(target, source.kind === 'setup' ? 65536 : 2048);
      const backupPath = before ? path.join(backupRoot, `${entries.length}.before`) : null;
      if (before) {
        copyExclusive(target, backupPath, 0o600);
        if (sha256File(backupPath) !== before.sha256 || sha256File(target) !== before.sha256) fail('workspace metadata changed during snapshot');
      }
      entries.push({ path: target, before, backupPath });
    }
  }
  const plan = { sources, entries, backupRoot };
  return { ...plan, sha256: sha256Content(JSON.stringify(plan)) };
}

function validateBootMetadata(plan, manifestPath) {
  if (!plan) return;
  if (!isRecord(plan) || !Array.isArray(plan.sources) || !Array.isArray(plan.entries)
    || plan.backupRoot !== path.join(`${manifestPath}.authority-before`, 'boot-files')
    || plan.sha256 !== sha256Content(JSON.stringify({ sources: plan.sources, entries: plan.entries, backupRoot: plan.backupRoot }))
    || plan.entries.length !== plan.sources.length * 2) fail('workspace metadata snapshot binding changed');
  plan.sources.forEach(validateBootSource);
  for (const [index, entry] of plan.entries.entries()) {
    const source = plan.sources[Math.floor(index / 2)];
    if (entry.path !== source.sourcePath + (index % 2 ? '.doctor-importing' : '')) fail('workspace metadata snapshot escaped its source');
    if (entry.before) {
      if (entry.backupPath !== path.join(plan.backupRoot, `${index}.before`)
        || !/^[a-f0-9]{64}$/.test(entry.before.sha256 || '')
        || !Number.isInteger(entry.before.mode) || entry.before.mode < 0 || entry.before.mode > 0o777) fail('invalid workspace metadata backup');
      const backup = bootMetadataFile(entry.backupPath);
      if (!backup || backup.sha256 !== entry.before.sha256 || backup.mode !== 0o600) fail('workspace metadata backup changed');
    } else if (entry.backupPath !== null) fail('absent workspace metadata has a backup');
  }
}

function assertBootMetadataState(plan, state) {
  if (!plan) return;
  for (const [index, entry] of plan.entries.entries()) {
    const current = bootMetadataFile(entry.path);
    const sourceBefore = plan.entries[index - index % 2].before || plan.entries[index - index % 2 + 1].before;
    if (state === 'original') {
      if (JSON.stringify(current) !== JSON.stringify(entry.before)) fail('workspace metadata changed from its original snapshot');
    } else if (state === 'migrated') {
      if (current) fail('legacy workspace metadata remains or reappeared after migration');
    } else if (current && (!sourceBefore || current.sha256 !== sourceBefore.sha256
      || ![sourceBefore.mode, 0o600].includes(current.mode))) {
      fail('foreign workspace metadata blocks rollback');
    }
  }
}

function materializeBootPreflight(plan, preflightRoot) {
  const sources = plan.sources.map((source, index) => {
    const rootDir = path.join(preflightRoot, 'workspaces', String(index));
    makeDirectoryTree(rootDir, 0o700);
    const copy = { ...source, rootDir, sourcePath: path.join(rootDir, source.relativePath) };
    for (const [offset, entry] of plan.entries.slice(index * 2, index * 2 + 2).entries()) {
      if (!entry.before) continue;
      const target = copy.sourcePath + (offset ? '.doctor-importing' : '');
      makeDirectoryTree(path.dirname(target), 0o700);
      copyExclusive(entry.backupPath, target, 0o600);
    }
    return copy;
  });
  return { sources, hasLegacy: sources.length > 0 };
}

async function migrateBootState(contract, detectedWorkspace, stateDir, env) {
  return withMigrationEnvironment(env, async () => {
    const deviceParams = { stateDir, env, allowLegacyDeviceIdentityImport: true, doctorOnlyStateMigrations: false };
    const detectedDevice = contract.detectDevice(deviceParams);
    const device = await contract.migrateDevice({ ...deviceParams, detected: detectedDevice });
    const workspace = await contract.migrateWorkspace({ stateDir, env, detected: detectedWorkspace });
    for (const result of [device, workspace]) {
      if (!isRecord(result) || !Array.isArray(result.changes) || !Array.isArray(result.warnings)
        || result.warnings.length) fail('targeted gateway boot-state migration did not verify cleanly');
    }
    if (contract.detectDevice(deviceParams).hasLegacy) fail('legacy device identity remains after import');
    for (const source of detectedWorkspace.sources) {
      if (fs.existsSync(source.sourcePath) || fs.existsSync(`${source.sourcePath}.doctor-importing`)) fail('legacy workspace state remains after import');
    }
    return { deviceChanges: device.changes.length, workspaceChanges: workspace.changes.length };
  });
}

function restoreBootMetadata(plan) {
  if (!plan) return;
  assertBootMetadataState(plan, 'recoverable');
  for (const entry of plan.entries) {
    const current = bootMetadataFile(entry.path);
    if (entry.before) {
      if (!current) copyExclusive(entry.backupPath, entry.path, entry.before.mode);
      else if (current.sha256 !== entry.before.sha256 || current.mode !== entry.before.mode) {
        writeAtomic(entry.path, fs.readFileSync(entry.backupPath), entry.before.mode);
      }
    } else if (current) { fs.unlinkSync(entry.path); fsyncDirectory(path.dirname(entry.path)); }
  }
  assertBootMetadataState(plan, 'original');
}

function assertReport(report, expectedMode, options = {}) {
  if (!isRecord(report) || report.mode !== expectedMode || !isRecord(report.totals)) {
    fail(`invalid OpenClaw session migration ${expectedMode} report`);
  }
  const issueCount = report.totals.issues;
  if (!Number.isInteger(issueCount) || issueCount < 0) fail('invalid session issue count');
  const admitted = [];
  if (issueCount > 0) {
    if (!options.stateDir || !Array.isArray(report.targets)) {
      fail(`OpenClaw session migration ${expectedMode} reported ${issueCount} issue(s)`);
    }
    const root = path.resolve(options.stateDir);
    const reportedIssues = report.targets.flatMap((target) => {
      if (!isRecord(target) || !Array.isArray(target.issues)) fail('invalid session target issues');
      return target.issues.map((issue) => ({ target, issue }));
    });
    if (reportedIssues.length !== issueCount) fail('session issue count does not match targets');
    for (const { target, issue } of reportedIssues) {
      if (!isRecord(issue) || issue.code !== 'transcript_missing'
        || typeof issue.sessionKey !== 'string' || typeof target.storePath !== 'string') {
        fail('session migration reported an unadmitted issue');
      }
      const relativeStore = path.relative(root, path.resolve(target.storePath));
      if (!isSafeRelativePath(relativeStore)) fail('session issue targets external state');
      const identity = JSON.stringify([relativeStore, issue.sessionKey]);
      if (expectedMode === 'import') {
        if (!options.missingTranscripts?.includes(identity)) fail('new missing transcript during import');
      } else if (expectedMode === 'dry-run') {
        assertNoSymlinkComponents(target.storePath);
        const entry = readJson(target.storePath, 'legacy session store')[issue.sessionKey];
        if (!isRecord(entry) || typeof entry.sessionId !== 'string'
          || typeof entry.sessionFile !== 'string' || !entry.sessionFile.trim()) {
          fail('missing transcript does not identify a stored legacy entry');
        }
        const transcript = path.resolve(path.dirname(target.storePath), entry.sessionFile);
        if (!isSafeRelativePath(path.relative(root, transcript))) fail('legacy transcript is outside snapshotted state');
        const relocated = path.join(path.dirname(target.storePath), path.basename(entry.sessionFile));
        for (const candidate of new Set([transcript, relocated])) {
          assertNoSymlinkComponents(candidate, true);
          if (fs.existsSync(candidate)) fail('missing-transcript notice contradicts stored authority');
        }
      } else fail('missing-transcript warning is not admissible in this phase');
      admitted.push(identity);
    }
  }
  if (options.requireMigrationRun && (!isRecord(report.migrationRun) || typeof report.migrationRun.manifestPath !== 'string')) {
    fail('OpenClaw session import did not return a migration manifest');
  }
  return [...new Set(admitted)].sort();
}

function relocateCopiedSessionReferences(snapshot, sourceStateDir, copiedStateDir) {
  for (const item of snapshot.entries) {
    if (item.kind !== 'file' || !item.relativePath.endsWith('sessions/sessions.json')) continue;
    const target = statePathFromRelative(copiedStateDir, item.relativePath);
    const store = readJson(target, 'copied legacy session store');
    if (!isRecord(store)) fail('copied legacy session store is not an object');
    let changed = false;
    for (const entry of Object.values(store)) {
      if (!isRecord(entry) || typeof entry.sessionFile !== 'string'
        || !path.isAbsolute(entry.sessionFile)) continue;
      const relative = path.relative(sourceStateDir, entry.sessionFile);
      if (!isSafeRelativePath(relative)) fail('legacy transcript reference is outside snapshotted state');
      if (!snapshot.managedRoots.some((root) => relative.startsWith(`${root.relativePath}${path.sep}`))) {
        fail('legacy transcript reference is outside snapshotted session roots');
      }
      entry.sessionFile = statePathFromRelative(copiedStateDir, relative);
      changed = true;
    }
    if (changed) writeAtomic(target, `${JSON.stringify(store)}\n`, item.mode);
  }
}

function assertGatewayStopped(stateDir) {
  const testRoot = process.env.PORTAL_OPENCLAW_MIGRATION_TEST_ROOT;
  if (testRoot) {
    const root = fs.realpathSync(testRoot);
    const state = fs.realpathSync(stateDir);
    if (state !== root && !state.startsWith(`${root}${path.sep}`)) fail('test state directory is outside PORTAL_OPENCLAW_MIGRATION_TEST_ROOT');
    return;
  }
  const result = spawnSync('systemctl', ['is-active', '--quiet', 'openclaw-gateway'], { stdio: 'ignore' });
  if (result.status === 0) fail('openclaw-gateway must be stopped before session/config migration');
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

function readManifest(manifestPath) {
  const manifest = readJson(manifestPath, 'Portal OpenClaw migration manifest');
  if (manifest.contractVersion !== CONTRACT_VERSION || manifest.packageVersion !== REQUIRED_PACKAGE_VERSION) {
    fail('Portal OpenClaw migration manifest has the wrong contract or package version');
  }
  for (const key of ['generationId', 'manifestPath', 'stateDir', 'configPath', 'packageDir', 'configBackupPath', 'configBeforeSha256', 'phase']) {
    if (typeof manifest[key] !== 'string' || !manifest[key]) fail(`migration manifest is missing ${key}`);
  }
  if (path.resolve(manifest.manifestPath) !== path.resolve(manifestPath)) fail('migration manifest path does not match its generation identity');
  if (manifest.configAfterSha256 !== null
    && (typeof manifest.configAfterSha256 !== 'string' || !manifest.configAfterSha256)) {
    fail('migration manifest has an invalid post-migration config hash');
  }
  if (!['preparing', 'prepared', 'restored', 'committed'].includes(manifest.state)) {
    fail(`migration manifest has an invalid state: ${String(manifest.state)}`);
  }
  if (typeof manifest.sessionRestoreRequired !== 'boolean') {
    fail('migration manifest is missing the session restore arm');
  }
  if (typeof manifest.cronRestoreRequired !== 'boolean') {
    fail('migration manifest is missing the cron restore arm');
  }
  if (typeof manifest.authorityRestoreRequired !== 'boolean') {
    fail('migration manifest is missing the authority restore arm');
  }
  validateAuthoritySnapshot(manifest.authoritySnapshot, manifest.stateDir, manifestPath);
  validateBootMetadata(manifest.bootMetadata, manifestPath);
  return manifest;
}

function writeManifest(manifestPath, manifest, replace = false) {
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!replace) writeExclusive(manifestPath, content, 0o600);
  else writeAtomic(manifestPath, content, 0o600);
}

function createSecureDirectoryExclusive(directory) {
  assertNoSymlinkComponents(directory, true);
  const parent = assertSecureParent(directory, 'cron migration backup');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fsyncDirectory(parent);
}

function snapshotLegacyCronAuthority(cron, stateDir, manifestPath) {
  const state = cron.state;
  if (!cron.migrationNeeded) {
    if (cron.targets.length > 0) {
      fail('Codex cron refs exist only in SQLite; automatic downgrade rollback cannot restore 7.1 authority');
    }
    return [];
  }
  const source = state.legacyMigrationSource;
  if (!isRecord(source) || typeof source.sourcePath !== 'string'
    || typeof source.sourceSha256 !== 'string' || typeof source.statePath !== 'string') {
    fail('legacy cron storage has no restorable migration source');
  }
  const files = [{ path: source.sourcePath, sha256: source.sourceSha256 }];
  if (source.stateSha256 !== undefined) {
    if (typeof source.stateSha256 !== 'string') fail('legacy cron state hash is invalid');
    files.push({ path: source.statePath, sha256: source.stateSha256 });
  }
  const stateRoot = `${path.resolve(stateDir)}${path.sep}`;
  const backupRoot = `${manifestPath}.cron-before`;
  createSecureDirectoryExclusive(backupRoot);
  const snapshots = [];
  for (const [index, entry] of files.entries()) {
    const sourcePath = path.resolve(entry.path);
    if (!sourcePath.startsWith(stateRoot)) {
      fail(`legacy cron authority is outside the standard OpenClaw state directory: ${sourcePath}`);
    }
    assertNoSymlinkComponents(sourcePath);
    const stat = lstatRegularFile(sourcePath, 'legacy cron authority');
    if (stat.uid !== process.getuid() || sha256File(sourcePath) !== entry.sha256) {
      fail(`legacy cron authority changed during migration planning: ${sourcePath}`);
    }
    const backupPath = path.join(backupRoot, `${String(index + 1).padStart(3, '0')}.before`);
    copyExclusive(sourcePath, backupPath, stat.mode & 0o777);
    snapshots.push({
      sourcePath,
      backupPath,
      sha256: entry.sha256,
      mode: stat.mode & 0o777,
    });
  }
  return snapshots;
}

function restoreLegacyCronAuthority(manifest, manifestPath) {
  if (!Array.isArray(manifest.cronAuthorityFiles)) {
    fail('migration manifest has no cron authority inventory');
  }
  const stateRoot = `${path.resolve(manifest.stateDir)}${path.sep}`;
  const backupRoot = `${path.resolve(`${manifestPath}.cron-before`)}${path.sep}`;
  for (const entry of manifest.cronAuthorityFiles) {
    if (!isRecord(entry) || typeof entry.sourcePath !== 'string'
      || typeof entry.backupPath !== 'string' || typeof entry.sha256 !== 'string'
      || !Number.isInteger(entry.mode)) {
      fail('migration manifest contains an invalid cron authority entry');
    }
    const sourcePath = path.resolve(entry.sourcePath);
    const backupPath = path.resolve(entry.backupPath);
    if (!sourcePath.startsWith(stateRoot) || !backupPath.startsWith(backupRoot)) {
      fail('migration manifest cron authority escaped its recovery roots');
    }
    assertNoSymlinkComponents(backupPath);
    lstatRegularFile(backupPath, 'legacy cron authority backup');
    if (sha256File(backupPath) !== entry.sha256) fail('legacy cron authority backup hash drifted');
    if (fs.existsSync(sourcePath)) {
      assertNoSymlinkComponents(sourcePath);
      lstatRegularFile(sourcePath, 'legacy cron authority restore target');
      if (sha256File(sourcePath) !== entry.sha256) {
        fail(`legacy cron authority restore target changed: ${sourcePath}`);
      }
      continue;
    }
    copyExclusive(backupPath, sourcePath, entry.mode);
    if (sha256File(sourcePath) !== entry.sha256) fail('legacy cron authority restore hash mismatch');
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

// Copied-state preflight runs before the outer installer converges these three
// required plugins. This copy deliberately contains data authority, not plugin
// packages. Defer only their exact 9.1 presence notices; schema errors, unknown
// plugins and all other warnings remain fatal. The outer commit still requires
// installed plugin/runtime attestation, including the Portal answer channel.
const DEFERRED_PLUGIN_PRESENCE_NOTICES = new Map([
  ['bridgesllm-ask-user', 'plugin not found: bridgesllm-ask-user (stale config entry ignored; remove it from plugins config)'],
  ['codex', 'plugin not installed: codex — install the official external plugin with: openclaw plugins install @openclaw/codex'],
  ['acpx', 'plugin not installed: acpx — install the official external plugin with: openclaw plugins install @openclaw/acpx'],
]);

function deferredPluginPresenceId(issue) {
  if (!isRecord(issue)) return null;
  for (const [id, message] of DEFERRED_PLUGIN_PRESENCE_NOTICES) {
    if (issue.path === `plugins.entries.${id}` && issue.message === message) return id;
  }
  return null;
}

async function runSessionPreflightOnSnapshot({
  cli,
  snapshot,
  sourceStateDir,
  manifestPath,
  migratedContent,
  originalConfig,
  packageDir,
  bootContract,
  bootMetadata,
}) {
  const preflightRoot = `${manifestPath}.preflight`;
  const preflightStateDir = path.join(preflightRoot, 'state');
  const preflightConfigPath = path.join(preflightRoot, 'openclaw.json');
  if (fs.existsSync(preflightRoot)) removePreflightTree(preflightRoot);
  createSecureDirectoryExclusive(preflightRoot);
  makeDirectoryTree(preflightStateDir, 0o700);
  try {
    materializeAuthoritySnapshot(snapshot, sourceStateDir, preflightStateDir, false);
    relocateCopiedSessionReferences(snapshot, sourceStateDir, preflightStateDir);
    writeExclusive(preflightConfigPath, `${JSON.stringify(originalConfig, null, 2)}\n`, 0o600);
    const env = buildEnvironment(preflightStateDir, preflightConfigPath);
    const sharedStateSchema = await migrateSharedStateSchema(packageDir, env);
    const copiedMigration = await migrateConfig(structuredClone(originalConfig), packageDir, env, sourceStateDir);
    const copiedMigratedContent = `${JSON.stringify(copiedMigration.config, null, 2)}\n`;
    if (copiedMigratedContent !== migratedContent) {
      fail('copied-state migration plan differs from the live read-only plan');
    }
    writeAtomic(preflightConfigPath, copiedMigratedContent, 0o600);
    const authProfiles = await migrateAuthProfileStores(packageDir, copiedMigration.config, env, sourceStateDir);
    const validation = runOpenClaw(cli, ['config', 'validate', '--json'], env, 60_000);
    const validationWarnings = [
      ...(Array.isArray(validation?.warnings) ? validation.warnings : []),
      ...(Array.isArray(validation?.issues)
        ? validation.issues.filter((issue) => {
          if (!isRecord(issue)) return false;
          const level = String(issue.level ?? issue.severity ?? issue.kind ?? '').toLowerCase();
          return level === 'warning' || issue.warning === true;
        })
        : []),
    ];
    const deferredPluginPresence = [...new Set(validationWarnings.map(deferredPluginPresenceId).filter(Boolean))];
    const blockingWarnings = validationWarnings.filter((issue) => !deferredPluginPresenceId(issue));
    if (validation?.valid !== true || blockingWarnings.length > 0) {
      // Report paths only: upstream validation messages can quote config values.
      const paths = blockingWarnings.map((issue) => typeof issue?.path === 'string'
        && /^[a-zA-Z0-9_.[\]-]{1,160}$/.test(issue.path) ? issue.path : '<unclassified>');
      fail(`OpenClaw rejected or warned on the migrated configuration during copied-state preflight${paths.length ? ` (${paths.join(', ')})` : ''}`);
    }
    const before = runOpenClaw(cli, ['doctor', '--session-sqlite', 'inspect', '--session-sqlite-all-agents', '--json'], env);
    assertReport(before, 'inspect');
    const dryRun = runOpenClaw(cli, ['doctor', '--session-sqlite', 'dry-run', '--session-sqlite-all-agents', '--json'], env);
    const missingTranscripts = assertReport(dryRun, 'dry-run', { stateDir: preflightStateDir });
    let imported = null;
    if (dryRun.totals.legacyEntries > 0) {
      imported = runOpenClaw(cli, ['doctor', '--session-sqlite', 'import', '--session-sqlite-all-agents', '--json'], env);
      assertReport(imported, 'import', { requireMigrationRun: true, stateDir: preflightStateDir, missingTranscripts });
      if (imported.totals.importedEntries !== dryRun.totals.legacyEntries) {
        fail(`copied-state session import count mismatch (${String(imported.totals.importedEntries)} != ${String(dryRun.totals.legacyEntries)})`);
      }
      const sessionRoutes = await copiedMigration.contract.repairSessions({
        cfg: copiedMigration.config,
        shouldRepair: true,
        env,
      });
      if (!isRecord(sessionRoutes) || !Array.isArray(sessionRoutes.warnings) || sessionRoutes.warnings.length > 0) {
        fail('copied-state Codex session route repair reported an unsafe result');
      }
    }
    let cronRepair = null;
    if (copiedMigration.cron.migrationNeeded) {
      const boundedCronState = {
        ...copiedMigration.cron.state,
        legacyRunLogDetected: false,
        legacyQuarantine: undefined,
      };
      cronRepair = await withMigrationEnvironment(
        env,
        () => copiedMigration.cron.contract.applyState({
          cfg: copiedMigration.config,
          state: boundedCronState,
          migrateCodexModelRefs: true,
        }),
      );
      if (!isRecord(cronRepair) || !Array.isArray(cronRepair.changes)
        || !Array.isArray(cronRepair.warnings) || cronRepair.warnings.length > 0) {
        fail('copied-state cron migration reported an unsafe result');
      }
      const remainingCronTargets = await withMigrationEnvironment(
        env,
        () => copiedMigration.cron.contract.collectTargets({ cfg: copiedMigration.config }),
      );
      if (!isRecord(remainingCronTargets) || !Array.isArray(remainingCronTargets.targets)
        || !Array.isArray(remainingCronTargets.warnings) || remainingCronTargets.warnings.length > 0
        || remainingCronTargets.targets.length > 0) {
        fail('copied-state cron migration left legacy Codex routes behind');
      }
    }
    const bootState = await migrateBootState(bootContract, materializeBootPreflight(bootMetadata, preflightRoot), preflightStateDir, env);
    // The snapshot copies data authority, not npm package ownership. Registry
    // records still name the original state root, which 9.1 correctly refuses
    // to refresh as foreign ownership in this copy. The real-state refresh
    // below remains mandatory and rollback-protected before final attestation.
    const runtimeMetadata = { deferredToLiveState: true };
    assertBootMetadataState(bootMetadata, 'original');
    const after = runOpenClaw(cli, ['doctor', '--session-sqlite', 'inspect', '--session-sqlite-all-agents', '--json'], env);
    assertReport(after, 'inspect');
    if (dryRun.totals.legacyEntries > 0 && after.totals.sqliteEntries < dryRun.totals.legacyEntries) {
      fail(`copied-state session inspection found too few entries (${String(after.totals.sqliteEntries)} < ${String(dryRun.totals.legacyEntries)})`);
    }
    return {
      stateCopy: true,
      authProfiles,
      sharedStateSchema,
      runtimeMetadata,
      bootState,
      deferredPluginPresence,
      missingTranscripts,
      inspectBeforeTotals: before.totals,
      dryRunTotals: dryRun.totals,
      importTotals: imported?.totals ?? null,
      inspectAfterTotals: after.totals,
      cronChanges: cronRepair?.changes?.length ?? 0,
    };
  } finally {
    removePreflightTree(preflightRoot);
  }
}

function snapshot(args) {
  const stateDir = path.resolve(args['state-dir']);
  const configPath = path.resolve(args.config);
  const packageDir = path.resolve(args['package-dir']);
  const manifestPath = path.resolve(args.manifest);
  assertNoSymlinkComponents(stateDir);
  lstatDirectory(stateDir, 'OpenClaw state directory');
  assertNoSymlinkComponents(configPath);
  const configStat = lstatRegularFile(configPath, 'OpenClaw config');
  if (configStat.uid !== process.getuid()) fail('OpenClaw config is not owned by the current user');
  assertGatewayStopped(stateDir);
  if (fs.existsSync(manifestPath)) {
    const existing = readManifest(manifestPath);
    if (existing.stateDir !== stateDir || existing.configPath !== configPath || existing.packageDir !== packageDir) {
      fail('existing migration manifest belongs to different prepare arguments');
    }
    if (existing.state === 'prepared') {
      if (sha256File(configPath) !== existing.configAfterSha256) fail('prepared migration config changed before repeated prepare');
      validateAuthoritySnapshot(existing.authoritySnapshot, stateDir, manifestPath);
      return existing;
    }
    if (existing.state === 'committed' || existing.state === 'restored') return existing;
    if (existing.state === 'preparing' && existing.phase === 'snapshot-complete') {
      if (sha256File(configPath) !== existing.configBeforeSha256) fail('config changed before migration prepare');
      verifyRestoredAuthority(existing.authoritySnapshot, stateDir);
      return existing;
    }
    fail(`migration generation is incomplete at ${existing.phase}; restore it before retrying prepare`);
  }
  assertSecureParent(manifestPath, 'migration manifest');

  const configBackupPath = `${manifestPath}.openclaw.json.before`;
  copyExclusive(configPath, configBackupPath, 0o600);
  const beforeSha256 = sha256File(configPath);
  if (sha256File(configBackupPath) !== beforeSha256) fail('OpenClaw config backup hash mismatch');
  const authoritySnapshot = snapshotAuthority(stateDir, manifestPath);
  if (sha256File(configPath) !== beforeSha256) fail('OpenClaw config changed during the authority snapshot');
  let manifest = {
    contractVersion: CONTRACT_VERSION,
    packageName: REQUIRED_PACKAGE_NAME,
    packageVersion: REQUIRED_PACKAGE_VERSION,
    state: 'preparing',
    phase: 'snapshot-complete',
    createdAt: new Date().toISOString(),
    generationId: crypto.randomUUID(),
    manifestPath,
    stateDir,
    configPath,
    packageDir,
    configBackupPath,
    configBeforeSha256: beforeSha256,
    configAfterSha256: null,
    configMode: configStat.mode & 0o777,
    configActions: [],
    authoritySnapshot,
    authorityRestoreRequired: true,
    sessionRestoreRequired: false,
    cronRestoreRequired: false,
    cronAuthorityFiles: [],
    cronMigration: null,
    copiedStatePreflight: null,
    sessionMigrationRunPath: null,
    sessionDryRunTotals: null,
    sessionImportTotals: null,
    sessionInspectTotals: null,
    sessionCodexRouteRepair: null,
  };
  // This fsynced journal exists before the first live config or session-store
  // mutation. A killed updater can therefore converge through the same restore
  // path as an ordinary failure.
  writeManifest(manifestPath, manifest);
  durableBoundary('snapshot-complete');

  return manifest;
}

async function prepare(args) {
  let manifest = snapshot(args);
  if (manifest.state !== 'preparing') return manifest;
  const {stateDir, configPath, packageDir, manifestPath, authoritySnapshot} = manifest;
  const cli = validatePackage(packageDir);
  const configStat = lstatRegularFile(configPath, 'OpenClaw config');
  const originalConfig = readJson(configPath, 'OpenClaw config');

  const genericConfig = structuredClone(originalConfig);
  const migrationEnv = buildEnvironment(stateDir, configPath);
  const migrated = await migrateConfig(genericConfig, packageDir, migrationEnv);
  const migratedConfig = migrated.config;
  const actions = migrated.actions;
  const migratedContent = `${JSON.stringify(migratedConfig, null, 2)}\n`;
  const afterSha256 = sha256Content(migratedContent);
  const cronAuthorityFiles = snapshotLegacyCronAuthority(migrated.cron, stateDir, manifestPath);
  const beforeBootDetection = fingerprintAuthority(stateDir);
  const bootContract = await loadBootStateContract(packageDir);
  const bootMetadata = await snapshotBootMetadata(bootContract, migratedConfig, manifest, migrationEnv);
  if (fingerprintAuthority(stateDir) !== beforeBootDetection) fail('boot-state inspection changed live authority');
  manifest = {
    ...manifest,
    phase: 'migration-planned',
    configAfterSha256: afterSha256,
    configActions: actions,
    cronAuthorityFiles,
    bootMetadata,
  };
  writeManifest(manifestPath, manifest, true);
  durableBoundary('migration-planned');

  let copiedStatePreflight;
  try {
    copiedStatePreflight = await runSessionPreflightOnSnapshot({
      cli,
      snapshot: authoritySnapshot,
      sourceStateDir: stateDir,
      manifestPath,
      migratedContent,
      originalConfig,
      packageDir,
      bootContract,
      bootMetadata,
    });
  } catch (error) {
    const restored = restore({ manifest: manifestPath });
    if (restored.state !== 'restored') fail('copied-state preflight rollback did not converge');
    throw error;
  }
  manifest = {
    ...manifest,
    phase: 'preflight-complete',
    copiedStatePreflight,
  };
  writeManifest(manifestPath, manifest, true);
  durableBoundary('preflight-complete');

  const env = buildEnvironment(stateDir, configPath);
  let dryRun;
  let imported;
  let inspected;
  let sessionRouteRepair = null;
  let cronRepair = null;
  try {
    manifest = {
      ...manifest,
      phase: 'live-mutation-armed',
      authorityRestoreRequired: true,
      authorityRestoreArmedAt: new Date().toISOString(),
      phaseAuthorityFingerprint: fingerprintAuthority(stateDir),
    };
    writeManifest(manifestPath, manifest, true);
    durableBoundary('live-mutation-armed');
    writeAtomic(configPath, migratedContent, configStat.mode & 0o777);
    if (sha256File(configPath) !== afterSha256) fail('OpenClaw config migration hash mismatch');
    manifest = { ...manifest, phase: 'config-written', phaseAuthorityFingerprint: fingerprintAuthority(stateDir) };
    writeManifest(manifestPath, manifest, true);
    durableBoundary('config-written');
    manifest = { ...manifest, phase: 'state-schema-migration-armed', phaseAuthorityFingerprint: fingerprintAuthority(stateDir) };
    writeManifest(manifestPath, manifest, true);
    durableBoundary('state-schema-migration-armed');
    const sharedStateSchema = await migrateSharedStateSchema(packageDir, env);
    manifest = { ...manifest, phase: 'state-schema-migrated', sharedStateSchema, phaseAuthorityFingerprint: fingerprintAuthority(stateDir) };
    writeManifest(manifestPath, manifest, true);
    durableBoundary('state-schema-migrated');
    manifest = { ...manifest, phase: 'auth-profile-migration-armed', phaseAuthorityFingerprint: fingerprintAuthority(stateDir) };
    writeManifest(manifestPath, manifest, true);
    durableBoundary('auth-profile-migration-armed');
    const authProfiles = await migrateAuthProfileStores(packageDir, migratedConfig, env);
    manifest = { ...manifest, phase: 'auth-profiles-migrated', authProfiles, phaseAuthorityFingerprint: fingerprintAuthority(stateDir) };
    writeManifest(manifestPath, manifest, true);
    durableBoundary('auth-profiles-migrated');
    dryRun = runOpenClaw(cli, ['doctor', '--session-sqlite', 'dry-run', '--session-sqlite-all-agents', '--json'], env);
    const missingTranscripts = assertReport(dryRun, 'dry-run', { stateDir });
    manifest = { ...manifest, missingTranscripts };
    if (dryRun.totals.legacyEntries > 0) {
      manifest = {
        ...manifest,
        sessionRestoreRequired: true,
        sessionRestoreArmedAt: new Date().toISOString(),
        sessionDryRunTotals: dryRun.totals,
        phase: 'session-import-armed',
        phaseAuthorityFingerprint: fingerprintAuthority(stateDir),
      };
      writeManifest(manifestPath, manifest, true);
      durableBoundary('session-import-armed');
      imported = runOpenClaw(cli, ['doctor', '--session-sqlite', 'import', '--session-sqlite-all-agents', '--json'], env);
      assertReport(imported, 'import', { requireMigrationRun: true, stateDir, missingTranscripts });
      if (imported.totals.importedEntries !== dryRun.totals.legacyEntries) {
        fail(`session import count mismatch (${String(imported.totals.importedEntries)} != ${String(dryRun.totals.legacyEntries)})`);
      }
      manifest = {
        ...manifest,
        phase: 'session-imported',
        sessionMigrationRunPath: imported.migrationRun.manifestPath,
        sessionImportTotals: imported.totals,
        phaseAuthorityFingerprint: fingerprintAuthority(stateDir),
      };
      writeManifest(manifestPath, manifest, true);
      durableBoundary('session-imported');
      manifest = { ...manifest, phase: 'session-route-repair-armed' };
      writeManifest(manifestPath, manifest, true);
      durableBoundary('session-route-repair-armed');
      sessionRouteRepair = await migrated.contract.repairSessions({
        cfg: migratedConfig,
        shouldRepair: true,
        env,
      });
      if (!isRecord(sessionRouteRepair) || !Array.isArray(sessionRouteRepair.warnings)
        || sessionRouteRepair.warnings.length > 0) {
        fail('OpenClaw Codex session route repair returned an invalid result');
      }
      const remainingSessionRoutes = await migrated.contract.repairSessions({
        cfg: migratedConfig,
        shouldRepair: false,
        env,
      });
      if (!isRecord(remainingSessionRoutes) || !Array.isArray(remainingSessionRoutes.warnings)
        || remainingSessionRoutes.warnings.length > 0) {
        fail('OpenClaw Codex session route repair left legacy session routes behind');
      }
      manifest = { ...manifest, phase: 'session-routes-repaired', phaseAuthorityFingerprint: fingerprintAuthority(stateDir) };
      writeManifest(manifestPath, manifest, true);
      durableBoundary('session-routes-repaired');
    }
    if (migrated.cron.migrationNeeded) {
      manifest = {
        ...manifest,
        cronRestoreRequired: true,
        cronRestoreArmedAt: new Date().toISOString(),
        phase: 'cron-migration-armed',
        phaseAuthorityFingerprint: fingerprintAuthority(stateDir),
      };
      writeManifest(manifestPath, manifest, true);
      durableBoundary('cron-migration-armed');
      // Jobs are the 7.1 authority needed by the 9.1 scheduler. Leave legacy
      // run logs and quarantine sidecars untouched: migrating those unrelated
      // artifacts would expand rollback beyond the tested job-store boundary.
      const boundedCronState = {
        ...migrated.cron.state,
        legacyRunLogDetected: false,
        legacyQuarantine: undefined,
      };
      cronRepair = await withMigrationEnvironment(
        env,
        () => migrated.cron.contract.applyState({
          cfg: migratedConfig,
          state: boundedCronState,
          migrateCodexModelRefs: true,
        }),
      );
      if (!isRecord(cronRepair) || !Array.isArray(cronRepair.changes)
        || !Array.isArray(cronRepair.warnings) || cronRepair.warnings.length > 0) {
        fail('OpenClaw cron job migration reported an unsafe result');
      }
      const remainingCronTargets = await withMigrationEnvironment(
        env,
        () => migrated.cron.contract.collectTargets({ cfg: migratedConfig }),
      );
      if (!isRecord(remainingCronTargets) || !Array.isArray(remainingCronTargets.targets)
        || !Array.isArray(remainingCronTargets.warnings)
        || remainingCronTargets.warnings.length > 0
        || remainingCronTargets.targets.length > 0) {
        fail('OpenClaw cron job migration left legacy Codex routes behind');
      }
      manifest = { ...manifest, phase: 'cron-migrated', phaseAuthorityFingerprint: fingerprintAuthority(stateDir) };
      writeManifest(manifestPath, manifest, true);
      durableBoundary('cron-migrated');
    }

    assertBootMetadataState(bootMetadata, 'original');
    manifest = { ...manifest, phase: 'boot-state-migration-armed', phaseAuthorityFingerprint: fingerprintAuthority(stateDir) };
    writeManifest(manifestPath, manifest, true);
    durableBoundary('boot-state-migration-armed');
    const bootState = await migrateBootState(bootContract, { sources: bootMetadata.sources, hasLegacy: bootMetadata.sources.length > 0 }, stateDir, env);
    assertBootMetadataState(bootMetadata, 'migrated');
    manifest = { ...manifest, phase: 'boot-state-migrated', bootState, phaseAuthorityFingerprint: fingerprintAuthority(stateDir) };
    writeManifest(manifestPath, manifest, true);
    durableBoundary('boot-state-migrated');

    manifest = { ...manifest, phase: 'runtime-metadata-normalize-armed', phaseAuthorityFingerprint: fingerprintAuthority(stateDir) };
    writeManifest(manifestPath, manifest, true);
    durableBoundary('runtime-metadata-normalize-armed');
    const runtimeMetadata = normalizeRuntimeMetadata(cli, env);
    manifest = { ...manifest, phase: 'runtime-metadata-normalized', runtimeMetadata, phaseAuthorityFingerprint: fingerprintAuthority(stateDir) };
    writeManifest(manifestPath, manifest, true);
    durableBoundary('runtime-metadata-normalized');
    inspected = runOpenClaw(cli, ['doctor', '--session-sqlite', 'inspect', '--session-sqlite-all-agents', '--json'], env);
    assertReport(inspected, 'inspect');
    if (dryRun.totals.legacyEntries > 0 && inspected.totals.sqliteEntries < dryRun.totals.legacyEntries) {
      fail(`session SQLite inspection found too few entries (${String(inspected.totals.sqliteEntries)} < ${String(dryRun.totals.legacyEntries)})`);
    }
    manifest = {
      ...manifest,
      phase: 'live-inspected',
      sessionInspectTotals: inspected.totals,
      phaseAuthorityFingerprint: fingerprintAuthority(stateDir),
    };
    writeManifest(manifestPath, manifest, true);
    durableBoundary('live-inspected');
  } catch (error) {
    try {
      restore({ manifest: manifestPath });
    } catch (restoreError) {
      fail(`${error instanceof Error ? error.message : String(error)}; automatic migration rollback also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
    }
    throw error;
  }

  manifest = {
    ...manifest,
    state: 'prepared',
    phase: 'prepared',
    preparedAt: new Date().toISOString(),
    // The upstream path is opaque evidence. OpenClaw owns the file, its
    // location, and its lifecycle; Portal never opens, relocates, or removes it.
    sessionMigrationRunPath: imported?.migrationRun?.manifestPath ?? null,
    sessionDryRunTotals: dryRun.totals,
    sessionImportTotals: imported?.totals ?? null,
    sessionInspectTotals: inspected.totals,
    sessionCodexRouteRepair: sessionRouteRepair ? {
      repairedStores: sessionRouteRepair.repairedStores,
      repairedSessions: sessionRouteRepair.repairedSessions,
      changes: Array.isArray(sessionRouteRepair.changes) ? sessionRouteRepair.changes.length : 0,
    } : null,
    cronMigration: cronRepair ? {
      changes: cronRepair.changes.length,
      targets: migrated.cron.targets.length,
    } : null,
    preparedAuthorityFingerprint: fingerprintAuthority(stateDir),
    preparedAuthorityContentsFingerprint: fingerprintAuthorityContents(stateDir, null, null, packageDir),
    preparedAuthorityApplicationFingerprint: fingerprintAuthorityContents(stateDir, configPath, null, packageDir),
  };
  writeManifest(manifestPath, manifest, true);
  durableBoundary('prepared');
  return manifest;
}

function restore(args) {
  const manifestPath = path.resolve(args.manifest);
  let manifest = readManifest(manifestPath);
  if (manifest.state === 'restored') {
    if (sha256File(manifest.configPath) !== manifest.configBeforeSha256) fail('restored config changed after rollback');
    verifyRestoredAuthority(manifest.authoritySnapshot, manifest.stateDir);
    assertBootMetadataState(manifest.bootMetadata, 'original');
    return manifest;
  }
  if (!['preparing', 'prepared'].includes(manifest.state)) {
    fail(`cannot restore migration in state ${String(manifest.state)}`);
  }
  assertGatewayStopped(manifest.stateDir);
  lstatRegularFile(manifest.configPath, 'OpenClaw config');
  lstatRegularFile(manifest.configBackupPath, 'OpenClaw config backup');
  if (sha256File(manifest.configBackupPath) !== manifest.configBeforeSha256) {
    fail('OpenClaw config backup hash no longer matches the migration manifest');
  }
  const currentConfigSha256 = sha256File(manifest.configPath);
  const acceptedConfigHashes = [manifest.configBeforeSha256];
  if (typeof manifest.configAfterSha256 === 'string') acceptedConfigHashes.push(manifest.configAfterSha256);
  if (!acceptedConfigHashes.includes(currentConfigSha256)) {
    fail('OpenClaw config changed after migration; refusing automatic overwrite during rollback');
  }
  const indeterminateMutationPhases = new Set([
    'state-schema-migration-armed',
    'auth-profile-migration-armed',
    'session-import-armed',
    'session-route-repair-armed',
    'cron-migration-armed',
    'runtime-metadata-normalize-armed',
    'boot-state-migration-armed',
    'restore-armed',
    'authority-restored',
    'config-restored',
  ]);
  const currentAuthorityFingerprint = fingerprintAuthority(manifest.stateDir);
  const preparedGeneration = manifest.state === 'prepared' && manifest.phase === 'prepared';
  const byteEquivalent = currentAuthorityFingerprint === manifest.phaseAuthorityFingerprint
    && currentAuthorityFingerprint === manifest.preparedAuthorityFingerprint;
  // An old journal has no content receipt and retains its original byte gate.
  // No rows, schema, row identity or non-database files are exempted.
  const contentEquivalent = preparedGeneration && !byteEquivalent
    && typeof manifest.preparedAuthorityContentsFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(manifest.preparedAuthorityContentsFingerprint)
    && fingerprintAuthorityContents(manifest.stateDir, null, null, manifest.packageDir) === manifest.preparedAuthorityContentsFingerprint;
  const applicationEquivalent = preparedGeneration && !byteEquivalent && !contentEquivalent
    && typeof manifest.preparedAuthorityApplicationFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(manifest.preparedAuthorityApplicationFingerprint)
    && fingerprintAuthorityContents(manifest.stateDir, manifest.configPath, null, manifest.packageDir)
      === manifest.preparedAuthorityApplicationFingerprint;
  const generatedReceiptPath = `${manifestPath}.runtime-bookkeeping.json`;
  if (applicationEquivalent) {
    if (fingerprintAuthorityContents(manifest.stateDir, manifest.configPath, generatedReceiptPath, manifest.packageDir)
      !== manifest.preparedAuthorityApplicationFingerprint) fail('application authority changed while preserving rollback receipts');
  }
  if (typeof manifest.phaseAuthorityFingerprint === 'string'
    && !indeterminateMutationPhases.has(manifest.phase)
    && currentAuthorityFingerprint !== manifest.phaseAuthorityFingerprint
    && !contentEquivalent && !applicationEquivalent) {
    fail('OpenClaw authority changed after the last durable migration boundary; refusing ambiguous rollback');
  }
  if (manifest.state === 'prepared' && manifest.phase === 'prepared') {
    if (typeof manifest.preparedAuthorityFingerprint !== 'string'
      || (currentAuthorityFingerprint !== manifest.preparedAuthorityFingerprint && !contentEquivalent && !applicationEquivalent)) {
      fail('OpenClaw authority changed after migration prepare; refusing ambiguous rollback');
    }
  }
  assertBootMetadataState(manifest.bootMetadata, preparedGeneration ? 'migrated' : 'recoverable');
  manifest = {
    ...manifest,
    phase: 'restore-armed',
    ...(applicationEquivalent ? { generatedReceiptPath, generatedReceiptSha256: sha256File(generatedReceiptPath) } : {}),
    restoreArmedAt: manifest.restoreArmedAt ?? new Date().toISOString(),
  };
  writeManifest(manifestPath, manifest, true);
  durableBoundary('restore-armed');
  if (manifest.authorityRestoreRequired) {
    materializeAuthoritySnapshot(manifest.authoritySnapshot, manifest.stateDir, manifest.stateDir, true);
  }
  restoreBootMetadata(manifest.bootMetadata);
  removePreflightTree(`${manifestPath}.preflight`);
  manifest = { ...manifest, phase: 'authority-restored' };
  writeManifest(manifestPath, manifest, true);
  durableBoundary('authority-restored');
  if (currentConfigSha256 !== manifest.configBeforeSha256) {
    writeAtomic(manifest.configPath, fs.readFileSync(manifest.configBackupPath, 'utf8'), manifest.configMode);
  }
  if (sha256File(manifest.configPath) !== manifest.configBeforeSha256) fail('OpenClaw config restore hash mismatch');
  verifyRestoredAuthority(manifest.authoritySnapshot, manifest.stateDir);
  manifest = { ...manifest, phase: 'config-restored' };
  writeManifest(manifestPath, manifest, true);
  durableBoundary('config-restored');
  const restored = {
    ...manifest,
    state: 'restored',
    phase: 'restored',
    restoredAt: new Date().toISOString(),
    sessionRestoreTotals: null,
    exactAuthorityRestore: true,
  };
  writeManifest(manifestPath, restored, true);
  durableBoundary('restored');
  return restored;
}

function commit(args) {
  const manifestPath = path.resolve(args.manifest);
  const manifest = readManifest(manifestPath);
  if (manifest.state === 'committed') {
    if (sha256File(manifest.configPath) !== manifest.finalConfigSha256) fail('committed config changed after migration commit');
    return manifest;
  }
  if (manifest.state !== 'prepared') fail(`cannot commit migration in state ${String(manifest.state)}`);
  lstatRegularFile(manifest.configPath, 'OpenClaw config');
  const finalConfigSha256 = sha256File(manifest.configPath);
  const armed = {
    ...manifest,
    phase: 'commit-armed',
    finalConfigSha256,
  };
  writeManifest(manifestPath, armed, true);
  durableBoundary('commit-armed');
  const committed = {
    ...armed,
    state: 'committed',
    phase: 'committed',
    committedAt: new Date().toISOString(),
  };
  writeManifest(manifestPath, committed, true);
  durableBoundary('committed');
  return committed;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = args.command === 'snapshot' ? snapshot(args) : (args.command === 'prepare' ? await prepare(args) : (args.command === 'restore' ? restore(args) : commit(args)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
