import fs from 'fs';
import os from 'os';
import path from 'path';
import { __gatewayHistoryTest } from '../routes/gateway';
import { recordRuntimeTurnEvent } from '../services/RuntimeTurnEventHistory';
import type { RuntimeTurnEvent } from '../services/RuntimeTurnEvents';

describe('gateway history readers', () => {
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

      expect(assistant).toBeTruthy();
      expect(assistant.segments.map((segment: any) => segment.text)).toEqual([
        'Starting Codex turn...',
        'I need to inspect the file first.',
        'Now I can answer with the verified detail.',
      ]);
      expect(assistant.toolCalls).toEqual([
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

  test('enhanced session history merges recovered runtime reasoning into assistant messages that already have tool calls', () => {
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

      expect(assistant).toBeTruthy();
      expect(assistant.segments.map((segment: any) => segment.text)).toEqual(expect.arrayContaining([
        'Existing local segment.',
        'Recovered reasoning that used to disappear after steering.',
      ]));
      expect(assistant.toolCalls).toEqual([
        expect.objectContaining({
          id: 'tool-read',
          name: 'read',
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
          id: `tool-only-${index}`,
          type: 'message',
          timestamp: new Date(toolBaseTs + index * 1000).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: `tool-${index}`, name: 'apply_patch', arguments: { index } }],
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

      expect(roles).toContain('user');
      expect(messages.some((message: any) => message.content === 'make the animation better')).toBe(true);
      expect(final).toBeTruthy();
      expect(final.toolCalls).toHaveLength(toolOnlyCount);
      expect(final.segments.map((segment: any) => segment.text)).toContain('I will inspect and improve the existing file.');
      expect(messages.filter((message: any) => message.role === 'assistant' && !message.content && Array.isArray(message.toolCalls))).toHaveLength(0);
    } finally {
      if (previousEventDir === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
      else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = previousEventDir;
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
});
