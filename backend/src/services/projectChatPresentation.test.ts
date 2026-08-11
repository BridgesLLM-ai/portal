import {
  PROJECT_CHAT_PRESENTATION_MAX_BYTES,
  buildProjectChatMessagePresentation,
  parseProjectChatMessagePresentation,
  projectChatPresentationMaterializationMarker,
  retainNewestProjectChatPresentationEvents,
  shouldRepairProjectChatPresentation,
} from './projectChatPresentation';
import type { ProjectNativeRunEvent } from './projectNativeRunBroker';

function event(seq: number, value: Partial<ProjectNativeRunEvent>): ProjectNativeRunEvent {
  return { seq, ts: 1_000 + seq, type: 'status', ...value } as ProjectNativeRunEvent;
}

test('persists an ordered pre-tool, reasoning, tool, and post-tool timeline', () => {
  const presentation = buildProjectChatMessagePresentation([
    event(1, { type: 'thinking', content: 'Plan ' }),
    event(2, { type: 'thinking', content: 'carefully.' }),
    event(3, { type: 'text', content: 'I will inspect it.' }),
    event(4, { type: 'segment_break' }),
    event(5, { type: 'tool_start', toolName: 'exec', toolCallId: 'call-1', toolArgs: { command: 'pwd' } }),
    event(6, { type: 'tool_update', toolName: 'exec', toolCallId: 'call-1', toolResult: '/workspace' }),
    event(7, { type: 'tool_end', toolName: 'exec', toolCallId: 'call-1', toolResult: '/workspace/project', status: 'done' }),
    event(8, { type: 'thinking', content: 'The path is correct.' }),
    event(9, { type: 'text', content: 'Done.' }),
  ]);

  expect(presentation).toEqual({
    version: 2,
    segments: [
      { text: 'Plan carefully.', kind: 'thinking', position: 'before', ts: 1_001, order: 1 },
      { text: 'I will inspect it.', kind: 'text', position: 'before', ts: 1_003, order: 3 },
      { text: 'The path is correct.', kind: 'thinking', position: 'after', ts: 1_008, order: 8 },
      { text: 'Done.', kind: 'text', position: 'after', ts: 1_009, order: 9 },
    ],
    toolCalls: [{
      id: 'call-1',
      name: 'exec',
      arguments: { command: 'pwd' },
      result: '/workspace/project',
      startedAt: 1_005,
      endedAt: 1_007,
      status: 'done',
      order: 5,
    }],
  });
  expect(parseProjectChatMessagePresentation(presentation)).toEqual(presentation);
});

test('replace applies only to the current reasoning phase', () => {
  const presentation = buildProjectChatMessagePresentation([
    event(1, { type: 'thinking', content: 'phase one' }),
    event(2, { type: 'tool_start', toolName: 'read', toolCallId: 'read-1' }),
    event(3, { type: 'tool_end', toolName: 'read', toolCallId: 'read-1', status: 'done' }),
    event(4, { type: 'thinking', content: 'partial' }),
    event(5, { type: 'thinking', content: 'phase two replacement', replace: true }),
  ]);
  expect(presentation?.segments?.map((segment) => segment.text)).toEqual([
    'phase one',
    'phase two replacement',
  ]);
});

