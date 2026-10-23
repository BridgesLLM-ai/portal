// @vitest-environment jsdom
import '../../test/setup';
import { Profiler } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../contexts/AuthContext';
import {
  hideWorkspacePrivacyCurtain,
  useWorkspaceAuthorizationLifecycle,
} from '../../hooks/useWorkspaceAuthorizationLifecycle';
import { __resetAgentChatProviderCatalogForTests } from '../../utils/agentChatProviderCatalog';
import { isElevated } from '../../utils/authz';
import { resetWorkspaceAuthorizationForTests } from '../../utils/workspaceAuthorization';
import AgentSelector from './AgentSelector';

// Only HTTP and the authorization socket are stand-ins. restoreSession, the
// privacy curtain lifecycle and the admin route predicate are the real ones.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  sockets: [] as Array<{ emitServer: (event: string, value: unknown) => void }>,
}));
vi.mock('../../api/client', () => ({
  default: { get: mocks.get },
  startSessionHeartbeat: vi.fn(),
  stopSessionHeartbeat: vi.fn(),
}));
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const handlers = new Map<string, (value: unknown) => void>();
    const socket: any = {
      connected: true,
      on: (event: string, handler: (value: unknown) => void) => { handlers.set(event, handler); return socket; },
      connect: vi.fn(),
      disconnect: vi.fn(),
      emitServer: (event: string, value: unknown) => handlers.get(event)?.(value),
    };
    mocks.sockets.push(socket);
    return socket;
  }),
}));

const OWNER_A = { id: 'owner-a', email: 'a@example.invalid', username: 'a', role: 'OWNER', authorizationVersion: 1 } as any;
const ISOLATED_B = {
  id: 'isolated-b', email: 'b@example.invalid', username: 'b', role: 'SUB_ADMIN', sandboxEnabled: true, authorizationVersion: 1,
} as any;
const SELECTED = `p4oc-${'1234567890'.repeat(4)}`;
const B_OWN = `p4oc-${'abcdef1234'.repeat(4)}`;
const A_NAME = 'A Confidential Project';
const SESSION_KEY = `agent:${SELECTED}:portal-new-1760000000000`;

const rowsFor: Record<string, unknown[]> = {
  [OWNER_A.id]: [
    { id: 'main' }, { id: 'parity', name: 'Parity' },
    { id: SELECTED, projectAgent: { projectName: A_NAME, ownChat: true } },
    { id: B_OWN, projectAgent: { projectName: null, ownChat: false } },
  ],
  // B cannot open A's Project; B's own Project Chat is named for B only.
  [ISOLATED_B.id]: [
    { id: 'main' }, { id: 'parity', name: 'Parity' },
    { id: SELECTED, projectAgent: { projectName: null, ownChat: false } },
    { id: B_OWN, projectAgent: { projectName: 'B Own Project', ownChat: true } },
  ],
};

interface AgentsCall { actor: string; version: number; signal?: AbortSignal }
let agentsCalls: AgentsCall[] = [];
let me: unknown = ISOLATED_B;
// Optional per-call override; otherwise the caller's own rows answer.
let answerAgents: ((call: AgentsCall) => Promise<unknown> | undefined) | null = null;

