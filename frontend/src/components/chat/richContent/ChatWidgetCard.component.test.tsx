// @vitest-environment jsdom
import { WidgetPresentationProvider } from './WidgetPresentationContext';
import { widgetPresentationFor } from './widgetPresentation';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextEncoder } from 'node:util';
import { ScopedChatWidgetCard } from './ChatWidgetCard';
import { WIDGET_CHANNEL } from './widgetModel';
import { WORKSPACE_AUTHORIZATION_CHANGED_EVENT } from '../../../utils/workspaceAuthorization';
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../api/client', () => ({ default: { get } }));
vi.mock('../../../contexts/ChatStateProvider', () => ({ useChatState: () => ({ session: 'agent:main:portal-a', provider: 'OPENCLAW' }) }));
const reference = { schema: 'bridgesllm.widget-ref.v1', toolCallId: 'call-owned', title: 'Counter', mode: 'inline' };
const tool = { id: 'call-owned', name: 'show_widget', startedAt: 1, status: 'done' as const, result: JSON.stringify(reference) };
const response = { data: { v: 1, reference, html: '<button id="counter" onclick="this.textContent=2">1</button>' } };
function shellMessage(frame: HTMLIFrameElement, type: string, extra = {}, overrides = {}) {
  const instance = frame.src.split('#')[1];
  fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: 'null',
    data: { channel: WIDGET_CHANNEL, instance, type, ...extra }, ...overrides }));
}
async function iframe() { await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull()); return document.querySelector('iframe')!; }
beforeEach(() => { get.mockReset(); get.mockResolvedValue(response); Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('Portal native widget card (component evidence only)', () => {
  it('loads real projected content via owned API, hands bytes to isolated shell, and re-reads on history remount', async () => {
    const view = render(<ScopedChatWidgetCard tool={tool} session="agent:main:portal-a" enabled />);
    expect(screen.getByRole('status').textContent).toContain('Loading');
    const frame = await iframe(); const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts'); expect(frame.getAttribute('srcdoc')).toBeNull();
    expect(document.body.innerHTML).not.toContain('onclick');
    expect(get.mock.calls[0][0]).toContain('/sessions/agent%3Amain%3Aportal-a/tools/call-owned/document');
    shellMessage(frame, 'ready'); expect(post.mock.calls[0][0]).toMatchObject({ type: 'document', html: response.data.html });
    shellMessage(frame, 'rendered'); expect(screen.queryByRole('status')).toBeNull();
    expect(post.mock.calls[1][0]).toMatchObject({ type: 'theme' });
    view.unmount(); render(<ScopedChatWidgetCard tool={tool} session="agent:main:portal-a" enabled />);
    await iframe(); expect(get).toHaveBeenCalledTimes(2);
  });
  it('ignores malicious bridge messages, clamps sizing, expands accessibly and collapses with Escape', async () => {
    render(<ScopedChatWidgetCard tool={tool} session="agent:main:portal-a" enabled />);
    const frame = await iframe(); const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    shellMessage(frame, 'ready', {}, { origin: 'https://attacker.example' });
    shellMessage(frame, 'ready', {}, { source: window }); expect(post).not.toHaveBeenCalled();
    shellMessage(frame, 'ready'); shellMessage(frame, 'rendered');
    shellMessage(frame, 'size', { height: 999999 }); expect(frame.style.height).toBe('720px');
    const calls = get.mock.calls.length;
    shellMessage(frame, 'chat.send', { prompt: 'hidden run' }); shellMessage(frame, 'openclaw:widget-bridge-request', { method: 'tools.invoke' });
    expect(get.mock.calls.length).toBe(calls);
    fireEvent.click(screen.getByRole('button', { name: 'Expand widget' })); expect(screen.getByRole('dialog')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand widget' })).toBe(document.activeElement);
  });
  it('shows retryable errors and retries with a fresh instance/channel', async () => {
    get.mockRejectedValueOnce(new Error('expired'));
    render(<ScopedChatWidgetCard tool={tool} session="agent:main:portal-a" enabled />);
    await screen.findByRole('alert'); expect(document.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); const frame = await iframe();
    shellMessage(frame, 'ready'); shellMessage(frame, 'rendered'); expect(screen.queryByRole('alert')).toBeNull(); expect(get).toHaveBeenCalledTimes(2);
  });
  it('honors late matched height without re-fetching or replacing the counter iframe', async () => {
    const bound = { ...tool, result: JSON.stringify({ ...reference, presentationRef: 'cv_owned' }) };
    const history = [{ role: 'assistant' as const, content: '', toolCalls: [bound] }];
    const draw = (content: string) => <WidgetPresentationProvider value={widgetPresentationFor([...history,
      { role: 'assistant', content }])}><ScopedChatWidgetCard tool={bound} session="agent:main:portal-a" enabled /></WidgetPresentationProvider>;
    const view = render(draw('')); const frame = await iframe();
    shellMessage(frame, 'ready'); shellMessage(frame, 'rendered'); expect(frame.style.height).toBe('320px');
    view.rerender(draw('[embed ref="cv_owned" title="Counter" height="160" /]'));
    expect(document.querySelector('iframe')).toBe(frame); expect(frame.style.height).toBe('160px');
    shellMessage(frame, 'size', { height: 600 }); expect(frame.style.height).toBe('160px'); expect(get).toHaveBeenCalledTimes(1);
  });
  it('dashboard-only and unknown/raw outputs visibly degrade without document fetch or fabricated interaction', () => {
    const view = render(<ScopedChatWidgetCard tool={{ ...tool, result: JSON.stringify({ ...reference, mode: 'dashboard' }) }} session="agent:main:portal-a" enabled />);
    expect(screen.getByText(/no inline preview/)).not.toBeNull(); expect(get).not.toHaveBeenCalled();
    view.rerender(<ScopedChatWidgetCard tool={{ ...tool, result: '<script>raw()</script>' }} session="agent:main:portal-a" enabled />);
    expect(screen.getByText(/has not been rendered/)).not.toBeNull(); expect(document.querySelector('iframe')).toBeNull();
  });
  it('revocation retires already rendered content and cannot be undone by an old in-flight read', async () => {
    let resolve!: (value: any) => void;
    get.mockImplementation(() => new Promise(done => { resolve = done; }));
    render(<ScopedChatWidgetCard tool={tool} session="agent:main:portal-a" enabled />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    fireEvent(window, new Event(WORKSPACE_AUTHORIZATION_CHANGED_EVENT));
    await act(async () => resolve(response));
    expect(document.querySelector('iframe')).toBeNull(); expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
  it('session navigation hides old content before the next read settles and aborts old scope', async () => {
    const view = render(<ScopedChatWidgetCard tool={tool} session="agent:main:portal-a" enabled />); const old = await iframe();
    shellMessage(old, 'ready'); shellMessage(old, 'rendered');
    get.mockImplementation(() => new Promise(() => {}));
    view.rerender(<ScopedChatWidgetCard tool={tool} session="agent:main:portal-b" enabled />);
    expect(document.querySelector('iframe')).toBeNull(); expect(get.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
