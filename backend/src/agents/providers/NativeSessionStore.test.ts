import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createHostOperatorExecutionContext,
  createProjectSandboxExecutionContext,
} from '../executionScope';
import type { AgentMessage } from '../AgentProvider.interface';

describe('append-only native provider transcript storage', () => {
  let sessionsDir: string;
  let previous: string | undefined;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-native-history-'));
    previous = process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
    process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = sessionsDir;
    jest.resetModules();
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
    else process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = previous;
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    jest.resetModules();
  });

  test('migrates a 10,000-message lifetime JSON once, then pages the append-only tail', () => {
    const providerDirectory = path.join(sessionsDir, 'codex');
    fs.mkdirSync(providerDirectory, { recursive: true });
    const messages: AgentMessage[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `history row ${index}`,
      timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    }));
    fs.writeFileSync(path.join(providerDirectory, 'legacy.json'), JSON.stringify({
      sessionId: 'legacy',
      provider: 'CODEX',
      userId: 'owner-1',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActivityAt: '2026-07-20T00:00:00.000Z',
      cwd: '/workspace',
      executionContext: createHostOperatorExecutionContext('owner-1'),
      messages,
    }));

    const store = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
    const firstPage = store.readNativeSessionHistoryTail('CODEX', 'legacy', 80);
    expect(firstPage.messages).toHaveLength(80);
    expect(firstPage.messages[0].id).toBe('message-9920');
    expect(firstPage.hasMore).toBe(true);

    const metadataPath = path.join(providerDirectory, 'legacy.json');
    const historyPath = path.join(providerDirectory, 'legacy.history.jsonl');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    expect(metadata.messages).toEqual([]);
    expect(metadata.historyMessageCount).toBe(10_000);
    expect(fs.statSync(metadataPath).size).toBeLessThan(8_192);
    expect(fs.readFileSync(historyPath, 'utf8').trim().split('\n')).toHaveLength(10_000);

    const metadataOnly = store.loadNativeSessionMetadata('CODEX', 'legacy')!;
    expect(metadataOnly.messages).toEqual([]);
    expect(metadataOnly.historyMessageCount).toBe(10_000);

    const session = store.loadNativeSession('CODEX', 'legacy')!;
    expect(session.messages).toHaveLength(200);
    store.appendNativeMessage(session, {
      id: 'message-10000',
      role: 'assistant',
      content: 'newest row',
      timestamp: '2026-07-20T01:00:00.000Z',
    });

    const nextPage = store.readNativeSessionHistoryTail('CODEX', 'legacy', 80);
    expect(nextPage.messages).toHaveLength(80);
    expect(nextPage.messages.at(-1)?.id).toBe('message-10000');
    expect(store.nativeSessionMessageCount(store.loadNativeSession('CODEX', 'legacy')!)).toBe(10_001);
    expect(fs.statSync(metadataPath).size).toBeLessThan(8_192);

    const latestPositioned = store.readNativeSessionHistoryPage('CODEX', 'legacy', 100);
    expect(latestPositioned.messages[0].id).toBe('message-9901');
    expect(latestPositioned.messages.at(-1)?.id).toBe('message-10000');
    expect(latestPositioned.beforeOffset).toEqual(expect.any(Number));
    expect(latestPositioned.fileIdentity).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const olderPositioned = store.readNativeSessionHistoryPage(
      'CODEX',
      'legacy',
      100,
      latestPositioned.beforeOffset!,
      latestPositioned.fileIdentity,
    );
    expect(olderPositioned.messages[0].id).toBe('message-9801');
    expect(olderPositioned.messages.at(-1)?.id).toBe('message-9900');
  });

  test('reset and deletion retire both metadata and transcript sidecars', () => {
    const store = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
    const session = store.createNativeSession('OLLAMA', 'owner-1', {
      executionContext: createHostOperatorExecutionContext('owner-1'),
    });
    store.appendNativeMessage(session, {
      id: 'one',
      role: 'user',
      content: 'hello',
      timestamp: '2026-07-20T00:00:00.000Z',
    });
    expect(store.readAllNativeSessionHistory('OLLAMA', session.sessionId)).toHaveLength(1);

    store.clearNativeSessionHistory(session);
    expect(store.readAllNativeSessionHistory('OLLAMA', session.sessionId)).toEqual([]);
    expect(store.nativeSessionMessageCount(store.loadNativeSession('OLLAMA', session.sessionId)!)).toBe(0);

    store.deleteNativeSession('OLLAMA', session.sessionId);
    const providerDirectory = path.join(sessionsDir, 'ollama');
    expect(fs.readdirSync(providerDirectory)).toEqual([]);
  });

  test('deletion durably retires transcript before identity and exposes no artifacts', () => {
    const store = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
    const session = store.createNativeSession('CODEX', 'owner-1', {
      executionContext: createHostOperatorExecutionContext('owner-1'),
    });
    store.appendNativeMessage(session, {
      id: 'one',
      role: 'user',
      content: 'hello',
      timestamp: '2026-07-20T00:00:00.000Z',
    });
    const providerDirectory = path.join(sessionsDir, 'codex');
    const identityPath = path.join(providerDirectory, `${session.sessionId}.json`);
    const historyPath = path.join(providerDirectory, `${session.sessionId}.history.jsonl`);
    const source = fs.readFileSync(path.join(__dirname, 'NativeSessionStore.ts'), 'utf8');
    const deletion = source.slice(
      source.indexOf('export function deleteNativeSession'),
      source.indexOf('export function nativeSessionArtifactsPresent'),
    );

    expect(deletion.indexOf('unlinkSync(historyFile)')).toBeLessThan(deletion.indexOf('unlinkSync(file)'));
    expect(deletion.indexOf('unlinkSync(historyFile)'))
      .toBeLessThan(deletion.indexOf("temporaryArtifacts.filter((candidate) => candidate.kind === 'metadata')"));
    expect((deletion.match(/fsyncProviderDir\(provider\)/g) || []).length).toBeGreaterThanOrEqual(2);
    store.deleteNativeSession('CODEX', session.sessionId);
    expect(fs.existsSync(historyPath)).toBe(false);
    expect(fs.existsSync(identityPath)).toBe(false);
    expect(store.nativeSessionArtifactsPresent('CODEX', session.sessionId)).toBe(false);
  });

  test('retries mixed canonical-history and temporary-metadata deletion without orphaning plaintext', () => {
    const store = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
    const session = store.createNativeSession('CODEX', 'owner-1', {
      executionContext: createHostOperatorExecutionContext('owner-1'),
    });
    store.appendNativeMessage(session, {
      id: 'mixed-crash-row',
      role: 'user',
      content: 'must be retired before identity',
      timestamp: '2026-07-21T00:00:00.000Z',
    });
    const providerDirectory = path.join(sessionsDir, 'codex');
    const metadataPath = path.join(providerDirectory, `${session.sessionId}.json`);
    const historyPath = path.join(providerDirectory, `${session.sessionId}.history.jsonl`);
    const metadataTemp = `${metadataPath}.tmp-123-456-3`;
    fs.copyFileSync(metadataPath, metadataTemp);
    fs.chmodSync(metadataTemp, 0o600);
    fs.unlinkSync(metadataPath);

    // Supported recovery state: a durable transcript plus only its atomic
    // metadata identity. A crash after the transcript unlink remains safely
    // retryable because the temp identity is deliberately removed later.
    expect(fs.readFileSync(historyPath, 'utf8')).toContain('must be retired before identity');
    fs.unlinkSync(historyPath);
    store.deleteNativeSession('CODEX', session.sessionId);
    expect(fs.existsSync(metadataTemp)).toBe(false);
    expect(store.nativeSessionArtifactsPresent('CODEX', session.sessionId)).toBe(false);
  });

  test('discovers and durably deletes exact atomic-write residue after a process crash', () => {
    const store = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
    const context = createProjectSandboxExecutionContext({
      userId: 'owner-1',
      projectId: 'project-atomic-residue',
      workspaceOwnerId: 'owner-1',
      projectName: 'atomic-residue',
      canonicalRoot: '/srv/projects/atomic-residue',
      rootDevice: '8',
      rootInode: '707',
      rootBirthtimeNs: '1000000707',
      runtimePolicyVersion: 'project-runtime-v1',
      egressPolicyVersion: 'project-egress-v1',
      runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
      policyFingerprint: 'policy-atomic',
    });
    const session = store.createNativeSession('CODEX', 'owner-1', { executionContext: context });
    store.appendNativeMessage(session, {
      id: 'private-row',
      role: 'user',
      content: 'private atomic transcript',
      timestamp: '2026-07-21T00:00:00.000Z',
    });
    const providerDirectory = path.join(sessionsDir, 'codex');
    const metadataPath = path.join(providerDirectory, `${session.sessionId}.json`);
    const historyPath = path.join(providerDirectory, `${session.sessionId}.history.jsonl`);
    const metadataTemp = `${metadataPath}.tmp-123-456-1`;
    const historyTemp = `${historyPath}.tmp-123-456-2`;
    fs.copyFileSync(metadataPath, metadataTemp);
    fs.copyFileSync(historyPath, historyTemp);
    fs.chmodSync(metadataTemp, 0o600);
    fs.chmodSync(historyTemp, 0o600);
    fs.unlinkSync(historyPath);
    fs.unlinkSync(metadataPath);

    expect(store.nativeSessionArtifactsPresent('CODEX', session.sessionId)).toBe(true);
    expect(store.listNativeProjectSessions('CODEX', {
      projectIdentityId: context.projectId,
      canonicalRoot: context.canonicalRoot,
      rootDevice: context.rootDevice,
      rootInode: context.rootInode,
      rootBirthtimeNs: context.rootBirthtimeNs,
    }).map((candidate) => candidate.sessionId)).toEqual([session.sessionId]);

    store.deleteNativeSession('CODEX', session.sessionId);
    expect(fs.readdirSync(providerDirectory)).toEqual([]);
    expect(store.nativeSessionArtifactsPresent('CODEX', session.sessionId)).toBe(false);
  });

  test('rejects unbound transcript temps and unsafe temp aliases without deleting their targets', () => {
    const store = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
    const providerDirectory = path.join(sessionsDir, 'codex');
    fs.mkdirSync(providerDirectory, { recursive: true, mode: 0o700 });
    const orphan = path.join(providerDirectory, 'orphan.history.jsonl.tmp-123-456-1');
    fs.writeFileSync(orphan, '{"private":"transcript"}\n', { mode: 0o600 });
    expect(() => store.listNativeProjectSessions('CODEX', {
      projectIdentityId: 'project-1',
      canonicalRoot: '/srv/projects/project-1',
      rootDevice: '8',
      rootInode: '101',
      rootBirthtimeNs: '1000000000',
    })).toThrow(/orphan atomic transcript/i);

    fs.unlinkSync(orphan);
    const outside = path.join(sessionsDir, 'outside-private-sentinel');
    fs.writeFileSync(outside, 'must remain', { mode: 0o600 });
    const unsafe = path.join(providerDirectory, 'unsafe.json.tmp-123-456-2');
    fs.symlinkSync(outside, unsafe);
    expect(() => store.nativeSessionArtifactsPresent('CODEX', 'unsafe')).toThrow(/unsafe atomic-write artifact/i);
    expect(() => store.deleteNativeSession('CODEX', 'unsafe')).toThrow(/unsafe atomic-write artifact/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('must remain');
  });

  test('fsyncs atomic content and directory metadata and retires unsafe rekeying', () => {
    const store = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
    const session = store.createNativeSession('CODEX', 'owner-1', {
      executionContext: createHostOperatorExecutionContext('owner-1'),
    });
    const source = fs.readFileSync(path.join(__dirname, 'NativeSessionStore.ts'), 'utf8');
    const atomic = source.slice(
      source.indexOf('function atomicWrite'),
      source.indexOf('function assertHistoryFile'),
    );
    expect(atomic.indexOf('fsyncFile(temporary)')).toBeLessThan(atomic.indexOf('renameSync(temporary, filePath)'));
    expect(atomic).toContain('fsyncFile(filePath)');
    expect(atomic).toContain('fsyncDirectory(path.dirname(filePath))');
    const append = source.slice(
      source.indexOf('export function appendNativeMessages'),
      source.indexOf('export function clearNativeSessionHistory'),
    );
    expect(append.indexOf('dependencies.fsyncHistory ?? fsyncFile'))
      .toBeLessThan(append.indexOf('saveNativeSession(data)'));
    const reconcile = source.slice(
      source.indexOf('function reconcileHistoryMetadata'),
      source.indexOf('export function readNativeSessionHistoryPage'),
    );
    expect(reconcile.indexOf('ftruncateSync(fd, committedSize)')).toBeLessThan(reconcile.indexOf('fsyncSync(fd)'));

    expect(() => store.rekeyNativeSession('CODEX', session.sessionId, 'new-session-id'))
      .toThrow(/rekeying is retired.*not crash-safe/i);
    expect(store.loadNativeSession('CODEX', session.sessionId)?.sessionId).toBe(session.sessionId);
    expect(store.nativeSessionArtifactsPresent('CODEX', 'new-session-id')).toBe(false);
  });

  test('strict Project discovery rejects an orphan transcript instead of silently losing its scope', () => {
    const store = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
    const context = createProjectSandboxExecutionContext({
      userId: 'owner-1',
      projectId: 'project-1',
      workspaceOwnerId: 'owner-1',
      projectName: 'project-1',
      canonicalRoot: '/srv/projects/project-1',
      rootDevice: '8',
      rootInode: '101',
      rootBirthtimeNs: '1000000000',
      runtimePolicyVersion: 'project-runtime-v1',
      egressPolicyVersion: 'project-egress-v1',
      runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
      policyFingerprint: 'policy-1',
    });
    const session = store.createNativeSession('CODEX', 'owner-1', { executionContext: context });
    store.appendNativeMessage(session, {
      id: 'one',
      role: 'user',
      content: 'private transcript',
      timestamp: '2026-07-20T00:00:00.000Z',
    });
    const identityPath = path.join(sessionsDir, 'codex', `${session.sessionId}.json`);
    fs.unlinkSync(identityPath);

    expect(() => store.listNativeProjectSessions('CODEX', {
      projectIdentityId: context.projectId,
      canonicalRoot: context.canonicalRoot,
      rootDevice: context.rootDevice,
      rootInode: context.rootInode,
      rootBirthtimeNs: context.rootBirthtimeNs,
    })).toThrow(/orphan transcript sidecar/i);
  });

  test('rejects unknown and traversal-shaped provider identities before filesystem access', () => {
    const store = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
    const outsideSentinel = path.join(path.dirname(sessionsDir), 'provider-traversal-sentinel');

    expect(() => store.loadNativeSession('../../provider-traversal-sentinel' as any, 'session-1'))
      .toThrow(/provider identity is invalid/i);
    expect(() => store.listNativeSessions('NOT_A_PROVIDER' as any, 'owner-1'))
      .toThrow(/provider identity is invalid/i);
    expect(fs.existsSync(outsideSentinel)).toBe(false);
  });

  test('recovers metadata when a transcript append survives an interrupted metadata write', () => {
    const store = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
    const session = store.createNativeSession('CODEX', 'owner-1', {
      executionContext: createHostOperatorExecutionContext('owner-1'),
    });
    store.appendNativeMessage(session, {
      id: 'first',
      role: 'user',
      content: 'first request',
      timestamp: '2026-07-20T00:00:00.000Z',
    });

    const providerDirectory = path.join(sessionsDir, 'codex');
    const metadataPath = path.join(providerDirectory, `${session.sessionId}.json`);
    const historyPath = path.join(providerDirectory, `${session.sessionId}.history.jsonl`);
    const metadataBeforeSecondAppend = fs.readFileSync(metadataPath, 'utf8');
    store.appendNativeMessage(session, {
      id: 'second',
      role: 'assistant',
      content: 'second response',
      timestamp: '2026-07-20T00:01:00.000Z',
    });

    // Simulate power loss after appendFileSync reached the sidecar but before
    // the matching atomic metadata replacement became durable.
    fs.writeFileSync(metadataPath, metadataBeforeSecondAppend, { mode: 0o600 });
    const recovered = store.loadNativeSessionMetadata('CODEX', session.sessionId)!;

    expect(recovered.historyMessageCount).toBe(2);
    expect(recovered.historyLastAssistantMessage).toBe('second response');
    expect(recovered.historyByteLength).toBe(fs.statSync(historyPath).size);
    expect(store.readAllNativeSessionHistory('CODEX', session.sessionId).map((message) => message.id)).toEqual([
      'first',
      'second',
    ]);

    const committedSize = fs.statSync(historyPath).size;
    fs.appendFileSync(historyPath, '{"id":"power-loss-fragment"');
    const recoveredPartial = store.loadNativeSessionMetadata('CODEX', session.sessionId)!;
    expect(recoveredPartial.historyMessageCount).toBe(2);
    expect(recoveredPartial.historyByteLength).toBe(committedSize);
    expect(fs.statSync(historyPath).size).toBe(committedSize);
  });

  test('commits a completed user/assistant turn as one durable record and rolls back a partial write failure', () => {
    const store = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
    const session = store.createNativeSession('OLLAMA', 'owner-1', {
      executionContext: createHostOperatorExecutionContext('owner-1'),
    });
    const providerDirectory = path.join(sessionsDir, 'ollama');
    const metadataPath = path.join(providerDirectory, `${session.sessionId}.json`);
    const historyPath = path.join(providerDirectory, `${session.sessionId}.history.jsonl`);
    const metadataBeforeTurn = fs.readFileSync(metadataPath, 'utf8');
    const turn: AgentMessage[] = [
      {
        id: 'turn-user',
        role: 'user',
        content: 'complete this turn atomically',
        timestamp: '2026-07-26T20:00:00.000Z',
      },
      {
        id: 'turn-assistant',
        role: 'assistant',
        content: 'completed',
        timestamp: '2026-07-26T20:00:01.000Z',
      },
    ];

    store.appendNativeMessages(session, turn);
    expect(fs.readFileSync(historyPath, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(store.readAllNativeSessionHistory('OLLAMA', session.sessionId))
      .toEqual(turn);

    // Simulate a crash after the transcript transaction reached disk but
    // before its metadata replacement. Recovery publishes both messages.
    fs.writeFileSync(metadataPath, metadataBeforeTurn, { mode: 0o600 });
    const recovered = store.loadNativeSessionMetadata('OLLAMA', session.sessionId)!;
    expect(recovered.historyMessageCount).toBe(2);
    expect(recovered.historyLastUserMessage).toBe('complete this turn atomically');
    expect(recovered.historyLastAssistantMessage).toBe('completed');

    const historyBeforeFailure = fs.readFileSync(historyPath);
    const inMemoryBeforeFailure = [...session.messages];
    expect(() => store.appendNativeMessages(session, [
      {
        id: 'failed-user',
        role: 'user',
        content: 'must never become one-sided',
        timestamp: '2026-07-26T20:01:00.000Z',
      },
      {
        id: 'failed-assistant',
        role: 'assistant',
        content: 'must remain in the same transaction',
        timestamp: '2026-07-26T20:01:01.000Z',
      },
    ], {
      appendHistory(filePath, record) {
        fs.appendFileSync(filePath, record.slice(0, -1), { mode: 0o600 });
        throw new Error('simulated partial append failure');
      },
    })).toThrow('simulated partial append failure');
    expect(fs.readFileSync(historyPath)).toEqual(historyBeforeFailure);
    expect(session.messages).toEqual(inMemoryBeforeFailure);
    expect(store.readAllNativeSessionHistory('OLLAMA', session.sessionId))
      .toEqual(turn);
  });

  test('caps runtime tails and positioned pages by logical messages inside atomic turn records', () => {
    const store = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
    const session = store.createNativeSession('OLLAMA', 'owner-1', {
      executionContext: createHostOperatorExecutionContext('owner-1'),
    });
    for (let turn = 0; turn < 125; turn += 1) {
      store.appendNativeMessages(session, [
        {
          id: `user-${turn}`,
          role: 'user',
          content: `request ${turn}`,
          timestamp: '2026-07-26T21:00:00.000Z',
        },
        {
          id: `assistant-${turn}`,
          role: 'assistant',
          content: `response ${turn}`,
          timestamp: '2026-07-26T21:00:01.000Z',
        },
      ]);
    }

    const loaded = store.loadNativeSession('OLLAMA', session.sessionId)!;
    expect(loaded.messages).toHaveLength(200);
    expect(loaded.messages[0].id).toBe('user-25');
    expect(loaded.messages.at(-1)?.id).toBe('assistant-124');
    expect(loaded.historyMessageCount).toBe(250);

    const tail = store.readNativeSessionHistoryTail(
      'OLLAMA',
      session.sessionId,
      80,
    );
    expect(tail.messages).toHaveLength(80);
    expect(tail.messages[0].id).toBe('user-85');
    expect(tail.hasMore).toBe(true);

    const latestPage = store.readNativeSessionHistoryPage(
      'OLLAMA',
      session.sessionId,
      100,
    );
    expect(latestPage.messages).toHaveLength(100);
    expect(latestPage.messages[0].id).toBe('user-75');
    expect(latestPage.beforeOffset).toEqual(expect.any(Number));
    const olderPage = store.readNativeSessionHistoryPage(
      'OLLAMA',
      session.sessionId,
      100,
      latestPage.beforeOffset!,
      latestPage.fileIdentity,
    );
    expect(olderPage.messages).toHaveLength(100);
    expect(olderPage.messages[0].id).toBe('user-25');
    expect(olderPage.messages.at(-1)?.id).toBe('assistant-74');

    const atomicPage = store.readNativeSessionHistoryPage(
      'OLLAMA',
      session.sessionId,
      1,
    );
    expect(atomicPage.messages.map((message) => message.id)).toEqual([
      'user-124',
      'assistant-124',
    ]);
    const priorAtomicPage = store.readNativeSessionHistoryPage(
      'OLLAMA',
      session.sessionId,
      1,
      atomicPage.beforeOffset!,
      atomicPage.fileIdentity,
    );
    expect(priorAtomicPage.messages.map((message) => message.id)).toEqual([
      'user-123',
      'assistant-123',
    ]);
  });

  test('rejects traversal-shaped provider session identities before touching storage', () => {
    const store = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
    expect(() => store.loadNativeSession('CODEX', '../outside')).toThrow(/identity is invalid/);
    expect(() => store.readNativeSessionHistoryTail('CODEX', 'nested/session', 80)).toThrow(/identity is invalid/);
  });
});
