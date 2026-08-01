import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { ensureRuntimeDirectory } from '../utils/runtimeDirectory';

export const HOST_AGENT_RUN_RUNTIME_ROOT = '/run/bridgesllm/host-agent-runs';

const ACTIVATION_HANDSHAKE_TIMEOUT_MS = 30_000;
const UNIX_SOCKET_PATH_MAX_BYTES = 100;
const TARGET_ENVIRONMENT_MAX_BYTES = 256 * 1024;
const SCOPE_UNIT_PATTERN = /^bridgesllm-host-agent-([0-9a-f]{32})\.scope$/;
const SCOPE_TAG_PATTERN = /^[0-9a-f]{64}$/;

// Fixed bootstrap used by every host systemd-scope consumer. The systemd-run
// launcher receives only this wrapper and a root-only gate identity. The target
// environment and release byte arrive over the authenticated socket only after
// the caller has durably persisted the exact scope identity.
export const HOST_AGENT_RUN_ACTIVATION_WRAPPER_SOURCE = `
const net = require('net');
const { spawn } = require('child_process');
const [socketPath, scopeTag, command, ...args] = process.argv.slice(1);
let settled = false;
let target = null;
let phase = 'environment';
let inbound = Buffer.alloc(0);
let expectedEnvironmentBytes = null;
let targetEnvironment = null;
const failClosed = (code = 125) => {
  if (settled) return;
  settled = true;
  try { socket.destroy(); } catch {}
  process.exit(code);
};
if (!socketPath || !/^[0-9a-f]{64}$/.test(scopeTag || '') || !command) process.exit(126);
const socket = net.createConnection({ path: socketPath });
const deadline = setTimeout(() => failClosed(124), 35000);
socket.once('connect', () => socket.write(scopeTag + '\\n'));
socket.on('data', (chunk) => {
  if (settled || !Buffer.isBuffer(chunk)) return failClosed();
  inbound = Buffer.concat([inbound, chunk]);
  if (phase === 'environment') {
    if (expectedEnvironmentBytes === null) {
      const newline = inbound.indexOf(0x0a);
      if (newline < 0) {
        if (inbound.length > 32) failClosed();
        return;
      }
      const header = inbound.subarray(0, newline).toString('ascii');
      if (!/^E[1-9][0-9]{0,7}$/.test(header)) return failClosed();
      expectedEnvironmentBytes = Number(header.slice(1));
      if (!Number.isSafeInteger(expectedEnvironmentBytes) || expectedEnvironmentBytes > 400000) {
        return failClosed();
      }
      inbound = inbound.subarray(newline + 1);
    }
    if (inbound.length < expectedEnvironmentBytes) return;
    if (inbound.length !== expectedEnvironmentBytes) return failClosed();
    try {
      const decoded = Buffer.from(inbound.toString('ascii'), 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return failClosed();
      targetEnvironment = Object.create(null);
      for (const [key, value] of Object.entries(parsed)) {
        if (!key || key.includes('\\0') || key.includes('=') || typeof value !== 'string' || value.includes('\\0')) {
          return failClosed();
        }
        targetEnvironment[key] = value;
      }
    } catch {
      return failClosed();
    }
    phase = 'release';
    inbound = Buffer.alloc(0);
    socket.write('A');
    return;
  }

  if (inbound.length !== 1 || inbound[0] !== 0x31 || !targetEnvironment) return failClosed();
  settled = true;
  clearTimeout(deadline);
  socket.destroy();
  target = spawn(command, args, {
    cwd: process.cwd(),
    env: targetEnvironment,
    stdio: 'inherit',
    shell: false,
  });
  target.once('error', () => process.exit(127));
  target.once('exit', (code, signal) => {
    if (signal) {
      try {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
        return;
      } catch {}
    }
    process.exit(Number.isInteger(code) ? code : 1);
  });
});
socket.once('end', () => failClosed());
socket.once('close', () => failClosed());
socket.once('error', () => failClosed());
`;

export interface HostAgentRunActivationGate {
  readonly socketPath: string;
  readonly ready: Promise<void>;
  prepareTargetEnvironment(environment: NodeJS.ProcessEnv): void;
  release(): Promise<void>;
  abort(): Promise<void>;
}

