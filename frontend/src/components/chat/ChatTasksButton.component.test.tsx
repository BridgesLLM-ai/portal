// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, afterEach } from 'vitest';
import ChatTasksButton from './ChatTasksButton';
import { latestChatPlan } from '../../utils/chatTasks';
import type { ChatMessage } from '../../contexts/ChatStateProvider';
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api/client', () => ({ default: { get: mocks.get } }));
afterEach(() => mocks.get.mockReset());
const messages = [{ id: 'reply', role: 'assistant', content: '', toolCalls: [
  { id: 'plan', name: 'update_plan', status: 'done', startedAt: 1, arguments: { plan: [
    { step: 'Read the project', status: 'completed' }, { step: 'Make the change', status: 'in_progress' },
    { step: 'Verify the result', status: 'pending' },
  ] } },
] }] as ChatMessage[];
describe('Tasks in chat', () => {
  it('shows a native plan and real completion count without calling OpenClaw', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ChatTasksButton provider="CODEX" session="native-one" messages={messages} isRunning /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Tasks, 2 outstanding' }));
    expect(screen.getByText('1 of 3 completed')).toBeInTheDocument();
    expect(screen.getByText('Make the change')).toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('keeps unrelated OpenClaw tasks out of the current chat', async () => {
    mocks.get.mockResolvedValue({ data: { tasks: [
      { id: 'own', name: 'My task', status: 'running', parentSession: 'agent:main:one' },
      { id: 'other', name: 'Another chat task', status: 'running', parentSession: 'agent:main:other' },
    ] } });
    const user = userEvent.setup();
    render(<MemoryRouter><ChatTasksButton provider="OPENCLAW" session="agent:main:one" messages={[]} isRunning={false} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tasks, 1 outstanding' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Tasks, 1 outstanding' }));
    expect(screen.getByText('My task')).toBeInTheDocument();
    expect(screen.queryByText('Another chat task')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All OpenClaw' }));
    expect(screen.getByText('Another chat task')).toBeInTheDocument();
  });
  it('does not invent a task feed for a harness without one', () => {
    render(<MemoryRouter><ChatTasksButton provider="OLLAMA" session="local" messages={[]} isRunning /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /Tasks/ })).not.toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('honors the newest plan, including explicit removal, and ignores failed updates', () => {
    const latest = structuredClone(messages);
    latest[0].toolCalls!.push({ id: 'bad', name: 'update_plan', status: 'error', startedAt: 2, arguments: { plan: [] } });
    expect(latestChatPlan(latest)).toHaveLength(3);
    latest[0].toolCalls!.push({ id: 'removed', name: 'update_plan', status: 'done', startedAt: 3, arguments: { plan: [] } });
    expect(latestChatPlan(latest)).toHaveLength(0);
  });
});
