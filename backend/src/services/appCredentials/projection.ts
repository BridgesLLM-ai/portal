/**
 * Runtime projection of named App credentials into one resident App container.
 *
 * Each container start gets a fresh directory on tmpfs,
 * /run/bridgesllm/app-credentials/<appId>-<random>, holding one file per slot
 * (file name = slot name). Files are 0400 and the directory 0500, all owned by
 * the App user 1000:1000; the directory is bind-mounted read-only at
 * /portal/credentials and PORTAL_CREDENTIALS_DIR names it. Values never become
 * environment variables (those show in `docker inspect`), never touch
 * persistent storage, and the directory is removed when that container is
 * removed, replaced, fails to start or is found exited, and at Portal boot.
 *
 * Scope: only the App's own resident container. Project Chat and OpenClaw
 * sandboxes, other Apps and lifecycle jobs never receive it.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ensureRuntimeDirectory } from '../../utils/runtimeDirectory';
import {
  APP_CREDENTIAL_APP_ID_PATTERN,
  APP_CREDENTIAL_MAX_BYTES,
  APP_CREDENTIAL_MAX_SLOTS,
  APP_CREDENTIALS_CONTAINER_DIRECTORY,
  AppCredentialError,
  isAppCredentialSlot,
} from './policy';

export const APP_CREDENTIALS_RUNTIME_ROOT = '/run/bridgesllm/app-credentials';
export const APP_CREDENTIAL_UID = 1000;
export const APP_CREDENTIAL_GID = 1000;
const TMPFS_MAGIC = 0x01021994;
const DIRECTORY_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{16})$/;

export interface AppCredentialAttachment {
  appId: string;
  /** Credential-set revision this directory was written from (not a value digest). */
  revision: number;
  slots: readonly string[];
  sourceDirectory: string;
  containerDirectory: typeof APP_CREDENTIALS_CONTAINER_DIRECTORY;
  directory: { device: string; inode: string };
}

let runtimeRoot = APP_CREDENTIALS_RUNTIME_ROOT;
let filesystemType = (directory: string): number => Number(fs.statfsSync(directory).type);

function unavailable(message: string): AppCredentialError {
  return new AppCredentialError('APP_CREDENTIAL_PROJECTION_UNAVAILABLE', message, 503);
}

/** Root-owned 0700 directory on tmpfs; fails closed on anything else. */
function requireProjectionRoot(): string {
  let root: string;
  try {
    root = ensureRuntimeDirectory(runtimeRoot, { mode: 0o700, enforceMode: true });
  } catch {
    throw unavailable('The App credential runtime directory is unsafe or could not be created.');
  }
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw unavailable('The App credential runtime directory is not a private root-owned directory.');
  }
  if (filesystemType(root) !== TMPFS_MAGIC) {
    throw unavailable('App credentials are only written to tmpfs, and the runtime directory is not on tmpfs. The App was not started.');
  }
  return root;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
}

