/**
 * Root operator import of a named App credential that is already on this
 * machine (for example a login file left by an earlier host service), so
 * nobody has to retype it.
 *
 * Run as root from the installed Portal backend folder, so the Portal's .env
 * (database and encryption key) is loaded:
 *   cd /opt/bridgesllm/portal/backend && node dist/cli/appCredentialImport.js \
 *     --app <appId> --slot <slot> --from-file <absolute path> [--replace] [--dry-run] [--allow-multiple-links]
 *
 * - The command loads backend/.env itself before it touches the database, and
 *   prints nothing but its receipt or one safe failure line.
 * - The value is read from the file inside this process only: never from
 *   argv, the environment or stdin. Symlinks (anywhere in the path), non-regular
 *   files, files over 64 KiB and world-readable, world-writable or
 *   group-writable files are refused; tighten the file first (chmod o-rwx,g-w
 *   <file>). A file with several hard links is refused unless
 *   --allow-multiple-links is given after checking every link. Two reads and the
 *   inode state are compared to detect ordinary changes; that is not an atomic
 *   snapshot against a writable shared mapping, so import only a quiescent
 *   source with trusted ownership and no other open or mapped writer.
 * - The App must be a live full-stack Project App. An existing slot is only
 *   overwritten with --replace. --dry-run validates everything and writes nothing.
 * - Storage and audit are the Owner API's (actor "operator"). The receipt
 *   prints nothing derived from the value except its byte length. The App
 *   receives the credential at /portal/credentials/<slot> on its next start
 *   or redeploy.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { APP_CREDENTIAL_MAX_BYTES, AppCredentialError, requireAppCredentialAppId, requireAppCredentialSlot } from '../services/appCredentials/policy';

// '../config/database' constructs the Prisma client when it is first imported
// and needs DATABASE_URL, which a root login shell does not have until the
// installed .env is loaded. The store (and through it the database) is
// therefore imported only inside runImport, after loadInstalledEnvironment and
// inside the safe failure boundary below.
let storeLoaded = false;
async function credentialStore() {
  const store = await import('../services/appCredentials/store');
  storeLoaded = true;
  return store;
}

/**
 * Load the installed Portal environment (backend/.env, a link to
 * .env.production) the way the service's own config does. Variables that are
 * already set win; nothing is printed.
 */
export function loadInstalledEnvironment(cwd: string = process.cwd()): void {
  dotenv.config({ path: path.join(cwd, '.env'), quiet: true });
}

export class ImportError extends Error {}

export interface ImportArgs {
  appId: string;
  slot: string;
  fromFile: string;
  replace: boolean;
  dryRun: boolean;
  allowMultipleLinks: boolean;
}

const VALUE_FLAGS = new Set(['--app', '--slot', '--from-file']);
const SWITCHES = new Set(['--replace', '--dry-run', '--allow-multiple-links']);

export function parseArgs(argv: string[]): ImportArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (SWITCHES.has(flag)) {
      if (switches.has(flag)) throw new ImportError(`${flag} was given twice`);
      switches.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new ImportError(`Unknown argument at position ${index + 1}. Values are read only from --from-file.`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new ImportError(`${flag} needs a value`);
    if (values.has(flag)) throw new ImportError(`${flag} was given twice`);
    values.set(flag, value);
    index += 1;
  }
  const missing = [...VALUE_FLAGS].filter((flag) => !values.has(flag));
  if (missing.length) throw new ImportError(`Required: ${missing.join(', ')}`);
  const fromFile = values.get('--from-file')!;
  if (!path.isAbsolute(fromFile) || path.normalize(fromFile) !== fromFile || fromFile.includes('\0') || fromFile.endsWith('/')) {
    throw new ImportError('--from-file must be a normalized absolute file path');
  }
  try {
    return {
      appId: requireAppCredentialAppId(values.get('--app')),
      slot: requireAppCredentialSlot(values.get('--slot')),
      fromFile,
      replace: switches.has('--replace'),
      dryRun: switches.has('--dry-run'),
      allowMultipleLinks: switches.has('--allow-multiple-links'),
    };
  } catch (error) {
    if (error instanceof AppCredentialError) throw new ImportError(error.message);
    throw error;
  }
}

function readWhole(fd: number): Buffer {
  const buffer = Buffer.alloc(APP_CREDENTIAL_MAX_BYTES + 1);
  let length = 0;
  for (;;) {
    const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
    if (read === 0) break;
    length += read;
    if (length > APP_CREDENTIAL_MAX_BYTES) throw new ImportError(`The source file is larger than ${APP_CREDENTIAL_MAX_BYTES} bytes`);
  }
  return buffer.subarray(0, length);
}

function sameInodeState(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && before.nlink === after.nlink;
}

/**
 * Read the source file through one descriptor opened without following a
 * final symlink, after proving no path component is a symlink. Every check
 * is on the opened file itself. The file is read twice and its inode state
 * compared before and after to detect ordinary changes. A writer holding a
 * shared writable mapping can still change bytes without touching timestamps,
 * so this is not an atomic snapshot: the operator keeps the source quiescent. Group-writable files and files with more than one hard link (some
 * other path could change them) are refused; the latter only proceeds with
 * --allow-multiple-links after the operator has checked every link.
 */
