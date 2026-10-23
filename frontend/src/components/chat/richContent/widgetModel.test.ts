import { describe, expect, it } from 'vitest';
import { acceptWidgetMessage, parseWidgetReference, widgetDocumentPath, WIDGET_CHANNEL } from './widgetModel';
const reference = { schema: 'bridgesllm.widget-ref.v1', toolCallId: 'call-owned', title: 'Counter', mode: 'inline' };
describe('widget reference and bridge boundary', () => {
  it('restores the deliberately projected receipt, never raw HTML or arbitrary native text', () => {
    expect(parseWidgetReference('show_widget', 'call-owned', JSON.stringify(reference))).toEqual(reference);
    expect(parseWidgetReference('exec', 'call-owned', JSON.stringify(reference))).toBeNull();
    expect(parseWidgetReference('show_widget', 'call-foreign', JSON.stringify(reference))).toBeNull();
    expect(parseWidgetReference('show_widget', 'call-owned', '<button>raw source</button>')).toBeNull();
    expect(parseWidgetReference('show_widget', 'call-owned', JSON.stringify({ ...reference, docId: 'foreign' }))).toBeNull();
  });
  it('accepts only bounded inline presentation correlation, never a fetch target', () => {
    const bound = { ...reference, presentationRef: 'cv_owned' };
    expect(parseWidgetReference('show_widget', 'call-owned', JSON.stringify(bound))).toEqual(bound);
    for (const value of ['', '..', '../foreign', 'https://example.test/doc', 'x'.repeat(257), 12, null])
      expect(parseWidgetReference('show_widget', 'call-owned', JSON.stringify({ ...bound, presentationRef: value }))).toBeNull();
    for (const mode of ['dashboard', 'unsupported'])
      expect(parseWidgetReference('show_widget', 'call-owned', JSON.stringify({ ...bound, mode }))).toBeNull();
    expect(parseWidgetReference('show_widget', 'call-owned', JSON.stringify({ ...bound, html: '<script>x()</script>' }))).toBeNull();
  });
  it('rejects forged source/channel/instance/origin and any privileged commands', () => {
    const source = {} as Window; const good = { source, origin: 'null', data: { channel: WIDGET_CHANNEL, instance: 'owned', type: 'size', height: 999999 } };
    expect(acceptWidgetMessage(good as any, source, 'owned')?.height).toBe(720);
    for (const bad of [{ ...good, source: {} }, { ...good, origin: 'https://portal.example' },
      { ...good, data: { ...good.data, instance: 'foreign' } }, { ...good, data: { ...good.data, channel: 'foreign' } },
      { ...good, data: { ...good.data, type: 'chat.send' } }, { ...good, data: { ...good.data, method: 'tools.invoke' } },
      { ...good, data: { ...good.data, height: NaN } }, { ...good, data: { ...good.data, height: '100' } }])
      expect(acceptWidgetMessage(bad as any, source, 'owned')).toBeNull();
  });
  it('requests by owned session and tool call only, with no document ID/URL/path parameter', () => {
    expect(widgetDocumentPath('agent:main:portal-a', 'call-owned')).toBe('/chat-widgets/sessions/agent%3Amain%3Aportal-a/tools/call-owned/document');
    expect(widgetDocumentPath('agent:main:portal-a', 'call-owned', 'OPENCLAW')).toBe('/chat-widgets/sessions/agent%3Amain%3Aportal-a/tools/call-owned/document');
  });
  it('reads native harness widgets from the exact native session, never under an alias', () => {
    expect(widgetDocumentPath('codex-u1-1760000000000-abc', 'item_7', 'CODEX'))
      .toBe('/chat-widgets/native/sessions/codex-u1-1760000000000-abc/tools/item_7/document');
    expect(widgetDocumentPath('claude_code-u1-1-x', 'toolu_01/A', 'CLAUDE_CODE'))
      .toBe('/chat-widgets/native/sessions/claude_code-u1-1-x/tools/toolu_01%2FA/document');
    expect(widgetDocumentPath('main', 'item_7', 'CODEX')).toBeNull();
    expect(widgetDocumentPath('new-1760000000000', 'item_7', 'GROK')).toBeNull();
    // Another harness's session id is not this harness's session.
    expect(widgetDocumentPath('codex-u1-1-abc', 'item_7', 'GROK')).toBeNull();
  });
});