function validateScopeIdentity(scopeUnit: string, scopeTag: string): RegExpMatchArray {
  const match = scopeUnit.match(SCOPE_UNIT_PATTERN);
  if (!match || !SCOPE_TAG_PATTERN.test(scopeTag)) {
    throw new Error('Host agent activation gate identity is invalid');
  }
  return match;
}

export function initializeHostAgentRunGateStorage(): string {
  const runtimeRoot = ensureRuntimeDirectory(
    HOST_AGENT_RUN_RUNTIME_ROOT,
    { mode: 0o700, enforceMode: true },
  );
  const stat = fs.lstatSync(runtimeRoot);
  if (
    stat.uid !== 0
    || (stat.mode & 0o777) !== 0o700
    || stat.isSymbolicLink()
    || !stat.isDirectory()
  ) {
    throw new Error('Host agent activation gate root is not root-owned mode 0700');
  }
  return runtimeRoot;
}

export function hostAgentRunGatePath(scopeUnit: string, scopeTag: string): string {
  const match = validateScopeIdentity(scopeUnit, scopeTag);
  const socketPath = path.join(
    initializeHostAgentRunGateStorage(),
    `gate-${match[1]}.sock`,
  );
  if (Buffer.byteLength(socketPath, 'utf8') > UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new Error('Host agent activation socket path exceeds the Unix socket limit');
  }
  return socketPath;
}

export function assertCanonicalHostAgentRunGatePath(
  socketPath: string,
  scopeUnit: string,
  scopeTag: string,
): void {
  if (
    typeof socketPath !== 'string'
    || socketPath.includes('\0')
    || path.resolve(socketPath) !== socketPath
    || socketPath !== hostAgentRunGatePath(scopeUnit, scopeTag)
  ) {
    throw new Error('Host agent activation socket path is not canonical');
  }
}

