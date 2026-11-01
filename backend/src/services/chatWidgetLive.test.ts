import { findLatestBoardWidget, readBoardWidgetHtml, readLiveWidgetDocument } from './chatWidgetLive';
import { nativeWidgetBinding, MAX_WIDGET_HTML_BYTES } from './chatWidgetProjection';
import { WidgetReadError } from './chatWidgetDocument';
import { capabilitiesFromHello, clearOpenClawHello, observeOpenClawHello } from './openClawCompatibility';

const LIVE_HELLO = { server: { version: '2026.10.9' }, features: { methods: ['canvas.document.view', 'board.get'] } };
const inline = (id: string, board?: string) => ({ kind: 'canvas', presentation: { target: 'assistant_message', title: `T ${id}`, sandbox: 'scripts' },
  view: { id: `cv_${id}`, url: `/__openclaw__/canvas/documents/cv_${id}/index.html`, ...(board ? { boardWidgetName: board } : {}) } });
const pinned = (board: string) => ({ status: 'pinned', boardWidgetName: board, capabilityState: 'none', text: 'pinned' });
const pair = (id: string, details: any) => [
  { role: 'assistant', content: [{ type: 'toolCall', id, name: 'show_widget' }] },
  { role: 'toolResult', toolCallId: id, toolName: 'show_widget', details },
];
const page = (messages: any[], extra: Record<string, unknown> = {}) => ({ ok: true, data: { sessionId: 's1', messages, hasMore: false, ...extra } });
const FRAME = '/__openclaw__/board/agent%3Amain%3Aportal-x/timer/index.html?bt=ticket.abc-1';

function htmlResponse(body: string, headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }, status = 200) {
  return new Response(body, { status, headers });
}

beforeEach(() => observeOpenClawHello(LIVE_HELLO));
afterEach(() => { clearOpenClawHello(); jest.restoreAllMocks(); });

describe('live widget capability and projection', () => {
  test('live widgets need inline widgets plus board.get, with a plain reason when off', () => {
    expect(capabilitiesFromHello(LIVE_HELLO).liveWidgets).toBe(true);
    const noBoard = capabilitiesFromHello({ ...LIVE_HELLO, features: { methods: ['canvas.document.view'] } });
    expect(noBoard).toMatchObject({ inlineWidgets: true, liveWidgets: false });
    expect(noBoard.disabledReasons.liveWidgets).toMatch(/does not expose board\.get/);
    expect(capabilitiesFromHello({ ...LIVE_HELLO, features: { methods: ['board.get'] } }).disabledReasons.liveWidgets).toMatch(/canvas\.document\.view/);
  });

  test('a board name rides on inline and pinned-only references only while live widgets are on', () => {
    expect(nativeWidgetBinding('show_widget', 'c1', { details: inline('1', 'timer') })?.ref.boardName).toBe('timer');
    expect(nativeWidgetBinding('show_widget', 'c2', { details: pinned('timer') })?.ref).toMatchObject({ mode: 'dashboard', boardName: 'timer' });
    for (const bad of ['Timer', '../x', '', 'a'.repeat(65), 7]) {
      expect(nativeWidgetBinding('show_widget', 'c3', { details: inline('3', bad as any) })?.ref).not.toHaveProperty('boardName');
    }
    observeOpenClawHello({ ...LIVE_HELLO, features: { methods: ['canvas.document.view'] } });
    expect(nativeWidgetBinding('show_widget', 'c1', { details: inline('1', 'timer') })?.ref).not.toHaveProperty('boardName');
  });
});