export function readSourceFile(file: string, options: { allowMultipleLinks?: boolean } = {}): Buffer {
  let canonical: string;
  try { canonical = fs.realpathSync.native(file); }
  catch (error: any) {
    throw new ImportError(error?.code === 'ENOENT' ? 'The source file does not exist' : 'The source file path could not be resolved');
  }
  if (canonical !== file) throw new ImportError('The source path goes through a symbolic link; give the real path');
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY);
  } catch (error: any) {
    throw new ImportError(error?.code === 'ELOOP' ? 'The source file is a symbolic link' : `The source file could not be opened (${error?.code || 'error'})`);
  }
  try {
    // The opened inode must still be reachable at exactly this path.
    let opened = '';
    try { opened = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* checked below */ }
    if (opened !== file) throw new ImportError('The source path changed while it was being opened');
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new ImportError('The source is not a regular file');
    if ((stat.mode & 0o004n) !== 0n) throw new ImportError('The source file is world-readable; run chmod o-rwx on it first');
    if ((stat.mode & 0o002n) !== 0n) throw new ImportError('The source file is world-writable; run chmod o-rwx on it first');
    if ((stat.mode & 0o020n) !== 0n) throw new ImportError('The source file is group-writable; run chmod g-w on it first');
    if (stat.nlink > 1n && !options.allowMultipleLinks) {
      throw new ImportError(`The source file has ${stat.nlink} hard links, so another path can change it. Check every link, then pass --allow-multiple-links`);
    }
    if (stat.size > BigInt(APP_CREDENTIAL_MAX_BYTES)) throw new ImportError(`The source file is larger than ${APP_CREDENTIAL_MAX_BYTES} bytes`);
    const first = readWhole(fd);
    const second = readWhole(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (!sameInodeState(stat, after) || !first.equals(second) || BigInt(first.length) !== after.size) {
      throw new ImportError('The source file changed while it was being read; stop whatever is writing it and retry');
    }
    second.fill(0);
    return first;
  } finally {
    fs.closeSync(fd);
  }
}

export interface ImportReceipt {
  app: string;
  appName: string;
  slot: string;
  bytes: number;
  storedAt: string | null;
  revision: number | null;
  replaced: boolean;
  dryRun: boolean;
  keyCheck: 'verified' | 'no-existing-secret';
  appliesOn: string;
}

export async function runImport(argv: string[], options: { getuid?: () => number } = {}): Promise<ImportReceipt> {
  const getuid = options.getuid || process.getuid?.bind(process);
  if (!getuid || getuid() !== 0) throw new ImportError('Run as root');
  const args = parseArgs(argv);
  if (!process.env.PORTAL_ENCRYPTION_KEY?.trim() && !process.env.JWT_SECRET?.trim()) {
    throw new ImportError('The Portal environment is not loaded (no encryption key). Run from the installed Portal backend folder.');
  }
  const bytes = readSourceFile(args.fromFile, { allowMultipleLinks: args.allowMultipleLinks });
  const { requireCredentialApp, setAppCredential, verifyPortalEncryptionKey } = await credentialStore();
  const keyCheck = await verifyPortalEncryptionKey();
  const app = await requireCredentialApp(args.appId);
  const receipt = await setAppCredential({
    appId: app.id,
    slot: args.slot,
    value: bytes,
    actor: { kind: 'operator' },
    expectedRevision: args.replace ? undefined : null,
    dryRun: args.dryRun,
  });
  return {
    app: app.id,
    appName: app.name,
    slot: receipt.slot,
    bytes: receipt.bytes,
    storedAt: args.dryRun ? null : receipt.storedAt,
    revision: args.dryRun ? null : receipt.revision,
    replaced: receipt.replaced,
    dryRun: args.dryRun,
    keyCheck,
    appliesOn: `Mounted read-only at /portal/credentials/${receipt.slot} on the App's next start or redeploy.`,
  };
}

/** Messages that are safe to print; anything else is reported by type only. */
const DATABASE_UNAVAILABLE_CODES = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1010', 'P1011', 'P1017', 'ECONNREFUSED']);

export function safeFailureMessage(error: unknown): string {
  if (error instanceof ImportError || error instanceof AppCredentialError) return error.message;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && DATABASE_UNAVAILABLE_CODES.has(code)) {
    return `the Portal database could not be reached or refused the connection (${code}). Run from the installed Portal backend folder while the Portal database is running; nothing was printed from the source file`;
  }
  return `internal error (${typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : (error as { name?: string })?.name || 'Error'}); nothing was printed from the source file`;
}

/**
 * Run `work` with all console and stdio output suppressed. Libraries print on
 * their own (Prisma logs a whole failed invocation, query arguments included),
 * so the only output this command ever produces is the receipt or the safe
 * failure line written after output is restored.
 */
export async function withoutLibraryOutput<T>(work: () => Promise<T>): Promise<T> {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const savedConsole = methods.map((name) => console[name]);
  const savedStdout = process.stdout.write;
  const savedStderr = process.stderr.write;
  for (const name of methods) console[name] = () => undefined;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await work();
  } finally {
    methods.forEach((name, index) => { console[name] = savedConsole[index]; });
    process.stdout.write = savedStdout;
    process.stderr.write = savedStderr;
  }
}

/** Close the database client only if this run created one; never construct one here. */
async function disconnectIfLoaded(): Promise<void> {
  if (!storeLoaded) return;
  try {
    const { prisma } = await import('../config/database');
    await prisma.$disconnect();
  } catch { /* nothing to report: the outcome is already decided */ }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let receipt: ImportReceipt;
  try {
    loadInstalledEnvironment();
    receipt = await withoutLibraryOutput(() => runImport(argv));
  } catch (error) {
    await withoutLibraryOutput(disconnectIfLoaded);
    console.error(`app-credential-import: ${safeFailureMessage(error)}`);
    return 2;
  }
  await withoutLibraryOutput(disconnectIfLoaded);
  console.log(JSON.stringify(receipt, null, 2));
  return 0;
}

if (require.main === module) {
  // Exit explicitly so a lingering database pool cannot hold the shell open.
  void main().then((code) => process.exit(code));
}
