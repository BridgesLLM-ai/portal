import { describe, expect, test } from 'vitest';
import { normalizePortalStreamEventFromTurnEvent } from './runtimeTurnEvents';

describe('runtimeTurnEvents tool identity', () => {
  test('preserves the server tool-call ID and failure status during replay normalization', () => {
    const normalized = normalizePortalStreamEventFromTurnEvent({
      type: 'tool_end',
      turnEvent: {
        schema: 'bridgesllm.runtime-turn-event.v1' as const,
        type: 'tool_output' as const,
        visible: true,
        tool: {
          id: 'server-call-1',
          name: 'exec',
          status: 'error' as const,
          result: 'exit 1',
        },
      },
    });

    expect(normalized).toMatchObject({
      type: 'tool_end',
      toolCallId: 'server-call-1',
      toolName: 'exec',
      status: 'error',
      toolResult: 'exit 1',
    });
  });

  test('preserves a subject-only reasoning event without manufacturing body text', () => {
    const normalized = normalizePortalStreamEventFromTurnEvent({
      type: 'thinking',
      turnEvent: {
        schema: 'bridgesllm.runtime-turn-event.v1' as const,
        type: 'assistant_reasoning' as const,
        visible: true,
        subject: 'Inspecting the runtime',
        source: {
          transport: 'portal-stream-event-bus' as const,
          eventType: 'thinking' as const,
        },
      },
    });

    expect(normalized).toMatchObject({
      type: 'thinking',
      subject: 'Inspecting the runtime',
    });
    expect(normalized.content).toBe('');
  });
});
