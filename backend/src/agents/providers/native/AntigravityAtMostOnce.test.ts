import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import type { ExecApprovalRequest } from '../PersistentGatewayWs';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
  execFile: jest.fn(),
}));

jest.mock('../../../services/hostAgentRunJournal', () => {
  let attempt = 0;
  return {
    beginHostAgentRun: jest.fn(async (input: Record<string, unknown>) => {
      if (input.actorAuthorizationVersion !== 7) {
        throw new Error('fixture run lacks an exact authorization generation');
      }
      return input;
    }),
    reserveHostAgentRunAttempt: jest.fn(async () => {
      attempt += 1;
      const hex = attempt.toString(16).padStart(32, '0');
      const scopeUnit = `bridgesllm-host-agent-${hex}.scope`;
      return {
        attempt,
        scopeUnit,
        scopeTag: attempt.toString(16).padStart(64, '0'),
        description: `BridgesLLM host agent run tag=${attempt.toString(16).padStart(64, '0')}`,
        bootId: '01234567-89ab-4cde-8fab-0123456789ab',
        controlGroup: `/system.slice/${scopeUnit}`,
        gatePath: `/run/bridgesllm/host-agent-runs/gate-${hex}.sock`,
      };
    }),
    spawnGatedHostAgentRunAttempt: jest.fn((input: any) => ({
      child: require('child_process').spawn(input.command, input.args, input.options),
      attempt: input.reservation.attempt,
      identity: {
        ...input.reservation,
        invocationId: input.reservation.attempt.toString(16).padStart(32, '0'),
      },
    })),
    activateGatedHostAgentRunAttempt: jest.fn(async () => undefined),
    terminateHostAgentRunAttempt: jest.fn(async () => true),
    settleHostAgentRun: jest.fn(async () => undefined),
    quarantineHostAgentRun: jest.fn(async () => undefined),
    registerHostAgentRunAbort: jest.fn(() => () => undefined),
  };
});

jest.mock('../../../services/authorizationChangeBus', () => ({
  subscribeToAuthorizationChanges: jest.fn(() => () => undefined),
}));

jest.mock('../../nativeProviderReadiness', () => ({
  ...jest.requireActual('../../nativeProviderReadiness'),
  getNativeProviderReadiness: jest.fn(async () => ({
    provider: 'GEMINI',
    state: 'live_verified',
    usable: true,
    message: 'ready',
    checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    credentialFingerprint: 'test-credential',
    runtimeFingerprint: 'test-runtime',
  })),
  recordNativeProviderAuthFailure: jest.fn(),
}));

jest.mock('../../providerAvailability', () => ({
  getProviderAvailability: jest.fn(() => ({
    name: 'GEMINI',
    installed: true,
    implemented: true,
    usable: true,
    native: true,
    capabilities: {
      supportedExecutionScopes: ['HOST_OPERATOR', 'PROJECT_SANDBOX'],
    },
  })),
}));

const previousSessionsDir = process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-antigravity-once-'));
process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = sessionsDir;

const childProcess = require('child_process') as typeof import('child_process');
const spawnMock = childProcess.spawn as unknown as jest.Mock;
const execFileMock = childProcess.execFile as unknown as jest.Mock;
const { GeminiProvider } = require('../GeminiProvider') as typeof import('../GeminiProvider');
const sessionStore = require('../NativeSessionStore') as typeof import('../NativeSessionStore');
const { createHostOperatorExecutionContext } = require('../../executionScope') as typeof import('../../executionScope');
const { AgentAbortError } = require('../../AgentProvider.interface') as typeof import('../../AgentProvider.interface');
const { streamEventBus } = require('../../../services/StreamEventBus') as typeof import('../../../services/StreamEventBus');
const nativeProviderReadiness = require('../../nativeProviderReadiness') as typeof import('../../nativeProviderReadiness');
const hostRunJournal = require('../../../services/hostAgentRunJournal') as {
  terminateHostAgentRunAttempt: jest.Mock<Promise<boolean>, [Record<string, unknown>]>;
};
const {
  listPendingNativeCliApprovals,
  resolveNativeCliApproval,
} = require('../../nativeCliApprovals') as typeof import('../../nativeCliApprovals');

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number | undefined;
  kill = jest.fn(() => true);
}

const createdSessionIds: string[] = [];

function createSession(): string {
  const session = sessionStore.createNativeSession('GEMINI', 'owner-1', {
    executionContext: createHostOperatorExecutionContext('owner-1'),
  });
  createdSessionIds.push(session.sessionId);
  return session.sessionId;
}

function ownerSender() {
  return {
    userId: 'owner-1',
    label: 'owner',
    role: 'OWNER',
    authorizationVersion: 7,
  };
}

