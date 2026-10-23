// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextEncoder } from 'node:util';
import { ChatWidgetCard, ScopedChatWidgetCard } from './ChatWidgetCard';
import { WIDGET_CHANNEL } from './widgetModel';

const { get, chat } = vi.hoisted(() => ({
  get: vi.fn(),
  chat: { session: 'claude_code-u1-1760000000000-a1b2', provider: 'CLAUDE_CODE' },
}));
vi.mock('../../../api/client', () => ({ default: { get } }));
vi.mock('../../../contexts/ChatStateProvider', () => ({ useChatState: () => chat }));
vi.mock('../../../contexts/AuthContext', () => ({
  useAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: 'u1', authorizationVersion: 1 } }),
}));

// A bridge show_widget result bound to the harness's own tool-call id.
const reference = { schema: 'bridgesllm.widget-ref.v1', toolCallId: 'toolu_01Widget', title: 'Sales chart', mode: 'inline' };
const tool = { id: 'toolu_01Widget', name: 'show_widget', startedAt: 1, status: 'done' as const, result: JSON.stringify(reference) };
const response = { data: { v: 1, reference, html: '<canvas id="chart"></canvas>' } };

async function iframe() {
  await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
  return document.querySelector('iframe')!;
}

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue(response);
  chat.session = 'claude_code-u1-1760000000000-a1b2';
  chat.provider = 'CLAUDE_CODE';
  Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('native harness widgets', () => {
  it('renders a native harness widget from the Portal Chat Bridge document route', async () => {
    render(<ChatWidgetCard tool={tool} />);
    const frame = await iframe();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe('/chat-widgets/native/sessions/claude_code-u1-1760000000000-a1b2/tools/toolu_01Widget/document');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const instance = frame.src.split('#')[1];
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: 'null', data: { channel: WIDGET_CHANNEL, instance, type: 'ready' } }));
    expect(post.mock.calls[0][0]).toMatchObject({ type: 'document', html: response.data.html });
    expect(screen.queryByText(/not admitted/)).toBeNull();
  });

  it('fetches nothing while the native chat has no saved session and says why', () => {
    chat.session = 'new-1760000000000';
    render(<ChatWidgetCard tool={tool} />);
    expect(screen.getByText(/not saved yet/)).not.toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('keeps OpenClaw widgets on the OpenClaw route', async () => {
    render(<ScopedChatWidgetCard tool={tool} session="agent:main:portal-a" provider="OPENCLAW" enabled />);
    await iframe();
    expect(get.mock.calls[0][0]).toBe('/chat-widgets/sessions/agent%3Amain%3Aportal-a/tools/toolu_01Widget/document');
  });
});
