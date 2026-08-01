import { describe, expect, it } from 'vitest';
import {
  CANCELLED_TURN_MARKER,
  collapseGatewayInjectedAbortMirrors,
  isAbortedDoneEvent,
  resolveToolCompletionStatus,
  selectSnapshotReasoningEvents,
  settleCancelledAssistantMessage,
  supportsAgentChatStop,
} from './agentChatRunLifecycle';

describe('Agent Chat run lifecycle helpers', () => {
  it('settles a partial assistant bubble exactly once and removes an empty placeholder', () => {
    const partial = [{ id: 'assistant-1', content: 'rendered prefix' }];
    const first = settleCancelledAssistantMessage(partial, 'assistant-1', 'latest partial');
    expect(first).toEqual([{
      id: 'assistant-1',
      content: `latest partial\n\n${CANCELLED_TURN_MARKER}`,
    }]);
    expect(settleCancelledAssistantMessage(first, 'assistant-1', '')).toEqual(first);

    expect(settleCancelledAssistantMessage(
      [{ id: 'assistant-2', content: '' }],
      'assistant-2',
      '',
    )).toEqual([]);
  });

  it('collapses only the adjacent gateway abort mirror into one cancelled model reply', () => {
    const injected = {
      id: 'injected', role: 'assistant', content: 'partial answer  ',
      model: 'gateway-injected', createdAt: new Date('2026-07-23T00:04:55.991Z'),
    };
    const model = {
      id: 'model', role: 'assistant', content: 'partial answer',
      model: 'gpt-5.6-luna', createdAt: new Date('2026-07-23T00:04:56.102Z'),
    };

    expect(collapseGatewayInjectedAbortMirrors([injected, model])).toEqual([{
      ...model,
      content: `partial answer\n\n${CANCELLED_TURN_MARKER}`,
    }]);
    expect(collapseGatewayInjectedAbortMirrors([model, injected])).toEqual([{
      ...model,
      content: `partial answer\n\n${CANCELLED_TURN_MARKER}`,
    }]);

    const repeated = { ...model, id: 'later', createdAt: new Date('2026-07-23T00:05:10.000Z') };
    expect(collapseGatewayInjectedAbortMirrors([model, repeated])).toEqual([model, repeated]);
  });

  it('keeps structured tool/reasoning state while marking a text-empty cancellation', () => {
    expect(settleCancelledAssistantMessage([{
      id: 'assistant-1',
      content: '',
      toolCalls: [{ id: 'tool-1' }],
    }], 'assistant-1', '')).toEqual([{
      id: 'assistant-1',
      content: CANCELLED_TURN_MARKER,
      toolCalls: [{ id: 'tool-1' }],
    }]);
  });

  it('recognizes only metadata-confirmed aborted done events', () => {
    expect(isAbortedDoneEvent({ type: 'done', metadata: { aborted: true } })).toBe(true);
    expect(isAbortedDoneEvent({ type: 'done', aborted: true })).toBe(false);
    expect(isAbortedDoneEvent({ type: 'error', metadata: { aborted: true } })).toBe(false);
  });

  it.each([
    [{ status: 'failed' }],
    [{ failed: true }],
    [{ isError: true }],
    [{ exitCode: 2 }],
    [{ toolResult: { exitCode: '9' } }],
    [{ metadata: { exitCode: -1 } }],
  ])('maps failed SSE tool completions to error (%o)', (event) => {
    expect(resolveToolCompletionStatus(event)).toBe('error');
  });

  it('keeps successful and zero-exit SSE tool completions done', () => {
    expect(resolveToolCompletionStatus({ status: 'done', exitCode: 0 })).toBe('done');
    expect(resolveToolCompletionStatus({})).toBe('done');
  });

  it('replays snapshot reasoning only for the active snapshot run and in sequence order', () => {
    const events = [
      { type: 'assistant_reasoning', text: 'newer', runId: 'run-2', seq: 4 },
      { type: 'assistant_reasoning', text: 'stale', runId: 'run-1', seq: 1 },
      { type: 'assistant_reasoning', text: 'older', runId: 'run-2', seq: 2 },
      { type: 'assistant_message', text: 'answer', runId: 'run-2', seq: 3 },
    ];
    expect(selectSnapshotReasoningEvents(events, 'run-2').map((event) => event.text))
      .toEqual(['older', 'newer']);
    expect(selectSnapshotReasoningEvents(events, null)).toEqual([]);
  });

  it('hides Stop only for unsupported Agent Zero host runs', () => {
    expect(supportsAgentChatStop('AGENT_ZERO')).toBe(false);
    expect(supportsAgentChatStop('OLLAMA')).toBe(true);
    expect(supportsAgentChatStop('OPENCLAW')).toBe(true);
  });
});
