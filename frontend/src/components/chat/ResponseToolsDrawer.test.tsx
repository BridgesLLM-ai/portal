// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ResponseToolsDrawer from './ResponseToolsDrawer';
const mocks = vi.hoisted(() => ({ get: vi.fn(), choose: vi.fn(), state: { provider: 'OPENCLAW', session: 'owned', agentId: 'main', selectedModel: 'test/model', isRunning: false, responseFormat: 'auto' } }));
vi.mock('../../api/client', () => ({ default: { get: mocks.get } }));
vi.mock('../../contexts/ChatStateProvider', () => ({ useChatState: () => ({ ...mocks.state, setResponseFormat: mocks.choose }) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuthStore: (select: any) => select({ user: { id: 'actor-a', role: 'OWNER' } }) }));
const catalog = (provider = 'OPENCLAW', available = true) => ({ schema: 'portal-response-tools-v1', provider, formats: [
  { id: 'auto', label: 'Automatic', available: true, description: 'Choose automatically' },
  { id: 'mermaid', label: 'Diagram', available: true, description: 'A diagram' },
  { id: 'widget', label: 'Interactive widget', available, description: 'Interactive result', reason: available ? null : 'Widget transport is unavailable' },
] });
const mount = () => render(<MemoryRouter><ResponseToolsDrawer onAttach={mocks.choose} /></MemoryRouter>);
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Response tools and attachments' }));
beforeEach(() => { mocks.get.mockReset(); mocks.choose.mockReset(); Object.assign(mocks.state, { provider: 'OPENCLAW', session: 'owned', isRunning: false, responseFormat: 'auto' }); mocks.get.mockResolvedValue({ data: catalog() }); });
afterEach(cleanup);
describe('response tools drawer', () => {
  it('selects a real server-advertised format and returns focus to the composer control', async () => {
    mount(); open();
    fireEvent.click(await screen.findByRole('button', { name: /Diagram/ }));
    expect(mocks.choose).toHaveBeenCalledWith('mermaid');
    expect(screen.queryByRole('region', { name: 'Response tools' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Response tools and attachments' }));
    expect(mocks.get).toHaveBeenCalledWith('/gateway/response-capabilities', expect.objectContaining({ params: { provider: 'OPENCLAW', session: 'owned', agentId: 'main' } }));
  });
  it('shows why an unavailable widget cannot be selected', async () => {
    mocks.get.mockResolvedValue({ data: catalog('OPENCLAW', false) }); mount(); open();
    const widget = await screen.findByRole('button', { name: /Interactive widget/ });
    expect((widget as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(widget); expect(mocks.choose).not.toHaveBeenCalled();
    expect(screen.getByText('Widget transport is unavailable')).toBeTruthy();
  });
  it('does not change the capability of an active turn', async () => {
    mocks.state.isRunning = true; mount(); open();
    const diagram = await screen.findByRole('button', { name: /Diagram/ });
    expect((diagram as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Wait for this response to finish/)).toBeTruthy();
  });
  it('invalidates delayed responses when the selected chat changes', async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = mount(); open(); mocks.state.provider = 'CODEX';
    view.rerender(<MemoryRouter><ResponseToolsDrawer onAttach={mocks.choose} /></MemoryRouter>);
    resolve({ data: catalog('OPENCLAW') });
    await waitFor(() => expect(screen.queryByText('Interactive widget')).toBeNull());
    mocks.get.mockResolvedValue({ data: catalog('CODEX', false) }); open();
    expect((await screen.findByRole('button', { name: /Interactive widget/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('retains file input and skills navigation separately from response formats', () => {
    mount(); open();
    expect(screen.getByRole('link', { name: 'Skills & guides' }).getAttribute('href')).toBe('/agent-tools?tab=skills');
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' })); expect(mocks.choose).toHaveBeenCalledTimes(1);
  });
  it('fails visibly and retries a catalog error', async () => {
    mocks.get.mockRejectedValueOnce(new Error('offline')); mount(); open();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /Diagram/ })).toBeTruthy();
  });
});