describe('findLatestBoardWidget', () => {
  test('pages newest to oldest and returns the newest version plus the newest inline one', async () => {
    const pages = [
      page([...pair('c3', pinned('timer'))], { hasMore: true, nextOffset: 250 }),
      page([...pair('c1', inline('1', 'timer')), ...pair('c2', inline('2', 'other'))], { hasMore: false }),
    ];
    const history = jest.fn(async (offset: number) => pages[offset === 0 ? 0 : 1]);
    const found = await findLatestBoardWidget('timer', history);
    expect(found).toEqual({ latest: { toolCallId: 'c3', title: 'Widget', mode: 'dashboard' }, latestInline: { toolCallId: 'c1', title: 'T 1', mode: 'inline' } });
    expect(history.mock.calls.map(([offset]) => offset)).toEqual([0, 250]);
  });

  test('stops at the newest inline version without reading older pages', async () => {
    const history = jest.fn(async () => page([...pair('c1', inline('1', 'timer')), ...pair('c2', inline('2', 'timer'))], { hasMore: true, nextOffset: 250 }));
    expect((await findLatestBoardWidget('timer', history))?.latest.toolCallId).toBe('c2');
    expect(history).toHaveBeenCalledTimes(1);
  });

  test('refuses a session that changed between pages and a broken pager', async () => {
    const rebound = jest.fn(async (offset: number) => offset === 0 ? page([], { hasMore: true, nextOffset: 250 }) : { ok: true, data: { sessionId: 's2', messages: [], hasMore: false } });
    await expect(findLatestBoardWidget('timer', rebound)).rejects.toMatchObject({ status: 409, code: 'WIDGET_SESSION_CHANGED' });
    const stuck = jest.fn(async () => page([], { hasMore: true, nextOffset: 0 }));
    await expect(findLatestBoardWidget('timer', stuck)).rejects.toMatchObject({ status: 502 });
  });

  test('reads at most four pages and rejects an invalid board name before any read', async () => {
    const history = jest.fn(async (offset: number) => page([], { hasMore: true, nextOffset: offset + 250 }));
    expect(await findLatestBoardWidget('timer', history)).toBeNull();
    expect(history).toHaveBeenCalledTimes(4);
    const none = jest.fn();
    expect(await findLatestBoardWidget('../timer', none)).toBeNull();
    expect(none).not.toHaveBeenCalled();
  });
});

