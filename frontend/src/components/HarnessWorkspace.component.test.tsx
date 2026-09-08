// @vitest-environment jsdom
import '../test/setup';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../contexts/AuthContext';
import { __resetAgentChatProviderCatalogForTests } from '../utils/agentChatProviderCatalog';
import HarnessWorkspace from './HarnessWorkspace';
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../api/client', () => ({ default: { get: mocks.get } }));
const entries = [
  { name: 'OPENCLAW', displayName: 'OpenClaw', installed: true, implemented: true, usable: true, capabilities: { supportsSessionList: true } },
  { name: 'CODEX', displayName: 'Codex', installed: true, implemented: true, usable: true, capabilities: { supportsSessionList: true, supportsExecApproval: true } },
  { name: 'HERMES', displayName: 'Hermes', installed: false, implemented: true, usable: false, capabilities: { supportsSessionList: false } },
];
function renderWorkspace(entry = '/agent-tools?tab=workspace') {
  return render(<MemoryRouter initialEntries={[entry]}><Routes>
    <Route path="/agent-tools" element={<HarnessWorkspace />} />
    <Route path="/agent-chats" element={<div>Agent Chat opened</div>} />
  </Routes></MemoryRouter>);
}
beforeEach(() => {
  useAuthStore.setState({ isAuthenticated: true, user: { id: 'operator', role: 'OWNER' } as any });
  mocks.get.mockImplementation(async (url: string) => {
    if (url === '/gateway/harnesses') return { data: { providers: entries } };
    if (url === '/users/me/agent-harness-preference') return { data: { defaultHarness: 'CODEX', revision: 3 } };
    throw new Error(`Unexpected GET ${url}`);
  });
});
afterEach(() => {
  __resetAgentChatProviderCatalogForTests(); mocks.get.mockReset(); localStorage.clear();
  useAuthStore.setState({ user: null, isAuthenticated: false });
});
describe('HarnessWorkspace', () => {
  it('opens the saved harness, exposes only real capabilities and links to actual native workspace routes', async () => {
    renderWorkspace();
    const workspace = await screen.findByRole('region', { name: 'Codex workspace' });
    expect(screen.getByRole('combobox', { name: 'Harness workspace' })).toHaveValue('CODEX');
    expect(within(workspace).getByRole('status')).toHaveTextContent('Ready in Portal');
    expect(within(workspace).getByLabelText('Approval controls supported')).toBeVisible();
    expect(within(workspace).queryByLabelText('Branch a conversation supported')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /sub-agent/ })).not.toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalledWith('/gateway/agents');
    expect(localStorage.getItem('agent-chat-provider')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Remote Desktop' })).toHaveAttribute('href', '/desktop');
    expect(screen.getByRole('link', { name: 'Open Terminal' })).toHaveAttribute('href', '/terminal');
  });
  it('explores another harness without rewriting the default, then explicitly opens its chat', async () => {
    const user = userEvent.setup(); renderWorkspace();
    await screen.findByRole('region', { name: 'Codex workspace' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Harness workspace' }), 'OPENCLAW');
    expect(within(screen.getByRole('region', { name: 'OpenClaw workspace' })).queryByText('Your default')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sub-agent/ })).toHaveAttribute('href', '/agent-tools?tab=tasks');
    expect(localStorage.getItem('agent-chat-provider')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Open Agent Chat/ }));
    expect(screen.getByText('Agent Chat opened')).toBeVisible();
    expect(localStorage.getItem('agent-chat-provider')).toBe('OPENCLAW');
    expect(localStorage.getItem('agent-chat-default-harness:operator')).toBeNull();
  });
  it('keeps an explicit unavailable harness and blocks launch without substituting another runtime', async () => {
    renderWorkspace('/agent-tools?tab=workspace&harness=HERMES');
    const workspace = await screen.findByRole('region', { name: 'Hermes workspace' });
    expect(within(workspace).getByRole('status')).toHaveTextContent('Not installed');
    expect(screen.getByRole('button', { name: /Open Agent Chat/ })).toBeDisabled();
    expect(screen.queryByRole('region', { name: 'OpenClaw workspace' })).not.toBeInTheDocument();
  });
});