/** Write a fresh credential directory for one container start. */
export function materializeAppCredentials(input: {
  appId: string;
  revision: number;
  entries: ReadonlyArray<{ slot: string; value: string }>;
}): AppCredentialAttachment {
  const slots = input.entries.map((entry) => entry.slot);
  if (!APP_CREDENTIAL_APP_ID_PATTERN.test(input.appId) || !Number.isSafeInteger(input.revision) || input.revision < 1
    || slots.length === 0 || slots.length > APP_CREDENTIAL_MAX_SLOTS || !slots.every(isAppCredentialSlot)
    || new Set(slots).size !== slots.length
    || input.entries.some((entry) => typeof entry.value !== 'string' || !entry.value
      || Buffer.byteLength(entry.value, 'utf8') > APP_CREDENTIAL_MAX_BYTES)) {
    throw new Error('App credential projection input is invalid');
  }
  const root = requireProjectionRoot();
  const sourceDirectory = path.join(root, `${input.appId}-${crypto.randomBytes(8).toString('hex')}`);
  fs.mkdirSync(sourceDirectory, { mode: 0o700 });
  try {
    for (const entry of input.entries) {
      const fd = fs.openSync(
        path.join(sourceDirectory, entry.slot),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeAll(fd, Buffer.from(entry.value, 'utf8'));
        fs.fchownSync(fd, APP_CREDENTIAL_UID, APP_CREDENTIAL_GID);
        fs.fchmodSync(fd, 0o400);
      } finally {
        fs.closeSync(fd);
      }
    }
    fs.chownSync(sourceDirectory, APP_CREDENTIAL_UID, APP_CREDENTIAL_GID);
    fs.chmodSync(sourceDirectory, 0o500);
    const stat = fs.lstatSync(sourceDirectory, { bigint: true });
    const attachment: AppCredentialAttachment = Object.freeze({
      appId: input.appId,
      revision: input.revision,
      slots: Object.freeze([...slots].sort()),
      sourceDirectory,
      containerDirectory: APP_CREDENTIALS_CONTAINER_DIRECTORY,
      directory: Object.freeze({ device: stat.dev.toString(), inode: stat.ino.toString() }),
    });
    attestAppCredentialDirectory(attachment);
    return attachment;
  } catch (error) {
    fs.rmSync(sourceDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Re-prove the exact directory inode, its mode/ownership and its exact file set. */
export function attestAppCredentialDirectory(attachment: AppCredentialAttachment): void {
  const fail = (): never => { throw unavailable('The App credential directory changed or is unsafe.'); };
  const match = DIRECTORY_NAME.exec(path.basename(attachment.sourceDirectory));
  if (!match || match[1] !== attachment.appId || path.dirname(attachment.sourceDirectory) !== path.resolve(runtimeRoot)
    || attachment.containerDirectory !== APP_CREDENTIALS_CONTAINER_DIRECTORY) fail();
  let stat: fs.BigIntStats;
  try { stat = fs.lstatSync(attachment.sourceDirectory, { bigint: true }); } catch { return fail(); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || Number(stat.uid) !== APP_CREDENTIAL_UID
    || Number(stat.gid) !== APP_CREDENTIAL_GID || Number(stat.mode & 0o7777n) !== 0o500
    || stat.dev.toString() !== attachment.directory.device || stat.ino.toString() !== attachment.directory.inode
    || fs.realpathSync(attachment.sourceDirectory) !== attachment.sourceDirectory
    || filesystemType(attachment.sourceDirectory) !== TMPFS_MAGIC) fail();
  const names = fs.readdirSync(attachment.sourceDirectory).sort();
  if (JSON.stringify(names) !== JSON.stringify([...attachment.slots].sort())) fail();
  for (const name of names) {
    const file = fs.lstatSync(path.join(attachment.sourceDirectory, name));
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== APP_CREDENTIAL_UID || file.gid !== APP_CREDENTIAL_GID
      || (file.mode & 0o7777) !== 0o400 || file.nlink !== 1 || file.size > APP_CREDENTIAL_MAX_BYTES) fail();
  }
}

function isProjectionEntry(name: string, appId?: string): boolean {
  const match = DIRECTORY_NAME.exec(name);
  return Boolean(match && (appId === undefined || match[1] === appId));
}

function removeEntries(appId?: string): number {
  let names: string[];
  try { names = fs.readdirSync(runtimeRoot); }
  catch (error: any) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    if (!isProjectionEntry(name, appId)) continue;
    fs.rmSync(path.join(runtimeRoot, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Remove one container's directory (idempotent). */
export function removeAppCredentialDirectory(sourceDirectory: string): void {
  if (path.dirname(sourceDirectory) !== path.resolve(runtimeRoot) || !isProjectionEntry(path.basename(sourceDirectory))) {
    throw new Error('Refusing to remove a path outside the App credential runtime directory');
  }
  fs.rmSync(sourceDirectory, { recursive: true, force: true });
}

/** Remove every directory of one App (its container was removed or replaced). */
export function removeAppCredentialProjections(appId: string): number {
  if (!APP_CREDENTIAL_APP_ID_PATTERN.test(appId)) return 0;
  return removeEntries(appId);
}

/** Portal boot: no App container is adopted across a restart, so none may keep a directory. */
export function sweepAppCredentialProjections(): number {
  return removeEntries();
}

export const __appCredentialProjectionTest = {
  setRuntimeRoot(root: string): void { runtimeRoot = root; },
  setFilesystemType(probe: (directory: string) => number): void { filesystemType = probe; },
  reset(): void {
    runtimeRoot = APP_CREDENTIALS_RUNTIME_ROOT;
    filesystemType = (directory: string): number => Number(fs.statfsSync(directory).type);
  },
  TMPFS_MAGIC,
};
