// @vitest-environment jsdom
import '../../../test/setup';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, WsManager } from '../../../contexts/ChatStateProvider';
import { AgentWorkButton, AgentWorkStrip, useAgentWorkSurface } from './AgentWorkSurface';
import { GOAL_OPERATION_STORAGE_PREFIX } from './goalOperationStore';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), sessionInfo: vi.fn() }));
vi.mock('../../../api/client', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('../../../api/endpoints', () => ({ gatewayAPI: { sessionInfo: mocks.sessionInfo } }));

const USER = '11111111-2222-4333-8444-555555555555';
const KEY = `agent:main:portal-${USER}-new-1`;
const OTHER = `agent:main:portal-${USER}-new-2`;
const CHILD = 'agent:main:subagent:aaaa-111111';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const goal = (status = 'active', extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, id: 'goal-1', objective: 'Get CI green and push the fix', status,
  createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000, tokenStart: 0, tokensUsed: 12_000, tokenBudget: 50_000, continuationTurns: 1, ...extra,
});
const row = (key: string, extra: Record<string, unknown> = {}) => ({ kind: 'session', key, parentKey: null, label: key, status: null, updatedAt: Date.now() - 5000, ...extra });
function work(key = KEY, extra: Record<string, any> = {}) {
  return {
    v: 1, sessionKey: key, fetchedAt: new Date().toISOString(), caps: { goals: true, progress: true },
    session: row(key, { label: 'Fix CI', status: 'running' }),
    goal: goal(),
    progress: { sessionKey: key, revision: 4, updatedAt: Date.now() - 10_000, markdown: 'Working on **tests**', steps: [
      { step: 'Reproduce the failure', status: 'completed' },
      { step: 'Patch the flaky test', status: 'in_progress' },
      { step: 'Push the fix', status: 'pending' },
    ] },
    children: [
      row(CHILD, { kind: 'subagent', parentKey: key, label: 'Research the flake', status: 'running', subagentRole: 'leaf', activityText: 'Reading CI logs' }),
      row('agent:main:subagent:bbbb-222222', { kind: 'subagent', parentKey: key, label: 'Lint pass', status: 'queued' }),
      row('agent:main:subagent:cccc-333333', { kind: 'subagent', parentKey: key, label: 'Deploy check', status: 'failed', lastRunError: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" failed' }),
    ],
    ...extra,
  };
}

type Payloads = Map<string, unknown | (() => unknown)>;
let payloads: Payloads;
let activityPayload: unknown;
const httpError = (status: number, data: unknown) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
const workCalls = (key = KEY) => mocks.get.mock.calls.filter(([url]) => url === `/agent-work/sessions/${encodeURIComponent(key)}/work`).length;

function fakeSocket() {
  const handlers = new Set<(data: any) => void>();
  const reconnects = new Set<() => void>();
  const manager = {
    ws: null,
    send: vi.fn(() => true),
    addHandler: (handler: (data: any) => void) => { handlers.add(handler); },
    removeHandler: (handler: (data: any) => void) => { handlers.delete(handler); },
    onDisconnect: () => () => undefined,
    onReconnect: (callback: () => void) => { reconnects.add(callback); return () => { reconnects.delete(callback); }; },
    isConnected: () => true,
    reconnect: vi.fn(),
    close: vi.fn(),
  } as WsManager;
  return {
    manager,
    emit: (data: unknown) => act(() => { for (const handler of [...handlers]) handler(data); }),
    reconnect: () => act(() => { for (const callback of [...reconnects]) callback(); }),
  };
}

function Harness({ session, socket, onOpen, messages = [], provider }: { session: string; socket: WsManager; onOpen?: (key: string) => void; messages?: ChatMessage[]; provider?: string }) {
  const surface = useAgentWorkSurface({ enabled: true, provider, session, wsManager: socket, userId: USER });
  return (
    <MemoryRouter>
      <AgentWorkButton surface={surface} messages={messages} projectWork={[]} isChatRunning={false} onOpenSession={onOpen} />
      <AgentWorkStrip surface={surface} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.sessionInfo.mockReset();
  payloads = new Map<string, unknown>([[KEY, work()], [OTHER, work(OTHER, { goal: null, progress: null, children: [], session: row(OTHER, { label: 'Other chat' }) })]]);
  activityPayload = { v: 1, fetchedAt: new Date().toISOString(), items: [] };
  mocks.get.mockImplementation(async (url: string) => {
    if (url === '/agent-work/activity') return { data: activityPayload };
    const match = /^\/agent-work\/sessions\/(.+)\/work$/.exec(url);
    const value = match ? payloads.get(decodeURIComponent(match[1])) : undefined;
    const resolved = typeof value === 'function' ? (value as () => unknown)() : value;
    if (resolved instanceof Promise) return resolved;
    if (resolved instanceof Error) throw resolved;
    if (!resolved) throw httpError(404, { v: 1, code: 'SESSION_NOT_FOUND' });
    return { data: resolved };
  });
});

async function openPanel(user = userEvent.setup()) {
  await user.click(await screen.findByRole('button', { name: /^Agent work(,|$)/ }));
  return screen.findByRole('dialog', { name: 'Agent work' });
}

describe('Agent Work panel', () => {
  it('shows the native goal, progress and sub-agents for the exact conversation key', async () => {
    const socket = fakeSocket();
    const onOpen = vi.fn();
    render(<Harness session={KEY} socket={socket.manager} onOpen={onOpen} />);
    const strip = await screen.findByRole('button', { name: /^Agent work: Goal: Get CI green/ });
    expect(strip).toHaveTextContent('1/3 steps');
    expect(strip).toHaveTextContent('2 sub-agents active');
    expect(mocks.get).toHaveBeenCalledWith(`/agent-work/sessions/${encodeURIComponent(KEY)}/work`, expect.objectContaining({ _silent: true }));
    expect(screen.getByRole('button', { name: 'Agent work, goal active, 2 sub-agents active, 1 failed' })).toBeInTheDocument();
    const user = userEvent.setup();
    const panel = await openPanel(user);
    expect(within(panel).getByText('Active')).toBeInTheDocument();
    expect(within(panel).getByText('12k of 50k tokens', { exact: false })).toBeInTheDocument();
    expect(within(panel).getByRole('progressbar', { name: 'Reported progress' })).toHaveAttribute('value', '1');
    expect(within(panel).getByLabelText('In progress')).toBeInTheDocument();
    expect(within(panel).getByText('Patch the flaky test')).toBeInTheDocument();
    const research = within(panel).getByText('Research the flake').closest('li')!;
    expect(within(research).getByText('Running')).toBeInTheDocument();
    expect(within(research).getByText('Reading CI logs')).toBeInTheDocument();
    expect(within(within(panel).getByText('Lint pass').closest('li')!).getByText('Waiting to start')).toBeInTheDocument();
    const failed = within(panel).getByText('Deploy check').closest('li')!;
    expect(within(failed).getByText('Failed')).toBeInTheDocument();
    expect(failed).toHaveTextContent('Authorization: Bearer ••••••');
    expect(failed).not.toHaveTextContent('abcdefghijklmnop1234');
    await user.click(within(panel).getByRole('button', { name: 'Open Research the flake' }));
    expect(onOpen).toHaveBeenCalledWith(CHILD);
  });

  it('renders measured native progress without a plan and clears it on authoritative replacement', async () => {
    payloads.set(KEY, work(KEY, { goal: null, children: [], progress: {
      sessionKey: KEY, revision: 5, updatedAt: Date.now(), steps: [],
      markdown: '<progress aria-label="Files reviewed · 12/30" value="12" max="30"></progress>\nChecked **twelve** files.',
    } }));
    render(<Harness session={KEY} socket={fakeSocket().manager} />);
    const strip = await screen.findByRole('button', { name: /^Agent work: Progress update/ });
    const user = userEvent.setup();
    await user.click(strip);
    const panel = await screen.findByRole('dialog', { name: 'Agent work' });
    const meter = within(panel).getByRole('progressbar', { name: 'Files reviewed · 12/30' });
    expect(meter).toHaveAttribute('value', '12');
    expect(meter).toHaveAttribute('max', '30');
    expect(within(panel).queryByRole('progressbar', { name: 'Reported progress' })).toBeNull();
    expect(within(panel).getByText('twelve').tagName).toBe('STRONG');
    expect(panel).not.toHaveTextContent('<progress');
    payloads.set(KEY, work(KEY, { goal: null, children: [], progress: null }));
    await user.click(within(panel).getByRole('button', { name: 'Refresh agent work' }));
    await waitFor(() => expect(within(panel).queryByRole('progressbar')).toBeNull());
    expect(screen.queryByRole('button', { name: /^Agent work: Progress update/ })).toBeNull();
    expect(within(panel).getByText(/No progress card yet/)).toBeInTheDocument();
  });

  it('keeps measured work and checklist counts distinct, ignoring invalid markup', async () => {
    const native = work();
    native.progress.markdown = '<progress aria-label="Tests finished · 12/30" value="12" max="30" onload="alert(1)"></progress>\n<img src="https://example.invalid/tracker">Tests finished are not tests passed.';
    payloads.set(KEY, native);
    render(<Harness session={KEY} socket={fakeSocket().manager} />);
    const panel = await openPanel();
    expect(within(panel).getByRole('progressbar', { name: 'Reported progress' })).toHaveAttribute('value', '1');
    expect(within(panel).getByRole('progressbar', { name: 'Tests finished · 12/30' })).toHaveAttribute('value', '12');
    expect(panel.querySelector('[onload], img')).toBeNull();
    expect(panel).toHaveTextContent('Tests finished are not tests passed.');
  });

  it('pauses with a closed body and shows the readback goal, not the receipt', async () => {
    mocks.post.mockResolvedValue({ status: 200, data: { v: 1, result: { status: 'updated', goal: goal('active') }, goal: goal('paused', { lastStatusNote: 'waiting' }) } });
    const socket = fakeSocket();
    render(<Harness session={KEY} socket={socket.manager} />);
    const user = userEvent.setup();
    const panel = await openPanel(user);
    const pause = await within(panel).findByRole('button', { name: 'Pause' });
    // Later reads never answer, so only the POST readback can change what is shown.
    payloads.set(KEY, () => new Promise(() => undefined));
    const before = workCalls();
    await user.click(pause);
    await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent('Goal paused.'));
    const [url, body, config] = mocks.post.mock.calls[0];
    expect(url).toBe(`/agent-work/sessions/${encodeURIComponent(KEY)}/goal`);
    expect(Object.keys(body).sort()).toEqual(['action', 'goalId', 'issuedAtMs', 'operationId']);
    expect(body).toMatchObject({ action: 'pause', goalId: 'goal-1' });
    expect(body.operationId).toMatch(UUID);
    expect(Number.isSafeInteger(body.issuedAtMs)).toBe(true);
    expect(config).toMatchObject({ _skipNetworkRetry: true, _silent: true });
    expect(within(panel).getByText('Paused')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    await waitFor(() => expect(workCalls()).toBeGreaterThan(before));
    expect(window.sessionStorage.length).toBe(0);
  });

  it('keeps an unconfirmed change and re-sends the identical request only when asked, across reloads', async () => {
    mocks.post.mockResolvedValueOnce({ status: 202, data: { v: 1, outcome: 'unconfirmed' } });
    const socket = fakeSocket();
    const view = render(<Harness session={KEY} socket={socket.manager} />);
    const user = userEvent.setup();
    let panel = await openPanel(user);
    await user.click(await within(panel).findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(within(panel).getByRole('alert')).toHaveTextContent('We couldn’t confirm “Pause goal”.'));
    expect(within(panel).getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Agent work: .*goal change unconfirmed/ })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mocks.post).toHaveBeenCalledTimes(1);

    view.unmount();
    render(<Harness session={KEY} socket={fakeSocket().manager} />);
    panel = await openPanel(user);
    expect(await within(panel).findByRole('alert')).toHaveTextContent('We couldn’t confirm “Pause goal”.');
    mocks.post.mockResolvedValueOnce({ status: 200, data: { v: 1, result: { replayed: true }, goal: goal('paused') } });
    await user.click(within(panel).getByRole('button', { name: 'Check outcome' }));
    await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent('This change had already been applied.'));
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1][1]).toEqual(mocks.post.mock.calls[0][1]);
    expect(Object.keys(window.sessionStorage).some((key) => key.startsWith(GOAL_OPERATION_STORAGE_PREFIX))).toBe(false);
  });

  it('retires a stale action and shows the fresh goal the backend read back', async () => {
    mocks.post.mockRejectedValueOnce(httpError(409, { v: 1, status: 409, code: 'GOAL_STALE', reason: 'goal-rebound', goal: goal('active', { id: 'goal-2', objective: 'A replacement goal' }) }));
    render(<Harness session={KEY} socket={fakeSocket().manager} />);
    const user = userEvent.setup();
    const panel = await openPanel(user);
    const pause = await within(panel).findByRole('button', { name: 'Pause' });
    payloads.set(KEY, () => new Promise(() => undefined));
    await user.click(pause);
    await waitFor(() => expect(within(panel).getByRole('alert')).toHaveTextContent('The goal changed before this action was applied.'));
    expect(within(panel).getByText('A replacement goal')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Review current goal' })).toBeInTheDocument();
    expect(Object.keys(window.sessionStorage).some((key) => key.startsWith(GOAL_OPERATION_STORAGE_PREFIX))).toBe(false);
  });

  it('starts a goal through the closed start body and explains a maintenance refusal', async () => {
    payloads.set(KEY, work(KEY, { goal: null, session: row(KEY, { label: 'Fix CI', status: 'done' }) }));
    mocks.post.mockRejectedValueOnce(httpError(503, { v: 1, code: 'OPENCLAW_EXECUTION_MAINTENANCE', error: 'Session work unavailable' }));
    render(<Harness session={KEY} socket={fakeSocket().manager} />);
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await user.click(await within(panel).findByRole('button', { name: 'Set a goal' }));
    await user.type(within(panel).getByLabelText('What should the agent achieve?'), 'Ship the release notes');
    await user.click(within(panel).getByRole('button', { name: 'Start goal' }));
    await waitFor(() => expect(within(panel).getByRole('alert')).toHaveTextContent('OpenClaw is being updated. Chat resumes shortly.'));
    const [url, body] = mocks.post.mock.calls[0];
    expect(url).toBe(`/agent-work/sessions/${encodeURIComponent(KEY)}/goal/start`);
    expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'issuedAtMs', 'objective']);
    expect(body.objective).toBe('Ship the release notes');
    expect(body.idempotencyKey).toMatch(UUID);
    // A refused start keeps the typed objective.
    expect(within(panel).getByLabelText('What should the agent achieve?')).toHaveValue('Ship the release notes');
  });

  it('coalesces duplicate signals, ignores other conversations and rereads on reconnect', async () => {
    const socket = fakeSocket();
    render(<Harness session={KEY} socket={socket.manager} />);
    await screen.findByRole('button', { name: /^Agent work: Goal/ });
    await waitFor(() => expect(workCalls()).toBe(1));
    socket.emit({ type: 'work.changed', v: 1, sessionKey: KEY, parts: ['goal'] });
    socket.emit({ type: 'work.changed', v: 1, sessionKey: KEY, parts: ['children'] });
    socket.emit({ type: 'work.changed', v: 1, sessionKey: KEY, parts: ['goal'] });
    socket.emit({ type: 'work.changed', v: 1, sessionKey: OTHER, parts: ['goal'] });
    socket.emit({ type: 'work.changed', v: 2, sessionKey: KEY, parts: ['goal'] });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(workCalls()).toBe(2);
    expect(workCalls(OTHER)).toBe(0);
    socket.reconnect();
    await waitFor(() => expect(workCalls()).toBe(3));
  });

  it('never shows a previous conversation’s late answer after switching', async () => {
    let releaseFirst!: (value: unknown) => void;
    payloads.set(KEY, () => new Promise((resolve) => { releaseFirst = resolve; }));
    const socket = fakeSocket();
    const view = render(<Harness session={KEY} socket={socket.manager} />);
    await waitFor(() => expect(workCalls()).toBe(1));
    view.rerender(<Harness session={OTHER} socket={socket.manager} />);
    await waitFor(() => expect(workCalls(OTHER)).toBe(1));
    await act(async () => { releaseFirst({ data: work() }); });
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await waitFor(() => expect(within(panel).getByText('No goal yet. Give the agent one objective to keep working toward.')).toBeInTheDocument());
    expect(screen.queryByText('Get CI green and push the fix')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Agent work: Goal/ })).not.toBeInTheDocument();
  });

  it('keeps the last good state when a refresh fails, and explains a conversation that has not started', async () => {
    const socket = fakeSocket();
    render(<Harness session={KEY} socket={socket.manager} />);
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await within(panel).findByText('Get CI green and push the fix');
    payloads.set(KEY, httpError(502, { v: 1, code: 'WORK_UNAVAILABLE', error: 'Session work unavailable' }));
    await user.click(within(panel).getByRole('button', { name: 'Refresh agent work' }));
    await waitFor(() => expect(within(panel).getByText(/Couldn’t refresh\. Showing the last update/)).toBeInTheDocument());
    expect(within(panel).getByText('Get CI green and push the fix')).toBeInTheDocument();

    payloads.delete(KEY);
    socket.emit({ type: 'work.changed', v: 1, sessionKey: KEY, parts: ['status'] });
    await waitFor(() => expect(within(panel).getByText('Agent work appears here once this conversation has started.')).toBeInTheDocument());
    expect(within(panel).queryByText('Get CI green and push the fix')).not.toBeInTheDocument();
  });

  it('resolves a Portal alias through the existing session read and never sends the alias', async () => {
    mocks.sessionInfo.mockResolvedValueOnce({ session: { key: KEY } });
    render(<Harness session="main" socket={fakeSocket().manager} />);
    await screen.findByRole('button', { name: /^Agent work: Goal/ });
    expect(mocks.sessionInfo).toHaveBeenCalledWith('main', { silent: true });
    expect(mocks.get.mock.calls.every(([url]) => !String(url).includes('/sessions/main/'))).toBe(true);

    mocks.sessionInfo.mockResolvedValueOnce({ session: null, missing: true });
    const later = render(<Harness session="new-77" socket={fakeSocket().manager} />);
    const user = userEvent.setup();
    await user.click(within(later.container).getByRole('button', { name: /^Agent work(,|$)/ }));
    expect(await screen.findByText('Agent work appears here once this conversation has started.')).toBeInTheDocument();
    expect(mocks.get.mock.calls.some(([url]) => String(url).includes('new-77'))).toBe(false);
  });

  it('marks a sub-agent conversation, links its parent and does not offer resume or start', async () => {
    payloads.set(CHILD, work(CHILD, {
      session: row(CHILD, { kind: 'subagent', parentKey: KEY, label: 'Research the flake', status: 'done' }),
      goal: goal('paused', { lastStatusNote: 'Waiting for logs' }), children: [],
    }));
    const onOpen = vi.fn();
    render(<Harness session={CHILD} socket={fakeSocket().manager} onOpen={onOpen} />);
    const user = userEvent.setup();
    const panel = await openPanel(user);
    expect(await within(panel).findByText('This is a sub-agent conversation.')).toBeInTheDocument();
    await within(panel).findByText('Note: Waiting for logs');
    expect(within(panel).queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    expect(within(panel).getByText('Resume this goal from the conversation that started this sub-agent.')).toBeInTheDocument();
    expect(within(panel).getByText('Note: Waiting for logs')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Open the conversation that started it' }));
    expect(onOpen).toHaveBeenCalledWith(KEY);
  });

  it('falls back to the chat plan without the progress capability and hides controls without the goal capability', async () => {
    payloads.set(KEY, work(KEY, { caps: { goals: false, progress: false }, progress: null }));
    const messages = [{ id: 'm', role: 'assistant', content: '', toolCalls: [{ id: 'p', name: 'update_plan', status: 'done', startedAt: 1, arguments: { plan: [{ step: 'Plan from chat', status: 'in_progress' }] } }] }] as ChatMessage[];
    render(<Harness session={KEY} socket={fakeSocket().manager} messages={messages} />);
    const user = userEvent.setup();
    const panel = await openPanel(user);
    expect(await within(panel).findByText('From the latest plan in this chat.')).toBeInTheDocument();
    expect(within(panel).getByText('Plan from chat')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(within(panel).getByText('Goal controls aren’t available for this conversation right now.')).toBeInTheDocument();
  });

  it('renders progress Markdown without raw HTML and keeps secrets out of the goal editor', async () => {
    payloads.set(KEY, work(KEY, {
      goal: goal('active', { objective: 'Rotate the key api_key=supersecretvalue123 today' }),
      progress: { sessionKey: KEY, revision: 1, updatedAt: Date.now(), markdown: 'Done <img src=x onerror="alert(1)"> **bold**', steps: [] },
    }));
    render(<Harness session={KEY} socket={fakeSocket().manager} />);
    const user = userEvent.setup();
    const panel = await openPanel(user);
    expect((await within(panel).findByText('bold')).tagName).toBe('STRONG');
    expect(panel.querySelector('img')).toBeNull();
    expect(panel).not.toHaveTextContent('supersecretvalue123');
    await user.click(within(panel).getByRole('button', { name: 'Edit' }));
    const editor = within(panel).getByLabelText('Edit the goal');
    expect(editor).toHaveValue('Rotate the key api_key=•••••• today');
    expect(within(panel).getByText(/Parts that look like secrets are hidden/)).toBeInTheDocument();
  });
});

describe('Agent Work for native harnesses', () => {
  const NATIVE = `claude_code-${USER}-1760000000000-6a1b2c3d`;
  const nativeWork = (extra: Record<string, unknown> = {}) => ({
    v: 1, sessionKey: NATIVE, fetchedAt: new Date().toISOString(), caps: { goals: false, progress: false },
    session: row(NATIVE, { label: 'Claude Code chat', status: 'running' }), goal: null, progress: null, children: [], swarm: null, ...extra,
  });
  const plan = [{ id: 'm', role: 'assistant', content: '', toolCalls: [{ id: 'todo-1', name: 'TodoWrite', status: 'done', startedAt: 1,
    arguments: { todos: [{ content: 'Read the failing test', status: 'completed' }, { content: 'Write the fix', status: 'in_progress' }] } }] }] as ChatMessage[];

  it('reads the exact native session, shows its chat plan and leaves out OpenClaw-only sections', async () => {
    payloads.set(NATIVE, nativeWork());
    render(<Harness provider="CLAUDE_CODE" session={NATIVE} socket={fakeSocket().manager} messages={plan} />);
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: /^Agent work(,|$)/ });
    expect(button).toHaveAttribute('title', 'Goal and progress');
    const panel = await openPanel(user);
    expect(await within(panel).findByText('From the latest plan in this chat.')).toBeInTheDocument();
    expect(within(panel).getByText('Write the fix')).toBeInTheDocument();
    expect(within(panel).getByText('1 of 2 steps')).toBeInTheDocument();
    expect(within(panel).getByText('Running')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith(`/agent-work/sessions/${NATIVE}/work`, expect.objectContaining({ _silent: true }));
    expect(mocks.sessionInfo).not.toHaveBeenCalled();
    // OpenClaw concepts stay out: no goal section without the capability, no
    // sub-agents, no other conversations, no OpenClaw task board.
    for (const text of ['Goal', 'Sub-agents', 'Other conversations', 'Open task board →']) {
      expect(within(panel).queryByText(text)).not.toBeInTheDocument();
    }
    expect(within(panel).getByText('Progress shows the plan this harness reports in chat.')).toBeInTheDocument();
    expect(mocks.get.mock.calls.some(([url]) => url === '/agent-work/activity')).toBe(false);
  });

  it('offers goal controls only when the backend reports the goal capability', async () => {
    payloads.set(NATIVE, nativeWork({ caps: { goals: true, progress: false }, session: row(NATIVE, { label: 'Claude Code chat', status: null }) }));
    render(<Harness provider="CLAUDE_CODE" session={NATIVE} socket={fakeSocket().manager} />);
    const panel = await openPanel(userEvent.setup());
    expect(await within(panel).findByRole('button', { name: 'Set a goal' })).toBeEnabled();
    expect(within(panel).getByText('No progress reported for this chat yet.')).toBeInTheDocument();
  });

  it('waits for the first turn instead of resolving a native alias through OpenClaw', async () => {
    render(<Harness provider="CODEX" session="new-1760000000000" socket={fakeSocket().manager} />);
    const panel = await openPanel(userEvent.setup());
    expect(within(panel).getByText('Agent work appears here once this conversation has started.')).toBeInTheDocument();
    expect(mocks.sessionInfo).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe('Stopping chosen work', () => {
  const stopCalls = () => mocks.post.mock.calls.filter(([url]) => url === '/gateway/chat/abort');
  const rowOf = (panel: HTMLElement, name: string) => within(panel).getByText(name).closest('li')!;
  async function stop(panel: HTMLElement, user: ReturnType<typeof userEvent.setup>, name: string) {
    await within(panel).findByText(name);
    await user.click(await within(rowOf(panel, name)).findByRole('button', { name: `Stop ${name}` }));
    await user.click(within(rowOf(panel, name)).getByRole('button', { name: 'Stop now' }));
  }

  it('stops only the chosen sub-agent through the existing session-scoped abort, after confirmation', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { ok: true, sessionKey: CHILD, harness: 'OPENCLAW', provider: 'OPENCLAW', runId: null, runIds: ['run-1'] } });
    render(<Harness session={KEY} socket={fakeSocket().manager} />);
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await within(panel).findByText('Research the flake');
    expect(within(rowOf(panel, 'Lint pass')).getByRole('button', { name: 'Stop Lint pass' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Stop Deploy check' })).not.toBeInTheDocument();
    await user.click(within(rowOf(panel, 'Research the flake')).getByRole('button', { name: 'Stop Research the flake' }));
    const confirm = within(panel).getByRole('group', { name: 'Confirm stopping Research the flake' });
    expect(confirm).toHaveTextContent('Stop what this sub-agent is doing now? Its history is kept.');
    expect(within(confirm).getByRole('button', { name: 'Keep running' })).toHaveFocus();
    expect(stopCalls()).toHaveLength(0);
    const before = workCalls();
    await user.click(within(confirm).getByRole('button', { name: 'Stop now' }));
    expect(await within(panel).findByText('Stopped “Research the flake”.')).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [, body, config] = stopCalls()[0];
    expect(body).toEqual({ session: CHILD, provider: 'OPENCLAW' });
    expect(config).toMatchObject({ _skipNetworkRetry: true, _silent: true });
    await waitFor(() => expect(workCalls()).toBeGreaterThan(before));
    // While the listed status catches up, the row does not offer a second stop.
    expect(within(rowOf(panel, 'Research the flake')).queryByRole('button', { name: 'Stop Research the flake' })).not.toBeInTheDocument();
    expect(within(rowOf(panel, 'Lint pass')).getByRole('button', { name: 'Stop Lint pass' })).toBeInTheDocument();
  });

  it('sends nothing when the user keeps it running', async () => {
    render(<Harness session={KEY} socket={fakeSocket().manager} />);
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await user.click(await within(panel).findByRole('button', { name: 'Stop Lint pass' }));
    const confirm = within(panel).getByRole('group', { name: 'Confirm stopping Lint pass' });
    expect(confirm).toHaveTextContent('Stop this sub-agent before it starts?');
    await user.click(within(confirm).getByRole('button', { name: 'Keep running' }));
    expect(within(panel).queryByRole('group', { name: 'Confirm stopping Lint pass' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Stop Lint pass' })).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('drops an open confirmation when that work finishes first', async () => {
    const socket = fakeSocket();
    const children = (status: string) => [
      row(CHILD, { kind: 'subagent', parentKey: KEY, label: 'Research the flake', status }),
      row('agent:main:subagent:bbbb-222222', { kind: 'subagent', parentKey: KEY, label: 'Lint pass', status: 'queued' }),
    ];
    render(<Harness session={KEY} socket={socket.manager} />);
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await user.click(await within(panel).findByRole('button', { name: 'Stop Research the flake' }));
    expect(within(panel).getByRole('group', { name: 'Confirm stopping Research the flake' })).toBeInTheDocument();
    payloads.set(KEY, work(KEY, { children: children('done') }));
    socket.emit({ type: 'work.changed', v: 1, sessionKey: KEY, parts: ['children'] });
    await waitFor(() => expect(rowOf(panel, 'Research the flake')).toHaveTextContent('Finished'));
    payloads.set(KEY, work(KEY, { children: children('running') }));
    socket.emit({ type: 'work.changed', v: 1, sessionKey: KEY, parts: ['children'] });
    await waitFor(() => expect(rowOf(panel, 'Research the flake')).toHaveTextContent('Running'));
    expect(within(panel).queryByRole('group', { name: 'Confirm stopping Research the flake' })).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('offers Stop only where the route acts on exactly that conversation; automation runs stay read-only', async () => {
    activityPayload = {
      v: 1,
      fetchedAt: new Date().toISOString(),
      items: [
        row('agent:main:main', { label: 'Host main chat', status: 'running' }),
        row('agent:ops:new-1700000000', { label: 'Host new chat', status: 'running' }),
        row('agent:main:portal-new-1700000001', { label: 'Portal alias chat', status: 'running' }),
        row(OTHER, { label: 'My other chat', status: 'running' }),
        row('agent:main:dashboard:lane-1', { label: 'Dashboard lane', status: 'queued' }),
      ],
      automation: [row('agent:main:cron:job-1:run:r1', { label: 'Nightly report', status: 'running' })],
    };
    render(<Harness session={KEY} socket={fakeSocket().manager} />);
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await within(panel).findByText('My other chat');
    await user.click(within(panel).getByText(/^Automation runs \(1\)/));
    expect(within(rowOf(panel, 'Nightly report')).getByText('Running')).toBeInTheDocument();
    const offered = within(panel).getAllByRole('button', { name: /^Stop / }).map((button) => button.getAttribute('aria-label')).sort();
    expect(offered).toEqual(['Stop Dashboard lane', 'Stop Lint pass', 'Stop My other chat', 'Stop Research the flake']);
    for (const name of ['Host main chat', 'Host new chat', 'Portal alias chat']) {
      expect(within(rowOf(panel, name)).getByText('Running')).toBeInTheDocument();
    }
  });

  it('reports an unconfirmed, refused or unanswered stop honestly and never retries it', async () => {
    mocks.post
      .mockResolvedValueOnce({ status: 200, data: { ok: false, sessionKey: CHILD, runIds: [], detail: 'The gateway did not confirm that a run was aborted.' } })
      .mockRejectedValueOnce(httpError(403, { error: 'Admin access required' }))
      .mockRejectedValueOnce(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));
    render(<Harness session={KEY} socket={fakeSocket().manager} />);
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await stop(panel, user, 'Research the flake');
    expect(await within(panel).findByText('Stop wasn’t confirmed for “Research the flake”. It may have already finished, or it may still be running.')).toBeInTheDocument();
    await stop(panel, user, 'Lint pass');
    expect(await within(panel).findByText('You don’t have permission to stop “Lint pass”.')).toBeInTheDocument();
    await stop(panel, user, 'Research the flake');
    expect(await within(panel).findByText('Couldn’t confirm the stop for “Research the flake”. Check its status before trying again.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mocks.post).toHaveBeenCalledTimes(3);
    expect(stopCalls().map(([, body]) => body.session)).toEqual([CHILD, 'agent:main:subagent:bbbb-222222', CHILD]);
  });

  it('flags a stop the server applied to a different conversation, and can be dismissed', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { ok: true, sessionKey: `agent:main:portal-${USER}`, runIds: ['run-9'] } });
    render(<Harness session={KEY} socket={fakeSocket().manager} />);
    const user = userEvent.setup();
    const panel = await openPanel(user);
    await stop(panel, user, 'Research the flake');
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('The server reported stopping a different conversation, not “Research the flake”.');
    expect(within(panel).queryByText('Stopped “Research the flake”.')).not.toBeInTheDocument();
    // Not offered again until the user has seen and dismissed the warning.
    expect(within(rowOf(panel, 'Research the flake')).queryByRole('button', { name: 'Stop Research the flake' })).not.toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(within(panel).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(rowOf(panel, 'Research the flake')).getByRole('button', { name: 'Stop Research the flake' })).toBeInTheDocument();
  });
});
