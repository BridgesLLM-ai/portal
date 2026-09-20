// @vitest-environment jsdom
import '../../test/setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, afterEach } from 'vitest';
import ChatTasksButton from './ChatTasksButton';
import { latestChatPlan, sessionTasks } from '../../utils/chatTasks';
import type { ChatMessage } from '../../contexts/ChatStateProvider';
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api/client', () => ({ default: { get: mocks.get } }));
afterEach(() => { mocks.get.mockReset(); vi.useRealTimers(); });
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
    expect(mocks.get).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Tasks' }));
    await waitFor(() => expect(screen.getByText('My task')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Tasks, 1 outstanding' })).toBeInTheDocument();
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


describe('OpenClaw task feed demand', () => {
  it.each([
    ['OPENCLAW', 'OPENCLAW', 'agent:main:two'],
    ['OPENCLAW', 'CODEX', 'native-two'],
    ['CODEX', 'OPENCLAW', 'agent:main:two'],
  ])('closes %s tasks on navigation to %s without fetching the new scope', async (provider, nextProvider, nextSession) => {
    mocks.get.mockImplementation(() => new Promise(() => {}));
    const { rerender } = render(<MemoryRouter><ChatTasksButton provider={provider} session="agent:main:one" messages={[]} isRunning={false} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    const initialCalls = provider === 'OPENCLAW' ? 1 : 0;
    expect(mocks.get).toHaveBeenCalledTimes(initialCalls);
    const signal = mocks.get.mock.calls[0]?.[1].signal as AbortSignal | undefined;
    rerender(<MemoryRouter><ChatTasksButton provider={nextProvider} session={nextSession} messages={[]} isRunning={false} /></MemoryRouter>);
    expect(screen.queryByRole('dialog', { name: 'Chat tasks' })).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledTimes(initialCalls);
    if (signal) expect(signal.aborted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(mocks.get).toHaveBeenCalledTimes(initialCalls + (nextProvider === 'OPENCLAW' ? 1 : 0));
    if (nextProvider !== 'OPENCLAW') {
      expect(screen.queryByText('Loading tasks…')).not.toBeInTheDocument();
      expect(screen.getByText('No plan or tasks reported for this chat yet.')).toBeInTheDocument();
    }
  });

  it('does not enumerate tasks on chat mount, idle polling, or run-state changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.get.mockResolvedValue({ data: { tasks: [] } });
    const { rerender } = render(<MemoryRouter><ChatTasksButton provider="OPENCLAW" session="agent:main:one" messages={messages} isRunning={false} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Tasks, 2 outstanding' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    rerender(<MemoryRouter><ChatTasksButton provider="OPENCLAW" session="agent:main:one" messages={messages} isRunning /></MemoryRouter>);
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('polls only the open feed, waits for slow requests, and stops on close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finish!: (value: unknown) => void;
    mocks.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mocks.get.mockResolvedValue({ data: { tasks: [] } });
    const { rerender } = render(<MemoryRouter><ChatTasksButton provider="OPENCLAW" session="agent:main:one" messages={[]} isRunning={false} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('/gateway/tasks', expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 35_000 }));
    rerender(<MemoryRouter><ChatTasksButton provider="OPENCLAW" session="agent:main:one" messages={[]} isRunning /></MemoryRouter>);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ data: { tasks: [] } }); });
    // The poll interval stays above the server's task-feed cache TTL so an open
    // feed is not a guaranteed gateway sweep on every tick.
    await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.get).toHaveBeenCalledTimes(2);
    const signal = mocks.get.mock.calls[1][1].signal as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Close chat tasks' }));
    expect(signal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.get).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await act(async () => {});
    expect(mocks.get).toHaveBeenCalledTimes(3);
  });

  it('ignores a late response after closing and switching conversations', async () => {
    let finish!: (value: unknown) => void;
    mocks.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<MemoryRouter><ChatTasksButton provider="OPENCLAW" session="agent:main:one" messages={[]} isRunning={false} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    const signal = mocks.get.mock.calls[0][1].signal as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Close chat tasks' }));
    rerender(<MemoryRouter><ChatTasksButton provider="OPENCLAW" session="agent:main:two" messages={[]} isRunning={false} /></MemoryRouter>);
    await act(async () => { finish({ data: { tasks: [{ id: 'late', name: 'Old task', status: 'running', parentSession: 'agent:main:one' }] } }); });
    expect(signal.aborted).toBe(true);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.queryByText('Old task')).not.toBeInTheDocument();
  });
});
