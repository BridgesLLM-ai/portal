import { readOwnedWidgetDocument } from './chatWidgetDocument';
const receipt = { kind: 'canvas', presentation: { target: 'assistant_message', title: 'Counter', sandbox: 'scripts' },
  view: { id: 'cv_owned', url: '/__openclaw__/canvas/documents/cv_owned/index.html' } };
const rows: any[] = [ { role: 'assistant', content: [{ type: 'toolCall', id: 'call-owned', name: 'show_widget' }] },
  { role: 'toolResult', toolCallId: 'call-owned', toolName: 'show_widget', details: receipt } ];
function deps() { return { authorize: jest.fn(async () => {}), history: jest.fn(async (_offset: number) => ({ ok: true, data: { sessionId: 'physical-owned', messages: rows, hasMore: false } })),
  view: jest.fn(async (_id: string) => ({ ok: true, data: { html: '<button onclick="this.textContent=2">1</button>', sandboxUrl: 'http://do-not-proxy/private' } })) }; }
describe('owned native tool-to-Canvas document retrieval', () => {
  test('renders and re-reads after a fresh backend instance/history reload; derives docId exclusively from paired native output', async () => {
    for (const d of [deps(), deps()]) {
      const value = await readOwnedWidgetDocument('call-owned', d);
      expect(value.html).toContain('onclick'); expect(value.reference.mode).toBe('inline');
      expect(d.view).toHaveBeenCalledWith('cv_owned'); expect(d.authorize).toHaveBeenCalledTimes(3);
      expect(value).not.toHaveProperty('sandboxUrl'); expect(d.history).toHaveBeenCalledTimes(2);
    }
  });
  test('unrelated owner/session/Project authorization fails before any history or document RPC', async () => {
    const d = deps(); d.authorize.mockRejectedValue(new Error('denied'));
    await expect(readOwnedWidgetDocument('call-owned', d)).rejects.toThrow('denied');
    expect(d.history).not.toHaveBeenCalled(); expect(d.view).not.toHaveBeenCalled();
  });
  test('unrelated tool ID does not allow an unscoped Canvas proxy', async () => {
    const d = deps(); await expect(readOwnedWidgetDocument('cv_foreign', d)).rejects.toMatchObject({ status: 404 });
    expect(d.view).not.toHaveBeenCalled();
  });
  test('revocation during document RPC suppresses returned HTML', async () => {
    const d = deps(); d.authorize.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('revoked'));
    await expect(readOwnedWidgetDocument('call-owned', d)).rejects.toThrow('revoked');
  });
  test('reset, deletion and conflicting rebinding suppress stale document bytes', async () => {
    for (const data of [{ sessionId: 'physical-reset', messages: rows }, { sessionId: 'physical-owned', messages: [] },
      { sessionId: 'physical-owned', messages: [rows[0], { ...rows[1], details: { ...receipt, view: { id: 'cv_other', url: '/__openclaw__/canvas/documents/cv_other/index.html' } } }] }]) {
      const d = deps(); d.history.mockResolvedValueOnce({ ok: true, data: { sessionId: 'physical-owned', messages: rows, hasMore: false } })
        .mockResolvedValueOnce({ ok: true, data: { ...data, hasMore: false } } as any);
      await expect(readOwnedWidgetDocument('call-owned', d)).rejects.toMatchObject({ status: 409 });
    }
  });
  test('expired document becomes410 and dashboard-only never invokes Canvas', async () => {
    const d = deps(); d.view.mockResolvedValue({ ok: false } as any);
    await expect(readOwnedWidgetDocument('call-owned', d)).rejects.toMatchObject({ status: 410 });
    d.history.mockResolvedValue({ ok: true, data: { sessionId: 'physical-owned', hasMore: false,
      messages: [rows[0], { ...rows[1], details: { status: 'pinned', boardWidgetName: 'report' } }] } });
    d.view.mockClear(); await expect(readOwnedWidgetDocument('call-owned', d)).rejects.toMatchObject({ status: 409 });
    expect(d.view).not.toHaveBeenCalled();
  });
  test('history work is finite and invalid pagination fails closed', async () => {
    const d = deps(); d.history.mockResolvedValue({ ok: true, data: { sessionId: 'physical-owned', messages: [], hasMore: true, nextOffset: 0 } } as any);
    await expect(readOwnedWidgetDocument('call-owned', d)).rejects.toMatchObject({ status: 502 });
    expect(d.history).toHaveBeenCalledTimes(1);
  });
});
