// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../../contexts/ChatStateProvider';
import { MAX_FLOATING_WIDGETS, sanitizeFloatingWidget, useAgentWorkspaceStore, useFloatingWidgetsStore } from '../../../stores/agentWorkspaceStore';
import { collectArtifacts, collectWidgets, latestBrowserActivity } from './artifacts';
import { decodeScreencastFrame, browserPoint, workspaceBrowserWsUrl } from './WorkspaceBrowserTab';
import { clampToViewport } from '../../workspace/FloatingWidgetLayer';
import { parseWorkspaceFocusRequest } from './WorkspaceFocusNavigation';
import { clearWorkspaceClientState } from '../../../utils/clearWorkspaceClientState';

const message = (id: string, content: string, toolCalls: any[] = []): ChatMessage =>
  ({ id, role: 'assistant', content, createdAt: new Date(0), toolCalls } as ChatMessage);
const widgetResult = (toolCallId: string, title: string, mode = 'inline') => JSON.stringify({
  schema: 'bridgesllm.widget-ref.v1', toolCallId, title, mode, ...(mode === 'inline' ? { presentationRef: `cv_${toolCallId}` } : {}),
});

describe('chat artifacts', () => {
  it('collects code, diagrams, markdown and file links newest first, skipping trivial snippets', () => {
    const artifacts = collectArtifacts([
      message('a', 'Run `ls`.\n```bash\nls\n```\n```python\nimport os\nprint(os.getcwd())\nprint(1)\n```'),
      message('b', '```mermaid\ngraph TD\nA[Quote] --> B[Book]\n```\nSee [the report](/api/files/f-123) and ```md\n# Notes\nbody\n```'),
    ]);
    expect(artifacts.map((item) => item.kind)).toEqual(['file', 'markdown', 'mermaid', 'code']);
    expect(artifacts[2].title).toBe('A[Quote] --> B[Book]');
    expect(artifacts[3].preview).toMatchObject({ kind: 'code', language: 'python' });
  });

  it('treats a long structured answer as a document and ignores user text', () => {
    const long = `## Rollout plan\n${'step '.repeat(300)}`;
    expect(collectArtifacts([message('c', long)])[0]).toMatchObject({ kind: 'markdown', title: 'Rollout plan', key: 'doc:c' });
    expect(collectArtifacts([{ ...message('u', '```python\na\nb\nc\n```'), role: 'user' } as ChatMessage])).toEqual([]);
  });

  it('lists each completed widget once, newest first, for every harness that reports the canonical reference', () => {
    const widgets = collectWidgets([
      message('m1', '', [{ id: 'c1', name: 'show_widget', status: 'done', startedAt: 0, result: widgetResult('c1', 'Build timer') }]),
      message('m2', '', [{ id: 'c2', name: 'show_widget', status: 'done', startedAt: 0, result: widgetResult('c2', 'Chart') },
        { id: 'c3', name: 'show_widget', status: 'running', startedAt: 0 },
        { id: 'c4', name: 'show_widget', status: 'done', startedAt: 0, result: widgetResult('c4', 'Saved', 'dashboard') },
        { id: 'c5', name: 'show_widget', status: 'done', startedAt: 0, result: widgetResult('other', 'Forged') }]),
    ]);
    expect(widgets).toEqual([
      { key: 'call:c4', toolCallId: 'c4', title: 'Saved', mode: 'dashboard', versions: 1 },
      { key: 'call:c2', toolCallId: 'c2', title: 'Chart', mode: 'inline', versions: 1 },
      { key: 'call:c1', toolCallId: 'c1', title: 'Build timer', mode: 'inline', versions: 1 },
    ]);
  });

  it('collapses a live widget to one row at its newest version, keeping the last version with a chat copy', () => {
    const live = (toolCallId: string, title: string, mode = 'inline') => JSON.stringify({
      schema: 'bridgesllm.widget-ref.v1', toolCallId, title, mode, boardName: 'build-timer' });
    const widgets = collectWidgets([
      message('m1', '', [{ id: 'v1', name: 'show_widget', status: 'done', startedAt: 0, result: live('v1', 'Timer 1') }]),
      message('m2', '', [{ id: 'chart', name: 'show_widget', status: 'done', startedAt: 0, result: widgetResult('chart', 'Chart') }]),
      message('m3', '', [{ id: 'v2', name: 'show_widget', status: 'done', startedAt: 0, result: live('v2', 'Timer 2') }]),
      message('m4', '', [{ id: 'v3', name: 'show_widget', status: 'done', startedAt: 0, result: live('v3', 'Widget', 'dashboard') }]),
    ]);
    expect(widgets).toEqual([
      { key: 'board:build-timer', toolCallId: 'v2', title: 'Widget', mode: 'inline', boardName: 'build-timer', versions: 3 },
      { key: 'call:chart', toolCallId: 'chart', title: 'Chart', mode: 'inline', versions: 1 },
    ]);
    // A live widget that so far exists only on the session board stays one pinned-only row.
    expect(collectWidgets([message('m5', '', [{ id: 'p1', name: 'show_widget', status: 'done', startedAt: 0, result: live('p1', 'Widget', 'dashboard') }])]))
      .toEqual([{ key: 'board:build-timer', toolCallId: 'p1', title: 'Widget', mode: 'dashboard', boardName: 'build-timer', versions: 1 }]);
  });

  it('finds the profile and tab of the latest native browser use, including namespaced names', () => {
    expect(latestBrowserActivity([
      message('x', '', [{ id: 'b1', name: 'browser', status: 'done', startedAt: 0, arguments: { action: 'open', profile: 'openclaw' }, result: '{"targetId":"T1","url":"https://example.com"}' }]),
      message('y', '', [{ id: 'b2', name: 'tools.openclaw__browser', status: 'running', startedAt: 0, arguments: { action: 'snapshot', profile: 'openclaw', targetId: 'T2' } }]),
    ])).toEqual({ toolCallId: 'b2', profile: 'openclaw', targetId: 'T2', running: true });
    expect(latestBrowserActivity([message('z', '', [{ id: 'q', name: 'browser', status: 'done', startedAt: 0, arguments: { profile: '../x', targetId: 'bad id' } }])]))
      .toEqual({ toolCallId: 'q', profile: undefined, targetId: undefined, running: false });
    expect(latestBrowserActivity([message('z', 'hello')])).toBeNull();
  });
});

