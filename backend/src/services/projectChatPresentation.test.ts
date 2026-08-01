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
