import { nativeWidgetBinding, projectWidgetToolResult, findOwnedWidgetBinding } from './chatWidgetProjection';
const receipt = { kind: 'canvas', presentation: { target: 'assistant_message', title: 'Counter', sandbox: 'scripts' },
  view: { id: 'cv_owned', url: '/__openclaw__/canvas/documents/cv_owned/index.html' }, text: 'Widget hosted' };
export const widgetRows = () => [
  { role: 'assistant', content: [{ type: 'toolCall', id: 'call-owned', name: 'show_widget', arguments: { widget_code: '<secret-code>' } }] },
  { role: 'toolResult', toolCallId: 'call-owned', toolName: 'show_widget', details: receipt,
    content: [{ type: 'text', text: JSON.stringify(receipt) }] },
];
describe('pinned9.9 native widget projection', () => {
  test('projects native details before text flattening with a display-only reference and no code or URL', () => {
    const projected = projectWidgetToolResult('show_widget', 'call-owned', widgetRows()[1])!;
    expect(JSON.parse(projected)).toEqual({ schema: 'bridgesllm.widget-ref.v1', toolCallId: 'call-owned', title: 'Counter', mode: 'inline', presentationRef: 'cv_owned' });
    expect(projected).not.toMatch(/widget_code|secret-code|html|url/);
    expect(findOwnedWidgetBinding(widgetRows(), 'call-owned')?.docId).toBe('cv_owned');
  });
  test('supports the exact single JSON text receipt when native details are absent', () => {
    expect(nativeWidgetBinding('show_widget', 'call-owned', { content: [{ type: 'text', text: JSON.stringify(receipt) }] })?.docId).toBe('cv_owned');
  });
  test.each(['exec', 'canvas', 'dashboard'])('does not infer widget output from %s tool text', tool => {
    expect(nativeWidgetBinding(tool, 'call-owned', receipt)).toBeNull();
  });
  test.each(['https://attacker.example/x', '/etc/passwd', '/__openclaw__/canvas/documents/../index.html'])('rejects forged output path %s', url => {
    expect(nativeWidgetBinding('show_widget', 'call-owned', { ...receipt, view: { ...receipt.view, url } })?.docId).toBeUndefined();
  });
  test('dashboard-only and node-panel receipts never become inline success', () => {
    expect(nativeWidgetBinding('show_widget', 'call-owned', { status: 'pinned', boardWidgetName: 'weekly' })?.ref.mode).toBe('dashboard');
    expect(nativeWidgetBinding('show_widget', 'call-owned', { ...receipt, presentation: { ...receipt.presentation, target: 'node_panel' } })?.ref.mode).toBe('unsupported');
  });
  test('unpaired, foreign and duplicate tool result IDs confer no document access', () => {
    expect(findOwnedWidgetBinding(widgetRows(), 'call-foreign')).toBeNull();
    expect(findOwnedWidgetBinding(widgetRows().slice(1), 'call-owned')).toBeNull();
    expect(findOwnedWidgetBinding([...widgetRows(), widgetRows()[1]], 'call-owned')).toBeNull();
    expect(findOwnedWidgetBinding([{ ...widgetRows()[0], role: 'user' }, widgetRows()[1]], 'call-owned')).toBeNull();
  });
});