describe('readBoardWidgetHtml loopback safeguards', () => {
  const board = (widgets: any[]) => jest.fn(async () => ({ ok: true, data: { widgets } }));
  const widget = { name: 'timer', revision: 4, title: 'Timer', frameUrl: FRAME, contentKind: 'html' };

  test('reads one loopback frame with redirects refused', async () => {
    const fetchMock = jest.fn(async () => htmlResponse('<p>tick</p>'));
    const result = await readBoardWidgetHtml('agent:main:portal-x', 'timer', { rpc: board([widget]), gatewayHttpBase: 'http://127.0.0.1:18789', fetch: fetchMock as any });
    expect(result).toEqual({ html: '<p>tick</p>', revision: 4, title: 'Timer' });
    const [url, init] = (fetchMock.mock.calls[0] as unknown) as [URL, RequestInit];
    expect(String(url)).toBe(`http://127.0.0.1:18789${FRAME}`);
    expect(init.redirect).toBe('error');
  });

  test.each([
    ['a non-loopback Gateway', { gatewayHttpBase: 'http://10.0.0.5:18789' }],
    ['a non-HTTP Gateway URL', { gatewayHttpBase: 'file:///tmp/x' }],
    ['a frame outside the board path', { frameUrl: '/__openclaw__/canvas/documents/x/index.html?bt=t' }],
    ['an absolute frame URL', { frameUrl: `http://evil.example${FRAME}` }],
    ['a protocol-relative frame URL', { frameUrl: `//evil.example${FRAME}` }],
    ['a dot-segment frame', { frameUrl: '/__openclaw__/board/s/../timer/index.html?bt=t' }],
    ['a frame for another widget', { frameUrl: FRAME.replace('/timer/', '/other/') }],
    ['a frame without a ticket', { frameUrl: FRAME.split('?')[0] }],
    ['a plugin widget', { contentKind: 'plugin' }],
  ])('refuses %s without fetching', async (_label, change: any) => {
    const fetchMock = jest.fn();
    const { gatewayHttpBase = 'http://localhost:18789', ...widgetChange } = change;
    expect(await readBoardWidgetHtml('k', 'timer', { rpc: board([{ ...widget, ...widgetChange }]), gatewayHttpBase, fetch: fetchMock as any })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('refuses duplicate names, a failed board read and a missing widget', async () => {
    const fetchMock = jest.fn();
    const deps = (rpc: any) => ({ rpc, gatewayHttpBase: 'http://[::1]:18789', fetch: fetchMock as any });
    expect(await readBoardWidgetHtml('k', 'timer', deps(board([widget, widget])))).toBeNull();
    expect(await readBoardWidgetHtml('k', 'timer', deps(jest.fn(async () => ({ ok: false }))))).toBeNull();
    expect(await readBoardWidgetHtml('k', 'timer', deps(board([{ ...widget, name: 'other' }])))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ['a wrong content type', () => htmlResponse('{}', { 'content-type': 'application/json' })],
    ['an error status', () => htmlResponse('<p>no</p>', { 'content-type': 'text/html' }, 403)],
    ['a declared oversize body', () => htmlResponse('<p>x</p>', { 'content-type': 'text/html', 'content-length': String(MAX_WIDGET_HTML_BYTES + 1) })],
    ['a streamed oversize body', () => htmlResponse('x'.repeat(MAX_WIDGET_HTML_BYTES + 1), { 'content-type': 'text/html' })],
  ])('rejects %s', async (_label, respond) => {
    const fetchMock = jest.fn(async () => respond());
    expect(await readBoardWidgetHtml('k', 'timer', { rpc: board([widget]), gatewayHttpBase: 'http://127.0.0.1:1', fetch: fetchMock as any })).toBeNull();
  });
});

describe('readLiveWidgetDocument', () => {
  const view = jest.fn(async (docId: string) => ({ ok: true, data: { html: `<p>${docId}</p>` } }));

  test('a pinned-only newest version comes from the board and is re-authorized after the fetch', async () => {
    const authorize = jest.fn(async () => {});
    const boardRead = jest.fn(async () => ({ html: '<p>board</p>', revision: 7, title: 'Timer' }));
    const history = jest.fn(async () => page([...pair('c1', inline('1', 'timer')), ...pair('c2', pinned('timer'))]));
    const result = await readLiveWidgetDocument('timer', { authorize, history, view, board: boardRead });
    expect(result).toMatchObject({ v: 1, html: '<p>board</p>', reference: { toolCallId: 'c2', mode: 'inline', boardName: 'timer', title: 'Timer' },
      live: { source: 'board', revision: 7 } });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize.mock.invocationCallOrder[1]).toBeGreaterThan(boardRead.mock.invocationCallOrder[0]);
  });

  test('nothing is returned when the actor is revoked after the board fetch', async () => {
    let calls = 0;
    const authorize = jest.fn(async () => { if (++calls > 1) throw new WidgetReadError(404, 'WIDGET_NOT_FOUND'); });
    const history = jest.fn(async () => page([...pair('c2', pinned('timer'))]));
    await expect(readLiveWidgetDocument('timer', { authorize, history, view, board: async () => ({ html: '<p>board</p>', revision: 1 }) }))
      .rejects.toMatchObject({ status: 404 });
  });

  test('an unreadable board falls back to the newest transcript document through the attested read', async () => {
    const history = jest.fn(async () => page([...pair('c1', inline('1', 'timer')), ...pair('c2', pinned('timer'))]));
    const result = await readLiveWidgetDocument('timer', { authorize: async () => {}, history, view, board: async () => null });
    expect(result).toMatchObject({ html: '<p>cv_1</p>', reference: { toolCallId: 'c1', boardName: 'timer' }, live: { source: 'transcript' } });
  });

  test('the newest inline version is read from the transcript, never the board', async () => {
    const boardRead = jest.fn();
    const history = jest.fn(async () => page([...pair('c1', inline('1', 'timer')), ...pair('c3', inline('3', 'timer'))]));
    const result = await readLiveWidgetDocument('timer', { authorize: async () => {}, history, view, board: boardRead });
    expect(result.html).toBe('<p>cv_3</p>');
    expect(boardRead).not.toHaveBeenCalled();
  });

  test('a foreign session is refused before any history or board read; unknown names are 404', async () => {
    const history = jest.fn();
    const boardRead = jest.fn();
    const denied = async () => { throw new WidgetReadError(404, 'WIDGET_NOT_FOUND'); };
    await expect(readLiveWidgetDocument('timer', { authorize: denied, history, view, board: boardRead })).rejects.toMatchObject({ status: 404 });
    expect(history).not.toHaveBeenCalled();
    expect(boardRead).not.toHaveBeenCalled();
    await expect(readLiveWidgetDocument('timer', { authorize: async () => {}, history: async () => page([]), view, board: boardRead }))
      .rejects.toMatchObject({ status: 404, code: 'WIDGET_NOT_FOUND' });
  });
});
