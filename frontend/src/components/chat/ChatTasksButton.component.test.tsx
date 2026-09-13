// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, afterEach } from 'vitest';
import ChatTasksButton from './ChatTasksButton';
import { latestChatPlan, sessionTasks } from '../../utils/chatTasks';
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


describe('Current native progress cards', () => {
  it('renders the actual progress_card plan and completes it without a background-task feed', async () => {
    const progress = structuredClone(messages);
    progress[0].toolCalls![0].name = 'progress_card';
    const user = userEvent.setup();
    const { rerender } = render(<MemoryRouter><ChatTasksButton provider="CODEX" session="progress-session" messages={progress} isRunning /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Tasks, 2 outstanding' }));
    expect(screen.getByRole('progressbar', { name: 'Reported task progress' })).toHaveAttribute('value', '1');
    const completed = structuredClone(progress);
    completed[0].toolCalls![0].arguments.plan.forEach((item: { status: string }) => { item.status = 'completed'; });
    rerender(<MemoryRouter><ChatTasksButton provider="CODEX" session="progress-session" messages={completed} isRunning={false} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Tasks, all completed' })).toBeInTheDocument();
    expect(screen.getByText('3 of 3 completed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close chat tasks' }));
    expect(screen.queryByRole('dialog', { name: 'Chat tasks' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tasks, all completed' })).toHaveFocus();
  });
  it('supports namespaced progress tools, retains a plan on note-only updates, and honors a clear', () => {
    const progress = structuredClone(messages);
    progress[0].toolCalls![0].name = 'functions__progress_card';
    progress[0].toolCalls!.push({ id: 'note', name: 'tools.progress_card', status: 'done', startedAt: 2, arguments: { markdown: 'Still working' } });
    expect(latestChatPlan(progress)).toHaveLength(3);
    progress[0].toolCalls!.push({ id: 'clear', name: 'progress_card', status: 'done', startedAt: 3, arguments: { plan: [] } });
    expect(latestChatPlan(progress)).toEqual([]);
  });
  it('does not attach unscoped automation runs to an empty chat session', () => {
    expect(sessionTasks([{ id: 'heartbeat', name: 'Heartbeat', status: 'failed', parentSession: '' }], '')).toEqual([]);
  });
});


it('does not label an unknown task status as all complete', async () => {
  mocks.get.mockResolvedValue({ data: { tasks: [{ id: 'unknown', name: 'Awaiting runtime status', status: 'unknown', parentSession: 'uncertain-session' }] } });
  const user = userEvent.setup();
  render(<MemoryRouter><ChatTasksButton provider="OPENCLAW" session="uncertain-session" messages={[]} isRunning={false} /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Tasks' }));
  expect(await screen.findByText('Awaiting runtime status')).toBeInTheDocument();
  expect(screen.queryByText('All complete')).not.toBeInTheDocument();
  expect(screen.getByText('Last reported progress')).toBeInTheDocument();
});