function serve() {
  mocks.get.mockImplementation(async (url: string, config?: { signal?: AbortSignal }) => {
    if (url === '/auth/me') return { data: me };
    if (url === '/gateway/harnesses') {
      return { data: { providers: [{ name: 'OPENCLAW', displayName: 'OpenClaw', implemented: true, installed: true, usable: true }] } };
    }
    if (url === '/gateway/sessions') return { data: { sessions: [] } };
    if (url === '/gateway/agents') {
      const user = useAuthStore.getState().user;
      const call = { actor: user?.id || 'signed-out', version: Number(user?.authorizationVersion ?? 1), signal: config?.signal };
      agentsCalls.push(call);
      const answer = answerAgents?.(call);
      if (answer) return answer;
      return { data: { agents: rowsFor[call.actor] || [{ id: 'main' }] } };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Text of the whole app root after every commit of the selector. */
function mountAdminRoute(options: { route?: boolean } = {}) {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  const commits: string[] = [];
  const navigate = vi.fn();
  const selector = (
    <Profiler id="agent-selector" onRender={() => { commits.push(root.textContent || ''); }}>
      <AgentSelector
        value="OPENCLAW"
        agentId={SELECTED}
        onChange={vi.fn()}
        onViewSession={vi.fn()}
        currentSessionKey={SESSION_KEY}
      />
    </Profiler>
  );
  function AdminRoute() {
    const { user, isAuthenticated } = useAuthStore();
    useWorkspaceAuthorizationLifecycle(navigate);
    return isAuthenticated && isElevated(user) ? selector : null;
  }
  const view = render(options.route === false ? selector : <AdminRoute />, { container: root });
  // The curtain can hide the app from accessibility queries, so read the DOM directly.
  const trigger = () => root.querySelector('button[aria-label="Choose agent"]');
  return { root, commits, trigger, view, navigate };
}

async function admitCurrentAuthorization() {
  await act(async () => { mocks.sockets.at(-1)!.emitServer('authorization_snapshot', { authorizationVersion: 1 }); });
}

describe('AgentSelector Project names follow the signed-in actor', () => {
  afterEach(() => {
    cleanup();
    hideWorkspacePrivacyCurtain();
    resetWorkspaceAuthorizationForTests();
    __resetAgentChatProviderCatalogForTests();
    mocks.get.mockReset();
    mocks.sockets.splice(0);
    agentsCalls = [];
    answerAgents = null;
    me = ISOLATED_B;
    useAuthStore.setState({ user: null, isAuthenticated: false, sessionRestoreError: false });
    localStorage.clear();
  });

  it('never shows the previous actor’s Project name after restoreSession switches actors in a mounted selector', async () => {
    serve();
    useAuthStore.setState({ user: OWNER_A, isAuthenticated: true, sessionRestoreError: false });
    const { root, commits, trigger } = mountAdminRoute();
    await waitFor(() => expect(trigger()).toHaveTextContent(A_NAME));
    await admitCurrentAuthorization();
    expect(root).not.toHaveAttribute('aria-hidden');

    const bLookup = deferred();
    answerAgents = (call) => (call.actor === ISOLATED_B.id ? bLookup.promise : undefined);
    const fromSwitch = commits.length;
    const callsBeforeSwitch = agentsCalls.length;
    await act(async () => { expect(await useAuthStore.getState().restoreSession()).toBe(true); });
    expect(useAuthStore.getState().user?.id).toBe(ISOLATED_B.id);

    // Before B's own lookup answers, the selection is only "a Project agent".
    expect(trigger()).toHaveTextContent('Project agent');
    expect(root.textContent).not.toContain(A_NAME);
    expect(agentsCalls.slice(callsBeforeSwitch).map((call) => call.actor)).toEqual([ISOLATED_B.id]);

    await admitCurrentAuthorization();
    expect(root).not.toHaveAttribute('aria-hidden');
    expect(screen.getByRole('button', { name: 'Choose agent' })).toHaveTextContent('Project agent');
    // Unnamed rows share "Project agent", so the conversations control carries the short id suffix.
    expect(screen.getByTitle('Project agent · 123456 sessions')).toBeInTheDocument();

    await act(async () => { bLookup.resolve({ data: { agents: rowsFor[ISOLATED_B.id] } }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose agent' })).toHaveTextContent('Unavailable Project'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Choose agent' }));
    await user.click(await screen.findByRole('button', { name: /^Project agents/ }));
    expect(screen.getByRole('group', { name: 'Project agents' })).toHaveTextContent('B Own Project');

    const afterSwitch = commits.slice(fromSwitch);
    expect(afterSwitch.some((text) => text.includes('Unavailable Project'))).toBe(true);
    expect(afterSwitch.filter((text) => text.includes(A_NAME))).toEqual([]);
    expect(document.body.textContent).not.toContain(A_NAME);
    expect(localStorage.getItem('agent-chat-agents-cache') || '').not.toContain(A_NAME);
  });

  it('cancels a lookup started for the previous actor so its answer cannot land after the switch', async () => {
    serve();
    const aLookup = deferred();
    const bLookup = deferred();
    answerAgents = (call) => (call.actor === OWNER_A.id ? aLookup.promise : bLookup.promise);
    useAuthStore.setState({ user: OWNER_A, isAuthenticated: true, sessionRestoreError: false });
    const { commits, trigger } = mountAdminRoute();
    await waitFor(() => expect(agentsCalls.map((call) => call.actor)).toEqual([OWNER_A.id]));
    await admitCurrentAuthorization();

    const fromSwitch = commits.length;
    await act(async () => { expect(await useAuthStore.getState().restoreSession()).toBe(true); });
    expect(agentsCalls.map((call) => call.actor)).toEqual([OWNER_A.id, ISOLATED_B.id]);
    expect(agentsCalls[0].signal?.aborted).toBe(true);
    expect(agentsCalls[1].signal?.aborted).toBe(false);

    // A's answer arrives late, after B took over the tab.
    await act(async () => { aLookup.resolve({ data: { agents: rowsFor[OWNER_A.id] } }); });
    await admitCurrentAuthorization();
    expect(trigger()).toHaveTextContent('Project agent');

    await act(async () => { bLookup.resolve({ data: { agents: rowsFor[ISOLATED_B.id] } }); });
    await waitFor(() => expect(trigger()).toHaveTextContent('Unavailable Project'));
    expect(commits.slice(fromSwitch).filter((text) => text.includes(A_NAME))).toEqual([]);
  });

  it('drops a retry scheduled for the previous actor and asks for the new actor at once', async () => {
    serve();
    answerAgents = (call) => (call.actor === OWNER_A.id ? Promise.reject(new Error('gateway restarting')) : undefined);
    useAuthStore.setState({ user: OWNER_A, isAuthenticated: true, sessionRestoreError: false });
    const { trigger } = mountAdminRoute();
    await waitFor(() => expect(agentsCalls.map((call) => call.actor)).toEqual([OWNER_A.id]));
    await admitCurrentAuthorization();

    await act(async () => { expect(await useAuthStore.getState().restoreSession()).toBe(true); });
    expect(agentsCalls.map((call) => call.actor)).toEqual([OWNER_A.id, ISOLATED_B.id]);
    await waitFor(() => expect(trigger()).toHaveTextContent('Unavailable Project'));

    // A's retry was due 1.5 s after its failure; it never runs.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)); });
    expect(agentsCalls.map((call) => call.actor)).toEqual([OWNER_A.id, ISOLATED_B.id]);
  });

  it('hides names from an older authorization generation of the same actor until a fresh lookup answers', async () => {
    serve();
    useAuthStore.setState({ user: OWNER_A, isAuthenticated: true, sessionRestoreError: false });
    const { commits, trigger } = mountAdminRoute({ route: false });
    await waitFor(() => expect(trigger()).toHaveTextContent(A_NAME));

    // The new generation no longer reaches that Project.
    const v2Lookup = deferred();
    answerAgents = (call) => (call.version === 2 ? v2Lookup.promise : undefined);
    me = { ...OWNER_A, authorizationVersion: 2 };
    const fromChange = commits.length;
    await act(async () => { expect(await useAuthStore.getState().restoreSession()).toBe(true); });
    expect(trigger()).toHaveTextContent('Project agent');
    expect(agentsCalls.map((call) => call.version)).toEqual([1, 2]);

    await act(async () => {
      v2Lookup.resolve({ data: { agents: [{ id: 'main' }, { id: SELECTED, projectAgent: { projectName: null, ownChat: false } }] } });
    });
    await waitFor(() => expect(trigger()).toHaveTextContent('Unavailable Project'));
    expect(commits.slice(fromChange).filter((text) => text.includes(A_NAME))).toEqual([]);

    // Signed out with the selector still mounted: no names and no lookups.
    await act(async () => { useAuthStore.setState({ user: null, isAuthenticated: false }); });
    expect(trigger()).toHaveTextContent('Project agent');
    expect(agentsCalls).toHaveLength(2);
  });
});
