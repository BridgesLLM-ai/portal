import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import type { NativeCliInvocation, NativeCliProviderAdapter } from './types';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));

jest.mock('../../../services/hostAgentRunJournal', () => {
  let attempt = 0;
  return {
    beginHostAgentRun: jest.fn(async (input: Record<string, unknown>) => input),
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
  getNativeProviderReadiness: jest.fn(async (provider: string) => ({
    provider,
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
  getProviderAvailability: jest.fn((provider: string) => ({
    name: provider,
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
const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-native-lifecycle-'));
process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = sessionsDir;

const childProcess = require('child_process') as typeof import('child_process');
const spawnMock = childProcess.spawn as unknown as jest.Mock;
const { NativeCliAdapterProvider } = require('./NativeCliAdapterProvider') as typeof import('./NativeCliAdapterProvider');
const sessionStore = require('../NativeSessionStore') as typeof import('../NativeSessionStore');
const { createHostOperatorExecutionContext } = require('../../executionScope') as typeof import('../../executionScope');
const { createProjectSandboxExecutionContext } = require('../../executionScope') as typeof import('../../executionScope');
const { AgentAbortError } = require('../../AgentProvider.interface') as typeof import('../../AgentProvider.interface');
const { streamEventBus } = require('../../../services/StreamEventBus') as typeof import('../../../services/StreamEventBus');
const { listPendingNativeCliApprovals } = require('../../nativeCliApprovals') as typeof import('../../nativeCliApprovals');
const nativeProviderReadiness = require('../../nativeProviderReadiness') as typeof import('../../nativeProviderReadiness');
const hostRunJournal = require('../../../services/hostAgentRunJournal') as {
  terminateHostAgentRunAttempt: jest.Mock<Promise<boolean>, [Record<string, unknown>]>;
};

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number | undefined;
  kill = jest.fn(() => true);
}

class TestNativeProvider extends NativeCliAdapterProvider {
  constructor(adapter: NativeCliProviderAdapter) {
    super(adapter);
  }
}

function adapter(overrides: Partial<NativeCliProviderAdapter> = {}): NativeCliProviderAdapter {
  return {
    providerName: 'CODEX',
    displayName: 'Lifecycle Test CLI',
    cliCommand: 'lifecycle-test-cli',
    messageIdPrefix: 'lifecycle-test',
    buildInvocation: () => ({ command: 'lifecycle-test-cli', args: [] }),
    handleStdoutLine: (line, ctx) => {
      ctx.appendFullText(line);
      ctx.emitChunk(line);
    },
    getResultText: (ctx) => ctx.fullText,
    ...overrides,
  };
}

const createdSessionIds: string[] = [];

function createSession(): string {
  const session = sessionStore.createNativeSession('CODEX', 'owner-1', {
    executionContext: createHostOperatorExecutionContext('owner-1'),
  });
  createdSessionIds.push(session.sessionId);
  return session.sessionId;
}

function createProjectSession(): string {
  const session = sessionStore.createNativeSession('CODEX', 'owner-1', {
    executionContext: createProjectSandboxExecutionContext({
      userId: 'owner-1',
      projectId: 'project-1',
      workspaceOwnerId: 'owner-1',
      projectName: 'lifecycle-test',
      canonicalRoot: sessionsDir,
      rootDevice: '1',
      rootInode: '2',
      rootBirthtimeNs: '3',
      runtimePolicyVersion: 'test-runtime-v1',
      egressPolicyVersion: 'test-egress-v1',
      runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
      policyFingerprint: 'b'.repeat(64),
    }),
  });
  createdSessionIds.push(session.sessionId);
  return session.sessionId;
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

afterEach(() => {
  jest.useRealTimers();
  spawnMock.mockReset();
  hostRunJournal.terminateHostAgentRunAttempt.mockClear();
  jest.mocked(nativeProviderReadiness.recordNativeProviderAuthFailure).mockClear();
  for (const sessionId of createdSessionIds.splice(0)) {
    streamEventBus.clearStream(sessionId);
    try { sessionStore.deleteNativeSession('CODEX', sessionId); } catch {}
  }
  expect(listPendingNativeCliApprovals()).toEqual([]);
});

afterAll(() => {
  if (previousSessionsDir === undefined) delete process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
  else process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = previousSessionsDir;
  fs.rmSync(sessionsDir, { recursive: true, force: true });
});

describe('NativeCliAdapterProvider logical-turn lifecycle', () => {
  test('reserves before invocation construction so concurrent sends cannot overlap', async () => {
    let resolveBuild!: (invocation: NativeCliInvocation) => void;
    const build = new Promise<NativeCliInvocation>((resolve) => { resolveBuild = resolve; });
    const authoritativeAbort = jest.fn(async () => undefined);
    const provider = new TestNativeProvider(adapter({ buildInvocation: () => build }));
    const sessionId = createSession();

    const firstOutcome = provider.sendMessage(sessionId, 'first').then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => provider.hasActiveRun(sessionId), 'first turn was not reserved');

    await expect(provider.sendMessage(sessionId, 'second')).rejects.toThrow(/already has an active turn/i);
    let abortResolved = false;
    const abort = provider.abortActiveRun(sessionId).then((confirmed) => {
      abortResolved = true;
      return confirmed;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(abortResolved).toBe(false);
    expect(provider.hasActiveRun(sessionId)).toBe(true);
    expect(authoritativeAbort).not.toHaveBeenCalled();

    resolveBuild({ command: 'lifecycle-test-cli', args: [], abort: authoritativeAbort });
    await expect(abort).resolves.toBe(true);
    expect(await firstOutcome).toBeInstanceOf(AgentAbortError);
    expect(authoritativeAbort).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(provider.hasActiveRun(sessionId)).toBe(false);
  });

  test('aborts a pre-spawn approval and never launches the child', async () => {
    const provider = new TestNativeProvider(adapter({
      buildInvocation: async (ctx) => {
        await ctx.requestApproval({ command: 'echo waiting', timeoutMs: 120_000 });
        return { command: 'lifecycle-test-cli', args: [] };
      },
    }));
    const sessionId = createSession();
    const approvalSeen = jest.fn();
    const sendOutcome = provider.sendMessage(
      sessionId,
      'approval turn',
      undefined,
      undefined,
      approvalSeen,
      { userId: 'owner-1', label: 'owner', role: 'OWNER' },
    ).then((result) => result, (error) => error);

    await waitFor(() => approvalSeen.mock.calls.length === 1, 'approval was not requested');
    const runId = streamEventBus.getStreamStatus(sessionId)?.runId;
    expect(runId).toEqual(expect.any(String));
    await expect(provider.abortActiveRun(sessionId, runId)).resolves.toBe(true);

    expect(await sendOutcome).toBeInstanceOf(AgentAbortError);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(listPendingNativeCliApprovals()).toEqual([]);
  });

  test('fails closed on a bounded deadline when invocation construction never resolves', async () => {
    const never = new Promise<NativeCliInvocation>(() => undefined);
    const buildInvocation = jest.fn(() => never);
    const provider = new TestNativeProvider(adapter({ buildInvocation }));
    const sessionId = createSession();
    const sendOutcome = provider.sendMessage(sessionId, 'never builds').then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => buildInvocation.mock.calls.length === 1, 'invocation construction did not start');

    jest.useFakeTimers();
    const abort = provider.abortActiveRun(sessionId);
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(abort).resolves.toBe(false);
    const outcome = await sendOutcome;
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(AgentAbortError);
    expect(provider.hasActiveRun(sessionId)).toBe(true);
    await expect(provider.sendMessage(sessionId, 'replacement')).rejects.toThrow(/already has an active turn/i);
  });

  test('invokes a late invocation abort hook once after the bounded abort deadline', async () => {
    let resolveBuild!: (invocation: NativeCliInvocation) => void;
    const build = new Promise<NativeCliInvocation>((resolve) => { resolveBuild = resolve; });
    const buildInvocation = jest.fn(() => build);
    const authoritativeAbort = jest.fn(async () => undefined);
    const provider = new TestNativeProvider(adapter({ buildInvocation }));
    const sessionId = createSession();
    const sendOutcome = provider.sendMessage(sessionId, 'late build').then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => buildInvocation.mock.calls.length === 1, 'invocation construction did not start');

    jest.useFakeTimers();
    const abort = provider.abortActiveRun(sessionId);
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(abort).resolves.toBe(false);
    expect(await sendOutcome).toBeInstanceOf(Error);
    expect(authoritativeAbort).not.toHaveBeenCalled();

    jest.useRealTimers();
    resolveBuild({ command: 'lifecycle-test-cli', args: [], abort: authoritativeAbort });
    await waitFor(() => authoritativeAbort.mock.calls.length === 1, 'late abort hook was not invoked');
    await expect(provider.abortActiveRun(sessionId)).resolves.toBe(false);
    expect(authoritativeAbort).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(provider.hasActiveRun(sessionId)).toBe(true);
  });

  test('clears stream and reservation when buildInvocation rejects', async () => {
    const provider = new TestNativeProvider(adapter({
      buildInvocation: async () => { throw new Error('build exploded'); },
    }));
    const sessionId = createSession();
    const events: Array<{ type: string }> = [];
    const unsubscribe = streamEventBus.subscribe(sessionId, (event: { type: string }) => events.push(event));

    await expect(provider.sendMessage(sessionId, 'fail before spawn')).rejects.toThrow(/could not complete/i);
    unsubscribe();

    expect(provider.hasActiveRun(sessionId)).toBe(false);
    expect(streamEventBus.getStreamStatus(sessionId)).toBeNull();
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test('quarantines a Project turn when invocation construction rejects without a cleanup boundary', async () => {
    const provider = new TestNativeProvider(adapter({
      buildInvocation: async () => { throw new Error('project provisioning exploded'); },
    }));
    const sessionId = createProjectSession();

    await expect(provider.sendMessage(sessionId, 'project build failure')).rejects.toBeInstanceOf(Error);
    expect(provider.hasActiveRun(sessionId)).toBe(true);
    await expect(provider.sendMessage(sessionId, 'replacement')).rejects.toThrow(/already has an active turn/i);
    await expect(provider.abortActiveRun(sessionId)).resolves.toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test('settles spawn error plus close exactly once', async () => {
    const child = queueChild();
    const authoritativeAbort = jest.fn(async () => undefined);
    const provider = new TestNativeProvider(adapter({
      buildInvocation: () => ({
        command: 'lifecycle-test-cli',
        args: [],
        abort: authoritativeAbort,
      }),
    }));
    const sessionId = createSession();
    const events: Array<{ type: string }> = [];
    const unsubscribe = streamEventBus.subscribe(sessionId, (event: { type: string }) => events.push(event));
    const sendOutcome = provider.sendMessage(sessionId, 'spawn race').then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'child was not spawned');

    child.emit('error', new Error('spawn failed'));
    child.emit('close', null, null);
    expect(await sendOutcome).toBeInstanceOf(Error);
    unsubscribe();

    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(0);
    expect(authoritativeAbort).toHaveBeenCalledTimes(1);
    expect(provider.hasActiveRun(sessionId)).toBe(false);
  });

  test('treats a signal exit as failure even after partial assistant output', async () => {
    const child = queueChild();
    let resolveAuthoritativeAbort!: () => void;
    const authoritativeAbortPending = new Promise<void>((resolve) => {
      resolveAuthoritativeAbort = resolve;
    });
    const authoritativeAbort = jest.fn(() => authoritativeAbortPending);
    const provider = new TestNativeProvider(adapter({
      buildInvocation: () => ({
        command: 'lifecycle-test-cli',
        args: [],
        abort: authoritativeAbort,
      }),
    }));
    const sessionId = createSession();
    let sendSettled = false;
    const sendOutcome = provider.sendMessage(sessionId, 'signal turn').then(
      (result) => {
        sendSettled = true;
        return result;
      },
      (error) => {
        sendSettled = true;
        return error;
      },
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'child was not spawned');

    child.stdout.emit('data', Buffer.from('partial answer\n'));
    child.emit('close', null, 'SIGKILL');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sendSettled).toBe(false);
    resolveAuthoritativeAbort();
    expect(await sendOutcome).toBeInstanceOf(Error);
    expect(authoritativeAbort).toHaveBeenCalledTimes(1);

    const history = sessionStore.readAllNativeSessionHistory('CODEX', sessionId);
    expect(history.filter((entry) => entry.role === 'assistant')).toHaveLength(1);
    expect(history.at(-1)?.content).toMatch(/^Error:/);
    expect(history.at(-1)?.content).not.toContain('partial answer');
  });

  test('treats every unaccepted nonzero exit as failure despite partial assistant output', async () => {
    const child = queueChild();
    const provider = new TestNativeProvider(adapter());
    const sessionId = createSession();
    const events: Array<{ type: string }> = [];
    const unsubscribe = streamEventBus.subscribe(sessionId, (event: { type: string }) => events.push(event));
    const sendOutcome = provider.sendMessage(sessionId, 'crashing turn').then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'child was not spawned');

    child.stdout.emit('data', Buffer.from('partial answer\n'));
    child.emit('close', 137, null);
    expect(await sendOutcome).toBeInstanceOf(Error);
    unsubscribe();

    const history = sessionStore.readAllNativeSessionHistory('CODEX', sessionId);
    expect(history.at(-1)?.content).toMatch(/^Error:/);
    expect(history.at(-1)?.content).not.toContain('partial answer');
    expect(events.filter((event) => event.type === 'done')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
  });

  test('records structured auth rejection against the exact admitted credential generation', async () => {
    const child = queueChild();
    const provider = new TestNativeProvider(adapter({
      displayName: 'Claude',
      getErrorMessage: () => 'Claude Code provider error: authentication_failed',
    }));
    const sessionId = createSession();
    const sendOutcome = provider.sendMessage(sessionId, 'auth failure').then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'child was not spawned');

    child.emit('close', 1, null);
    const outcome = await sendOutcome;

    expect(outcome).toMatchObject({
      code: 'AUTH_REQUIRED',
      message: expect.stringMatching(/authentication is unavailable/i),
    });
    expect(outcome.message).not.toMatch(/exited with code/i);
    expect(nativeProviderReadiness.recordNativeProviderAuthFailure).toHaveBeenCalledWith(
      'CODEX',
      'Claude Code provider error: authentication_failed',
      {
        credentialFingerprint: 'test-credential',
        runtimeFingerprint: 'test-runtime',
      },
      { confirmed: true },
    );
  });

  test('allows only explicitly attested nonzero exit codes to settle successfully', async () => {
    const child = queueChild();
    const provider = new TestNativeProvider(adapter({ acceptedExitCodes: [7] }));
    const sessionId = createSession();
    const send = provider.sendMessage(sessionId, 'accepted nonzero');
    await waitFor(() => spawnMock.mock.calls.length === 1, 'child was not spawned');

    child.stdout.emit('data', Buffer.from('complete answer\n'));
    child.emit('close', 7, null);
    await expect(send).resolves.toMatchObject({ fullText: 'complete answer' });
    expect(provider.hasActiveRun(sessionId)).toBe(false);
  });

  test('soft-clears a completed provider run for authoritative reconnect recovery', async () => {
    const child = queueChild();
    const provider = new TestNativeProvider(adapter());
    const sessionId = createSession();
    const send = provider.sendMessage(
      sessionId,
      'complete while the browser may be disconnected',
      undefined,
      undefined,
      undefined,
      { label: 'owner', userId: 'owner-1', role: 'OWNER', requestId: 'reconnect-terminal-run' },
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'child was not spawned');

    child.stdout.emit('data', Buffer.from('authoritative completion\n'));
    child.emit('close', 0, null);
    await expect(send).resolves.toMatchObject({ fullText: 'authoritative completion' });

    expect(streamEventBus.getStreamStatus(sessionId)).toBeNull();
    expect(streamEventBus.getTrackedStream(sessionId)).toMatchObject({
      active: false,
      runId: 'reconnect-terminal-run',
      lastDoneAt: expect.any(Number),
    });
  });

  test.each([
    ['stdout parser', 'false' as const],
    ['stderr parser', 'error' as const],
  ])('quarantines the logical turn when %s cleanup returns %s', async (failureSource, hookOutcome) => {
    const child = queueChild();
    const authoritativeAbort = hookOutcome === 'false'
      ? jest.fn(async () => false)
      : jest.fn(async () => { throw new Error('provider cleanup unavailable'); });
    const provider = new TestNativeProvider(adapter({
      buildInvocation: () => ({
        command: 'lifecycle-test-cli',
        args: [],
        abort: authoritativeAbort,
      }),
      handleStdoutLine: failureSource === 'stdout parser'
        ? () => { throw new Error('stdout parse failed'); }
        : adapter().handleStdoutLine,
      handleStderrChunk: failureSource === 'stderr parser'
        ? () => { throw new Error('stderr parse failed'); }
        : undefined,
    }));
    const sessionId = createSession();
    const sendOutcome = provider.sendMessage(sessionId, 'parser failure').then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'child was not spawned');

    if (failureSource === 'stdout parser') child.stdout.emit('data', Buffer.from('invalid\n'));
    else child.stderr.emit('data', Buffer.from('invalid stderr'));
    await waitFor(
      () => hostRunJournal.terminateHostAgentRunAttempt.mock.calls.length === 1,
      'failed attempt scope was not terminated',
    );
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', 1, null);

    expect(await sendOutcome).toBeInstanceOf(Error);
    expect(authoritativeAbort).toHaveBeenCalledTimes(1);
    expect(provider.hasActiveRun(sessionId)).toBe(true);
    await expect(provider.sendMessage(sessionId, 'replacement')).rejects.toThrow(/already has an active turn/i);
    await expect(provider.abortActiveRun(sessionId)).resolves.toBe(false);
  });

  test('honors the provider abort hook when spawn throws after invocation construction', async () => {
    spawnMock.mockImplementationOnce(() => { throw new Error('synchronous spawn failure'); });
    const authoritativeAbort = jest.fn(async () => false);
    const provider = new TestNativeProvider(adapter({
      buildInvocation: () => ({
        command: 'lifecycle-test-cli',
        args: [],
        abort: authoritativeAbort,
      }),
    }));
    const sessionId = createSession();

    await expect(provider.sendMessage(sessionId, 'spawn throws')).rejects.toBeInstanceOf(Error);
    expect(authoritativeAbort).toHaveBeenCalledTimes(1);
    expect(provider.hasActiveRun(sessionId)).toBe(true);
    await expect(provider.sendMessage(sessionId, 'replacement')).rejects.toThrow(/already has an active turn/i);
  });

  test('signals the child and honors the abort hook when setup throws after spawn', async () => {
    const child = queueChild();
    child.stdout.on = jest.fn(() => { throw new Error('listener setup failed'); }) as any;
    const authoritativeAbort = jest.fn(async () => false);
    const provider = new TestNativeProvider(adapter({
      buildInvocation: () => ({
        command: 'lifecycle-test-cli',
        args: [],
        abort: authoritativeAbort,
      }),
    }));
    const sessionId = createSession();
    const sendOutcome = provider.sendMessage(sessionId, 'post-spawn setup failure').then(
      (result) => result,
      (error) => error,
    );

    await waitFor(
      () => hostRunJournal.terminateHostAgentRunAttempt.mock.calls.length === 1,
      'systemd scope was not terminated after setup failure',
    );
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', 1, null);

    expect(await sendOutcome).toBeInstanceOf(Error);
    expect(authoritativeAbort).toHaveBeenCalledTimes(1);
    expect(provider.hasActiveRun(sessionId)).toBe(true);
  });

  test('ignores a stale runId without touching the active child', async () => {
    const child = queueChild();
    const provider = new TestNativeProvider(adapter());
    const sessionId = createSession();
    const events: Array<{ type: string; metadata?: { aborted?: boolean } }> = [];
    const unsubscribe = streamEventBus.subscribe(sessionId, (event: { type: string; metadata?: { aborted?: boolean } }) => events.push(event));
    const sendOutcome = provider.sendMessage(
      sessionId,
      'guarded abort',
      undefined,
      undefined,
      undefined,
      { label: 'owner', userId: 'owner-1', role: 'OWNER', requestId: 'durable-run-id' },
    ).then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'child was not spawned');
    const runId = streamEventBus.getStreamStatus(sessionId)?.runId;
    expect(runId).toBe('durable-run-id');

    await expect(provider.abortActiveRun(sessionId, 'stale-run-id')).resolves.toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    expect(provider.hasActiveRun(sessionId)).toBe(true);

    const abort = provider.abortActiveRun(sessionId, runId);
    await waitFor(
      () => hostRunJournal.terminateHostAgentRunAttempt.mock.calls.length === 1,
      'active systemd scope was not terminated',
    );
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGTERM');
    await expect(abort).resolves.toBe(true);
    expect(await sendOutcome).toBeInstanceOf(AgentAbortError);
    unsubscribe();
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'done')).toEqual([
      expect.objectContaining({ metadata: { aborted: true } }),
    ]);
  });

  test('coalesces repeated aborts into one hook, one signal, and one timer lifecycle', async () => {
    const child = queueChild();
    const authoritativeAbort = jest.fn(async () => undefined);
    const provider = new TestNativeProvider(adapter({
      buildInvocation: () => ({
        command: 'lifecycle-test-cli',
        args: [],
        abort: authoritativeAbort,
      }),
    }));
    const sessionId = createSession();
    const sendOutcome = provider.sendMessage(sessionId, 'repeat abort').then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'child was not spawned');
    const runId = streamEventBus.getStreamStatus(sessionId)?.runId;

    const firstAbort = provider.abortActiveRun(sessionId, runId);
    const secondAbort = provider.abortActiveRun(sessionId, runId);
    await waitFor(
      () => hostRunJournal.terminateHostAgentRunAttempt.mock.calls.length === 1,
      'systemd scope was not terminated',
    );
    expect(authoritativeAbort).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();

    child.emit('close', null, 'SIGTERM');
    await expect(firstAbort).resolves.toBe(true);
    await expect(secondAbort).resolves.toBe(true);
    expect(await sendOutcome).toBeInstanceOf(AgentAbortError);
    expect(authoritativeAbort).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test('quarantines the Project session when its in-container hard-stop hook rejects', async () => {
    const child = queueChild();
    const authoritativeAbort = jest.fn(async () => { throw new Error('exact run survived hard stop'); });
    const provider = new TestNativeProvider(adapter({
      buildInvocation: () => ({
        command: 'docker',
        args: ['container', 'exec', 'attested-container'],
        abort: authoritativeAbort,
      }),
    }));
    const sessionId = createProjectSession();
    const sendOutcome = provider.sendMessage(sessionId, 'hard-stop failure').then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'Project docker client was not spawned');

    const abort = provider.abortActiveRun(sessionId);
    await waitFor(() => child.kill.mock.calls.length === 1, 'Project docker client was not signalled');
    child.emit('close', null, 'SIGTERM');

    await expect(abort).resolves.toBe(false);
    expect(await sendOutcome).toBeInstanceOf(Error);
    expect(authoritativeAbort).toHaveBeenCalledTimes(1);
    expect(provider.hasActiveRun(sessionId)).toBe(true);
    await expect(provider.sendMessage(sessionId, 'replacement')).rejects.toThrow(/already has an active turn/i);
  });

  test('fails closed within a bounded deadline when a signalled child never closes', async () => {
    const child = queueChild();
    const authoritativeAbort = jest.fn(async () => undefined);
    const provider = new TestNativeProvider(adapter({
      buildInvocation: () => ({
        command: 'lifecycle-test-cli',
        args: [],
        abort: authoritativeAbort,
      }),
    }));
    const sessionId = createSession();
    const sendOutcome = provider.sendMessage(sessionId, 'ignore signals').then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'child was not spawned');

    jest.useFakeTimers();
    const abort = provider.abortActiveRun(sessionId);
    await Promise.resolve();
    expect(hostRunJournal.terminateHostAgentRunAttempt).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(abort).resolves.toBe(false);
    expect(await sendOutcome).toBeInstanceOf(Error);
    expect(authoritativeAbort).toHaveBeenCalledTimes(1);
    expect(provider.hasActiveRun(sessionId)).toBe(true);
    await expect(provider.sendMessage(sessionId, 'replacement')).rejects.toThrow(/already has an active turn/i);
  });

  test('waits for child close and authoritative abort before terminateSession deletes durable state', async () => {
    const child = queueChild();
    let resolveAuthoritativeAbort!: () => void;
    const authoritativeAbort = new Promise<void>((resolve) => { resolveAuthoritativeAbort = resolve; });
    const provider = new TestNativeProvider(adapter({
      buildInvocation: () => ({
        command: 'lifecycle-test-cli',
        args: [],
        abort: () => authoritativeAbort,
      }),
    }));
    const sessionId = createSession();
    const sendOutcome = provider.sendMessage(sessionId, 'terminate turn').then(
      (result) => result,
      (error) => error,
    );
    await waitFor(() => spawnMock.mock.calls.length === 1, 'child was not spawned');

    let terminateResolved = false;
    const terminate = provider.terminateSession(sessionId).then(() => { terminateResolved = true; });
    await waitFor(
      () => hostRunJournal.terminateHostAgentRunAttempt.mock.calls.length === 1,
      'terminate did not stop the systemd scope',
    );
    expect(child.kill).not.toHaveBeenCalled();
    expect(terminateResolved).toBe(false);
    expect(sessionStore.loadNativeSession('CODEX', sessionId)).not.toBeNull();

    child.emit('close', null, 'SIGTERM');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminateResolved).toBe(false);
    expect(sessionStore.loadNativeSession('CODEX', sessionId)).not.toBeNull();

    resolveAuthoritativeAbort();
    await terminate;
    expect(terminateResolved).toBe(true);
    expect(await sendOutcome).toBeInstanceOf(AgentAbortError);
    expect(sessionStore.loadNativeSession('CODEX', sessionId)).toBeNull();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sessionStore.loadNativeSession('CODEX', sessionId)).toBeNull();
  });

  test('keeps the logical reservation across retry and settles success once', async () => {
    const firstChild = queueChild();
    const secondChild = queueChild();
    const provider = new TestNativeProvider(adapter({
      finalizeTurn: (ctx) => {
        if (ctx.state.turnAttempt === 1) ctx.state.retryRequested = true;
      },
    }));
    const sessionId = createSession();
    const send = provider.sendMessage(sessionId, 'retry turn');
    await waitFor(() => spawnMock.mock.calls.length === 1, 'first child was not spawned');

    firstChild.emit('close', 0, null);
    await waitFor(() => spawnMock.mock.calls.length === 2, 'retry child was not spawned');
    expect(provider.hasActiveRun(sessionId)).toBe(true);
    await expect(provider.sendMessage(sessionId, 'overlap retry')).rejects.toThrow(/already has an active turn/i);

    secondChild.stdout.emit('data', Buffer.from('final answer\n'));
    secondChild.emit('close', 0, null);
    await expect(send).resolves.toMatchObject({ fullText: 'final answer' });

    const history = sessionStore.readAllNativeSessionHistory('CODEX', sessionId);
    expect(history.filter((entry) => entry.role === 'user')).toHaveLength(1);
    expect(history.filter((entry) => entry.role === 'assistant')).toHaveLength(1);
    expect(provider.hasActiveRun(sessionId)).toBe(false);
  });
});
