import {
  appendCompletedToolCallIfMissing,
  buildCompletedToolCall,
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

test('stable replay order preserves legitimate repeated same-name tools and dedupes the same event', () => {
  const first = buildCompletedToolCall({
    id: 'compat-first',
    name: 'exec',
    startedAt: 1,
    endedAt: 2,
  });
  const messages = [{
    id: 'assistant-1',
    role: 'assistant',
    toolCalls: [{ ...first, order: 10 }],
  }];

  const repeatedName = appendCompletedToolCallIfMissing(messages, 'assistant-1', {
    ...buildCompletedToolCall({
      id: 'compat-second',
      name: 'exec',
      startedAt: 3,
      endedAt: 4,
    }),
    order: 11,
  }, { stableOrder: 11, now: 4 });
  expect(repeatedName.changed).toBe(true);
  expect(repeatedName.toolCalls.map((tool) => tool.order)).toEqual([10, 11]);

  const duplicateReplay = appendCompletedToolCallIfMissing(repeatedName.messages, 'assistant-1', {
    ...buildCompletedToolCall({
      id: 'compat-second-replayed',
      name: 'exec',
      startedAt: 5,
      endedAt: 6,
    }),
    order: 11,
  }, { stableOrder: 11, now: 6 });
  expect(duplicateReplay.changed).toBe(false);
});

test('stable provider tool ID dedupes replay without suppressing another same-name tool', () => {
  const messages = [{
    id: 'assistant-1',
    role: 'assistant',
    toolCalls: [{
      ...buildCompletedToolCall({ id: 'provider-call-1', name: 'read', startedAt: 1, endedAt: 2 }),
      order: 4,
    }],
  }];

  const duplicate = appendCompletedToolCallIfMissing(messages, 'assistant-1', {
    ...buildCompletedToolCall({ id: 'provider-call-1', name: 'read', startedAt: 3, endedAt: 4 }),
    order: 9,
  }, { stableToolCallId: 'provider-call-1', now: 4 });
  expect(duplicate.changed).toBe(false);

  const distinct = appendCompletedToolCallIfMissing(messages, 'assistant-1', {
    ...buildCompletedToolCall({ id: 'provider-call-2', name: 'read', startedAt: 3, endedAt: 4 }),
    order: 9,
  }, { stableToolCallId: 'provider-call-2', now: 4 });
  expect(distinct.changed).toBe(true);
});

test('stable replay order is scoped to the active assistant turn', () => {
  const messages = [{
    id: 'assistant-old',
    role: 'assistant',
    toolCalls: [{
      ...buildCompletedToolCall({ id: 'old-call', name: 'exec', startedAt: 1, endedAt: 2 }),
      order: 3,
    }],
  }, {
    id: 'assistant-current',
    role: 'assistant',
    toolCalls: [],
  }];

  const result = appendCompletedToolCallIfMissing(messages, 'assistant-current', {
    ...buildCompletedToolCall({ id: 'current-call', name: 'exec', startedAt: 3, endedAt: 4 }),
    order: 3,
  }, { stableOrder: 3, now: 4 });

  expect(result.changed).toBe(true);
  expect(result.messages.find((message) => message.id === 'assistant-current')?.toolCalls).toHaveLength(1);
});
