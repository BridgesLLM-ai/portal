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
      turn('user', '[OpenClaw heartbeat poll]', { provenance: { kind: 'internal_system' } }),
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
      turn('user', '[OpenClaw heartbeat poll]', { provenance: { kind: 'internal_system' } }),
      turn('assistant', 'Disk usage crossed 90% — investigate /var/log growth.', {
        thinkingContent: 'Internal heartbeat reasoning.',
        toolCalls: [{ id: 't1', name: 'exec', status: 'completed' }],
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toContain('Disk usage crossed 90%');
    expect(messages[0].thinkingContent).toBeUndefined();
    expect(messages[0].segments).toBeUndefined();
    expect(messages[0].toolCalls).toBeUndefined();
  });

  it('hides every memory-flush fragment through its next real user boundary', () => {
    const messages = parseHistoryMessages([
      turn('user', 'Keep this request.'),
      turn('assistant', 'Keep this answer.'),
      turn('user', 'Pre-compaction memory flush.', { provenance: { kind: 'internal_system' } }),
      turn('assistant', '', {
        thinkingContent: 'Writing durable internal memory.',
        toolCalls: [{ id: 'flush-tool', name: 'apply_patch', status: 'completed' }],
      }),
      turn('toolResult', 'updated memory.md', { toolCallId: 'flush-tool', toolName: 'apply_patch' }),
      turn('assistant', 'Memory updated.'),
      turn('assistant', 'NO_REPLY'),
      turn('system', 'Memory flush completed', { provenance: 'hidden-history-artifact' }),
      turn('user', 'Visible request after maintenance.'),
      turn('assistant', 'Visible answer after maintenance.'),
    ]);

    expect(messages.map((message) => message.content)).toEqual([
      'Keep this request.',
      'Keep this answer.',
      'Visible request after maintenance.',
      'Visible answer after maintenance.',
    ]);
  });

  it('keeps only the final non-OK heartbeat result and clears provisional alerts on OK', () => {
    const messages = parseHistoryMessages([
      turn('user', '[OpenClaw heartbeat poll]', { provenance: { kind: 'internal_system' } }),
      turn('assistant', 'Potential stale warning.'),
      turn('assistant', 'HEARTBEAT_OK'),
      turn('user', 'Visible request.'),
      turn('assistant', 'Visible answer.'),
    ]);

    expect(messages.map((message) => message.content)).toEqual([
      'Visible request.',
      'Visible answer.',
    ]);
  });

  it('ignores old persisted maintenance and compaction markers on refresh', () => {
    const messages = parseHistoryMessages([
      turn('system', 'Compacting context…', { provenance: 'compaction' }),
      turn('system', 'Context compacted', { __openclaw: { kind: 'compaction' } }),
      turn('system', 'Heartbeat check completed', { provenance: 'hidden-history-artifact' }),
      turn('user', 'Visible request'),
      turn('assistant', 'Visible answer'),
    ]);

    expect(messages.map((message) => message.content)).toEqual(['Visible request', 'Visible answer']);
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

  it.each(['Pre-compaction memory flush.', '[OpenClaw heartbeat poll]', 'HEARTBEAT_OK', 'Memory flush completed.'])(
    'preserves exact authored control text: %s', (content) => {
      const rows = parseHistoryMessages([turn('user', content), turn('assistant', 'Answer to the user.')]);
      expect(rows.map((row) => row.content)).toEqual([content, 'Answer to the user.']);
    },
  );

  it('preserves authored prefix text and quoted internal marker strings', () => {
    const quotedEnvelope = [
      'Explain this quoted marker:',
      '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>',
      'OpenClaw runtime context (internal):',
      'quoted example only',
      '<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
    ].join('\n');
    const quotedMetadataEnvelope = [
      'Explain this quoted wrapper:',
      'Sender (untrusted metadata):',
      '```json',
      '{"name":"quoted-example"}',
      '```',
      '[Thu 2026-08-20 10:20 EDT] quoted body',
    ].join('\n');
    const messages = parseHistoryMessages([
      turn('user', 'Pre-compaction memory flush. Explain what this phrase means.'),
      turn('assistant', 'It is a lifecycle phrase.'),
      turn('user', quotedEnvelope),
      turn('assistant', 'The marker remains visible as authored text.'),
      turn('user', quotedMetadataEnvelope),
      turn('assistant', 'The wrapper remains visible as authored text.'),
      turn('user', [
        'Sender (untrusted metadata):',
        '```json',
        '{"name":"gateway"}',
        '```',
        '[Thu 2026-08-20 10:21 EDT] Canonically wrapped request.',
      ].join('\n')),
      turn('assistant', 'Canonical wrapper was removed.'),
    ]);

    expect(messages.map((message) => message.content)).toEqual([
      'Pre-compaction memory flush. Explain what this phrase means.',
      'It is a lifecycle phrase.',
      quotedEnvelope,
      'The marker remains visible as authored text.',
      quotedMetadataEnvelope,
      'The wrapper remains visible as authored text.',
      ['Sender (untrusted metadata):', '```json', '{"name":"gateway"}', '```', '[Thu 2026-08-20 10:21 EDT] Canonically wrapped request.'].join('\n'),
      'Canonical wrapper was removed.',
    ]);
  });
});
