// @vitest-environment jsdom
import '../../test/setup';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TaskConversationNavigation from './TaskConversationNavigation';
const mocks = vi.hoisted(() => ({ preference: vi.fn(), select: vi.fn(), session: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({ useAuthStore: (selector: any) => selector({ user: { id: 'owner' } }) }));
vi.mock('../../contexts/ChatStateProvider', () => ({ useChatState: () => ({ provider: 'CODEX', selectProviderAgent: mocks.select, selectSession: mocks.session }) }));
vi.mock('../../api/agentHarnessPreference', () => ({ loadAndApplyDefaultAgentHarness: mocks.preference }));
function Fixture() { const navigate = useNavigate(); return <><button onClick={() => navigate('/agent-chats')}>Leave target</button><TaskConversationNavigation /></>; }
function setup(key: string) { return render(<MemoryRouter initialEntries={[`/agent-chats?openclawSession=${encodeURIComponent(key)}`]}><Fixture /></MemoryRouter>); }
beforeEach(() => { mocks.preference.mockReset().mockResolvedValue({ defaultHarness: 'CODEX' }); mocks.select.mockReset(); mocks.session.mockReset().mockResolvedValue(undefined); });
describe('Open a task conversation', () => {
  it('requires an explicit choice and loads the exact agent/session without changing the saved default', async () => {
    const key = 'agent:worker:subagent:child-42'; setup(key);
    expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Open conversation' }));
    await waitFor(() => expect(mocks.session).toHaveBeenCalledWith(key));
    expect(mocks.select).toHaveBeenCalledWith('OPENCLAW', 'worker');
    expect(mocks.select.mock.invocationCallOrder[0]).toBeLessThan(mocks.session.mock.invocationCallOrder[0]);
    expect(screen.queryByRole('region', { name: 'Task conversation' })).not.toBeInTheDocument();
  });
  it('discards slow preference hydration after the user leaves the target', async () => {
    let resolve!: (value: unknown) => void; mocks.preference.mockReturnValue(new Promise(done => { resolve = done; }));
    setup('agent:worker:subagent:child');
    await userEvent.click(screen.getByRole('button', { name: 'Open conversation' }));
    await userEvent.click(screen.getByRole('button', { name: 'Leave target' }));
    await act(async () => resolve({ defaultHarness: 'CODEX' }));
    expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled();
  });
  it('does not treat an opaque task id or external URL as a conversation', () => {
    setup('https://example.invalid/task');
    expect(screen.queryByRole('button', { name: 'Open conversation' })).not.toBeInTheDocument();
    expect(screen.getByText('This task has no valid OpenClaw conversation link.')).toBeInTheDocument();
    expect(mocks.preference).not.toHaveBeenCalled();
  });
});