export function removePersistedHostAgentRunGate(
  socketPath: string,
  scopeUnit: string,
  scopeTag: string,
): void {
  assertCanonicalHostAgentRunGatePath(socketPath, scopeUnit, scopeTag);
  try {
    const stat = fs.lstatSync(socketPath);
    if (
      stat.uid !== 0
      || stat.isSymbolicLink()
      || !stat.isSocket()
      || (stat.mode & 0o077) !== 0
    ) {
      throw new Error('Host agent activation socket identity drifted');
    }
    fs.unlinkSync(socketPath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function createHostAgentRunActivationGate(
  scopeUnit: string,
  scopeTag: string,
): Promise<HostAgentRunActivationGate> {
  if (process.platform !== 'linux') {
    throw new Error('Host-native agent runs require a Linux activation gate');
  }
  const socketPath = hostAgentRunGatePath(scopeUnit, scopeTag);
  if (fs.existsSync(socketPath)) {
    throw new Error('Host agent activation socket already exists');
  }

  let acceptedSocket: net.Socket | null = null;
  let handshakeSettled = false;
  let closed = false;
  let released = false;
  let encodedTargetEnvironment: string | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);

  const server = net.createServer((socket) => {
    if (acceptedSocket || closed) {
      socket.destroy();
      return;
    }
    acceptedSocket = socket;
    socket.setEncoding('utf8');
    let inbound = '';
    let authenticated = false;
    socket.on('data', (chunk: string) => {
      if (handshakeSettled || closed) return;
      inbound += chunk;
      if (!authenticated) {
        if (inbound.length > scopeTag.length + 1) {
          void abortWith(new Error('Host agent activation handshake exceeded its bound'));
          return;
        }
        const newline = inbound.indexOf('\n');
        if (newline < 0) return;
        if (newline !== inbound.length - 1) {
          void abortWith(new Error('Host agent activation handshake contained trailing data'));
          return;
        }
        const provided = Buffer.from(inbound.slice(0, newline), 'utf8');
        const expected = Buffer.from(scopeTag, 'utf8');
        if (
          provided.length !== expected.length
          || !crypto.timingSafeEqual(provided, expected)
        ) {
          void abortWith(new Error('Host agent activation handshake identity mismatch'));
          return;
        }
        if (encodedTargetEnvironment === null) {
          void abortWith(new Error('Host agent target environment was not prepared'));
          return;
        }
        authenticated = true;
        inbound = '';
        socket.write(
          `E${Buffer.byteLength(encodedTargetEnvironment, 'ascii')}\n${encodedTargetEnvironment}`,
        );
        return;
      }

      if (inbound !== 'A') {
        if (inbound.length > 1 || !'A'.startsWith(inbound)) {
          void abortWith(new Error('Host agent target environment acknowledgement mismatch'));
        }
        return;
      }
      handshakeSettled = true;
      clearTimeout(handshakeTimer);
      server.close();
      resolveReady();
    });
    socket.once('error', (error) => {
      if (!released) void abortWith(error);
    });
    socket.once('close', () => {
      if (!released && !closed) {
        void abortWith(new Error('Host agent activation socket closed before release'));
      }
    });
  });

  const unlinkSocket = (): void => {
    try {
      removePersistedHostAgentRunGate(socketPath, scopeUnit, scopeTag);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };

  const cleanup = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    unlinkSocket();
  };

  const abortWith = async (error: Error): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(handshakeTimer);
    acceptedSocket?.destroy();
    try {
      await cleanup();
    } finally {
      if (!handshakeSettled) {
        handshakeSettled = true;
        rejectReady(error);
      }
    }
  };

  const handshakeTimer = setTimeout(() => {
    void abortWith(new Error('Host agent activation handshake timed out'));
  }, ACTIVATION_HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref?.();

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(socketPath, () => {
        server.off('error', onError);
        resolve();
      });
    });
    server.on('error', (error) => {
      void abortWith(error);
    });
    fs.chmodSync(socketPath, 0o600);
    const stat = fs.lstatSync(socketPath);
    if (
      stat.uid !== 0
      || !stat.isSocket()
      || stat.isSymbolicLink()
      || (stat.mode & 0o777) !== 0o600
    ) {
      throw new Error('Host agent activation socket is not root-owned mode 0600');
    }
  } catch (error) {
    await abortWith(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  return Object.freeze({
    socketPath,
    ready,
    prepareTargetEnvironment(environment: NodeJS.ProcessEnv): void {
      if (closed || acceptedSocket || encodedTargetEnvironment !== null) {
        throw new Error('Host agent target environment can no longer be prepared');
      }
      if (!environment || typeof environment !== 'object') {
        throw new Error('Host agent target environment is invalid');
      }
      const normalized: Record<string, string> = Object.create(null);
      for (const [key, value] of Object.entries(environment)) {
        if (
          !key
          || key.includes('\0')
          || key.includes('=')
          || (
            value !== undefined
            && (typeof value !== 'string' || value.includes('\0'))
          )
        ) {
          throw new Error('Host agent target environment is invalid');
        }
        if (value !== undefined) normalized[key] = value;
      }
      const serialized = JSON.stringify(normalized);
      if (Buffer.byteLength(serialized, 'utf8') > TARGET_ENVIRONMENT_MAX_BYTES) {
        throw new Error('Host agent target environment exceeds its bound');
      }
      encodedTargetEnvironment = Buffer.from(serialized, 'utf8').toString('base64');
    },
    async release(): Promise<void> {
      await ready;
      if (closed || released || !acceptedSocket) {
        throw new Error('Host agent activation gate is unavailable');
      }
      released = true;
      closed = true;
      clearTimeout(handshakeTimer);
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = acceptedSocket as net.Socket;
          const onError = (error: Error) => reject(error);
          socket.once('error', onError);
          socket.end(Buffer.from([0x31]), () => {
            socket.off('error', onError);
            resolve();
          });
        });
      } finally {
        acceptedSocket.destroy();
        await cleanup();
      }
    },
    async abort(): Promise<void> {
      await abortWith(new Error('Host agent activation was aborted'));
    },
  });
}

export const __hostAgentRunActivationGateTest = Object.freeze({
  ACTIVATION_HANDSHAKE_TIMEOUT_MS,
  UNIX_SOCKET_PATH_MAX_BYTES,
  TARGET_ENVIRONMENT_MAX_BYTES,
  SCOPE_UNIT_PATTERN,
  SCOPE_TAG_PATTERN,
});