function queueChild(child = new FakeChild()): FakeChild {
  spawnMock.mockReturnValueOnce(child as any);
  return child;
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

function expectSingleSanitizedInvocation(): void {
  expect(spawnMock).toHaveBeenCalledTimes(1);
  expect(execFileMock).not.toHaveBeenCalled();
  expect(spawnMock.mock.calls.length + execFileMock.mock.calls.length).toBe(1);
  const [command, args, options] = spawnMock.mock.calls[0];
  expect(command).toBe('agy');
  expect(args).toEqual(expect.arrayContaining(['--print-timeout', '5m', '--add-dir', '--print']));
  expect(options).toEqual(expect.objectContaining({
    detached: true,
    env: expect.objectContaining({
      AGY_CLI_DISABLE_AUTO_UPDATE: '1',
      NO_COLOR: '1',
    }),
  }));
  expect(options.env).not.toHaveProperty('DATABASE_URL');
  expect(options.env).not.toHaveProperty('JWT_SECRET');
  expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
}

beforeEach(() => {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(null, 'unexpected fallback response', ''));
    }
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  spawnMock.mockReset();
  execFileMock.mockReset();
  hostRunJournal.terminateHostAgentRunAttempt.mockClear();
  jest.mocked(nativeProviderReadiness.recordNativeProviderAuthFailure).mockClear();
  for (const sessionId of createdSessionIds.splice(0)) {
    streamEventBus.clearStream(sessionId);
    try { sessionStore.deleteNativeSession('GEMINI', sessionId); } catch {}
  }
  expect(listPendingNativeCliApprovals()).toEqual([]);
});

afterAll(() => {
  if (previousSessionsDir === undefined) delete process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
  else process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = previousSessionsDir;
  fs.rmSync(sessionsDir, { recursive: true, force: true });
});

