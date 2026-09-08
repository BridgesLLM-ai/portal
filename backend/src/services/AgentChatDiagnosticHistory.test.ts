import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import {
  classifyAgentChatDiagnosticEvent,
  readAgentChatDiagnosticHistory,
  recordAgentChatDiagnosticEvent,
} from './AgentChatDiagnosticHistory';

const railPolicy = { presentation: 'rail', durability: 'transient' } as const;

describe('AgentChatDiagnosticHistory', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'portal-agent-diagnostics-'));
    process.env.PORTAL_AGENT_CHAT_DIAGNOSTIC_HISTORY_DIR = dir;
    delete process.env.PORTAL_DISABLE_AGENT_CHAT_DIAGNOSTIC_HISTORY;
  });

  afterEach(() => {
    delete process.env.PORTAL_AGENT_CHAT_DIAGNOSTIC_HISTORY_DIR;
    delete process.env.PORTAL_DISABLE_AGENT_CHAT_DIAGNOSTIC_HISTORY;
    rmSync(dir, { recursive: true, force: true });
  });

  test('ignores ordinary progress while classifying maintenance, lifecycle, and failures', () => {
    expect(classifyAgentChatDiagnosticEvent({
      event: { type: 'status', content: 'Thinking…' },
      policy: railPolicy,
      now: Date.parse('2026-08-20T12:00:00.000Z'),
    })).toBeNull();

    expect(classifyAgentChatDiagnosticEvent({
      event: {
        type: 'status',
        content: 'Memory flush secret=do-not-return',
        maintenanceKind: 'maintenance',
      },
      policy: railPolicy,
      now: Date.parse('2026-08-20T12:00:01.000Z'),
    })).toMatchObject({
      severity: 'info',
      category: 'maintenance',
      title: 'Context maintenance update',
      detail: 'Durable memory maintenance ran outside the conversation timeline.',
      timestamp: '2026-08-20T12:00:01.000Z',
    });

    expect(classifyAgentChatDiagnosticEvent({
      event: { type: 'error', content: 'token=do-not-return', terminal: true },
      policy: { presentation: 'banner', durability: 'transient' },
      now: Date.parse('2026-08-20T12:00:02.000Z'),
    })).toMatchObject({
      severity: 'error',
      category: 'runtime',
      title: 'Harness run failed',
      presentation: 'banner',
    });
  });

  test('persists only fixed safe summaries and collapses immediate duplicates', () => {
    const sessionKey = 'agent:main:diagnostic-test';
    recordAgentChatDiagnosticEvent({
      sessionKey,
      event: {
        type: 'status',
        content: 'Heartbeat token=do-not-return',
        maintenanceKind: 'maintenance',
      },
      policy: railPolicy,
      now: Date.parse('2026-08-20T12:00:00.000Z'),
    });
    recordAgentChatDiagnosticEvent({
      sessionKey,
      event: {
        type: 'status',
        content: 'Heartbeat a second secret',
        maintenanceKind: 'maintenance',
      },
      policy: railPolicy,
      now: Date.parse('2026-08-20T12:00:01.000Z'),
    });
    recordAgentChatDiagnosticEvent({
      sessionKey,
      event: { type: 'done', content: 'private model output', runId: 'run-1' },
      policy: { presentation: 'timeline', durability: 'durable' },
      now: Date.parse('2026-08-20T12:00:10.000Z'),
    });

    const page = readAgentChatDiagnosticHistory(sessionKey, 20);
    expect(page.events).toHaveLength(2);
    expect(page.events.map((event) => event.title)).toEqual([
      'Context maintenance update',
      'Harness turn completed',
    ]);
    expect(page.events[0].timestamp).toBe('2026-08-20T12:00:00.000Z');
    expect(page.events[1].runId).toBe('run-1');
    const stored = readFileSync(path.join(dir, createHash('sha256')
      .update(sessionKey)
      .digest('hex')
      .slice(0, 32) + '.jsonl'), 'utf8');
    expect(stored).not.toContain('do-not-return');
    expect(stored).not.toContain('private model output');
  });

  test('reports truncation truthfully when the requested event window is smaller', () => {
    const sessionKey = 'agent:main:diagnostic-limit';
    for (let index = 0; index < 5; index += 1) {
      recordAgentChatDiagnosticEvent({
        sessionKey,
        event: { type: 'done', runId: `run-${index}` },
        policy: { presentation: 'internal', durability: 'transient' },
        now: Date.parse('2026-08-20T12:00:00.000Z') + (index * 10_000),
      });
    }
    const page = readAgentChatDiagnosticHistory(sessionKey, 2);
    expect(page.events.map((event) => event.runId)).toEqual(['run-3', 'run-4']);
    expect(page.truncated).toBe(true);
  });
});
