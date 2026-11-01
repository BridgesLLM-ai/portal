// @vitest-environment jsdom
import '../../../test/setup';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../api/client', () => ({ default: mocks }));
import { WidgetPreview } from './WorkspacePreviewView';

const SESSION = 'agent:main:portal-x';
const LIVE = '/chat-widgets/sessions/agent%3Amain%3Aportal-x/boards/build-timer/document';
const CALL = '/chat-widgets/sessions/agent%3Amain%3Aportal-x/tools/v1/document';
const reference = (toolCallId: string, extra: Record<string, unknown> = {}) =>
  ({ schema: 'bridgesllm.widget-ref.v1', toolCallId, title: 'Timer', mode: 'inline', ...extra });
const preview = (boardName?: string) =>
  render(<WidgetPreview provider="OPENCLAW" session={SESSION} toolCallId="v1" title="Timer" boardName={boardName} />);
const shown = (container: HTMLElement) => waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

describe('live widget preview', () => {
  beforeEach(() => { mocks.get.mockReset(); });

  it('shows the newest version, read by board name through the owner-checked route', async () => {
    mocks.get.mockResolvedValue({ data: { v: 1, html: '<p>newest</p>', reference: reference('v3', { boardName: 'build-timer' }) } });
    const view = preview('build-timer');
    await shown(view.container);
    expect(mocks.get.mock.calls.map((call) => call[0])).toEqual([LIVE]);
  });

  it.each([
    ['a refused live read', () => Promise.reject(Object.assign(new Error('409'), { response: { status: 409 } }))],
    ['another widget’s document', async () => ({ data: { v: 1, html: '<p>x</p>', reference: reference('v3', { boardName: 'other' }) } })],
    ['a reference without the board name', async () => ({ data: { v: 1, html: '<p>x</p>', reference: reference('v3') } })],
  ])('falls back to the version this chat saw after %s', async (_label, live) => {
    mocks.get.mockImplementation((path: string) => path === LIVE ? live()
      : Promise.resolve({ data: { v: 1, html: '<p>seen</p>', reference: reference('v1') } }));
    const view = preview('build-timer');
    await shown(view.container);
    expect(mocks.get.mock.calls.map((call) => call[0])).toEqual([LIVE, CALL]);
  });

  it('reads only the fixed tool call when the widget is not live', async () => {
    mocks.get.mockResolvedValue({ data: { v: 1, html: '<p>seen</p>', reference: reference('v1') } });
    const view = preview();
    await shown(view.container);
    expect(mocks.get.mock.calls.map((call) => call[0])).toEqual([CALL]);
  });
});