describe('agent workspace store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAgentWorkspaceStore.setState({ userId: '', open: false, tab: 'artifacts', previews: [], closedDuringRun: false, closedTabs: [], dismissedTabsDuringRun: [], unreadTab: null });
    useAgentWorkspaceStore.getState().bindUser('user-a');
  });

  it('focuses an existing preview instead of duplicating it and caps open previews', () => {
    const store = useAgentWorkspaceStore.getState();
    store.openPreview({ kind: 'code', title: 'a', language: 'ts', code: 'let a = 1' });
    store.openPreview({ kind: 'code', title: 'a again', language: 'ts', code: 'let a = 1' });
    expect(useAgentWorkspaceStore.getState().previews).toHaveLength(1);
    // A live widget is one side-panel tab whichever version opened it.
    store.openPreview({ kind: 'widget', title: 'Timer', provider: 'OPENCLAW', session: 's', toolCallId: 'v1', boardName: 'build-timer' });
    store.openPreview({ kind: 'widget', title: 'Timer', provider: 'OPENCLAW', session: 's', toolCallId: 'v2', boardName: 'build-timer' });
    expect(useAgentWorkspaceStore.getState().previews.filter((preview) => preview.kind === 'widget')).toHaveLength(1);
    for (let index = 0; index < 8; index++) store.openPreview({ kind: 'markdown', title: `m${index}`, markdown: `# ${index}` });
    const state = useAgentWorkspaceStore.getState();
    expect(state.previews).toHaveLength(6);
    expect(state.open).toBe(true);
    expect(state.tab).toBe(`preview:${state.previews[5].id}`);
  });

  it('closes built-in tabs, keeps them closed across reloads, and reopens them explicitly', () => {
    const store = useAgentWorkspaceStore.getState();
    store.show('browser'); store.closeTab('browser');
    expect(useAgentWorkspaceStore.getState()).toMatchObject({ open: true, tab: 'widgets', closedTabs: ['browser'] });
    expect(JSON.parse(window.localStorage.getItem('portal.agentWorkspace.v1:user-a')!).closedTabs).toEqual(['browser']);
    store.show('browser', { automatic: true });
    expect(useAgentWorkspaceStore.getState().tab).toBe('widgets');
    // A reload restores the user's own closed tabs and active tab.
    useAgentWorkspaceStore.setState({ userId: '' });
    useAgentWorkspaceStore.getState().bindUser('user-a');
    expect(useAgentWorkspaceStore.getState()).toMatchObject({ open: true, tab: 'widgets', closedTabs: ['browser'] });
    store.show('browser');
    expect(useAgentWorkspaceStore.getState().closedTabs).toEqual([]);
    store.openPreview({ id: 'p1', kind: 'markdown', title: 'Notes', markdown: '# Keep me' });
    store.closeTab('browser'); store.closeTab('widgets'); store.closeTab('artifacts');
    expect(useAgentWorkspaceStore.getState()).toMatchObject({ open: true, tab: 'preview:p1' });
    store.closePreview('p1');
    expect(useAgentWorkspaceStore.getState().open).toBe(false);
    store.show('artifacts');
    expect(useAgentWorkspaceStore.getState()).toMatchObject({ open: true, tab: 'artifacts', closedTabs: ['browser', 'widgets'] });
  });

  it('keeps each user’s layout separate and drops previews on a user change', () => {
    const store = useAgentWorkspaceStore.getState();
    store.openPreview({ id: 'p1', kind: 'markdown', title: 'Private', markdown: '# A' });
    store.setWidth(700);
    useAgentWorkspaceStore.getState().bindUser('user-b');
    expect(useAgentWorkspaceStore.getState()).toMatchObject({ previews: [], open: false, width: 460 });
    useAgentWorkspaceStore.getState().bindUser('user-a');
    expect(useAgentWorkspaceStore.getState()).toMatchObject({ previews: [], width: 700 });
  });

  it('does not reopen automatically after the user closed it during a run', () => {
    const store = useAgentWorkspaceStore.getState();
    store.show('browser');
    store.hide();
    store.show('browser', { automatic: true });
    expect(useAgentWorkspaceStore.getState().open).toBe(false);
    store.runStarted();
    store.show('browser', { automatic: true });
    expect(useAgentWorkspaceStore.getState()).toMatchObject({ open: true, tab: 'browser' });
  });

  it('marks new agent activity instead of covering a compact screen; user opens are unchanged', () => {
    const compact = (matches: boolean) => Object.defineProperty(window, 'matchMedia', { configurable: true,
      value: vi.fn((query: string) => ({ matches: matches && query === '(max-width: 1023.98px)', media: query })) });
    try {
      compact(true);
      const store = useAgentWorkspaceStore.getState();
      store.show('browser', { automatic: true });
      expect(useAgentWorkspaceStore.getState()).toMatchObject({ open: false, unreadTab: 'browser' });
      // The user's own open goes to the tab with the activity and clears the mark.
      store.toggle();
      expect(useAgentWorkspaceStore.getState()).toMatchObject({ open: true, tab: 'browser', unreadTab: null });
      // Already showing that tab: nothing to mark.
      store.show('browser', { automatic: true });
      expect(useAgentWorkspaceStore.getState().unreadTab).toBeNull();
      // Explicit opens still open on a compact screen.
      store.hide(); store.runStarted();
      store.show('widgets');
      expect(useAgentWorkspaceStore.getState()).toMatchObject({ open: true, tab: 'widgets', unreadTab: null });
      // A user who closed the panel during the run gets no mark either.
      store.hide();
      store.show('browser', { automatic: true });
      expect(useAgentWorkspaceStore.getState()).toMatchObject({ open: false, unreadTab: null });
      // From lg up, automatic opens behave as before.
      compact(false); store.runStarted();
      store.show('browser', { automatic: true });
      expect(useAgentWorkspaceStore.getState()).toMatchObject({ open: true, tab: 'browser', unreadTab: null });
    } finally {
      delete (window as any).matchMedia;
    }
  });

  it('drops the activity mark when another user signs in', () => {
    useAgentWorkspaceStore.setState({ unreadTab: 'browser' });
    useAgentWorkspaceStore.getState().bindUser('user-b');
    expect(useAgentWorkspaceStore.getState().unreadTab).toBeNull();
  });
});

