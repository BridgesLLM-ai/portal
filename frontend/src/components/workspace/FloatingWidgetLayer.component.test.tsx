// @vitest-environment jsdom
import '../../test/setup';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api/client', () => ({ default: mocks }));
import FloatingWidgetLayer from './FloatingWidgetLayer';
import { useFloatingWidgetsStore } from '../../stores/agentWorkspaceStore';
import { useAuthStore } from '../../contexts/AuthContext';

const stored = { id: 'w1', provider: 'CODEX', session: 'codex-abc', toolCallId: 'call-1', title: 'Build timer',
  x: 100, y: 120, width: 360, height: 280, minimized: false, z: 1 };

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}|{JSON.stringify(location.state)}</output>;
}

describe('FloatingWidgetLayer', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('portal.floatingWidgets.v1:owner-1', JSON.stringify([stored]));
    useFloatingWidgetsStore.setState({ userId: '', widgets: [], error: '' });
    act(() => { useAuthStore.setState({ user: { id: 'owner-1', role: 'OWNER' } as any }); });
    mocks.get.mockReset().mockResolvedValue({ data: { v: 1, html: '<p>ready</p>',
      reference: { schema: 'bridgesllm.widget-ref.v1', toolCallId: 'call-1', title: 'Build timer', mode: 'inline', presentationRef: 'cv_1' } } });
  });

  it('restores saved windows through the owner-checked document route with back, minimize and close controls', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/files']}><Routes><Route path="*" element={<><FloatingWidgetLayer /><Where /></>} /></Routes></MemoryRouter>);
    const dialog = await screen.findByRole('dialog', { name: 'Floating widget: Build timer' });
    expect(dialog.style.left).toBe('100px');
    // Native harness widgets come from the chat bridge store of that exact session.
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/chat-widgets/native/sessions/codex-abc/tools/call-1/document', expect.anything()));
    await waitFor(() => expect(dialog.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts'));
    expect(dialog.querySelector('iframe')?.getAttribute('src')).toMatch(/^\/api\/chat-widgets\/sandbox#widget-/);

    await user.click(screen.getByRole('button', { name: 'Minimize widget' }));
    expect(dialog.style.height).toBe('36px');
    expect(screen.getByRole('button', { name: 'Restore widget' })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('portal.floatingWidgets.v1:owner-1')!)[0].minimized).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Back to the chat that made this widget' }));
    expect(screen.getByTestId('where').textContent).toBe('/agent-chats|{"agentWorkspaceFocus":{"provider":"CODEX","session":"codex-abc","toolCallId":"call-1"}}');

    await user.click(screen.getByRole('button', { name: 'Close floating widget' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('portal.floatingWidgets.v1:owner-1')!)).toEqual([]);
  });

  it('refuses a document whose reference is not this inline widget', async () => {
    mocks.get.mockResolvedValue({ data: { v: 1, html: '<p>x</p>', reference: { schema: 'bridgesllm.widget-ref.v1', toolCallId: 'other', title: 'X', mode: 'inline' } } });
    render(<MemoryRouter><FloatingWidgetLayer /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Widget unavailable');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('shows nothing to a different signed-in user', async () => {
    act(() => { useAuthStore.setState({ user: { id: 'owner-2', role: 'OWNER' } as any }); });
    render(<MemoryRouter><FloatingWidgetLayer /></MemoryRouter>);
    await waitFor(() => expect(useFloatingWidgetsStore.getState().userId).toBe('owner-2'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
