import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { ensureRuntimeDirectory } from '../utils/runtimeDirectory';

export const HOST_AGENT_RUN_RUNTIME_ROOT = '/run/bridgesllm/host-agent-runs';

const ACTIVATION_HANDSHAKE_TIMEOUT_MS = 30_000;
const UNIX_SOCKET_PATH_MAX_BYTES = 100;
const TARGET_ENVIRONMENT_MAX_BYTES = 256 * 1024;
export const HOST_AGENT_RUN_STDIN_MAX_BYTES = 256 * 1024;
const TARGET_PAYLOAD_MAX_ENCODED_BYTES = 1024 * 1024;
const SCOPE_UNIT_PATTERN = /^bridgesllm-host-agent-([0-9a-f]{32})\.scope$/;
const SCOPE_TAG_PATTERN = /^[0-9a-f]{64}$/;

// Fixed bootstrap used by every host systemd-scope consumer. The systemd-run
// launcher receives only this wrapper and a root-only gate identity. The target
// environment, sensitive stdin, and release byte arrive over the authenticated
// socket only after the caller has durably persisted the exact scope identity.
export const HOST_AGENT_RUN_ACTIVATION_WRAPPER_SOURCE = `
const net = require('net');
const { spawn } = require('child_process');
const [socketPath, scopeTag, command, ...args] = process.argv.slice(1);
let settled = false;
let target = null;
let phase = 'target';
let inbound = Buffer.alloc(0);
let expectedTargetBytes = null;
let targetEnvironment = null;
let targetStdin = undefined;
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
  if (phase === 'target') {
    if (expectedTargetBytes === null) {
      const newline = inbound.indexOf(0x0a);
      if (newline < 0) {
        if (inbound.length > 32) failClosed();
        return;
      }
      const header = inbound.subarray(0, newline).toString('ascii');
      if (!/^T[1-9][0-9]{0,7}$/.test(header)) return failClosed();
      expectedTargetBytes = Number(header.slice(1));
      if (!Number.isSafeInteger(expectedTargetBytes) || expectedTargetBytes > 1048576) {
        return failClosed();
      }
      inbound = inbound.subarray(newline + 1);
    }
    if (inbound.length < expectedTargetBytes) return;
    if (inbound.length !== expectedTargetBytes) return failClosed();
    try {
      const encoded = inbound.toString('ascii');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return failClosed();
      const decodedBuffer = Buffer.from(encoded, 'base64');
      if (decodedBuffer.toString('base64') !== encoded) return failClosed();
      const decoded = decodedBuffer.toString('utf8');
      const parsed = JSON.parse(decoded);
      if (
        !parsed
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
        || Object.keys(parsed).sort().join(',') !== 'environment,stdinBase64'
        || !parsed.environment
        || typeof parsed.environment !== 'object'
        || Array.isArray(parsed.environment)
      ) return failClosed();
      targetEnvironment = Object.create(null);
      for (const [key, value] of Object.entries(parsed.environment)) {
        if (!key || key.includes('\\0') || key.includes('=') || typeof value !== 'string' || value.includes('\\0')) {
          return failClosed();
        }
        targetEnvironment[key] = value;
      }
      if (parsed.stdinBase64 === null) {
        targetStdin = undefined;
      } else {
        if (
          typeof parsed.stdinBase64 !== 'string'
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.stdinBase64)
          || parsed.stdinBase64.length % 4 !== 0
        ) return failClosed();
        targetStdin = Buffer.from(parsed.stdinBase64, 'base64');
        if (
          targetStdin.length < 1
          || targetStdin.length > 262144
          || targetStdin.toString('base64') !== parsed.stdinBase64
        ) return failClosed();
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
  clearTimeout(deadline);
  socket.destroy();
  try {
    target = spawn(command, args, {
      cwd: process.cwd(),
      env: targetEnvironment,
      stdio: [targetStdin === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
      shell: false,
    });
  } catch {
    process.exit(127);
  }
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
  if (targetStdin !== undefined) {
    if (!target.stdin) process.exit(127);
    target.stdin.on('error', () => {});
    target.stdin.end(targetStdin);
  }
  settled = true;
});
socket.once('end', () => failClosed());
socket.once('close', () => failClosed());
socket.once('error', () => failClosed());
`;

export interface HostAgentRunActivationGate {
  readonly socketPath: string;
  readonly ready: Promise<void>;
  prepareTarget(input: {
    environment: NodeJS.ProcessEnv;
    stdinText?: string;
  }): void;
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
  let encodedTargetPayload: string | null = null;
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
        if (encodedTargetPayload === null) {
          void abortWith(new Error('Host agent target payload was not prepared'));
          return;
        }
        authenticated = true;
        inbound = '';
        socket.write(
          `T${Buffer.byteLength(encodedTargetPayload, 'ascii')}\n${encodedTargetPayload}`,
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
    prepareTarget(input: { environment: NodeJS.ProcessEnv; stdinText?: string }): void {
      if (closed || acceptedSocket || encodedTargetPayload !== null) {
        throw new Error('Host agent target payload can no longer be prepared');
      }
      const { environment, stdinText } = input;
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
      if (
        stdinText !== undefined
        && (
          typeof stdinText !== 'string'
          || stdinText.includes('\0')
          || Buffer.byteLength(stdinText, 'utf8') < 1
          || Buffer.byteLength(stdinText, 'utf8') > HOST_AGENT_RUN_STDIN_MAX_BYTES
        )
      ) {
        throw new Error('Host agent target stdin exceeds its bound');
      }
      const payload = JSON.stringify({
        environment: normalized,
        stdinBase64: stdinText === undefined
          ? null
          : Buffer.from(stdinText, 'utf8').toString('base64'),
      });
      encodedTargetPayload = Buffer.from(payload, 'utf8').toString('base64');
      if (Buffer.byteLength(encodedTargetPayload, 'ascii') > TARGET_PAYLOAD_MAX_ENCODED_BYTES) {
        encodedTargetPayload = null;
        throw new Error('Host agent target payload exceeds its bound');
      }
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
  TARGET_STDIN_MAX_BYTES: HOST_AGENT_RUN_STDIN_MAX_BYTES,
  TARGET_PAYLOAD_MAX_ENCODED_BYTES,
  SCOPE_UNIT_PATTERN,
  SCOPE_TAG_PATTERN,
});
