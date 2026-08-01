import {
  buildRunningToolCall,
  finishMatchingToolCallInMessage,
  updateRunningToolCallInMessage,
} from './liveTurnProjector';
import { expect, test } from 'vitest';

test('parallel same-name tools update and finish by server tool-call ID', () => {
  const messages = [{
    id: 'assistant-1',
    role: 'assistant',
    toolCalls: [
      buildRunningToolCall({ id: 'call-a', name: 'exec', startedAt: 1 }),
      buildRunningToolCall({ id: 'call-b', name: 'exec', startedAt: 2 }),
    ],
  }];

  const updated = updateRunningToolCallInMessage(messages, 'assistant-1', {
    toolCallId: 'call-b',
    toolName: 'exec',
    result: 'second running',
  });
  expect(updated.toolCalls.map((tool) => [tool.id, tool.result])).toEqual([
    ['call-a', undefined],
    ['call-b', 'second running'],
  ]);

  const finishedB = finishMatchingToolCallInMessage(updated.messages, 'assistant-1', {
    toolCallId: 'call-b',
    toolName: 'exec',
    result: 'second done',
  });
  expect(finishedB.toolCalls.map((tool) => [tool.id, tool.status])).toEqual([
    ['call-a', 'running'],
    ['call-b', 'done'],
  ]);

  const finishedA = finishMatchingToolCallInMessage(finishedB.messages, 'assistant-1', {
    toolCallId: 'call-a',
    toolName: 'exec',
    result: 'first done',
  });
  expect(finishedA.toolCalls.map((tool) => [tool.id, tool.status, tool.result])).toEqual([
    ['call-a', 'done', 'first done'],
    ['call-b', 'done', 'second done'],
  ]);
});

test('an unknown server tool ID never falls back to another same-name tool', () => {
  const messages = [{
    id: 'assistant-1',
    role: 'assistant',
    toolCalls: [buildRunningToolCall({ id: 'call-a', name: 'exec' })],
  }];
  const result = finishMatchingToolCallInMessage(messages, 'assistant-1', {
    toolCallId: 'stale-call',
    toolName: 'exec',
    result: 'wrong result',
  });
  expect(result.changed).toBe(false);
  expect(result.toolCalls[0].status).toBe('running');
});