describe('floating widgets', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useFloatingWidgetsStore.setState({ userId: '', widgets: [], error: '' });
  });

  it('persists identities and geometry per user and restores them after a reload', () => {
    useFloatingWidgetsStore.getState().bindUser('user-a');
    const widget = useFloatingWidgetsStore.getState().popOut({ provider: 'codex', session: 'codex-1', toolCallId: 'call-1', title: 'Timer' })!;
    expect(widget).toMatchObject({ provider: 'CODEX', session: 'codex-1', toolCallId: 'call-1', minimized: false });
    useFloatingWidgetsStore.getState().patch(widget.id, { x: 40, y: 50, minimized: true });
    useFloatingWidgetsStore.setState({ userId: '', widgets: [] });
    useFloatingWidgetsStore.getState().bindUser('user-a');
    expect(useFloatingWidgetsStore.getState().widgets).toEqual([{ ...widget, x: 40, y: 50, minimized: true }]);
    useFloatingWidgetsStore.getState().bindUser('user-b');
    expect(useFloatingWidgetsStore.getState().widgets).toEqual([]);
  });

  it('reuses an existing window, rejects out-of-range geometry and caps the count', () => {
    useFloatingWidgetsStore.getState().bindUser('user-a');
    const first = useFloatingWidgetsStore.getState().popOut({ provider: 'OPENCLAW', session: 'agent:main:portal-a', toolCallId: 'c0', title: 'T' })!;
    expect(useFloatingWidgetsStore.getState().popOut({ provider: 'OPENCLAW', session: 'agent:main:portal-a', toolCallId: 'c0', title: 'T' })!.id).toBe(first.id);
    useFloatingWidgetsStore.getState().patch(first.id, { width: 99_999 });
    expect(useFloatingWidgetsStore.getState().widgets[0].width).toBe(first.width);
    for (let index = 1; index < MAX_FLOATING_WIDGETS + 2; index++) {
      useFloatingWidgetsStore.getState().popOut({ provider: 'OPENCLAW', session: 'agent:main:portal-a', toolCallId: `c${index}`, title: 'T' });
    }
    expect(useFloatingWidgetsStore.getState().widgets).toHaveLength(MAX_FLOATING_WIDGETS);
    expect(useFloatingWidgetsStore.getState().error).toContain('limit');
  });

  it('ignores tampered stored entries and is scrubbed at sign-out', () => {
    window.localStorage.setItem('portal.floatingWidgets.v1:user-a', JSON.stringify([
      { id: 'ok', provider: 'OPENCLAW', session: 'agent:main:portal-a', toolCallId: 'c1', title: 'T', x: 1, y: 1, width: 300, height: 200, minimized: false, z: 1 },
      { id: 'bad', provider: 'OPENCLAW', session: 'a\nb', toolCallId: 'c2', title: 'T', x: 1, y: 1, width: 300, height: 200, minimized: false, z: 1 },
      { id: 'big', provider: 'OPENCLAW', session: 's', toolCallId: 'c3', title: 'T', x: 1, y: 1, width: 300, height: 200, minimized: false, z: 1, html: '<script>' },
    ]));
    useFloatingWidgetsStore.getState().bindUser('user-a');
    expect(useFloatingWidgetsStore.getState().widgets.map((item) => item.id)).toEqual(['ok', 'big']);
    expect(Object.keys(useFloatingWidgetsStore.getState().widgets[1])).not.toContain('html');
    expect(sanitizeFloatingWidget({ id: 'x', provider: 'openclaw', session: 's', toolCallId: 'c', title: 'T', x: 0, y: 0, width: 300, height: 200, minimized: false, z: 0 })).toBeNull();
    window.localStorage.setItem('portal.agentWorkspace.v1:user-a', '{}');
    clearWorkspaceClientState();
    expect(window.localStorage.getItem('portal.floatingWidgets.v1:user-a')).toBeNull();
    expect(window.localStorage.getItem('portal.agentWorkspace.v1:user-a')).toBeNull();
  });

  it('accepts only the exact in-app focus request shape', () => {
    const request = { provider: 'OPENCLAW', session: 'agent:main:portal-a', toolCallId: 'call-1' };
    expect(parseWorkspaceFocusRequest({ agentWorkspaceFocus: request })).toEqual(request);
    expect(parseWorkspaceFocusRequest({ agentWorkspaceFocus: { ...request, session: 'not-an-agent-key' } })).toBeNull();
    expect(parseWorkspaceFocusRequest({ agentWorkspaceFocus: { ...request, provider: 'codex' } })).toBeNull();
    expect(parseWorkspaceFocusRequest({ agentWorkspaceFocus: { provider: 'CODEX', session: 'codex-1', toolCallId: 'a\u0000b' } })).toBeNull();
    expect(parseWorkspaceFocusRequest(null)).toBeNull();
  });
});

