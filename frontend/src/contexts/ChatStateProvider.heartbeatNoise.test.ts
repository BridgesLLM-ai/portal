// @vitest-environment jsdom
import '../test/setup';
import { describe, expect, it } from 'vitest';
import { parseHistoryMessages } from './ChatStateProvider';

function turn(role: string, content: string, extra: Record<string, unknown> = {}) {
  return { id: `${role}-${content.slice(0, 12)}-${Math.random()}`, role, content, timestamp: Date.now(), ...extra };
}

describe('Agent Chat heartbeat transcript noise', () => {
  it('hides heartbeat poll bubbles and their OK replies, tool calls included', () => {
    const messages = parseHistoryMessages([
      turn('user', 'What changed today?'),
      turn('assistant', 'Two files changed.'),
      turn('user', '[OpenClaw heartbeat poll]'),
      turn('assistant', 'HEARTBEAT_OK', {
        toolCalls: [{ id: 't1', name: 'exec', status: 'completed' }],
      }),
      turn('user', 'Thanks!'),
      turn('assistant', 'Anytime.'),
    ]);

    const rendered = messages.map((message) => message.content);
    expect(rendered).toEqual(['What changed today?', 'Two files changed.', 'Thanks!', 'Anytime.']);
  });

  it('keeps a non-OK heartbeat reply visible because it is an alert', () => {
    const messages = parseHistoryMessages([
      turn('user', '[OpenClaw heartbeat poll]'),
      turn('assistant', 'Disk usage crossed 90% — investigate /var/log growth.', {
        toolCalls: [{ id: 't1', name: 'exec', status: 'completed' }],
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toContain('Disk usage crossed 90%');
  });

  it('does not treat ordinary bracketed user text as a heartbeat marker', () => {
    const messages = parseHistoryMessages([
      turn('user', '[URGENT] the heartbeat monitor page is down, can you check it?'),
      turn('assistant', 'Looking now.'),
    ]);

    expect(messages.map((message) => message.content)).toEqual([
      '[URGENT] the heartbeat monitor page is down, can you check it?',
      'Looking now.',
    ]);
  });
});