test('removes cumulative preamble prefixes across tool and text boundaries', () => {
  const firstThought = 'I will inspect the Project runtime.';
  const secondThought = 'The runtime is confined correctly.';
  const revisedSecondThought = `${secondThought} Its boundaries are verified.`;
  const thirdThought = 'I will now summarize the verified result.';
  const presentation = buildProjectChatMessagePresentation([
    event(1, {
      type: 'thinking',
      content: firstThought,
      replace: true,
      preambleProgress: true,
      preambleItemId: 'preamble-1',
    }),
    event(2, { type: 'tool_start', toolName: 'read', toolCallId: 'read-1' }),
    event(3, { type: 'tool_end', toolName: 'read', toolCallId: 'read-1', status: 'done' }),
    event(4, {
      type: 'thinking',
      content: `${firstThought}\n\n${secondThought}`,
      replace: true,
      preambleProgress: true,
      preambleItemId: 'preamble-2',
    }),
    event(5, {
      type: 'thinking',
      content: `${firstThought}\n\n${revisedSecondThought}`,
      replace: true,
      preambleProgress: true,
      preambleItemId: 'preamble-3',
    }),
    event(6, { type: 'text', content: 'The check completed.' }),
    event(7, {
      type: 'thinking',
      content: `${firstThought}\n\n${revisedSecondThought}\n\n${thirdThought}`,
      replace: true,
      preambleProgress: true,
      preambleItemId: 'preamble-4',
    }),
  ]);

  expect(presentation?.segments?.map(({ kind, text, order }) => ({ kind, text, order }))).toEqual([
    { kind: 'thinking', text: firstThought, order: 1 },
    { kind: 'thinking', text: revisedSecondThought, order: 4 },
    { kind: 'text', text: 'The check completed.', order: 6 },
    { kind: 'thinking', text: thirdThought, order: 7 },
  ]);
  expect(presentation?.segments?.some((segment) => segment.text.includes(firstThought) && segment.order > 1))
    .toBe(false);
});

test('does not split a reasoning phase solely because its preamble item ID changes', () => {
  const firstThought = 'Inspecting the current implementation.';
  const secondThought = 'The snapshot remains one live reasoning phase.';
  const presentation = buildProjectChatMessagePresentation([
    event(1, {
      type: 'thinking',
      content: firstThought,
      replace: true,
      preambleProgress: true,
      preambleItemId: 'preamble-1',
    }),
    event(2, {
      type: 'thinking',
      content: `${firstThought}\n\n${secondThought}`,
      replace: true,
      preambleProgress: true,
      preambleItemId: 'preamble-2',
    }),
  ]);

  expect(presentation?.segments).toEqual([expect.objectContaining({
    kind: 'thinking',
    text: `${firstThought}\n\n${secondThought}`,
    order: 1,
  })]);
});

test('normalizes cumulative raw and preamble snapshots in independent lanes', () => {
  const rawFirst = 'Raw inspection';
  const rawSecond = 'Raw tests';
  const preambleFirst = 'Visible preamble';
  const preambleSecond = 'Visible check';
  const presentation = buildProjectChatMessagePresentation([
    event(1, { type: 'thinking', content: rawFirst, replace: true }),
    event(2, { type: 'tool_start', toolName: 'read', toolCallId: 'read-1' }),
    event(3, { type: 'tool_end', toolName: 'read', toolCallId: 'read-1', status: 'done' }),
    event(4, {
      type: 'thinking',
      content: preambleFirst,
      replace: true,
      preambleProgress: true,
    }),
    event(5, { type: 'tool_start', toolName: 'exec', toolCallId: 'exec-1' }),
    event(6, { type: 'tool_end', toolName: 'exec', toolCallId: 'exec-1', status: 'done' }),
    event(7, { type: 'thinking', content: `${rawFirst}\n\n${rawSecond}`, replace: true }),
    event(8, {
      type: 'thinking',
      content: `${preambleFirst}\n\n${preambleSecond}`,
      replace: true,
      preambleProgress: true,
    }),
  ]);

  expect(presentation?.segments?.map(({ kind, text, order }) => ({ kind, text, order }))).toEqual([
    { kind: 'thinking', text: rawFirst, order: 1 },
    { kind: 'thinking', text: preambleFirst, order: 4 },
    { kind: 'thinking', text: rawSecond, order: 7 },
    { kind: 'thinking', text: preambleSecond, order: 8 },
  ]);
});