describe('browser stream and floating geometry', () => {
  it('decodes a native screencast frame with its CSS dimensions', () => {
    const header = new TextEncoder().encode(JSON.stringify({ url: 'https://example.com', cssWidth: 1280, cssHeight: 720 }));
    const buffer = new ArrayBuffer(4 + header.length + 3);
    new DataView(buffer).setUint32(0, header.length);
    new Uint8Array(buffer, 4).set(header);
    new Uint8Array(buffer, 4 + header.length).set([0xff, 0xd8, 0xff]);
    const frame = decodeScreencastFrame(buffer);
    expect(frame?.header).toEqual({ url: 'https://example.com', cssWidth: 1280, cssHeight: 720 });
    expect(frame?.jpeg.size).toBe(3);
    expect(decodeScreencastFrame(new ArrayBuffer(6))).toBeNull();
  });

  it('maps clicks to zoom-independent ratios only inside the picture', () => {
    expect(browserPoint({ left: 10, top: 20, width: 200, height: 100 }, 110, 45)).toEqual({ x: 0.5, y: 0.25 });
    expect(browserPoint({ left: 10, top: 20, width: 200, height: 100 }, 5, 45)).toBeNull();
  });

  it('keeps a grabbable bar on screen', () => {
    expect(clampToViewport({ x: 5000, y: -40, width: 360 }, { width: 1280, height: 800 })).toEqual({ x: 1200, y: 0 });
    expect(clampToViewport({ x: -1000, y: 2000, width: 360 }, { width: 1280, height: 800 })).toEqual({ x: -280, y: 764 });
  });
});


describe('workspace browser transport', () => {
  it.each([
    ['', `${window.location.origin.replace(/^http/, 'ws')}/api`],
    ['/custom-api/', `${window.location.origin.replace(/^http/, 'ws')}/custom-api`],
    ['https://portal.example.test/api/', 'wss://portal.example.test/api'],
    ['http://127.0.0.1:4001/api', 'ws://127.0.0.1:4001/api'],
  ])('uses the configured API origin and path (%s)', (apiBase, expected) => {
    vi.stubEnv('VITE_API_URL', apiBase);
    try {
      const url = new URL(workspaceBrowserWsUrl('agent:main:one', 'tab-1', 'managed'));
      expect(`${url.origin}${url.pathname}`).toBe(`${expected}/agent-workspace/browser/stream`);
      expect(Object.fromEntries(url.searchParams)).toEqual({ session: 'agent:main:one', target: 'tab-1', profile: 'managed' });
    } finally { vi.unstubAllEnvs(); }
  });
});
