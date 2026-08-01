import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import {
  createHostAgentRunActivationGate,
  hostAgentRunGatePath,
} from './hostAgentRunActivationGate';
import { __hostAgentRunJournalTest } from './hostAgentRunJournal';

function identity(seed: string): { unit: string; tag: string } {
  return {
    unit: `bridgesllm-host-agent-${seed.padStart(32, '0')}.scope`,
    tag: seed.padStart(64, '0'),
  };
}

function connectAndHandshake(
  socketPath: string,
  handshake: string,
): Promise<{ socket: net.Socket; received: Promise<Buffer> }> {
  const socket = net.createConnection({ path: socketPath });
  let environmentAcknowledged = false;
  let inbound = Buffer.alloc(0);
  const received = new Promise<Buffer>((resolve, reject) => {
    socket.on('data', (chunk) => {
      if (environmentAcknowledged) {
        resolve(Buffer.from(chunk));
        return;
      }
      inbound = Buffer.concat([inbound, Buffer.from(chunk)]);
      const newline = inbound.indexOf(0x0a);
      if (newline < 0) return;
      const header = inbound.subarray(0, newline).toString('ascii');
      const length = /^E([1-9][0-9]*)$/.exec(header);
      if (!length) {
        reject(new Error('invalid target environment frame'));
        return;
      }
      const payloadLength = Number(length[1]);
      if (inbound.length !== newline + 1 + payloadLength) return;
      environmentAcknowledged = true;
      inbound = Buffer.alloc(0);
      socket.write('A');
    });
    socket.once('error', reject);
  });
  socket.once('connect', () => socket.write(handshake));
  return Promise.resolve({ socket, received });
}

describe('host agent parent-bound activation gate', () => {
  test('the Node wrapper cannot execute the target before the release byte', async () => {
    const { unit, tag } = identity('91');
    const gate = await createHostAgentRunActivationGate(unit, tag);
    gate.prepareTargetEnvironment({
      PATH: process.env.PATH,
      PORTAL_TARGET_ENV_TEST: 'delivered-over-authenticated-socket',
    });
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-run-gate-wrapper-'));
    const targetMarker = path.join(temporaryRoot, 'executed');
    const wrapper = spawn(process.execPath, [
      '-e',
      __hostAgentRunJournalTest.ACTIVATION_WRAPPER_SOURCE,
      '--',
      gate.socketPath,
      tag,
      process.execPath,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(targetMarker)}, process.env.PORTAL_TARGET_ENV_TEST || '')`,
    ], {
      cwd: temporaryRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        wrapper.once('error', reject);
        wrapper.once('close', (code, signal) => resolve({ code, signal }));
      },
    );

    await gate.ready;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(fs.existsSync(targetMarker)).toBe(false);
    await gate.release();
    await expect(closed).resolves.toEqual({ code: 0, signal: null });
    expect(fs.readFileSync(targetMarker, 'utf8')).toBe(
      'delivered-over-authenticated-socket',
    );
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test('authenticates the wrapper and emits exactly one release byte', async () => {
    const { unit, tag } = identity('a1');
    const gate = await createHostAgentRunActivationGate(unit, tag);
    gate.prepareTargetEnvironment({ PATH: '/usr/bin' });
    const { socket, received } = await connectAndHandshake(
      gate.socketPath,
      `${tag}\n`,
    );

    await gate.ready;
    await gate.release();
    await expect(received).resolves.toEqual(Buffer.from([0x31]));
    socket.destroy();
    expect(fs.existsSync(gate.socketPath)).toBe(false);
  });

  test('rejects a wrong token, releases no byte, and removes the socket', async () => {
    const { unit, tag } = identity('b2');
    const gate = await createHostAgentRunActivationGate(unit, tag);
    gate.prepareTargetEnvironment({ PATH: '/usr/bin' });
    const socket = net.createConnection({ path: gate.socketPath });
    socket.once('error', () => undefined);
    socket.once('connect', () => socket.write(`${'f'.repeat(64)}\n`));

    await expect(gate.ready).rejects.toThrow(/identity mismatch/i);
    socket.destroy();
    expect(fs.existsSync(gate.socketPath)).toBe(false);
  });

  test('derives only the fixed root-owned runtime path from the exact scope UUID', () => {
    const { unit, tag } = identity('c3');
    expect(hostAgentRunGatePath(unit, tag)).toBe(
      `/run/bridgesllm/host-agent-runs/gate-${'c3'.padStart(32, '0')}.sock`,
    );
    expect(() => hostAgentRunGatePath(
      'bridgesllm-host-agent-../../openclaw-gateway.service',
      tag,
    )).toThrow(/identity is invalid/i);
  });
});