test('removes the overlap from a sliding preamble snapshot after a tool', () => {
  const entries = Array.from({ length: 66 }, (_, index) => (
    `Reasoning item ${String(index + 1).padStart(2, '0')}: ${'detail '.repeat(24)}${index}`
  ));
  const firstWindow = entries.slice(0, 64).join('\n\n');
  const shiftedWindow = entries.slice(2, 66).join('\n\n');
  const presentation = buildProjectChatMessagePresentation([
    event(1, {
      type: 'thinking',
      content: firstWindow,
      replace: true,
      preambleProgress: true,
    }),
    event(2, { type: 'tool_start', toolName: 'exec', toolCallId: 'exec-1' }),
    event(3, { type: 'tool_end', toolName: 'exec', toolCallId: 'exec-1', status: 'done' }),
    event(4, {
      type: 'thinking',
      content: shiftedWindow,
      replace: true,
      preambleProgress: true,
    }),
  ]);

  expect(presentation?.segments?.map((segment) => segment.text)).toEqual([
    firstWindow,
    entries.slice(64).join('\n\n'),
  ]);
});

test('preserves a reset snapshot when its overlap is too weak to prove graduation', () => {
  const baseline = `${'old evidence '.repeat(24)}shared ending`;
  const reset = 'shared ending — but this is a distinct corrected snapshot';
  const presentation = buildProjectChatMessagePresentation([
    event(1, {
      type: 'thinking',
      content: baseline,
      replace: true,
      preambleProgress: true,
    }),
    event(2, { type: 'tool_start', toolName: 'read', toolCallId: 'read-1' }),
    event(3, { type: 'tool_end', toolName: 'read', toolCallId: 'read-1', status: 'done' }),
    event(4, {
      type: 'thinking',
      content: reset,
      replace: true,
      preambleProgress: true,
    }),
  ]);

  expect(presentation?.segments?.map((segment) => segment.text)).toEqual([baseline, reset]);
});

test('does not let a delayed baseline snapshot erase newer append reasoning', () => {
  const baseline = 'Finished inspection';
  const delta = '\nRunning tests';
  const presentation = buildProjectChatMessagePresentation([
    event(1, { type: 'thinking', content: baseline, replace: true }),
    event(2, { type: 'tool_start', toolName: 'read', toolCallId: 'read-1' }),
    event(3, { type: 'tool_end', toolName: 'read', toolCallId: 'read-1', status: 'done' }),
    event(4, { type: 'thinking', content: delta }),
    event(5, { type: 'thinking', content: baseline, replace: true }),
    event(6, { type: 'tool_start', toolName: 'exec', toolCallId: 'exec-1' }),
    event(7, { type: 'tool_end', toolName: 'exec', toolCallId: 'exec-1', status: 'done' }),
    event(8, {
      type: 'thinking',
      content: `${baseline}${delta}\nReviewing output`,
      replace: true,
    }),
  ]);

  expect(presentation?.segments?.map((segment) => segment.text)).toEqual([
    baseline,
    delta,
    'Reviewing output',
  ]);
});

test('preserves repeated and prefix-like append deltas verbatim', () => {
  const presentation = buildProjectChatMessagePresentation([
    event(1, { type: 'text', content: 'go' }),
    event(2, { type: 'text', content: 'go' }),
    event(3, { type: 'text', content: 'go farther' }),
  ]);

  expect(presentation?.segments?.[0]?.text).toBe('gogogo farther');
});

test('keeps transient reasoning progress out of the terminal presentation', () => {
  const presentation = buildProjectChatMessagePresentation([
    event(1, {
      type: 'status',
      content: 'Thinking… (~1,234 tokens)',
      transient: true,
      replace: true,
    }),
    event(2, { type: 'text', content: 'Done.' }),
  ]);

  expect(presentation?.segments).toEqual([{
    text: 'Done.',
    kind: 'text',
    position: 'after',
    ts: 1_002,
    order: 2,
  }]);
});

