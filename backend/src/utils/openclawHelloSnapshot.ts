/**
 * The last authenticated OpenClaw Gateway hello, kept on disk for the Portal's
 * tool updater. The gateway lists its methods only in the hello frame, and no
 * OpenClaw command prints them, so after an OpenClaw update toolctl reads this
 * file to check that chat's required methods are offered (DESIGN b.4 OC-HELLO).
 *
 * Root-owned 0600 regular file, replaced atomically (tmp + fsync + rename +
 * directory fsync). Writing it never blocks or fails the gateway connection:
 * each write is queued behind the previous one and a problem is logged once.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { capabilitiesFromHello } from '../services/openClawCompatibility';

export const OPENCLAW_HELLO_SNAPSHOT_SCHEMA = 'bridgesllm.openclaw-hello.v1';
/** Outside toolctl's run directories and outside chat's mutation-epoch directories. */
export const OPENCLAW_HELLO_SNAPSHOT_PATH = '/var/lib/bridgesllm/openclaw-hello.v1.json';
/** toolctl refuses a larger file (installer/tools/bridgesllm-toolctl.py OPENCLAW_HELLO_SNAPSHOT_MAX_BYTES). */
export const OPENCLAW_HELLO_SNAPSHOT_MAX_BYTES = 256 * 1024;
const MAX_NAME_LENGTH = 200;

export interface OpenClawHelloSnapshot {
  schema: typeof OPENCLAW_HELLO_SNAPSHOT_SCHEMA;
  serverVersion: string;
  methods: string[];
  events: string[];
  receivedAt: string;
}

/** The filesystem calls the writer makes; tests pass a fake. */
export interface HelloSnapshotFs {
  lstat(target: string): Promise<{ isDirectory(): boolean; uid: number; mode: number }>;
  open(target: string, flags: number, mode?: number): Promise<{
    writeFile(data: string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  rename(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
}

export interface HelloSnapshotOptions {
  fs?: HelloSnapshotFs;
  now?: () => Date;
  euid?: () => number;
  /** Test-only target; production always writes OPENCLAW_HELLO_SNAPSHOT_PATH. */
  path?: string;
}

/** What the hello proves, or null when it has no server version or exceeds the bounds (never truncated). */
export function buildOpenClawHelloSnapshot(hello: unknown, receivedAt: Date): OpenClawHelloSnapshot | null {
  const capabilities = capabilitiesFromHello(hello);
  if (!capabilities.version || capabilities.version.length > MAX_NAME_LENGTH) return null;
  const names = [...capabilities.methods, ...capabilities.events];
  if (names.some((name) => name.length > MAX_NAME_LENGTH)) return null;
  return {
    schema: OPENCLAW_HELLO_SNAPSHOT_SCHEMA,
    serverVersion: capabilities.version,
    methods: [...capabilities.methods],
    events: [...capabilities.events],
    receivedAt: receivedAt.toISOString(),
  };
}

/** The fixed path; under jest only an explicit absolute test path, so tests never touch the host. */
function snapshotTarget(options: HelloSnapshotOptions): string | null {
  if (process.env.NODE_ENV !== 'test') return OPENCLAW_HELLO_SNAPSHOT_PATH;
  const override = options.path ?? process.env.BRIDGESLLM_OPENCLAW_HELLO_SNAPSHOT;
  return override && path.isAbsolute(override) && path.normalize(override) === override ? override : null;
}

/** Write one snapshot. Resolves with the outcome; never rejects. */
export async function writeOpenClawHelloSnapshot(
  hello: unknown,
  options: HelloSnapshotOptions = {},
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const target = snapshotTarget(options);
  if (!target) return { ok: false, reason: 'no snapshot path in this environment' };
  const snapshot = buildOpenClawHelloSnapshot(hello, (options.now ?? (() => new Date()))());
  if (!snapshot) return { ok: false, reason: 'the hello has no server version, or a name longer than 200 characters' };
  const data = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(data) > OPENCLAW_HELLO_SNAPSHOT_MAX_BYTES) {
    return { ok: false, reason: `the hello is larger than ${OPENCLAW_HELLO_SNAPSHOT_MAX_BYTES} bytes` };
  }
  const files = options.fs ?? (fs.promises as unknown as HelloSnapshotFs);
  const euid = (options.euid ?? (() => (typeof process.geteuid === 'function' ? process.geteuid() : -1)))();
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let created = false;
  try {
    if (euid !== 0) return { ok: false, reason: 'the Portal backend is not running as root' };
    const parent = await files.lstat(directory);
    if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) {
      return { ok: false, reason: `${directory} is not a root-owned directory closed to group and other writes` };
    }
    const handle = await files.open(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await files.rename(temporary, target);
    created = false;
    const directoryHandle = await files.open(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return { ok: true, path: target };
  } catch (error: any) {
    if (created) await files.unlink(temporary).catch(() => undefined);
    return { ok: false, reason: String(error?.code || error?.message || error).slice(0, 200) };
  }
}

let writeQueue: Promise<void> = Promise.resolve();
let problemLogged = false;

/**
 * Record the hello of a connection that just authenticated. Returns at once;
 * writes run one after another in hello order, and a failure is logged once
 * until a later write succeeds.
 */
export function recordOpenClawHelloSnapshot(hello: unknown, options: HelloSnapshotOptions = {}): Promise<void> {
  if (!snapshotTarget(options)) return writeQueue;
  const receivedAt = (options.now ?? (() => new Date()))();
  writeQueue = writeQueue
    .then(() => writeOpenClawHelloSnapshot(hello, { ...options, now: () => receivedAt }))
    .then((outcome) => {
      if (outcome.ok) {
        problemLogged = false;
      } else if (!problemLogged) {
        problemLogged = true;
        console.warn(`[OpenClaw hello] Could not record the gateway's method list for Portal updates: ${outcome.reason}`);
      }
    })
    .catch(() => undefined);
  return writeQueue;
}
