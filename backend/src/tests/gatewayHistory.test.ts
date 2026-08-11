import fs from 'fs';
import os from 'os';
import path from 'path';
import { __gatewayHistoryTest } from '../routes/gateway';
import { streamEventBus } from '../services/StreamEventBus';
import { readRuntimeTurnEvents, recordRuntimeTurnEvent } from '../services/RuntimeTurnEventHistory';
import type { RuntimeTurnEvent } from '../services/RuntimeTurnEvents';

describe('gateway history readers', () => {
  test('separates saved-session lifecycle from exact Agent Chat run activity', () => {
    const sessions = __gatewayHistoryTest.annotateAgentChatSessionRunActivity([
      {
        sessionId: 'idle-host-session',
        status: 'active' as const,
        metadata: { executionScope: 'HOST_OPERATOR' },
      },
      {
        sessionId: 'running-host-session',
        status: 'active' as const,
        metadata: { executionScope: 'HOST_OPERATOR' },
      },
      {
        sessionId: 'running-project-session',
        status: 'active' as const,
        metadata: { executionScope: 'PROJECT_SANDBOX' },
      },
    ], (sessionId) => sessionId.startsWith('running-'));

    expect(sessions).toEqual([
      expect.objectContaining({ sessionId: 'idle-host-session', status: 'active', runActive: false }),
      expect.objectContaining({ sessionId: 'running-host-session', status: 'active', runActive: true }),
      expect.objectContaining({ sessionId: 'running-project-session', status: 'active', runActive: false }),
    ]);
  });

  test('backward cursors stay stable across appends and reject another actor/session scope', () => {
    const messages = Array.from({ length: 120 }, (_, index) => ({
      id: `message-${index + 1}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `content-${index + 1}`,
      timestamp: new Date(Date.parse('2026-07-20T00:00:00.000Z') + index * 1000).toISOString(),
    }));
    const scope = __gatewayHistoryTest.historyCursorScope('actor-a', 'OPENCLAW', 'agent:main:cursor-test');
    const initial = __gatewayHistoryTest.buildHistoryPage(messages, 20, scope);

    expect(initial.messages.map((message: any) => message.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `message-${index + 101}`),
    );
    expect(initial.hasMoreBefore).toBe(true);
    expect(initial.beforeCursor).toEqual(expect.any(String));

    // New live messages arriving after the cursor was issued do not move its
    // anchor. The next page is still the exact preceding durable window.
    const appended = [
      ...messages,
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `new-${index + 1}`,
        role: 'assistant',
        content: `new-content-${index + 1}`,
        timestamp: new Date(Date.parse('2026-07-20T00:03:00.000Z') + index * 1000).toISOString(),
      })),
    ];
    const anchor = __gatewayHistoryTest.decodeHistoryCursor(initial.beforeCursor, scope);
    const older = __gatewayHistoryTest.buildHistoryPage(appended, 20, scope, anchor);
    expect(older.messages.map((message: any) => message.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `message-${index + 81}`),
    );

    const otherScope = __gatewayHistoryTest.historyCursorScope('actor-b', 'OPENCLAW', 'agent:main:cursor-test');
    expect(() => __gatewayHistoryTest.decodeHistoryCursor(initial.beforeCursor, otherScope))
      .toThrow('does not belong to this chat');

    const nativeScope = __gatewayHistoryTest.historyCursorScope('actor-a', 'CODEX', 'codex-session-1');
    const nativeInitial = __gatewayHistoryTest.buildHistoryPage(messages, 20, nativeScope);
    expect(() => __gatewayHistoryTest.decodeHistoryCursor(nativeInitial.beforeCursor, nativeScope)).not.toThrow();
    const otherNativeSessionScope = __gatewayHistoryTest.historyCursorScope('actor-a', 'CODEX', 'codex-session-2');
    expect(() => __gatewayHistoryTest.decodeHistoryCursor(nativeInitial.beforeCursor, otherNativeSessionScope))
      .toThrow('does not belong to this chat');
  });

  test('backward cursors distinguish equal timestamps and tolerate same-row live enrichment', () => {
    const timestamp = '2026-07-20T00:00:00.000Z';
    const messages = Array.from({ length: 8 }, (_, index) => ({
      id: `equal-ts-${index + 1}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `content-${index + 1}`,
      timestamp,
    }));
    const scope = __gatewayHistoryTest.historyCursorScope('actor-a', 'OPENCLAW', 'agent:main:equal-ts');
    const initial = __gatewayHistoryTest.buildHistoryPage(messages, 3, scope);
    expect(initial.messages.map((message: any) => message.id)).toEqual([
      'equal-ts-6',
      'equal-ts-7',
      'equal-ts-8',
    ]);

    const anchor = __gatewayHistoryTest.decodeHistoryCursor(initial.beforeCursor, scope);
    const enriched = messages.map((message) => message.id === 'equal-ts-6'
      ? { ...message, content: `${message.content} (completed)`, toolCalls: [{ id: 'tool-1' }] }
      : message);
    const older = __gatewayHistoryTest.buildHistoryPage(enriched, 3, scope, anchor);
    expect(older.messages.map((message: any) => message.id)).toEqual([
      'equal-ts-3',
      'equal-ts-4',
      'equal-ts-5',
    ]);
    expect(older.beforeCursor).toEqual(expect.any(String));
  });

  test('history page size is capped at 100', () => {
    expect(__gatewayHistoryTest.parseHistoryLimit(undefined)).toBe(100);
    expect(__gatewayHistoryTest.parseHistoryLimit('100')).toBe(100);
    expect(__gatewayHistoryTest.parseHistoryLimit('500')).toBe(100);
  });

  test('enhanced OpenClaw pagination uses pre-hydration source completeness for tool-heavy tails', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-source-completeness-'));
    const sessionKey = 'agent:main:tool-pair-pagination';
    const filePath = path.join(sessionsDir, `${sessionKey}.jsonl`);
    const epoch = Date.parse('2026-08-10T10:00:00.000Z');
    const lines: string[] = [];

    try {
      for (let index = 0; index < 40; index += 1) {
        lines.push(JSON.stringify({
          id: `older-user-${index}`,
          type: 'message',
          timestamp: new Date(epoch + index * 2000).toISOString(),
          message: { role: 'user', content: `older prompt ${index}` },
        }));
        lines.push(JSON.stringify({
          id: `older-assistant-${index}`,
          type: 'message',
          timestamp: new Date(epoch + index * 2000 + 1000).toISOString(),
          message: { role: 'assistant', content: `older answer ${index}` },
        }));
      }

      const longTurnTs = epoch + 100_000;
      lines.push(JSON.stringify({
        id: 'long-user',
        type: 'message',
        timestamp: new Date(longTurnTs).toISOString(),
        message: { role: 'user', content: 'run four hundred tools' },
      }));
      for (let index = 0; index < 400; index += 1) {
        lines.push(JSON.stringify({
          id: `long-tool-call-${index}`,
          type: 'message',
          timestamp: new Date(longTurnTs + index * 10 + 1).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: `long-tool-${index}`, name: 'exec', arguments: { index } }],
          },
        }));
        lines.push(JSON.stringify({
          id: `long-tool-result-${index}`,
          type: 'message',
          timestamp: new Date(longTurnTs + index * 10 + 2).toISOString(),
          message: {
            role: 'toolResult',
            toolCallId: `long-tool-${index}`,
            toolName: 'exec',
            content: 'ok',
          },
        }));
      }
      lines.push(JSON.stringify({
        id: 'long-final',
        type: 'message',
        timestamp: new Date(longTurnTs + 5000).toISOString(),
        message: { role: 'assistant', content: 'all four hundred tools finished' },
      }));
      fs.writeFileSync(filePath, lines.join('\n'));

      const scope = __gatewayHistoryTest.historyCursorScope('actor-a', 'OPENCLAW', sessionKey);
      const page = await __gatewayHistoryTest.readOpenClawHistoryPage({
        sessionKey,
        sessionId: sessionKey,
        sessionsDir,
        enhanced: true,
        limit: 20,
        scope,
      });

      expect(page.messages).toHaveLength(20);
      expect(page.hasMoreBefore).toBe(true);
      expect(page.beforeCursor).toEqual(expect.any(String));
      expect(page.messages.some((message: any) => message.content === 'run four hundred tools')).toBe(true);
      const final = page.messages.find((message: any) => message.id === 'long-final');
      expect(final?.toolCalls).toHaveLength(400);
    } finally {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test('trajectory recovery reads only bounded complete tail records', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-trajectory-tail-'));
    const trajectory = path.join(sessionsDir, 'active.trajectory.jsonl');
    try {
      const complete = JSON.stringify({ sessionKey: 'agent:main:main', data: { messagesSnapshot: [] } });
      const incomplete = JSON.stringify({ sessionKey: 'agent:main:other', data: { messagesSnapshot: [] } }).slice(0, 31);
      fs.writeFileSync(trajectory, `${'x'.repeat(4_096)}\n${complete}\n${incomplete}`);

      const tail = __gatewayHistoryTest.readBoundedJsonlTailText(trajectory, 512);
      expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(512);
      expect(tail).toBe(`${complete}\n`);
      expect(tail).not.toContain('x'.repeat(64));
      expect(tail).not.toContain('agent:main:other');
    } finally {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test('Agent Zero history pages through the provider sidecar path without loading remote lifetime history', async () => {
    const provider = {
      getHistory: jest.fn(async () => { throw new Error('remote connector must not be used'); }),
      getHistoryPage: jest.fn(async (_sessionId: string, _limit: number, beforeSequence?: number) => (
        beforeSequence === undefined
          ? {
              messages: [{ id: 'a0-9', role: 'assistant', content: 'latest', timestamp: '2026-07-20T00:00:09Z' }],
              hasMoreBefore: true,
              beforeSequence: 9,
            }
          : {
              messages: [{ id: 'a0-2', role: 'user', content: 'oldest', timestamp: '2026-07-20T00:00:02Z' }],
              hasMoreBefore: false,
              beforeSequence: null,
            }
      )),
    };
    const scope = __gatewayHistoryTest.historyCursorScope('actor-a0', 'AGENT_ZERO', 'CtxPaged');
    const latest = await __gatewayHistoryTest.readAgentZeroHistoryPage({
      provider,
      sessionId: 'CtxPaged',
      limit: 80,
      scope,
    });
    expect(latest.messages.map((message: any) => message.id)).toEqual(['a0-9']);
    expect(latest.hasMoreBefore).toBe(true);

    const older = await __gatewayHistoryTest.readAgentZeroHistoryPage({
      provider,
      sessionId: 'CtxPaged',
      limit: 80,
      scope,
      beforeCursor: latest.beforeCursor,
    });
    expect(older.messages.map((message: any) => message.id)).toEqual(['a0-2']);
    expect(provider.getHistoryPage).toHaveBeenNthCalledWith(2, 'CtxPaged', 80, 9);
    expect(provider.getHistory).not.toHaveBeenCalled();

    const otherScope = __gatewayHistoryTest.historyCursorScope('other-a0', 'AGENT_ZERO', 'CtxPaged');
    await expect(__gatewayHistoryTest.readAgentZeroHistoryPage({
      provider,
      sessionId: 'CtxPaged',
      limit: 80,
      scope: otherScope,
      beforeCursor: latest.beforeCursor,
    })).rejects.toThrow('does not belong to this chat');
  });

  test('native 10k sidecar history uses bounded byte-positioned pages', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-native-history-'));
    const previousSessionsDir = process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
    process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = sessionsDir;
    jest.resetModules();

    try {
      const providerDir = path.join(sessionsDir, 'codex');
      fs.mkdirSync(providerDir, { recursive: true });
      const messages = Array.from({ length: 10_000 }, (_, index) => ({
        id: `native-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `native history ${index}`,
        timestamp: new Date(Date.parse('2026-07-20T00:00:00.000Z') + index).toISOString(),
      }));
      fs.writeFileSync(path.join(providerDir, 'native-long.json'), JSON.stringify({
        sessionId: 'native-long',
        provider: 'CODEX',
        userId: 'actor-native',
        createdAt: '2026-07-20T00:00:00.000Z',
        lastActivityAt: '2026-07-20T00:00:00.000Z',
        cwd: '/workspace',
        executionContext: {
          scope: 'HOST_OPERATOR',
          source: 'PORTAL_SERVER',
          userId: 'actor-native',
        },
        messages,
      }));

      const store = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
      const scope = __gatewayHistoryTest.historyCursorScope('actor-native', 'CODEX', 'native-long');
      const pageReads: Array<{ limit: number; beforeOffset?: number; expectedFileIdentity?: string }> = [];
      const readPage = (limit: number, beforeOffset?: number, expectedFileIdentity?: string) => {
        pageReads.push({ limit, beforeOffset, expectedFileIdentity });
        return store.readNativeSessionHistoryPage(
          'CODEX',
          'native-long',
          limit,
          beforeOffset,
          expectedFileIdentity,
        );
      };

      const latest = __gatewayHistoryTest.readNativeHistoryPage({
        providerName: 'CODEX',
        sessionId: 'native-long',
        limit: 100,
        scope,
        readPage,
      });
      expect(pageReads).toEqual([{ limit: 100 }]);
      expect(latest.messages).toHaveLength(100);
      expect(latest.messages[0].id).toBe('native-9900');
      expect(latest.messages.at(-1)?.id).toBe('native-9999');
      expect(latest.hasMoreBefore).toBe(true);

      pageReads.length = 0;
      const older = __gatewayHistoryTest.readNativeHistoryPage({
        providerName: 'CODEX',
        sessionId: 'native-long',
        limit: 100,
        scope,
        beforeCursor: latest.beforeCursor,
        readPage,
      });
      expect(pageReads).toHaveLength(1);
      expect(pageReads[0].limit).toBe(100);
      expect(pageReads[0].beforeOffset).toEqual(expect.any(Number));
      expect(pageReads[0].expectedFileIdentity).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(older.messages[0].id).toBe('native-9800');
      expect(older.messages.at(-1)?.id).toBe('native-9899');

      const metadata = JSON.parse(fs.readFileSync(path.join(providerDir, 'native-long.json'), 'utf8'));
      expect(metadata.messages).toEqual([]);
      expect(fs.statSync(path.join(providerDir, 'native-long.json')).size).toBeLessThan(8_192);
      expect(fs.readFileSync(path.join(providerDir, 'native-long.history.jsonl'), 'utf8').trim().split('\n')).toHaveLength(10_000);
    } finally {
      if (previousSessionsDir === undefined) delete process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
      else process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = previousSessionsDir;
      fs.rmSync(sessionsDir, { recursive: true, force: true });
      jest.resetModules();
    }
  });

  test('tail reader adaptively skips artifacts without parsing a 25k-line transcript', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-history-tail-'));
    const sessionId = 'adaptive-tail-session';
    const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
    const historicalArtifacts = Array.from({ length: 25_000 }, (_, index) => JSON.stringify({
      type: 'artifact',
      index,
      payload: 'x'.repeat(48),
    }));
    const durableMessages = Array.from({ length: 80 }, (_, index) => JSON.stringify({
      type: 'message',
      id: `message-${index + 1}`,
    }));
    const trailingArtifacts = Array.from({ length: 260 }, (_, index) => JSON.stringify({
      type: 'artifact',
      index: `tail-${index}`,
    }));
    fs.writeFileSync(filePath, [...historicalArtifacts, ...durableMessages, ...trailingArtifacts].join('\n'));

    let parsedLines = 0;
    const messages = __gatewayHistoryTest.readRecentSessionMessages({
      sessionId,
      limit: 40,
      sessionsDir,
      parseLine: (line: string) => {
        parsedLines += 1;
        const parsed = JSON.parse(line);
        return parsed.type === 'message' ? parsed : null;
      },
    });

    expect(messages).toHaveLength(40);
    expect(messages[0].id).toBe('message-41');
    expect(messages.at(-1).id).toBe('message-80');
    // Windows grow 200 -> 400; the implementation may reparse those bounded
    // tails, but it must not touch the 25,000 historical artifact records.
    expect(parsedLines).toBeLessThan(1_000);
  });

  test('mergeHistoryToolCalls collapses metadata-free ghost duplicates of the same tool', () => {
    const merged = __gatewayHistoryTest.mergeHistoryToolCalls(
      [
        { id: 'toolu_rich', name: 'exec', arguments: { command: 'echo RAIL_TOOL' }, result: 'RAIL_TOOL', startedAt: 1000, endedAt: 5900, status: 'done' },
      ],
      [
        // Same call arriving from the stream lane with a different id and no metadata.
        { id: 'tool-ghost-1', name: 'tool', startedAt: 1200, endedAt: 1200, status: 'done' },
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('toolu_rich');

    // Two genuinely distinct substantive calls survive.
    const distinct = __gatewayHistoryTest.mergeHistoryToolCalls(
      [{ id: 'a', name: 'exec', arguments: { command: 'ls' }, startedAt: 1000 }],
      [{ id: 'b', name: 'exec', arguments: { command: 'pwd' }, startedAt: 2000 }],
    );
    expect(distinct).toHaveLength(2);

    // A lone metadata-free call (no rich sibling) is preserved.
    const lone = __gatewayHistoryTest.mergeHistoryToolCalls(undefined, [
      { id: 'only', name: 'tool', startedAt: 1000 },
    ]);
    expect(lone).toHaveLength(1);
  });

  test('legacy history converts reasoning mirrors into thinkingContent instead of assistant content', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-history-'));
    const sessionId = 'reasoning-mirror-session';
    const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);

    fs.writeFileSync(filePath, [
      JSON.stringify({
        id: 'u1',
        type: 'message',
        timestamp: '2026-05-25T20:00:00.000Z',
        message: {
          role: 'user',
          content: 'hello',
        },
      }),
      JSON.stringify({
        id: 'r1',
        type: 'message',
        timestamp: '2026-05-25T20:00:01.000Z',
        message: {
          role: 'assistant',
          content: 'Codex reasoning: inspect the runtime event ordering',
          __openclaw: { mirrorIdentity: 'turn-1:reasoning' },
          idempotencyKey: 'codex-app-server:turn-1:reasoning',
        },
      }),
      JSON.stringify({
        id: 'a1',
        type: 'message',
        timestamp: '2026-05-25T20:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Final answer.' }],
        },
      }),
    ].join('\n'));

    const messages = await __gatewayHistoryTest.readSessionMessages(sessionId, 10, sessionsDir);

    expect(messages).toEqual([
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2026-05-25T20:00:00.000Z' },
      {
        id: 'r1',
        role: 'assistant',
        content: '',
        thinkingContent: 'inspect the runtime event ordering',
        timestamp: '2026-05-25T20:00:01.000Z',
        provenance: 'reasoning-mirror',
      },
      { id: 'a1', role: 'assistant', content: 'Final answer.', timestamp: '2026-05-25T20:00:02.000Z' },
    ]);
  });

  test('enhanced history converts array reasoning mirrors into thinkingContent', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-history-'));
    const sessionId = 'enhanced-reasoning-mirror-session';
    const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);

    fs.writeFileSync(filePath, [
      JSON.stringify({
        id: 'r1',
        type: 'message',
        timestamp: '2026-05-25T20:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'OpenClaw reasoning: normalize the source reply before final delivery' }],
          __openclaw: { mirrorIdentity: 'turn-2:reasoning' },
        },
      }),
    ].join('\n'));

    const messages = __gatewayHistoryTest.readSessionMessagesEnhanced(sessionId, 10, sessionsDir);

    expect(messages).toEqual([
      {
        id: 'r1',
        role: 'assistant',
        content: '',
        model: undefined,
        thinkingContent: 'normalize the source reply before final delivery',
        toolCalls: undefined,
        segments: undefined,
        timestamp: '2026-05-25T20:00:01.000Z',
      },
    ]);
  });

  test('enhanced history summarizes gateway restart recovery prompts as system markers', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-history-'));
    const sessionId = 'gateway-restart-marker-session';
    const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);

    fs.writeFileSync(filePath, JSON.stringify({
      id: 'restart-1',
      type: 'message',
      timestamp: '2026-05-25T20:00:00.000Z',
      message: {
        role: 'user',
        content: '[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.',
      },
    }) + '\n');

    const messages = __gatewayHistoryTest.readSessionMessagesEnhanced(sessionId, 10, sessionsDir);

    expect(messages).toEqual([
      {
        id: 'restart-1',
        role: 'system',
        content: 'Previous turn interrupted by gateway restart',
        provenance: 'hidden-history-artifact',
        timestamp: '2026-05-25T20:00:00.000Z',
      },
    ]);
  });

  test('best OpenClaw history follows usage-family session ids across restart recovery', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-usage-family-history-'));
    const sessionKey = 'agent:max_revenue:new-usage-family';
    const firstSessionId = 'usage-family-first';
    const currentSessionId = 'usage-family-current';

    fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: {
        sessionId: currentSessionId,
        usageFamilySessionIds: [firstSessionId, currentSessionId],
      },
    }));
    fs.writeFileSync(path.join(sessionsDir, `${firstSessionId}.jsonl`), [
      JSON.stringify({
        id: 'family-user-1',
        type: 'message',
        timestamp: '2026-08-02T03:40:00.000Z',
        message: { role: 'user', content: 'Keep this earlier request.' },
      }),
      JSON.stringify({
        id: 'family-assistant-1',
        type: 'message',
        timestamp: '2026-08-02T03:41:00.000Z',
        message: { role: 'assistant', content: 'Keep this earlier answer.' },
      }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(sessionsDir, `${currentSessionId}.jsonl`), JSON.stringify({
      id: 'family-user-2',
      type: 'message',
      timestamp: '2026-08-02T04:03:00.000Z',
      message: { role: 'user', content: 'Continue after the restart.' },
    }) + '\n');

    const messages = __gatewayHistoryTest.readBestOpenClawSessionMessagesForSessionKey(
      sessionKey,
      20,
      sessionsDir,
    );

    expect(messages.map((message: any) => message.id)).toEqual([
      'family-user-1',
      'family-assistant-1',
      'family-user-2',
    ]);
  });

  test('usage-family pagination does not report completion when the merged files exceed the read window', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-usage-family-pagination-'));
    const sessionKey = 'agent:main:usage-family-pagination';
    const firstSessionId = 'usage-family-page-first';
    const currentSessionId = 'usage-family-page-current';
    const epoch = Date.parse('2026-08-10T08:00:00.000Z');
    const rows = (start: number, count: number) => Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      return JSON.stringify({
        id: `family-page-${index}`,
        type: 'message',
        timestamp: new Date(epoch + index * 1000).toISOString(),
        message: {
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `usage family message ${index}`,
        },
      });
    }).join('\n') + '\n';

    try {
      fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), JSON.stringify({
        [sessionKey]: {
          sessionId: currentSessionId,
          usageFamilySessionIds: [firstSessionId, currentSessionId],
        },
      }));
      fs.writeFileSync(path.join(sessionsDir, `${firstSessionId}.jsonl`), rows(0, 150));
      fs.writeFileSync(path.join(sessionsDir, `${currentSessionId}.jsonl`), rows(150, 150));

      const scope = __gatewayHistoryTest.historyCursorScope('actor-a', 'OPENCLAW', sessionKey);
      const readPage = (beforeCursor?: string | null) => __gatewayHistoryTest.readOpenClawHistoryPage({
        sessionKey,
        sessionId: currentSessionId,
        sessionsDir,
        enhanced: true,
        limit: 100,
        scope,
        ...(beforeCursor ? { beforeCursor } : {}),
      });

      const newest = await readPage();
      const middle = await readPage(newest.beforeCursor);
      const oldest = await readPage(middle.beforeCursor);

      expect(newest.messages[0].id).toBe('family-page-200');
      expect(newest.messages.at(-1).id).toBe('family-page-299');
      expect(newest.hasMoreBefore).toBe(true);
      expect(middle.messages[0].id).toBe('family-page-100');
      expect(middle.messages.at(-1).id).toBe('family-page-199');
      expect(middle.hasMoreBefore).toBe(true);
      expect(oldest.messages[0].id).toBe('family-page-0');
      expect(oldest.messages.at(-1).id).toBe('family-page-99');
      expect(oldest.hasMoreBefore).toBe(false);
    } finally {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test('best OpenClaw history filters stale trajectory snapshots around canonical transcript span', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-history-'));
    const sessionKey = 'agent:main:trajectory-window-test';
    const canonicalFilePath = path.join(sessionsDir, `${sessionKey}.jsonl`);
    const trajectoryFilePath = path.join(sessionsDir, 'trajectory-window-test.trajectory.jsonl');

    fs.writeFileSync(canonicalFilePath, [
      JSON.stringify({
        id: 'u1',
        type: 'message',
        timestamp: '2026-05-25T20:00:00.000Z',
        message: { role: 'user', content: 'current question' },
      }),
      JSON.stringify({
        id: 'a1',
        type: 'message',
        timestamp: '2026-05-25T20:01:00.000Z',
        message: { role: 'assistant', content: 'current answer', model: 'openai/gpt-5.5' },
      }),
    ].join('\n'));

    fs.writeFileSync(trajectoryFilePath, JSON.stringify({
      sessionKey,
      runId: 'run-1',
      ts: '2026-05-25T20:02:00.000Z',
      data: {
        messagesSnapshot: [
          {
            id: 'old-trajectory-card',
            role: 'assistant',
            content: 'stale recovered tool card from yesterday',
            model: 'openai/gpt-5.2',
            timestamp: '2026-05-24T20:00:00.000Z',
          },
          {
            id: 'near-trajectory-card',
            role: 'assistant',
            content: 'nearby recovered tool card',
            model: 'openai/gpt-5.5',
            timestamp: '2026-05-25T20:02:00.000Z',
          },
        ],
      },
    }) + '\n');

    const messages = __gatewayHistoryTest.readBestOpenClawSessionMessagesForSessionKey(sessionKey, 20, sessionsDir);
    const contents = messages.map((message: any) => message.content);

    expect(contents).toContain('current question');
    expect(contents).toContain('current answer');
    expect(contents).toContain('nearby recovered tool card');
    expect(contents).not.toContain('stale recovered tool card from yesterday');
    expect(messages.some((message: any) => message.model === 'openai/gpt-5.2')).toBe(false);
  });

  test('collapses replace-style reasoning snapshots into one persisted event per thought', () => {
    const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-turn-events-'));
    const previousEventDir = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = eventDir;

    try {
      const sessionKey = 'agent:main:reasoning-collapse-test';
      const event = (type: RuntimeTurnEvent['type'], seq: number, extra: Partial<RuntimeTurnEvent> = {}): RuntimeTurnEvent => ({
        schema: 'bridgesllm.runtime-turn-event.v1',
        type,
        sessionKey,
        runId: 'run-collapse',
        seq,
        ts: Date.parse('2026-07-14T12:00:00.000Z') + seq * 100,
        visible: true,
        source: { transport: 'portal-stream-event-bus', eventType: type === 'assistant_reasoning' ? 'thinking' : 'text' },
        ...extra,
      });

      // A claude-cli thought streams as many growing snapshots; only the first
      // (segment start) and the settled snapshot should reach disk.
      recordRuntimeTurnEvent(sessionKey, event('assistant_reasoning', 0, { text: 'Plan' }));
      recordRuntimeTurnEvent(sessionKey, event('assistant_reasoning', 1, { text: 'Plan the', replace: true }));
      recordRuntimeTurnEvent(sessionKey, event('assistant_reasoning', 2, { text: 'Plan the fix', replace: true }));
      recordRuntimeTurnEvent(sessionKey, event('assistant_reasoning', 3, { text: 'Plan the fix carefully', replace: true }));
      recordRuntimeTurnEvent(sessionKey, event('assistant_final', 4, { text: 'Done.', terminal: true }));

      const digest = require('crypto').createHash('sha256').update(sessionKey).digest('hex').slice(0, 32);
      const persistedLines = fs.readFileSync(path.join(eventDir, `${digest}.jsonl`), 'utf8')
        .split('\n')
        .filter((line: string) => line.trim())
        .map((line: string) => JSON.parse(line));
      const reasoningLines = persistedLines.filter((entry: any) => entry.type === 'assistant_reasoning');

      // Intermediate snapshots collapsed: the pending snapshot replaced in
      // memory and only the settled thought was flushed by assistant_final.
      expect(reasoningLines).toHaveLength(1);
      expect(reasoningLines[0].text).toBe('Plan the fix carefully');

      const replayed = readRuntimeTurnEvents(sessionKey, 50);
      expect(replayed.filter((entry) => entry.type === 'assistant_reasoning')).toHaveLength(1);
    } finally {
      if (previousEventDir === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
      else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = previousEventDir;
    }
  });

  test('collapses replace-style preamble statuses instead of persisting token floods', () => {
    const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-preamble-events-'));
    const previousEventDir = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = eventDir;

    try {
      const sessionKey = 'agent:main:preamble-collapse-test';
      const base = (seq: number, text: string): RuntimeTurnEvent => ({
        schema: 'bridgesllm.runtime-turn-event.v1',
        type: 'assistant_status',
        sessionKey,
        runId: 'run-preamble-collapse',
        seq,
        ts: Date.parse('2026-08-02T04:00:00.000Z') + seq,
        text,
        replace: true,
        visible: true,
        source: { transport: 'portal-stream-event-bus', eventType: 'status' },
      });
      recordRuntimeTurnEvent(sessionKey, base(1, 'Inspect'));
      recordRuntimeTurnEvent(sessionKey, base(2, 'Inspect every'));
      recordRuntimeTurnEvent(sessionKey, base(3, 'Inspect every file'));

      const replayed = readRuntimeTurnEvents(sessionKey, 50);
      expect(replayed.filter((event) => event.type === 'assistant_status')).toEqual([
        expect.objectContaining({ text: 'Inspect every file', replace: true }),
      ]);
    } finally {
      if (previousEventDir === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
      else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = previousEventDir;
      fs.rmSync(eventDir, { recursive: true, force: true });
    }
  });

  test('history reads flush the pending reasoning snapshot mid-turn', () => {
    const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-turn-events-'));
    const previousEventDir = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = eventDir;

    try {
      const sessionKey = 'agent:main:reasoning-pending-read-test';
      const event = (seq: number, extra: Partial<RuntimeTurnEvent> = {}): RuntimeTurnEvent => ({
        schema: 'bridgesllm.runtime-turn-event.v1',
        type: 'assistant_reasoning',
        sessionKey,
        runId: 'run-pending-read',
        seq,
        ts: Date.parse('2026-07-14T12:10:00.000Z') + seq * 100,
        visible: true,
        source: { transport: 'portal-stream-event-bus', eventType: 'thinking' },
        ...extra,
      });

      recordRuntimeTurnEvent(sessionKey, event(0, { text: 'Live thought' }));
      recordRuntimeTurnEvent(sessionKey, event(1, { text: 'Live thought still going', replace: true }));

      // Resume replay while the turn is still streaming must see the thought.
      const replayed = readRuntimeTurnEvents(sessionKey, 50);
      const reasoning = replayed.filter((entry) => entry.type === 'assistant_reasoning');
      expect(reasoning).toHaveLength(1);
      expect(reasoning[0].text).toBe('Live thought still going');
    } finally {
      if (previousEventDir === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
      else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = previousEventDir;
    }
  });

  test('enhanced session history restores runtime thinking segments after refresh', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-history-'));
    const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-turn-events-'));
    const previousEventDir = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = eventDir;

    try {
      const sessionKey = 'agent:main:runtime-overlay-test';
      const filePath = path.join(sessionsDir, `${sessionKey}.jsonl`);
      fs.writeFileSync(filePath, [
        JSON.stringify({
          id: 'u1',
          type: 'message',
          timestamp: '2026-05-30T04:00:00.000Z',
          message: { role: 'user', content: 'use a tool and explain' },
        }),
        JSON.stringify({
          id: 'a1',
          type: 'message',
          timestamp: '2026-05-30T04:00:10.000Z',
          message: { role: 'assistant', content: 'Done after the tool.', model: 'openai-codex/gpt-5.5' },
        }),
      ].join('\n'));

      const event = (type: RuntimeTurnEvent['type'], seq: number, ts: number, extra: Partial<RuntimeTurnEvent> = {}): RuntimeTurnEvent => ({
        schema: 'bridgesllm.runtime-turn-event.v1',
        type,
        sessionKey,
        runId: 'run-overlay',
        seq,
        ts,
        visible: true,
        source: { transport: 'portal-stream-event-bus', eventType: type === 'assistant_reasoning' ? 'thinking' : (type === 'assistant_status' ? 'status' : 'text') },
        ...extra,
      });

      recordRuntimeTurnEvent(sessionKey, event('assistant_status', 0, Date.parse('2026-05-30T04:00:00.500Z'), {
        text: 'Starting Codex turn...',
      }));
      recordRuntimeTurnEvent(sessionKey, event('assistant_reasoning', 1, Date.parse('2026-05-30T04:00:01.000Z'), {
        text: 'I need to inspect the file first.',
        replace: true,
      }));
      recordRuntimeTurnEvent(sessionKey, event('tool_started', 2, Date.parse('2026-05-30T04:00:02.000Z'), {
        tool: { id: 'tool-read', name: 'read', status: 'running', arguments: { path: 'README.md' } },
      }));
      recordRuntimeTurnEvent(sessionKey, event('tool_output', 3, Date.parse('2026-05-30T04:00:03.000Z'), {
        tool: { id: 'tool-read', name: 'read', status: 'done', result: 'ok' },
      }));
      recordRuntimeTurnEvent(sessionKey, event('assistant_reasoning', 4, Date.parse('2026-05-30T04:00:04.000Z'), {
        text: 'Now I can answer with the verified detail.',
        replace: true,
      }));
      recordRuntimeTurnEvent(sessionKey, event('assistant_final', 5, Date.parse('2026-05-30T04:00:10.000Z'), {
        text: 'Done after the tool.',
        terminal: true,
      }));

      const messages = __gatewayHistoryTest.readSessionMessagesEnhancedForSessionKey(sessionKey, 20, sessionsDir);
      const assistant = messages.find((message: any) => message.id === 'a1');
      const runtimeOverlay = messages.find((message: any) => (
        message?.__portal?.kind === 'runtime-turn-event-history'
      ));

      expect(assistant).toBeTruthy();
      expect(runtimeOverlay?.segments.map((segment: any) => segment.text)).toEqual([
        'Starting Codex turn...',
        'I need to inspect the file first.',
        'Now I can answer with the verified detail.',
      ]);
      expect(runtimeOverlay?.toolCalls).toEqual([
        expect.objectContaining({
          id: 'tool-read',
          name: 'read',
          result: 'ok',
          status: 'done',
        }),
      ]);
    } finally {
      if (previousEventDir === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
      else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = previousEventDir;
    }
  });

  test('enhanced session history keeps richer runtime evidence standalone when a durable tool is only partial', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-history-'));
    const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-turn-events-'));
    const previousEventDir = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = eventDir;

    try {
      const sessionKey = 'agent:main:runtime-merge-existing-segments-test';
      const filePath = path.join(sessionsDir, `${sessionKey}.jsonl`);
      fs.writeFileSync(filePath, [
        JSON.stringify({
          id: 'u1',
          type: 'message',
          timestamp: '2026-05-30T04:10:00.000Z',
          message: { role: 'user', content: 'steer while the tool is running' },
        }),
        JSON.stringify({
          id: 'a1',
          type: 'message',
          timestamp: '2026-05-30T04:10:05.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Existing local segment.' },
              { type: 'toolCall', id: 'tool-read', name: 'read', arguments: { path: 'README.md' } },
              { type: 'text', text: 'Partial answer after steering.' },
            ],
            model: 'openai-codex/gpt-5.5',
          },
        }),
      ].join('\n'));

      const event = (type: RuntimeTurnEvent['type'], seq: number, ts: number, extra: Partial<RuntimeTurnEvent> = {}): RuntimeTurnEvent => ({
        schema: 'bridgesllm.runtime-turn-event.v1',
        type,
        sessionKey,
        runId: 'run-merge-existing',
        seq,
        ts,
        visible: true,
        source: { transport: 'portal-stream-event-bus', eventType: type === 'assistant_reasoning' ? 'thinking' : (type === 'tool_started' ? 'tool_start' : 'text') },
        ...extra,
      });

      const durableAssistantBefore = __gatewayHistoryTest
        .readSessionMessagesEnhancedForSessionKey(sessionKey, 20, sessionsDir)
        .find((message: any) => message.id === 'a1');

      recordRuntimeTurnEvent(sessionKey, event('assistant_reasoning', 1, Date.parse('2026-05-30T04:10:02.000Z'), {
        text: 'Recovered reasoning that used to disappear after steering.',
      }));
      recordRuntimeTurnEvent(sessionKey, event('tool_started', 2, Date.parse('2026-05-30T04:10:03.000Z'), {
        tool: { id: 'tool-read', name: 'read', status: 'running', arguments: { path: 'README.md' } },
      }));
      recordRuntimeTurnEvent(sessionKey, event('assistant_final', 3, Date.parse('2026-05-30T04:10:05.000Z'), {
        text: 'Partial answer after steering.',
        terminal: true,
      }));

      const messages = __gatewayHistoryTest.readSessionMessagesEnhancedForSessionKey(sessionKey, 20, sessionsDir);
      const assistant = messages.find((message: any) => message.id === 'a1');
      const runtimeOverlay = messages.find((message: any) => (
        message?.__portal?.kind === 'runtime-turn-event-history'
      ));

      expect(assistant).toEqual(durableAssistantBefore);
      expect(runtimeOverlay?.segments.map((segment: any) => segment.text)).toEqual(expect.arrayContaining([
        'Recovered reasoning that used to disappear after steering.',
      ]));
      expect(runtimeOverlay?.toolCalls).toEqual([
        expect.objectContaining({
          id: 'tool-read',
          name: 'read',
          result: undefined,
          status: 'done',
        }),
      ]);
    } finally {
      if (previousEventDir === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
      else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = previousEventDir;
    }
  });

  test('active stream snapshot can recover from recent non-terminal runtime events', () => {
    const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-turn-events-'));
    const previousEventDir = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = eventDir;

    try {
      const sessionKey = 'agent:main:runtime-active-recovery-test';
      const now = Date.now();
      const event = (type: RuntimeTurnEvent['type'], seq: number, ts: number, extra: Partial<RuntimeTurnEvent> = {}): RuntimeTurnEvent => ({
        schema: 'bridgesllm.runtime-turn-event.v1',
        type,
        sessionKey,
        runId: 'run-active-recovery',
        seq,
        ts,
        visible: true,
        source: { transport: 'portal-stream-event-bus', eventType: type === 'tool_started' ? 'tool_start' : 'status' },
        ...extra,
      });

      recordRuntimeTurnEvent(sessionKey, event('assistant_status', 0, now - 1000, {
        text: 'Codex is working...',
      }));
      recordRuntimeTurnEvent(sessionKey, event('tool_started', 1, now, {
        tool: { id: 'tool-audit', name: 'bash', status: 'running', arguments: { cmd: 'npm run build' } },
      }));

      expect(__gatewayHistoryTest.getOpenClawRuntimeActiveStreamSnapshot(sessionKey)).toEqual(expect.objectContaining({
        active: true,
        phase: 'tool',
        runId: 'run-active-recovery',
        toolName: 'bash',
      }));

      recordRuntimeTurnEvent(sessionKey, event('turn_done', 2, now + 1, {
        terminal: true,
        visible: false,
      }));

      expect(__gatewayHistoryTest.getOpenClawRuntimeActiveStreamSnapshot(sessionKey)).toEqual(expect.objectContaining({
        active: false,
        inactiveReason: 'terminal',
        safeToClear: true,
      }));
    } finally {
      if (previousEventDir === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
      else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = previousEventDir;
    }
  });

  test('enhanced session history keeps prompt and final after long tool-heavy runtime overlay', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-history-'));
    const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-turn-events-'));
    const previousEventDir = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = eventDir;

    try {
      const sessionKey = 'agent:main:runtime-long-tool-overlay-test';
      const filePath = path.join(sessionsDir, `${sessionKey}.jsonl`);
      const toolOnlyCount = 650;
      const toolBaseTs = Date.parse('2026-05-30T04:20:00.000Z');
      const lines: string[] = [
        JSON.stringify({
          id: 'u1',
          type: 'message',
          timestamp: '2026-05-30T04:19:03.000Z',
          message: { role: 'user', content: 'make the animation better' },
        }),
      ];

      for (let index = 0; index < toolOnlyCount; index += 1) {
        lines.push(JSON.stringify({
          id: `tool-call-${index}`,
          type: 'message',
          timestamp: new Date(toolBaseTs + index * 1000).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: `tool-${index}`, name: 'apply_patch', arguments: { index } }],
          },
        }));
        // Hydration folds each result into its preceding toolCall. The raw
        // source therefore has twice as many rows as the hydrated projection;
        // source exhaustion must come from the pre-hydration tail reader, not
        // `hydrated.length < requestedLimit`.
        lines.push(JSON.stringify({
          id: `tool-result-${index}`,
          type: 'message',
          timestamp: new Date(toolBaseTs + index * 1000 + 500).toISOString(),
          message: {
            role: 'toolResult',
            toolCallId: `tool-${index}`,
            toolName: 'apply_patch',
            content: 'ok',
          },
        }));
      }

      lines.push(JSON.stringify({
        id: 'a-final',
        type: 'message',
        timestamp: new Date(toolBaseTs + toolOnlyCount * 1000 + 500).toISOString(),
        message: { role: 'assistant', content: 'Finished the upgrade.', model: 'openai-codex/gpt-5.5' },
      }));
      fs.writeFileSync(filePath, lines.join('\n'));

      const event = (type: RuntimeTurnEvent['type'], seq: number, ts: number, extra: Partial<RuntimeTurnEvent> = {}): RuntimeTurnEvent => ({
        schema: 'bridgesllm.runtime-turn-event.v1',
        type,
        sessionKey,
        runId: 'run-long-tools',
        seq,
        ts,
        visible: true,
        source: { transport: 'portal-stream-event-bus', eventType: type === 'assistant_reasoning' ? 'thinking' : 'text' },
        ...extra,
      });

      recordRuntimeTurnEvent(sessionKey, event('assistant_reasoning', 1, Date.parse('2026-05-30T04:19:05.000Z'), {
        text: 'I will inspect and improve the existing file.',
        replace: true,
      }));
      for (let index = 0; index < toolOnlyCount; index += 1) {
        recordRuntimeTurnEvent(sessionKey, event('tool_started', index + 2, toolBaseTs + index * 1000, {
          tool: { id: `tool-${index}`, name: 'apply_patch', status: 'running', arguments: { index } },
        }));
      }
      recordRuntimeTurnEvent(sessionKey, event('assistant_final', toolOnlyCount + 3, toolBaseTs + toolOnlyCount * 1000 + 500, {
        text: 'Finished the upgrade.',
        terminal: true,
      }));

      const messages = __gatewayHistoryTest.readSessionMessagesEnhancedForSessionKey(sessionKey, 20, sessionsDir);
      const roles = messages.map((message: any) => message.role);
      const final = messages.find((message: any) => message.id === 'a-final');
      const runtimeOverlay = messages.find((message: any) => (
        message?.__portal?.kind === 'runtime-turn-event-history'
      ));
      const retainedTools = [
        ...(Array.isArray(final?.toolCalls) ? final.toolCalls : []),
        ...(Array.isArray(runtimeOverlay?.toolCalls) ? runtimeOverlay.toolCalls : []),
      ];

      expect(roles).toContain('user');
      expect(messages.some((message: any) => message.content === 'make the animation better')).toBe(true);
      expect(final).toBeTruthy();
      expect(messages.filter((message: any) => message.content === 'Finished the upgrade.')).toHaveLength(1);
      expect(runtimeOverlay?.content).toBe('');
      expect(new Set(retainedTools.map((tool: any) => tool.id)).size).toBe(toolOnlyCount);
      expect(runtimeOverlay?.segments.map((segment: any) => segment.text))
        .toContain('I will inspect and improve the existing file.');
      expect(messages.filter((message: any) => (
        message.role === 'assistant'
        && !message.content
        && Array.isArray(message.toolCalls)
        && message?.__portal?.kind !== 'runtime-turn-event-history'
      ))).toHaveLength(0);
    } finally {
      if (previousEventDir === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
      else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = previousEventDir;
    }
  });

  test('terminal contentless runtime history reconciles a fragmented canonical tool timeline exactly once', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-contentless-runtime-'));
    const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-contentless-events-'));
    const previousEventDir = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = eventDir;

    try {
      const sessionKey = 'agent:main:contentless-fragmented-runtime-test';
      const runId = 'run-contentless-fragmented';
      const heartbeatRunId = 'run-contentless-heartbeat';
      const filePath = path.join(sessionsDir, `${sessionKey}.jsonl`);
      const baseTs = Date.parse('2026-08-10T21:59:10.000Z');
      const toolIds = Array.from({ length: 11 }, (_, index) => `stable-call-${index + 1}`);
      const lines: string[] = [
        JSON.stringify({
          id: 'prior-user',
          type: 'message',
          timestamp: new Date(baseTs - 2_000).toISOString(),
          message: { role: 'user', content: 'prior prompt' },
        }),
        JSON.stringify({
          id: 'prior-assistant',
          type: 'message',
          timestamp: new Date(baseTs - 1_000).toISOString(),
          message: { role: 'assistant', content: 'prior answer' },
        }),
        JSON.stringify({
          id: 'smoke-user',
          type: 'message',
          timestamp: new Date(baseTs).toISOString(),
          message: { role: 'user', content: 'run the chronology smoke test' },
        }),
      ];
      const runtimeEvents: RuntimeTurnEvent[] = [];
      let seq = 1;
      const runtimeEvent = (
        type: RuntimeTurnEvent['type'],
        ts: number,
        extra: Partial<RuntimeTurnEvent> = {},
      ): RuntimeTurnEvent => ({
        schema: 'bridgesllm.runtime-turn-event.v1',
        type,
        sessionKey,
        runId,
        seq: seq++,
        ts,
        visible: true,
        source: {
          transport: 'portal-stream-event-bus',
          eventType: type === 'assistant_reasoning'
            ? 'thinking'
            : type === 'assistant_delta'
              ? 'text'
              : type === 'tool_started'
                ? 'tool_start'
                : type === 'tool_output'
                  ? 'tool_end'
                  : 'done',
        },
        ...extra,
      });

      for (let index = 0; index < toolIds.length; index += 1) {
        const assistantTs = baseTs + 1_000 + index * 1_000;
        const reasoning = `Reasoning phase ${index + 1}.`;
        const text = index === 1 ? 'Visible phase-two check.' : '';
        const toolName = index === 5 || index === 6 ? 'process' : 'exec';
        lines.push(JSON.stringify({
          id: `fragment-${index + 1}`,
          type: 'message',
          timestamp: new Date(assistantTs).toISOString(),
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: reasoning },
              ...(text ? [{ type: 'text', text }] : []),
              { type: 'toolCall', id: toolIds[index], name: toolName, arguments: { index } },
            ],
          },
        }));
        lines.push(JSON.stringify({
          id: `tool-result-${index + 1}`,
          type: 'message',
          timestamp: new Date(assistantTs + 200).toISOString(),
          message: {
            role: 'toolResult',
            toolCallId: toolIds[index],
            toolName,
            content: [{ type: 'text', text: index === 5 ? 'sessionId is required' : `phase-${index + 1}` }],
          },
        }));
        runtimeEvents.push(runtimeEvent('assistant_reasoning', assistantTs + 10, { text: reasoning }));
        if (text) runtimeEvents.push(runtimeEvent('assistant_delta', assistantTs + 20, { text }));
        runtimeEvents.push(runtimeEvent('tool_started', assistantTs + 30, {
          tool: { id: toolIds[index], name: toolName, status: 'running' },
        }));
        runtimeEvents.push(runtimeEvent('tool_output', assistantTs + 150, {
          tool: {
            id: toolIds[index],
            name: toolName,
            status: index === 5 ? 'error' : 'done',
          },
        }));
      }

      const finalReasoning = 'All chronology phases are complete.';
      lines.push(JSON.stringify({
        id: 'final-reasoning-fragment',
        type: 'message',
        timestamp: new Date(baseTs + 12_100).toISOString(),
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: finalReasoning }] },
      }));
      runtimeEvents.push(runtimeEvent('assistant_reasoning', baseTs + 12_110, { text: finalReasoning }));
      runtimeEvents.push(runtimeEvent('turn_done', baseTs + 12_200, { terminal: true, visible: false }));
      lines.push(JSON.stringify({
        id: 'canonical-final',
        type: 'message',
        timestamp: new Date(baseTs + 12_300).toISOString(),
        message: { role: 'assistant', content: 'UI_TIMELINE_SMOKE_COMPLETE' },
      }));
      lines.push(JSON.stringify({
        id: 'heartbeat-user',
        type: 'message',
        timestamp: new Date(baseTs + 13_000).toISOString(),
        message: { role: 'user', content: '[OpenClaw heartbeat poll]' },
      }));
      lines.push(JSON.stringify({
        id: 'heartbeat-assistant',
        type: 'message',
        timestamp: new Date(baseTs + 14_000).toISOString(),
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Heartbeat reasoning remains in its own turn.' },
            { type: 'text', text: 'HEARTBEAT_OK' },
          ],
        },
      }));
      fs.writeFileSync(filePath, lines.join('\n'));
      runtimeEvents.push({
        ...runtimeEvent('assistant_reasoning', baseTs + 14_010, {
          text: 'Heartbeat reasoning remains in its own turn.',
        }),
        runId: heartbeatRunId,
        seq: 1,
      });
      runtimeEvents.push({
        ...runtimeEvent('assistant_delta', baseTs + 14_020, { text: 'HEARTBEAT_OK' }),
        runId: heartbeatRunId,
        seq: 2,
      });
      runtimeEvents.push({
        ...runtimeEvent('turn_done', baseTs + 14_100, { terminal: true, visible: false }),
        runId: heartbeatRunId,
        seq: 3,
      });
      for (const event of runtimeEvents) recordRuntimeTurnEvent(sessionKey, event);

      const messages = __gatewayHistoryTest.readSessionMessagesEnhancedForSessionKey(
        sessionKey,
        100,
        sessionsDir,
      );
      const smokeTools = messages.flatMap((message: any) => (
        Array.isArray(message?.toolCalls)
          ? message.toolCalls.filter((tool: any) => toolIds.includes(tool.id))
          : []
      ));

      expect(smokeTools).toHaveLength(11);
      expect(smokeTools.map((tool: any) => tool.id)).toEqual(toolIds);
      expect(smokeTools.find((tool: any) => tool.id === toolIds[5])).toEqual(expect.objectContaining({
        status: 'error',
        result: 'sessionId is required',
      }));
      expect(messages.find((message: any) => message.id === 'smoke-user')?.content)
        .toBe('run the chronology smoke test');
      expect(messages.find((message: any) => message.id === 'canonical-final')?.content)
        .toBe('UI_TIMELINE_SMOKE_COMPLETE');
      expect(messages.find((message: any) => message.id === 'prior-assistant')?.content)
        .toBe('prior answer');
      expect(messages.find((message: any) => message.id === 'heartbeat-user')?.content)
        .toBe('[OpenClaw heartbeat poll]');
      expect(messages.find((message: any) => message.id === 'heartbeat-assistant')).toEqual(
        expect.objectContaining({
          thinkingContent: 'Heartbeat reasoning remains in its own turn.',
        }),
      );
      expect(messages.some((message: any) => (
        message?.__portal?.kind === 'runtime-turn-event-history'
        && message?.__portal?.runId === runId
      ))).toBe(false);
      expect(messages.filter((message: any) => message.content === 'HEARTBEAT_OK')).toHaveLength(1);
    } finally {
      if (previousEventDir === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
      else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = previousEventDir;
      fs.rmSync(sessionsDir, { recursive: true, force: true });
      fs.rmSync(eventDir, { recursive: true, force: true });
    }
  });

  test('contentless runtime history stays fail-closed without a complete run boundary', () => {
    const baseTs = Date.parse('2026-08-10T23:00:00.000Z');
    const canonical = [
      { id: 'u1', role: 'user', content: 'keep both lanes', timestamp: new Date(baseTs).toISOString() },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        thinkingContent: 'Still running.',
        timestamp: new Date(baseTs + 1_000).toISOString(),
        toolCalls: [{ id: 'stable-live-tool', name: 'exec', status: 'done', startedAt: baseTs + 1_200 }],
      },
    ];
    const events: RuntimeTurnEvent[] = [
      {
        schema: 'bridgesllm.runtime-turn-event.v1',
        type: 'assistant_reasoning',
        sessionKey: 'agent:main:incomplete-contentless',
        runId: 'run-incomplete-contentless',
        seq: 400,
        ts: baseTs + 1_010,
        text: 'Still running.',
        visible: true,
        source: { transport: 'portal-stream-event-bus', eventType: 'thinking' },
      },
      {
        schema: 'bridgesllm.runtime-turn-event.v1',
        type: 'tool_started',
        sessionKey: 'agent:main:incomplete-contentless',
        runId: 'run-incomplete-contentless',
        seq: 401,
        ts: baseTs + 1_200,
        visible: true,
        tool: { id: 'stable-live-tool', name: 'exec', status: 'running' },
        source: { transport: 'portal-stream-event-bus', eventType: 'tool_start' },
      },
      {
        schema: 'bridgesllm.runtime-turn-event.v1',
        type: 'turn_done',
        sessionKey: 'agent:main:incomplete-contentless',
        runId: 'run-incomplete-contentless',
        seq: 402,
        ts: baseTs + 1_300,
        terminal: true,
        visible: false,
        source: { transport: 'portal-stream-event-bus', eventType: 'done' },
      },
    ];
    const runtime = __gatewayHistoryTest.buildRuntimeHistoryMessages(events, {
      leadingRunComplete: false,
    });
    const messages = __gatewayHistoryTest.mergeRuntimeHistoryMessages(canonical, runtime, 20);

    expect(runtime[0].__portal).toEqual(expect.objectContaining({ terminal: true, complete: false }));
    expect(messages.flatMap((message: any) => message.toolCalls || [])).toHaveLength(2);
    expect(messages.some((message: any) => message?.__portal?.kind === 'runtime-turn-event-history'))
      .toBe(true);
  });

  test('a later match-budget failure restores the original contentless overlay', () => {
    const baseTs = Date.parse('2026-08-10T23:30:00.000Z');
    const canonical = [
      { id: 'u1', role: 'user', content: 'first turn', timestamp: new Date(baseTs).toISOString() },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        thinkingContent: 'First thought.',
        timestamp: new Date(baseTs + 1_000).toISOString(),
        toolCalls: [{ id: 'stable-first-tool', name: 'exec', status: 'done', startedAt: baseTs + 1_200 }],
      },
      { id: 'u2', role: 'user', content: '[OpenClaw heartbeat poll]', timestamp: new Date(baseTs + 2_000).toISOString() },
      { id: 'a2', role: 'assistant', content: 'HEARTBEAT_OK', timestamp: new Date(baseTs + 3_000).toISOString() },
    ];
    const contentless = {
      id: 'runtime-first',
      role: 'assistant',
      content: '',
      timestamp: new Date(baseTs + 1_500).toISOString(),
      segments: [{
        kind: 'thinking',
        source: 'reasoning',
        position: 'before',
        text: 'First thought.',
        ts: baseTs + 1_010,
      }],
      toolCalls: [{
        id: 'stable-first-tool',
        identity: 'provider',
        name: 'exec',
        status: 'done',
        startedAt: baseTs + 1_100,
        endedAt: baseTs + 1_300,
      }],
      __portal: {
        kind: 'runtime-turn-event-history',
        runId: 'run-first',
        terminal: true,
        complete: true,
      },
    };
    const heartbeat = {
      id: 'runtime-heartbeat',
      role: 'assistant',
      content: 'HEARTBEAT_OK',
      timestamp: new Date(baseTs + 3_010).toISOString(),
      __portal: {
        kind: 'runtime-turn-event-history',
        runId: 'run-heartbeat',
        terminal: true,
        complete: true,
      },
    };

    const messages = __gatewayHistoryTest.mergeRuntimeHistoryMessages(
      canonical,
      [contentless, heartbeat],
      20,
      { match: 0 },
    );

    expect(messages.flatMap((message: any) => message.toolCalls || [])).toHaveLength(2);
    expect(messages.some((message: any) => message.id === 'runtime-first')).toBe(true);
    expect(messages.some((message: any) => message.id === 'a1')).toBe(true);
    expect(messages.some((message: any) => message.id === 'u2')).toBe(true);
  });

  test.each([
    { label: 'active', terminal: false },
    { label: 'completed', terminal: true },
  ])('runtime history scans to the real run boundary for a >320-event $label turn', ({ terminal }) => {
    const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-run-boundary-'));
    const previousEventDir = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = eventDir;

    try {
      const sessionKey = `agent:main:runtime-run-boundary-${terminal ? 'completed' : 'active'}`;
      const runId = `run-boundary-${terminal ? 'completed' : 'active'}`;
      const baseTs = Date.parse('2026-08-10T15:00:00.000Z');
      const event = (
        type: RuntimeTurnEvent['type'],
        seq: number,
        extra: Partial<RuntimeTurnEvent> = {},
      ): RuntimeTurnEvent => ({
        schema: 'bridgesllm.runtime-turn-event.v1',
        type,
        sessionKey,
        runId,
        seq,
        ts: baseTs + seq * 10,
        visible: true,
        source: {
          transport: 'portal-stream-event-bus',
          eventType: type === 'assistant_reasoning' ? 'thinking' : (type === 'tool_started' ? 'tool_start' : 'done'),
        },
        ...extra,
      });

      recordRuntimeTurnEvent(sessionKey, event('assistant_reasoning', 0, {
        text: 'The first reasoning phase must survive a bounded tail read.',
        replace: true,
      }));
      for (let index = 0; index < 420; index += 1) {
        recordRuntimeTurnEvent(sessionKey, event('tool_started', index + 1, {
          tool: { id: `boundary-tool-${index}`, name: 'exec', status: 'running', arguments: { index } },
        }));
      }
      if (terminal) {
        recordRuntimeTurnEvent(sessionKey, event('assistant_final', 421, {
          text: 'Boundary scan complete.',
          terminal: true,
        }));
      }

      // No canonical timestamp fence is available. The scanner must still read
      // past its initial limit*4 tail until it proves the leading run boundary.
      const messages = __gatewayHistoryTest.mergeRuntimeTurnEventHistory(sessionKey, [], 20);
      const overlay = messages.find((message: any) => (
        message?.__portal?.kind === 'runtime-turn-event-history'
      ));

      expect(overlay?.segments.map((segment: any) => segment.text)).toContain(
        'The first reasoning phase must survive a bounded tail read.',
      );
      expect(overlay?.toolCalls).toHaveLength(420);
      expect(overlay?.toolCalls[0].id).toBe('boundary-tool-0');
      expect(overlay?.toolCalls.at(-1).id).toBe('boundary-tool-419');
      expect(overlay?.content).toBe(terminal ? 'Boundary scan complete.' : '');
    } finally {
      if (previousEventDir === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
      else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = previousEventDir;
      fs.rmSync(eventDir, { recursive: true, force: true });
    }
  });

  test('enhanced session history collapses fragmented tool-only assistant messages without runtime overlay', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-history-'));
    const sessionKey = 'agent:main:fragmented-tool-history-test';
    const filePath = path.join(sessionsDir, `${sessionKey}.jsonl`);
    const toolBaseTs = Date.parse('2026-05-30T05:00:00.000Z');

    fs.writeFileSync(filePath, [
      JSON.stringify({
        id: 'u1',
        type: 'message',
        timestamp: '2026-05-30T04:59:58.000Z',
        message: { role: 'user', content: 'audit the server' },
      }),
      ...Array.from({ length: 5 }, (_, index) => JSON.stringify({
        id: `tool-only-${index}`,
        type: 'message',
        timestamp: new Date(toolBaseTs + index * 1000).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: `tool-${index}`, name: 'bash', arguments: { index } }],
        },
      })),
      JSON.stringify({
        id: 'a-final',
        type: 'message',
        timestamp: new Date(toolBaseTs + 6000).toISOString(),
        message: { role: 'assistant', content: 'Server audit complete.', model: 'openai-codex/gpt-5.5' },
      }),
    ].join('\n'));

    const messages = __gatewayHistoryTest.readSessionMessagesEnhancedForSessionKey(sessionKey, 20, sessionsDir);
    const final = messages.find((message: any) => message.id === 'a-final');

    expect(messages.map((message: any) => message.content)).toContain('audit the server');
    expect(final).toBeTruthy();
    expect(final.toolCalls).toHaveLength(5);
    expect(final.toolCalls.map((toolCall: any) => toolCall.id)).toEqual(['tool-0', 'tool-1', 'tool-2', 'tool-3', 'tool-4']);
    expect(messages.filter((message: any) => message.role === 'assistant' && !message.content && Array.isArray(message.toolCalls))).toHaveLength(0);
  });

  test('runtime history reassembles append-style deltas without corrupting words', () => {
    const baseTs = Date.parse('2026-07-07T12:00:00.000Z');
    const deltaEvent = (seq: number, text: string): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'assistant_delta',
      sessionKey: 'agent:main:main',
      runId: 'run-delta-reassembly',
      seq,
      ts: baseTs + seq,
      text,
      visible: true,
      source: { transport: 'portal-stream-event-bus', eventType: 'text' },
    });

    // Claude CLI append-style chunks split mid-word and carry their own spacing.
    const messages = __gatewayHistoryTest.buildRuntimeHistoryMessages([
      deltaEvent(1, 'The qu'),
      deltaEvent(2, 'ick brown'),
      deltaEvent(3, ' '),
      deltaEvent(4, 'fox jum'),
      deltaEvent(5, 'ps.'),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('The quick brown fox jumps.');
  });

  test('runtime history keeps pre-tool text and pairs a tool result carrying a different id', () => {
    const baseTs = Date.parse('2026-07-15T04:00:00.000Z');
    const event = (seq: number, extra: Partial<RuntimeTurnEvent>): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'assistant_delta',
      sessionKey: 'agent:main:rail-regression',
      runId: 'run-pre-tool-text',
      seq,
      ts: baseTs + seq * 100,
      visible: true,
      source: { transport: 'portal-stream-event-bus', eventType: 'text' },
      ...extra,
    });

    // Live shape from the sonnet-4-6 rail probe: preamble text streams, a
    // tool_started arrives with a synthesized id, the tool_output carries the
    // provider's real id, and the final replaces deltas with only the
    // post-tool block.
    const messages = __gatewayHistoryTest.buildRuntimeHistoryMessages([
      event(1, { text: 'RAIL_PRE preamble before the tool call.' }),
      event(2, { type: 'tool_started', tool: { id: 'tool-1784091230064-1', name: 'Bash', arguments: { command: 'echo RAIL_TOOL' }, status: 'running' } }),
      event(3, { type: 'tool_output', tool: { id: 'toolu_011Kq5cti6VBSRpxGS3XHeMj', name: 'Bash', result: 'RAIL_TOOL' } }),
      event(4, { type: 'assistant_final', text: 'RAIL_POST\n\nRAIL_FINAL', replace: true, terminal: true }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('RAIL_POST\n\nRAIL_FINAL');

    const textSegments = (messages[0].segments || []).filter((segment: any) => segment.kind === 'text');
    expect(textSegments).toHaveLength(1);
    expect(textSegments[0].text).toBe('RAIL_PRE preamble before the tool call.');
    expect(textSegments[0].ts).toBe(baseTs + 100);

    const toolCalls = messages[0].toolCalls || [];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe('toolu_011Kq5cti6VBSRpxGS3XHeMj');
    expect(toolCalls[0].arguments).toEqual({ command: 'echo RAIL_TOOL' });
    expect(toolCalls[0].result).toBe('RAIL_TOOL');
    expect(toolCalls[0].status).toBe('done');
  });

  test('runtime history anchors an exact terminal replay after late tool activity', () => {
    const baseTs = Date.parse('2026-08-02T04:00:00.000Z');
    const event = (seq: number, extra: Partial<RuntimeTurnEvent>): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'assistant_delta',
      sessionKey: 'agent:main:late-tool-final',
      runId: 'run-late-tool-final',
      seq,
      ts: baseTs + seq * 100,
      visible: true,
      source: { transport: 'portal-stream-event-bus', eventType: 'text' },
      ...extra,
    });

    const messages = __gatewayHistoryTest.buildRuntimeHistoryMessages([
      event(1, { text: 'The actual final answer.' }),
      event(2, { type: 'tool_started', tool: { id: 'late-tool', name: 'sessions_yield', status: 'running' } }),
      event(3, { type: 'tool_output', tool: { id: 'late-tool', name: 'sessions_yield', result: 'returned', status: 'done' } }),
      event(4, { type: 'assistant_final', text: 'The actual final answer.', replace: true, terminal: true }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('The actual final answer.');
    expect(messages[0].segments).toBeUndefined();
    expect(messages[0].toolCalls).toEqual([
      expect.objectContaining({ id: 'late-tool', status: 'done' }),
    ]);
  });

  test('runtime history drops placeholder status events but keeps substantive statuses', () => {
    const baseTs = Date.parse('2026-07-15T05:00:00.000Z');
    const event = (seq: number, extra: Partial<RuntimeTurnEvent>): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'assistant_status',
      sessionKey: 'agent:main:status-placeholder-test',
      runId: 'run-status-placeholder',
      seq,
      ts: baseTs + seq * 100,
      visible: true,
      source: { transport: 'portal-stream-event-bus', eventType: 'status' },
      ...extra,
    });

    // "Thinking…"/compaction statuses are rail strip material; replaying them
    // as durable segments resurrects the pre-rail thinking bubble in history.
    const messages = __gatewayHistoryTest.buildRuntimeHistoryMessages([
      event(1, { text: 'Thinking…' }),
      event(2, { text: 'thinking...' }),
      event(3, { text: 'Compacting context…' }),
      event(4, { text: 'Context compacted' }),
      event(5, { text: 'Analyzing the failing migration files' }),
      event(6, { type: 'assistant_final', text: 'All done.', terminal: true }),
    ]);

    expect(messages).toHaveLength(1);
    const segments = messages[0].segments || [];
    expect(segments.map((segment: any) => segment.text)).toEqual(['Analyzing the failing migration files']);
  });

  test('runtime history keeps raw reasoning and attested preamble replacement lanes separate', () => {
    const baseTs = Date.parse('2026-08-08T04:00:00.000Z');
    const event = (
      seq: number,
      text: string,
      preambleProgress = false,
    ): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'assistant_reasoning',
      sessionKey: 'agent:main:opus-preamble-history',
      runId: 'run-opus-preamble-history',
      seq,
      ts: baseTs + seq * 100,
      text,
      replace: true,
      visible: true,
      source: {
        transport: 'portal-stream-event-bus',
        eventType: preambleProgress ? 'status' : 'thinking',
        ...(preambleProgress ? { preambleProgress: true as const } : {}),
      },
    });

    const messages = __gatewayHistoryTest.buildRuntimeHistoryMessages([
      event(1, 'Private reasoning snapshot'),
      event(2, 'Inspecting the affected files', true),
      event(3, 'Private reasoning snapshot, expanded'),
      event(4, 'Inspecting the affected files and tests', true),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].segments).toEqual([
      expect.objectContaining({
        kind: 'thinking',
        source: 'reasoning',
        text: 'Private reasoning snapshot',
      }),
      expect.objectContaining({
        kind: 'thinking',
        source: 'preamble',
        text: 'Inspecting the affected files',
      }),
      expect.objectContaining({
        kind: 'thinking',
        source: 'reasoning',
        text: 'Private reasoning snapshot, expanded',
      }),
      expect.objectContaining({
        kind: 'thinking',
        source: 'preamble',
        text: 'Inspecting the affected files and tests',
      }),
    ]);
  });

  test('runtime history projects strict and sliding cumulative preambles across tool boundaries', () => {
    const baseTs = Date.parse('2026-08-10T13:00:00.000Z');
    const sessionKey = 'agent:main:sliding-preamble-history';
    const runId = 'run-sliding-preamble-history';
    const preamble = (seq: number, text: string): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'assistant_reasoning',
      sessionKey,
      runId,
      seq,
      ts: baseTs + seq * 100,
      text,
      replace: true,
      visible: true,
      source: {
        transport: 'portal-stream-event-bus',
        eventType: 'status',
        preambleProgress: true,
      },
    });
    const tool = (seq: number, id: string): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'tool_started',
      sessionKey,
      runId,
      seq,
      ts: baseTs + seq * 100,
      visible: true,
      tool: { id, name: 'exec', status: 'running' },
      source: { transport: 'portal-stream-event-bus', eventType: 'tool_start' },
    });
    const phaseA = `Phase A ${'a'.repeat(120)}`;
    const phaseB = `Phase B ${'b'.repeat(360)}`;
    const phaseC = `Phase C ${'c'.repeat(120)}`;
    const reset = `Independent provider reset ${'z'.repeat(180)}`;

    const messages = __gatewayHistoryTest.buildRuntimeHistoryMessages([
      preamble(1, phaseA),
      tool(2, 'tool-a'),
      preamble(3, `${phaseA}\n\n${phaseB}`),
      tool(4, 'tool-b'),
      // OpenClaw evicted A from its bounded accumulator. This is a sliding
      // B+C window, not a provider reset and not a fresh B thought.
      preamble(5, `${phaseB}\n\n${phaseC}`),
      tool(6, 'tool-c'),
      // Low-overlap rewrites remain authoritative and are never suppressed.
      preamble(7, reset),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].segments.map((segment: any) => segment.text)).toEqual([
      phaseA,
      phaseB,
      phaseC,
      reset,
    ]);
    expect(messages[0].segments.map((segment: any) => segment.order)).toEqual([0, 2, 4, 6]);
    expect(messages[0].toolCalls.map((toolCall: any) => [toolCall.id, toolCall.order])).toEqual([
      ['tool-a', 1],
      ['tool-b', 3],
      ['tool-c', 5],
    ]);
  });

  test('runtime history projects cumulative assistant statuses across tool boundaries', () => {
    const baseTs = Date.parse('2026-08-10T13:30:00.000Z');
    const sessionKey = 'agent:main:cumulative-status-history';
    const runId = 'run-cumulative-status-history';
    const status = (seq: number, text: string): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'assistant_status',
      sessionKey,
      runId,
      seq,
      ts: baseTs + seq * 100,
      text,
      replace: true,
      visible: true,
      source: { transport: 'portal-stream-event-bus', eventType: 'status' },
    });
    const tool = (seq: number, id: string): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'tool_started',
      sessionKey,
      runId,
      seq,
      ts: baseTs + seq * 100,
      visible: true,
      tool: { id, name: 'exec', status: 'running' },
      source: { transport: 'portal-stream-event-bus', eventType: 'tool_start' },
    });
    const phaseA = `Status A ${'a'.repeat(140)}`;
    const phaseB = `Status B ${'b'.repeat(140)}`;
    const phaseC = `Status C ${'c'.repeat(140)}`;

    const messages = __gatewayHistoryTest.buildRuntimeHistoryMessages([
      status(1, phaseA),
      tool(2, 'status-tool-a'),
      status(3, `${phaseA}\n\n${phaseB}`),
      tool(4, 'status-tool-b'),
      status(5, `${phaseA}\n\n${phaseB}\n\n${phaseC}`),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].segments.map((segment: any) => segment.text)).toEqual([
      phaseA,
      phaseB,
      phaseC,
    ]);
    expect(messages[0].segments.map((segment: any) => segment.order)).toEqual([0, 2, 4]);
    expect(messages[0].toolCalls.map((toolCall: any) => [toolCall.id, toolCall.order])).toEqual([
      ['status-tool-a', 1],
      ['status-tool-b', 3],
    ]);
    expect(messages[0].__portal).toEqual(expect.objectContaining({
      kind: 'runtime-turn-event-history',
      runId,
      lastEventSeq: 5,
      thinkingCursors: { status: `${phaseA}\n\n${phaseB}\n\n${phaseC}` },
    }));
  });

  test('runtime history ignores a delayed graduated baseline without rolling back later status text', () => {
    const baseTs = Date.parse('2026-08-10T13:45:00.000Z');
    const baseline = `Baseline ${'a'.repeat(140)}`;
    const extension = `Extension ${'b'.repeat(140)}`;
    const tail = `Tail ${'c'.repeat(140)}`;
    const event = (seq: number, extra: Partial<RuntimeTurnEvent>): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'assistant_status',
      sessionKey: 'agent:main:delayed-status-baseline',
      runId: 'run-delayed-status-baseline',
      seq,
      ts: baseTs + seq * 100,
      replace: true,
      visible: true,
      source: { transport: 'portal-stream-event-bus', eventType: 'status' },
      ...extra,
    });

    const messages = __gatewayHistoryTest.buildRuntimeHistoryMessages([
      event(1, { text: baseline }),
      event(2, {
        type: 'tool_started',
        tool: { id: 'delayed-tool-a', name: 'exec', status: 'running' },
        source: { transport: 'portal-stream-event-bus', eventType: 'tool_start' },
      }),
      event(3, { text: `${baseline}\n\n${extension}` }),
      // A late copy of the old baseline must not replace the newer latest
      // snapshot that the following tool boundary will graduate.
      event(4, { text: baseline }),
      event(5, {
        type: 'tool_started',
        tool: { id: 'delayed-tool-b', name: 'exec', status: 'running' },
        source: { transport: 'portal-stream-event-bus', eventType: 'tool_start' },
      }),
      event(6, { text: `${baseline}\n\n${extension}\n\n${tail}` }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].segments.map((segment: any) => segment.text)).toEqual([
      baseline,
      extension,
      tail,
    ]);
  });

  test('runtime history projects the new tail after the 64-item preamble window evicts its oldest item', () => {
    const items = Array.from({ length: 65 }, (_, index) => (
      `item-${String(index).padStart(2, '0')}:${String.fromCharCode(65 + (index % 26)).repeat(96)}`
    ));
    const firstWindow = items.slice(0, 64).join('\n\n');
    const shiftedWindow = items.slice(1, 65).join('\n\n');
    const base = (seq: number, extra: Partial<RuntimeTurnEvent>): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'assistant_reasoning',
      sessionKey: 'agent:main:bounded-preamble-window',
      runId: 'run-bounded-preamble-window',
      seq,
      ts: Date.parse('2026-08-10T14:00:00.000Z') + seq * 100,
      replace: true,
      visible: true,
      source: {
        transport: 'portal-stream-event-bus',
        eventType: 'status',
        preambleProgress: true,
      },
      ...extra,
    });

    const messages = __gatewayHistoryTest.buildRuntimeHistoryMessages([
      base(1, { text: firstWindow }),
      base(2, {
        type: 'tool_started',
        tool: { id: 'window-tool', name: 'exec', status: 'running' },
        source: { transport: 'portal-stream-event-bus', eventType: 'tool_start' },
      }),
      base(3, { text: shiftedWindow }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].segments.map((segment: any) => segment.text)).toEqual([
      firstWindow,
      items[64],
    ]);
  });

  test('runtime history keeps the pre-tool segment and stores only the cumulative final tail', () => {
    const baseTs = Date.parse('2026-07-15T04:10:00.000Z');
    const event = (seq: number, extra: Partial<RuntimeTurnEvent>): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'assistant_delta',
      sessionKey: 'agent:main:rail-regression-full-final',
      runId: 'run-full-final',
      seq,
      ts: baseTs + seq * 100,
      visible: true,
      source: { transport: 'portal-stream-event-bus', eventType: 'text' },
      ...extra,
    });

    // Some providers replay the whole turn text in the final event; the
    // flushed pre-tool segment must not render that text twice.
    const messages = __gatewayHistoryTest.buildRuntimeHistoryMessages([
      event(1, { text: 'Preamble before the tool call.' }),
      event(2, { type: 'tool_started', tool: { id: 'call-1', name: 'Bash', arguments: { command: 'true' }, status: 'running' } }),
      event(3, { type: 'tool_output', tool: { id: 'call-1', name: 'Bash', result: 'ok' } }),
      event(4, { type: 'assistant_final', text: 'Preamble before the tool call.\n\nAll done.', replace: true, terminal: true }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('All done.');
    expect((messages[0].segments || []).filter((segment: any) => segment.kind === 'text'))
      .toEqual([
        expect.objectContaining({ text: 'Preamble before the tool call.', order: 0 }),
      ]);
  });

  test('runtime history preserves A/tool1/B/tool2/C against an aggregate provider final', () => {
    const baseTs = Date.parse('2026-07-15T04:15:00.000Z');
    const event = (seq: number, extra: Partial<RuntimeTurnEvent>): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'assistant_delta',
      sessionKey: 'agent:main:multi-tool-aggregate-final',
      runId: 'run-multi-tool-aggregate-final',
      seq,
      ts: baseTs + seq * 100,
      visible: true,
      source: { transport: 'portal-stream-event-bus', eventType: 'text' },
      ...extra,
    });

    const messages = __gatewayHistoryTest.buildRuntimeHistoryMessages([
      event(1, { text: 'A ' }),
      event(2, { type: 'tool_started', tool: { id: 'call-1', name: 'read', status: 'running' } }),
      event(3, { type: 'tool_output', tool: { id: 'call-1', name: 'read', result: 'one', status: 'done' } }),
      event(4, { text: 'B ' }),
      event(5, { type: 'tool_started', tool: { id: 'call-2', name: 'exec', status: 'running' } }),
      event(6, { type: 'tool_output', tool: { id: 'call-2', name: 'exec', result: 'two', status: 'done' } }),
      event(7, { text: 'C' }),
      event(8, { type: 'assistant_final', text: 'A B C', terminal: true }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('C');
    expect(messages[0].segments.map((segment: any) => [segment.text, segment.order]))
      .toEqual([['A', 0], ['B', 2]]);
    expect(messages[0].toolCalls.map((tool: any) => [tool.id, tool.order]))
      .toEqual([['call-1', 1], ['call-2', 3]]);

    expect(__gatewayHistoryTest.reconcileMergedRuntimeHistoryContent(
      { content: 'A B C' },
      messages[0],
    )).toBe('C');
    expect(__gatewayHistoryTest.reconcileMergedRuntimeHistoryContent(
      { content: 'Independent canonical answer.' },
      messages[0],
    )).toBe('Independent canonical answer.');
  });

  test('runtime history preserves segment order across multiple tools', () => {
    const baseTs = Date.parse('2026-07-15T04:20:00.000Z');
    const event = (seq: number, extra: Partial<RuntimeTurnEvent>): RuntimeTurnEvent => ({
      schema: 'bridgesllm.runtime-turn-event.v1',
      type: 'assistant_reasoning',
      sessionKey: 'agent:main:multi-tool-order',
      runId: 'run-multi-tool-order',
      seq,
      ts: baseTs + seq * 100,
      visible: true,
      source: { transport: 'portal-stream-event-bus', eventType: 'thinking' },
      ...extra,
    });

    const messages = __gatewayHistoryTest.buildRuntimeHistoryMessages([
      event(1, { text: 'Before first tool.' }),
      event(2, { type: 'tool_started', tool: { id: 'call-1', name: 'read', status: 'running' } }),
      event(3, { type: 'tool_output', tool: { id: 'call-1', name: 'read', result: 'one', status: 'done' } }),
      event(4, { text: 'Between tools.' }),
      event(5, { type: 'tool_started', tool: { id: 'call-2', name: 'exec', status: 'running' } }),
      event(6, { type: 'tool_output', tool: { id: 'call-2', name: 'exec', result: 'two', status: 'done' } }),
      event(7, { text: 'After second tool.' }),
      event(8, { type: 'assistant_final', text: 'Canonical final.', terminal: true }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].segments.map((segment: any) => segment.order)).toEqual([0, 2, 4]);
    expect(messages[0].toolCalls.map((tool: any) => tool.order)).toEqual([1, 3]);
  });

  test('history reconciliation preserves runtime order when transcript duplicates lack it', () => {
    const segments = __gatewayHistoryTest.mergeHistorySegments(
      [
        { text: 'Before first tool.', kind: 'thinking', position: 'before', ts: 1_000 },
        { text: 'Between tools.', kind: 'thinking', position: 'between', ts: 3_000 },
      ],
      [
        { text: 'Before first tool.', kind: 'thinking', position: 'before', ts: 1_000, order: 0 },
        { text: 'Between tools.', kind: 'thinking', position: 'between', ts: 3_000, order: 2 },
        { text: 'After second tool.', kind: 'thinking', position: 'after', ts: 5_000, order: 4 },
      ],
    );
    const tools = __gatewayHistoryTest.mergeHistoryToolCalls(
      [
        { id: 'call-1', name: 'read', startedAt: 2_000, status: 'done' },
        { id: 'call-2', name: 'exec', startedAt: 4_000, status: 'done' },
      ],
      [
        { id: 'call-1', name: 'read', startedAt: 2_000, status: 'done', order: 1 },
        { id: 'call-2', name: 'exec', startedAt: 4_000, status: 'done', order: 3 },
      ],
    );

    expect(segments.map((segment: any) => segment.order)).toEqual([0, 2, 4]);
    expect(tools.map((tool: any) => tool.order)).toEqual([1, 3]);
  });

  test('mergeRuntimeText keeps short repeated chunks and cumulative snapshots', () => {
    const { mergeRuntimeText } = __gatewayHistoryTest;

    // Short chunks that repeat earlier text are legitimate append deltas.
    expect(mergeRuntimeText('the cat sat on ', 'the')).toBe('the cat sat on the');
    expect(mergeRuntimeText('Hello', ' ')).toBe('Hello ');

    // Cumulative streams still grow via prefix replacement.
    expect(mergeRuntimeText('Hello wor', 'Hello world!')).toBe('Hello world!');

    // Long replayed snapshots are still deduped.
    const paragraph = 'This is a complete paragraph that was already streamed.';
    expect(mergeRuntimeText(paragraph, paragraph)).toBe(paragraph);
    expect(mergeRuntimeText(`${paragraph}\n`, paragraph)).toBe(`${paragraph}\n`);

    // Replace snapshots win outright.
    expect(mergeRuntimeText('partial', 'replacement', true)).toBe('replacement');
  });

  test('conversation marker ignores the portal runtime overlay so live state cannot fake completion', () => {
    const now = Date.now();
    // Mid-turn shape: durable transcript has only the user prompt; the enhanced
    // reader merged in the runtime overlay (portal-synthesized live state whose
    // timestamp tracks the newest stream event). The overlay must not become
    // the "latest durable assistant message" — that made the terminal
    // heuristics compare the live lane against itself and report healthy
    // Anthropic mid-turn sessions as finished on every reconnect.
    const marker = __gatewayHistoryTest.getLatestMeaningfulConversationMarker([
      { role: 'user', content: 'run the long migration', timestamp: new Date(now - 120_000).toISOString() },
      {
        role: 'assistant',
        content: 'Working through the steps.',
        timestamp: new Date(now - 1_000).toISOString(),
        toolCalls: [{ id: 'call-1', name: 'Bash', status: 'running', startedAt: now - 5_000 }],
        __portal: { kind: 'runtime-turn-event-history', runId: 'run-live' },
      },
    ]);
    expect(marker).toEqual(expect.objectContaining({ role: 'user' }));

    // A real transcript assistant message still wins as usual.
    const finished = __gatewayHistoryTest.getLatestMeaningfulConversationMarker([
      { role: 'user', content: 'run the long migration', timestamp: new Date(now - 120_000).toISOString() },
      { role: 'assistant', content: 'Done — migration applied.', timestamp: new Date(now - 500).toISOString() },
    ]);
    expect(finished).toEqual(expect.objectContaining({ role: 'assistant' }));
  });

  test('runtime snapshot stays active mid-turn when the durable marker is the user prompt', () => {
    const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-turn-events-'));
    const previousEventDir = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = eventDir;

    try {
      const sessionKey = 'agent:main:midturn-marker-test';
      const now = Date.now();
      recordRuntimeTurnEvent(sessionKey, {
        schema: 'bridgesllm.runtime-turn-event.v1',
        type: 'tool_started',
        sessionKey,
        runId: 'run-midturn',
        seq: 1,
        ts: now - 60_000,
        visible: true,
        source: { transport: 'portal-stream-event-bus', eventType: 'tool_start' },
        tool: { id: 'call-1', name: 'Bash', arguments: { command: 'sleep 300' }, status: 'running' },
      });

      const userMarker = { role: 'user' as const, timestamp: now - 120_000, content: 'run the long migration' };
      const active = __gatewayHistoryTest.getOpenClawRuntimeActiveStreamSnapshot(sessionKey, userMarker);
      expect(active).toEqual(expect.objectContaining({ active: true, phase: 'tool' }));

      // A durable transcript assistant final at/after the runtime lane still
      // flips the leaked overlay to terminal.
      const finalMarker = { role: 'assistant' as const, timestamp: now - 55_000, content: 'All done.' };
      const terminal = __gatewayHistoryTest.getOpenClawRuntimeActiveStreamSnapshot(sessionKey, finalMarker);
      expect(terminal).toEqual(expect.objectContaining({ active: false, inactiveReason: 'terminal' }));
    } finally {
      if (previousEventDir === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
      else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = previousEventDir;
    }
  });

  test('active stream status keeps quiet streaming turns active inside the 10-minute window', async () => {
    const sessionKey = 'agent:main:quiet-streaming-window-test';
    const now = Date.now();

    try {
      streamEventBus.clearStream(sessionKey);
      streamEventBus.updateStreamPhase(sessionKey, {
        phase: 'streaming',
        startedAt: now - 4 * 60_000,
        runId: 'run-quiet-stream',
        model: 'anthropic/claude-sonnet-4-6',
      });
      streamEventBus.publish(sessionKey, {
        type: 'text',
        content: 'Partial answer before a long reasoning pause.',
        runId: 'run-quiet-stream',
      });

      const tracked = streamEventBus.getTrackedStream(sessionKey);
      expect(tracked).toBeTruthy();
      if (tracked) {
        tracked.lastEventAt = now - 4 * 60_000;
        tracked.startedAt = now - 4 * 60_000;
      }

      const snapshot = await __gatewayHistoryTest.getOpenClawActiveStreamSnapshot(sessionKey);

      expect(snapshot).toEqual(expect.objectContaining({
        active: true,
        phase: 'streaming',
        runId: 'run-quiet-stream',
        content: 'Partial answer before a long reasoning pause.',
        staleAfterMs: 10 * 60_000,
      }));
    } finally {
      streamEventBus.clearStream(sessionKey);
    }
  });
});