test('persists only broker-attested visible status thoughts across terminal refresh', () => {
  const presentation = buildProjectChatMessagePresentation([
    event(1, {
      type: 'status',
      content: 'Reviewing the first result.',
      assistantStatus: true,
      replace: true,
    }),
    event(2, { type: 'tool_start', toolName: 'read', toolCallId: 'read-1' }),
    event(3, { type: 'tool_end', toolName: 'read', toolCallId: 'read-1', status: 'done' }),
    event(4, {
      type: 'status',
      content: 'Reviewing the first result. Checking the second result.',
      assistantStatus: true,
      replace: true,
    }),
    event(5, {
      type: 'status',
      content: 'Unattested rail text must not become history.',
      replace: true,
    }),
  ]);

  expect(presentation?.segments?.map(({ kind, text, order }) => ({ kind, text, order }))).toEqual([
    { kind: 'thinking', text: 'Reviewing the first result.', order: 1 },
    { kind: 'thinking', text: 'Checking the second result.', order: 4 },
  ]);
});

test('persists a safe thinking subject separately from its streamed body', () => {
  const presentation = buildProjectChatMessagePresentation([
    event(1, { type: 'thinking', subject: '**Inspecting**\napi_key=sk-abcdefghijklmnopqrstuv', content: '' }),
    event(2, { type: 'thinking', content: 'Reading ' }),
    event(3, { type: 'thinking', content: 'the runtime.' }),
  ]);

  expect(presentation?.segments).toEqual([{
    text: 'Reading the runtime.',
    subject: 'Inspecting [redacted]',
    kind: 'thinking',
    position: 'after',
    ts: 1_001,
    order: 1,
  }]);
  expect(parseProjectChatMessagePresentation(presentation)?.segments?.[0]).toMatchObject({
    subject: 'Inspecting [redacted]',
    text: 'Reading the runtime.',
  });
});

test('keeps each changed thinking subject attached only to its own body', () => {
  const presentation = buildProjectChatMessagePresentation([
    event(1, { type: 'thinking', subject: 'Inspecting files', content: 'Reading files.' }),
    event(2, { type: 'thinking', subject: 'Checking tests', content: 'Running tests.' }),
  ]);

  expect(presentation?.segments).toEqual([
    expect.objectContaining({
      subject: 'Inspecting files',
      text: 'Reading files.',
      order: 1,
    }),
    expect.objectContaining({
      subject: 'Checking tests',
      text: 'Running tests.',
      order: 2,
    }),
  ]);
});

test.each(['error', 'aborted', 'expired'] as const)('finalizes running tool cards for %s turns', (terminalStatus) => {
  const presentation = buildProjectChatMessagePresentation([
    event(1, { type: 'tool_start', toolName: 'exec', toolCallId: 'call-1' }),
  ], { terminalStatus });
  expect(presentation?.toolCalls?.[0]).toMatchObject({
    id: 'call-1',
    status: 'error',
    endedAt: 1_001,
  });
  expect(presentation?.toolCalls?.[0]?.result).toMatch(/interrupted|error/);
});

test('enforces one aggregate byte budget and reports truncation', () => {
  const events = Array.from({ length: 96 }, (_, index) => event(index * 2 + 1, {
    type: 'tool_start',
    toolName: 'exec',
    toolCallId: `call-${index}`,
    toolArgs: { command: 'x'.repeat(20_000) },
  })).flatMap((start, index) => [
    start,
    event(index * 2 + 2, {
      type: 'tool_end',
      toolName: 'exec',
      toolCallId: `call-${index}`,
      toolResult: 'y'.repeat(30_000),
      status: 'done',
    }),
  ]);
  const presentation = buildProjectChatMessagePresentation(events)!;
  expect(Buffer.byteLength(JSON.stringify(presentation), 'utf8')).toBeLessThanOrEqual(PROJECT_CHAT_PRESENTATION_MAX_BYTES);
  expect(presentation.truncated).toBe(true);
});