describe('Antigravity host turns dispatch at most once', () => {
  test('fails visibly without replay when a successful invocation emits no assistant output', async () => {
    const child = queueChild();
    const provider = new GeminiProvider();
    const sessionId = createSession();
    const events: Array<{ type: string; content?: string; code?: string }> = [];
    const unsubscribe = streamEventBus.subscribe(
      sessionId,
      (event: { type: string; content?: string; code?: string }) => events.push(event),
    );

    const outcome = provider.sendMessage(
      sessionId,
      'Reply exactly P4OK.',
      undefined,
      undefined,
      undefined,
      ownerSender(),
    ).then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'Antigravity child was not spawned');
    child.emit('close', 0, null);

    await expect(outcome).resolves.toMatchObject({
      code: 'PROVIDER_FAILED',
      message: 'Google Antigravity completed without an assistant response. The turn was not retried to prevent duplicate work.',
    });
    unsubscribe();
    expect(events.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({
        code: 'PROVIDER_FAILED',
        content: expect.stringMatching(/not retried to prevent duplicate work/i),
      }),
    ]);
    expectSingleSanitizedInvocation();
    expect(provider.hasActiveRun(sessionId)).toBe(false);
  });

  test('preserves the first nonzero exit diagnostic without replay', async () => {
    const child = queueChild();
    const provider = new GeminiProvider();
    const sessionId = createSession();
    const outcome = provider.sendMessage(
      sessionId,
      'Reply exactly P4OK.',
      undefined,
      undefined,
      undefined,
      ownerSender(),
    ).then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'Antigravity child was not spawned');

    child.stderr.emit('data', Buffer.from('Antigravity provider rejected the request.\n'));
    child.emit('close', 17, null);

    await expect(outcome).resolves.toMatchObject({ code: 'PROVIDER_FAILED' });
    expectSingleSanitizedInvocation();
    const history = sessionStore.readAllNativeSessionHistory('GEMINI', sessionId);
    expect(history.filter((entry: { role: string }) => entry.role === 'user')).toHaveLength(1);
    expect(history.filter((entry: { role: string }) => entry.role === 'assistant')).toHaveLength(1);
    expect(history.at(-1)?.content).toMatch(/^Error:/);
  });

  test('does not replay a tool-only completion whose side effects may already have happened', async () => {
    const child = queueChild();
    const provider = new GeminiProvider();
    const sessionId = createSession();
    const statuses: Array<{ type?: string; toolName?: string }> = [];
    const outcome = provider.sendMessage(
      sessionId,
      'Reply exactly P4OK.',
      undefined,
      (event) => statuses.push(event as { type?: string; toolName?: string }),
      undefined,
      ownerSender(),
    ).then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'Antigravity child was not spawned');

    child.stdout.emit('data', Buffer.from('I will inspect the workspace.\n'));
    child.emit('close', 0, null);

    await expect(outcome).resolves.toMatchObject({
      code: 'PROVIDER_FAILED',
      message: expect.stringMatching(/not retried to prevent duplicate work/i),
    });
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_start', toolName: 'inspect' }),
      expect.objectContaining({ type: 'tool_end', toolName: 'inspect' }),
    ]));
    expectSingleSanitizedInvocation();
  });

  test('keeps trusted execution inside the one tracked sanitized child', async () => {
    const child = queueChild();
    const provider = new GeminiProvider();
    const sessionId = createSession();
    const approvalRequests: ExecApprovalRequest[] = [];
    const statuses: Array<{ type?: string; toolName?: string; isError?: boolean }> = [];
    const outcome = provider.sendMessage(
      sessionId,
      'Write exactly hi to /tmp/antigravity-at-most-once.txt using a command.',
      undefined,
      (event) => statuses.push(event as { type?: string; toolName?: string; isError?: boolean }),
      (approval) => {
        approvalRequests.push(approval);
        resolveNativeCliApproval(approval.id, 'allow-once');
      },
      ownerSender(),
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'trusted Antigravity child was not spawned');

    expect(approvalRequests).toHaveLength(1);
    expect(spawnMock.mock.calls[0][1]).toContain('--dangerously-skip-permissions');
    expect(spawnMock.mock.calls[0][1]).not.toContain('--sandbox');
    child.emit('close', 0, null);

    await expect(outcome).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
      message: expect.stringMatching(/not retried to prevent duplicate work/i),
    });
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_start', toolName: 'antigravity' }),
      expect.objectContaining({ type: 'tool_end', toolName: 'antigravity', isError: true }),
    ]));
    expectSingleSanitizedInvocation();
  });

  test('marks trusted execution failed when partial output precedes a nonzero exit', async () => {
    const child = queueChild();
    const provider = new GeminiProvider();
    const sessionId = createSession();
    const statuses: Array<{ type?: string; toolName?: string; isError?: boolean }> = [];
    const outcome = provider.sendMessage(
      sessionId,
      'Write exactly hi to /tmp/antigravity-nonzero.txt using a command.',
      undefined,
      (event) => statuses.push(event as { type?: string; toolName?: string; isError?: boolean }),
      (approval) => resolveNativeCliApproval(approval.id, 'allow-once'),
      ownerSender(),
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'trusted Antigravity child was not spawned');

    child.stdout.emit('data', Buffer.from('Partial assistant output before failure.\n'));
    child.stderr.emit('data', Buffer.from('Antigravity provider rejected the request.\n'));
    child.emit('close', 17, null);

    await expect(outcome).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(statuses.filter((event) => event.type === 'tool_end' && event.toolName === 'antigravity')).toEqual([
      expect.objectContaining({ isError: true }),
    ]);
    expectSingleSanitizedInvocation();
  });

  test('auth prompts override partial output and invalidate the admitted readiness generation', async () => {
    const child = queueChild();
    const provider = new GeminiProvider();
    const sessionId = createSession();
    const statuses: Array<{ type?: string; toolName?: string; isError?: boolean }> = [];
    const outcome = provider.sendMessage(
      sessionId,
      'Write exactly hi to /tmp/antigravity-auth.txt using a command.',
      undefined,
      (event) => statuses.push(event as { type?: string; toolName?: string; isError?: boolean }),
      (approval) => resolveNativeCliApproval(approval.id, 'allow-once'),
      ownerSender(),
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'trusted Antigravity child was not spawned');

    child.stdout.emit('data', Buffer.from('Partial assistant output before authentication stopped the turn.\n'));
    child.stderr.emit('data', Buffer.from(
      'Open https://accounts.google.com/o/oauth2/auth and paste the authorization code.\n',
    ));
    child.emit('close', 1, null);

    await expect(outcome).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: expect.stringMatching(/authentication is unavailable/i),
    });
    expect(statuses.filter((event) => event.type === 'tool_end' && event.toolName === 'antigravity')).toEqual([
      expect.objectContaining({ isError: true }),
    ]);
    expect(nativeProviderReadiness.recordNativeProviderAuthFailure).toHaveBeenCalledWith(
      'GEMINI',
      expect.stringContaining('accounts.google.com'),
      {
        credentialFingerprint: 'test-credential',
        runtimeFingerprint: 'test-runtime',
      },
      { confirmed: true },
    );
    expectSingleSanitizedInvocation();
  });

  test('aborts the exact systemd scope without signaling a launcher PID or replaying', async () => {
    const child = queueChild();
    child.pid = 43210;
    const processKill = jest.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    const provider = new GeminiProvider();
    const sessionId = createSession();
    const outcome = provider.sendMessage(
      sessionId,
      'Reply exactly P4OK.',
      undefined,
      undefined,
      undefined,
      ownerSender(),
    ).then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'Antigravity child was not spawned');

    const abort = provider.abortActiveRun(sessionId);
    await waitFor(
      () => hostRunJournal.terminateHostAgentRunAttempt.mock.calls.length === 1,
      'Antigravity systemd scope was not terminated',
    );
    expect(processKill).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGKILL');

    await expect(abort).resolves.toBe(true);
    expect(await outcome).toBeInstanceOf(AgentAbortError);
    expectSingleSanitizedInvocation();
    expect(processKill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(provider.hasActiveRun(sessionId)).toBe(false);
  });
});
