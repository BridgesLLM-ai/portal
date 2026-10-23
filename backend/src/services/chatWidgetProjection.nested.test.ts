import { readOwnedWidgetDocument } from './chatWidgetDocument';
import { expandNativeNestedToolHistory, findOwnedWidgetBinding, projectWidgetToolResult } from './chatWidgetProjection';
import fixture from './fixtures/native-widget-nested-2026.9.9.json';
const fresh = (): any[] => JSON.parse(JSON.stringify(fixture));
const nested = (rows: any[]) => rows.find(row => row.customType === 'openclaw.nested-tool.v1');
const id = nested(fixture).content[0].id;
describe('actual native9.9 deferred widget history', () => {
  test('binds real native receipt, projects a safe reference, and survives repeated history reads', () => {
    for (let i = 0; i < 2; i++) {
      const rows = fresh(); const binding = findOwnedWidgetBinding(rows, id);
      expect(binding?.ref.mode).toBe('inline'); expect(binding?.docId).toMatch(/^cv_/);
      const expanded = expandNativeNestedToolHistory(rows);
      const result = expanded.find(row => row.role === 'toolResult' && row.toolName === 'show_widget');
      expect(JSON.parse(projectWidgetToolResult(result.toolName, result.toolCallId, result)!)).toEqual(binding?.ref);
      const call = expanded.find(row => row.role === 'assistant' && row.content?.[0]?.name === 'show_widget');
      expect(call.content[0].arguments).toEqual({ title: 'Synthetic counter' });
      expect(rows).toEqual(fixture);
    }
  });
  test('preserves an unknown deferred tool and its result without a tool-name allowlist', () => {
    const rows = fresh(); const n = nested(rows); const call = n.content[0], result = n.content[1];
    call.name = result.toolName = 'future_native_tool';
    call.arguments = { requested: 'synthetic-only' };
    result.content = [{ type: 'text', text: 'future result' }];
    const expanded = expandNativeNestedToolHistory(rows);
    expect(expanded.find(row => row.role === 'assistant' && row.content?.[0]?.name === 'future_native_tool')?.content[0].arguments)
      .toEqual({ requested: 'synthetic-only' });
    expect(expanded.find(row => row.role === 'toolResult' && row.toolName === 'future_native_tool')?.content)
      .toEqual([{ type: 'text', text: 'future result' }]);
    expect(findOwnedWidgetBinding(rows, id)).toBeNull(); // Generic visibility does not confer Canvas authority.
  });
  test.each(['user', 'assistant', 'toolResult'])('does not confer access on a %s row with a forged envelope', role => {
    const rows = fresh(); nested(rows).role = role; expect(findOwnedWidgetBinding(rows, id)).toBeNull();
  });
  test.each(['run', 'parent', 'afterEntry', 'callId', 'toolName', 'failed', 'duplicate', 'missingParent'])('rejects %s mismatch', change => {
    const rows = fresh(); const n = nested(rows); const call = n.content[0], result = n.content[1];
    if (change === 'run') result.runId = 'foreign';
    if (change === 'parent') result.parentToolCallId = 'foreign';
    if (change === 'afterEntry') result.afterEntryId = 'foreign';
    if (change === 'callId') result.toolCallId = 'foreign';
    if (change === 'toolName') result.toolName = 'exec';
    if (change === 'failed') result.isError = true;
    if (change === 'duplicate') rows.push(JSON.parse(JSON.stringify(n)));
    if (change === 'missingParent') rows.splice(rows.findIndex(r => r.__openclaw?.id === result.afterEntryId), 1);
    expect(findOwnedWidgetBinding(rows, id)).toBeNull();
  });
});

test('real deferred native widget is retrievable after reconnect and revocation still denies it', async () => {
  const rows = fresh(); const expected = findOwnedWidgetBinding(rows, id)!;
  const deps = { authorize: jest.fn(async () => {}),
    history: jest.fn(async () => ({ ok: true, data: { sessionId: 'native-fixture', messages: rows, hasMore: false } })),
    view: jest.fn(async () => ({ ok: true, data: { html: '<button>Increment</button>' } })) };
  for (let i = 0; i < 2; i++) expect((await readOwnedWidgetDocument(id, deps)).reference).toEqual(expected.ref);
  expect(deps.view).toHaveBeenCalledWith(expected.docId);
  deps.authorize.mockRejectedValue(new Error('revoked'));
  await expect(readOwnedWidgetDocument(id, deps)).rejects.toThrow('revoked');
  expect(deps.view).toHaveBeenCalledTimes(2);
});
