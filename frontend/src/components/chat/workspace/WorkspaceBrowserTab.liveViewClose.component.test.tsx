// @vitest-environment jsdom
import '../../../test/setup';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../api/client', () => ({ default: { get: mocks.get } }));

import WorkspaceBrowserTab, { LIVE_VIEW_CLOSE, liveViewEndedMessage } from './WorkspaceBrowserTab';

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send() {}
  close() {}
}

describe('live view stop messages', () => {
  it.each([
    [LIVE_VIEW_CLOSE.tabClosed, 'That tab was closed.'],
    [LIVE_VIEW_CLOSE.blocked, 'This page is blocked by the browser policy.'],
    [LIVE_VIEW_CLOSE.tooManyInputs, 'The live view stopped because it got too many inputs at once. Select Reconnect, then click or type a little more slowly.'],
    [LIVE_VIEW_CLOSE.invalidInput, 'The live view stopped because it got an input it couldn\'t use. Select Reconnect to continue.'],
    [LIVE_VIEW_CLOSE.unavailable, 'The agent\'s browser tab closed or is unavailable. Pick a tab or select Reconnect; if it keeps stopping, ask the agent to open the page again.'],
    [LIVE_VIEW_CLOSE.sessionEnded, 'The browser session behind this live view ended. Select Reconnect to start a new one.'],
    [1006, 'The connection to the live view was lost. Select Reconnect when the Portal is reachable again.'],
    [1000, 'The live view stopped. Select Reconnect to try again.'],
    [1011, 'The live view stopped. Select Reconnect to try again.'],
  ])('close code %i says what happened and what to do', (code, text) => {
    expect(liveViewEndedMessage(code)).toBe(text);
  });

  it('uses the relay\'s own codes and keeps the native 4003/4004', () => {
    expect(LIVE_VIEW_CLOSE).toEqual({ blocked: 4003, tabClosed: 4004, invalidInput: 4400, sessionEnded: 4410, tooManyInputs: 4429, unavailable: 4503 });
  });
});

describe('WorkspaceBrowserTab when the live view stops', () => {
  const originalWebSocket = globalThis.WebSocket;
  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    mocks.get.mockReset().mockResolvedValue({ data: { running: true, tabs: [{ targetId: 'tab-1', title: 'Example', url: 'https://example.com/' }] } });
  });
  afterEach(() => { (globalThis as any).WebSocket = originalWebSocket; });

  async function stopWith(code: number) {
    render(<WorkspaceBrowserTab session="agent:main:main" activity={null} visible />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const listsBefore = mocks.get.mock.calls.length;
    act(() => { FakeWebSocket.instances[0].onclose?.({ code }); });
    return listsBefore;
  }

  it('too many inputs: says so, offers Reconnect, and keeps the tab list', async () => {
    const listsBefore = await stopWith(LIVE_VIEW_CLOSE.tooManyInputs);

    expect(screen.getByRole('status')).toHaveTextContent(/too many inputs at once/);
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(mocks.get.mock.calls.length).toBe(listsBefore);
  });

  it('an unavailable tab refreshes the tab list, as a closed tab does', async () => {
    const listsBefore = await stopWith(LIVE_VIEW_CLOSE.unavailable);

    expect(screen.getByRole('status')).toHaveTextContent(/browser tab closed or is unavailable/);
    await waitFor(() => expect(mocks.get.mock.calls.length).toBe(listsBefore + 1));
  });

  it('a closed tab keeps its message and refresh', async () => {
    const listsBefore = await stopWith(LIVE_VIEW_CLOSE.tabClosed);

    expect(screen.getByRole('status')).toHaveTextContent('That tab was closed.');
    await waitFor(() => expect(mocks.get.mock.calls.length).toBe(listsBefore + 1));
  });
});