test('reports count-cap eviction for otherwise tiny tools and reasoning segments', () => {
  const toolEvents = Array.from({ length: 97 }, (_, index) => [
    event(index * 2 + 1, {
      type: 'tool_start',
      toolName: 'read',
      toolCallId: `call-${index}`,
    }),
    event(index * 2 + 2, {
      type: 'tool_end',
      toolName: 'read',
      toolCallId: `call-${index}`,
      status: 'done',
    }),
  ]).flat();
  const toolPresentation = buildProjectChatMessagePresentation(toolEvents)!;
  expect(toolPresentation.toolCalls).toHaveLength(96);
  expect(toolPresentation.toolCalls?.[0]?.id).toBe('call-1');
  expect(toolPresentation.truncated).toBe(true);

  const reasoningEvents = Array.from({ length: 193 }, (_, index) => event(index + 1, {
    type: 'thinking',
    subject: `Reasoning phase ${index}`,
    content: `Thought ${index}`,
  }));
  const reasoningPresentation = buildProjectChatMessagePresentation(reasoningEvents)!;
  expect(reasoningPresentation.segments).toHaveLength(192);
  expect(reasoningPresentation.segments?.[0]?.subject).toBe('Reasoning phase 1');
  expect(reasoningPresentation.truncated).toBe(true);
});

test('retains the terminal tail of an over-limit replay in durable sequence order', () => {
  const newestFirst = Array.from({ length: 2_001 }, (_, index) => ({
    seq: 2_001 - index,
    type: index === 0 ? 'done' : 'text',
  }));
  const retained = retainNewestProjectChatPresentationEvents(newestFirst, 2_000);

  expect(retained.truncated).toBe(true);
  expect(retained.events).toHaveLength(2_000);
  expect(retained.events[0].seq).toBe(2);
  expect(retained.events.at(-1)).toEqual({ seq: 2_001, type: 'done' });

  const presentation = buildProjectChatMessagePresentation([
    event(2_000, { type: 'text', content: 'terminal answer' }),
  ], { sourceTruncated: retained.truncated });
  expect(presentation?.truncated).toBe(true);
});

test('reads legacy v1 evidence without accepting unknown versions', () => {
  expect(parseProjectChatMessagePresentation({ version: 3, thinkingContent: 'future' })).toBeNull();
  expect(parseProjectChatMessagePresentation({
    version: 1,
    thinkingContent: 'legacy reasoning',
    toolCalls: [{ id: 'ok', name: 'read', status: 'done', startedAt: 42, result: 'done' }],
  })).toEqual({
    version: 2,
    thinkingContent: 'legacy reasoning',
    toolCalls: [{ id: 'ok', name: 'read', status: 'done', startedAt: 42, endedAt: 42, result: 'done', order: 0 }],
  });
});

test('pre-migration terminal rows stay idempotent across repeated history reads', () => {
  const legacyMetadata = { providerStatus: 'completed' };
  expect(projectChatPresentationMaterializationMarker(legacyMetadata)).toBeNull();
  for (let read = 0; read < 3; read += 1) {
    expect(shouldRepairProjectChatPresentation({
      resultMetadata: legacyMetadata,
      presentation: null,
    })).toBe(false);
  }
});

test('repairs only explicit failed or unsettled durable projections', () => {
  expect(shouldRepairProjectChatPresentation({
    resultMetadata: { presentationMaterialized: false },
    presentation: null,
  })).toBe(true);
  expect(shouldRepairProjectChatPresentation({
    resultMetadata: { presentationMaterialized: true },
    presentation: null,
  })).toBe(false);
  expect(shouldRepairProjectChatPresentation({
    resultMetadata: { presentationMaterialized: true },
    presentation: {
      version: 2,
      toolCalls: [{ id: 'call-1', name: 'exec', startedAt: 1, status: 'running' }],
    },
  })).toBe(true);
});
