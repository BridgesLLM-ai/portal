// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../contexts/AuthContext';
import {
  __resetAgentChatProviderCatalogForTests,
  invalidateAgentChatProviderCatalog,
} from '../../utils/agentChatProviderCatalog';
import AgentSelector from './AgentSelector';

const mocks = vi.hoisted(() => ({ clientGet: vi.fn() }));
const originalInnerWidth = window.innerWidth;

function useMobileViewport() {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 720 });
}

const providerCatalog = [
  { name: 'OPENCLAW', displayName: 'OpenClaw', implemented: true, installed: true, usable: true },
  { name: 'CODEX', displayName: 'Codex', implemented: true, installed: true, usable: true, native: true },
  { name: 'AGENT_ZERO', displayName: 'Agent Zero', implemented: true, installed: true, usable: true },
];

const manyOpenClawAgents = [
  { id: 'main', name: 'Main' },
  ...Array.from({ length: 24 }, (_, index) => ({
    id: `openclaw-agent-${index + 1}`,
    name: `OpenClaw Agent ${String(index + 1).padStart(2, '0')}`,
    model: 'openai/gpt-5.5',
  })),
];

function mockProviderAndAgentCatalogs() {
  localStorage.setItem('agent-chat-agents-cache', JSON.stringify(manyOpenClawAgents));
  mocks.clientGet.mockImplementation(async (url: string) => {
    if (url === '/gateway/providers') return { data: { providers: providerCatalog } };
    if (url === '/gateway/agents') return { data: { agents: manyOpenClawAgents } };
    throw new Error(`Unexpected GET ${url}`);
  });
}

vi.mock('../../api/client', () => ({
  default: { get: mocks.clientGet },
}));

describe('AgentSelector', () => {
  afterEach(() => {
    useAuthStore.setState({ isAuthenticated: false, user: null });
    __resetAgentChatProviderCatalogForTests();
    mocks.clientGet.mockReset();
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  });

  it('renders the selected sub-agent avatar supplied by authenticated client settings', () => {
    useAuthStore.setState({ isAuthenticated: true });
    const { container } = render(
      <AgentSelector
        value="OPENCLAW"
        agentId="customer-project"
        onChange={vi.fn()}
        subAgentAvatars={{ 'customer-project': '/static-assets/avatars/customer-project.png' }}
      />,
    );

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      '/static-assets/avatars/customer-project.png',
    );
    expect(mocks.clientGet).not.toHaveBeenCalled();
  });

  it('blocks provider navigation while a model transition is in flight', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentSelector
        value="OPENCLAW"
        onChange={onChange}
        disabled
      />,
    );

    const selector = screen.getByRole('button', { name: 'Select agent provider' });
    expect(selector).toBeDisabled();
    await user.click(selector);
    expect(onChange).not.toHaveBeenCalled();
    expect(mocks.clientGet).not.toHaveBeenCalled();
  });

  it('lists every provider before a long OpenClaw agent catalog', async () => {
    mockProviderAndAgentCatalogs();
    const user = userEvent.setup();
    render(<AgentSelector value="OPENCLAW" onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Select agent provider' }));

    const codex = await screen.findByRole('button', { name: /Codex/i });
    const agentZero = screen.getByRole('button', { name: /Agent Zero/i });
    const agentGroup = screen.getByRole('group', { name: 'OpenClaw agents' });
    const firstOpenClawAgent = within(agentGroup).getByRole('button', { name: /OpenClaw Agent 01/i });

    expect(codex).toBeVisible();
    expect(agentZero).toBeVisible();
    expect(codex.compareDocumentPosition(firstOpenClawAgent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(agentZero.compareDocumentPosition(firstOpenClawAgent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('updates a cold checking provider row in place when shared polling settles it', async () => {
    let providerRequestCount = 0;
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/providers') {
        providerRequestCount += 1;
        return {
          data: {
            providers: providerRequestCount === 1
              ? [{
                  name: 'CODEX',
                  displayName: 'Codex',
                  installed: null,
                  implemented: true,
                  usable: false,
                  native: true,
                  availabilityState: 'checking',
                  checking: true,
                  stale: false,
                }]
              : [{
                  name: 'CODEX',
                  displayName: 'Codex',
                  installed: true,
                  implemented: true,
                  usable: true,
                  native: true,
                  availabilityState: 'ready',
                  checking: false,
                  stale: false,
                }],
          },
        };
      }
      if (url === '/gateway/agents') return { data: { agents: [] } };
      throw new Error(`Unexpected GET ${url}`);
    });
    const user = userEvent.setup();
    render(<AgentSelector value="CODEX" onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Select agent provider' }));
    const codex = await screen.findByRole('button', { name: /Codex/i });
    expect(codex).toBeDisabled();
    expect(within(codex).getByText('Checking')).toBeInTheDocument();

    await waitFor(() => expect(codex).toBeEnabled(), { timeout: 2_500 });
    expect(within(codex).getByText('Native')).toBeInTheDocument();
    expect(providerRequestCount).toBe(2);
  });

  it('keeps ready rows selectable while a slower provider row is still checking', async () => {
    let providerRequestCount = 0;
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/providers') {
        providerRequestCount += 1;
        return {
          data: {
            providers: [
              {
                name: 'OPENCLAW',
                displayName: 'OpenClaw',
                installed: true,
                implemented: true,
                usable: true,
                availabilityState: 'ready',
                checking: false,
                stale: false,
              },
              {
                name: 'CODEX',
                displayName: 'Codex',
                installed: providerRequestCount === 1 ? null : true,
                implemented: true,
                usable: providerRequestCount !== 1,
                native: true,
                availabilityState: providerRequestCount === 1 ? 'checking' : 'ready',
                checking: providerRequestCount === 1,
                stale: false,
              },
            ],
          },
        };
      }
      if (url === '/gateway/agents') return { data: { agents: [] } };
      throw new Error(`Unexpected GET ${url}`);
    });
    const user = userEvent.setup();
    render(<AgentSelector value="CODEX" onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Select agent provider' }));
    const openClaw = await screen.findByRole('button', { name: /OpenClaw/i });
    const codex = screen.getByRole('button', { name: /Codex/i });

    expect(openClaw).toBeEnabled();
    expect(codex).toBeDisabled();
    expect(within(codex).getByText('Checking')).toBeInTheDocument();
    await waitFor(() => expect(codex).toBeEnabled(), { timeout: 2_500 });
  });

  it('keeps Codex and Agent Zero directly selectable with many OpenClaw agents', async () => {
    mockProviderAndAgentCatalogs();
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AgentSelector value="OPENCLAW" onChange={onChange} />);

    const selector = screen.getByRole('button', { name: 'Select agent provider' });
    await user.click(selector);
    await user.click(await screen.findByRole('button', { name: /Codex/i }));
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'CODEX', agentId: undefined });

    await user.click(selector);
    await user.click(await screen.findByRole('button', { name: /Agent Zero/i }));
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'AGENT_ZERO', agentId: undefined });
  });

  it('loads selected native-provider capabilities before the selector opens so history is not hidden', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/providers') {
        return {
          data: {
            providers: [
              {
                name: 'CODEX',
                displayName: 'Codex',
                implemented: true,
                installed: true,
                usable: true,
                native: true,
                capabilities: { supportsSessionList: true },
              },
            ],
          },
        };
      }
      if (url === '/gateway/sessions') {
        return {
          data: {
            sessions: [{ key: 'provider:codex:session-1', status: 'active', title: 'First native session' }],
          },
        };
      }
      if (url === '/gateway/agents') return { data: { agents: [] } };
      throw new Error(`Unexpected GET ${url}`);
    });
    const user = userEvent.setup();
    render(<AgentSelector value="CODEX" onChange={vi.fn()} onViewSession={vi.fn()} />);

    const history = await screen.findByTitle('Codex sessions');
    expect(screen.getByRole('button', { name: 'Select agent provider' })).toHaveAttribute('aria-expanded', 'false');
    await user.click(history);

    expect(await screen.findByText('First native session')).toBeInTheDocument();
    expect(mocks.clientGet).toHaveBeenCalledWith(
      '/gateway/sessions',
      expect.objectContaining({ params: { provider: 'CODEX' } }),
    );
  });

  it('shows the live dot only for run-attested sessions, never every retained active session', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/providers') {
        return {
          data: {
            providers: [{
              name: 'CODEX',
              displayName: 'Codex',
              implemented: true,
              installed: true,
              usable: true,
              native: true,
              capabilities: { supportsSessionList: true },
            }],
          },
        };
      }
      if (url === '/gateway/sessions') {
        return {
          data: {
            sessions: [
              { sessionId: 'idle-session', status: 'active', runActive: false, title: 'Idle history' },
              { sessionId: 'running-session', status: 'active', runActive: true, title: 'Running task' },
            ],
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    const user = userEvent.setup();
    const view = render(
      <AgentSelector
        value="CODEX"
        onChange={vi.fn()}
        onViewSession={vi.fn()}
        currentSessionKey="idle-session"
        currentSessionActive={false}
      />,
    );

    const history = await screen.findByTitle('Codex sessions');
    expect(screen.getByLabelText('Codex has an active turn')).toBeInTheDocument();
    await user.click(history);
    expect(await screen.findByLabelText('Running task has an active turn')).toBeInTheDocument();
    expect(screen.queryByLabelText('Idle history has an active turn')).not.toBeInTheDocument();

    view.rerender(
      <AgentSelector
        value="CODEX"
        onChange={vi.fn()}
        onViewSession={vi.fn()}
        currentSessionKey="running-session"
        currentSessionActive={false}
      />,
    );
    expect(screen.queryByLabelText('Codex has an active turn')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Running task has an active turn')).not.toBeInTheDocument();
  });

  it('shows a sanitized live activity title, then falls back to the durable session title', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    const sessionKey = 'agent:main:parallel-work';
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/providers') return { data: { providers: providerCatalog } };
      if (url === '/gateway/sessions') {
        return {
          data: {
            sessions: [{
              key: sessionKey,
              status: 'active',
              title: 'Durable session name',
              preview: 'Durable preview',
            }],
          },
        };
      }
      if (url === '/gateway/agents') return { data: { agents: [] } };
      throw new Error(`Unexpected GET ${url}`);
    });
    const user = userEvent.setup();
    const view = render(
      <AgentSelector
        value="OPENCLAW"
        onChange={vi.fn()}
        onViewSession={vi.fn()}
        currentSessionKey={sessionKey}
        activityTitles={{ [sessionKey]: '**Inspecting runtime** password=hunter2' }}
      />,
    );

    const history = await screen.findByTitle('OpenClaw sessions');
    expect(history).toHaveTextContent('Inspecting runtime [redacted]');
    expect(history).not.toHaveTextContent('hunter2');
    await user.click(history);
    expect((await screen.findAllByText('Inspecting runtime [redacted]')).length).toBeGreaterThanOrEqual(2);

    view.rerender(
      <AgentSelector
        value="OPENCLAW"
        onChange={vi.fn()}
        onViewSession={vi.fn()}
        currentSessionKey={sessionKey}
        activityTitles={{}}
      />,
    );
    expect(history).toHaveTextContent('Durable session name');
    expect(screen.getAllByText('Durable session name').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps fresh native-provider history available while the provider catalog is unresolved', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    mocks.clientGet.mockImplementation((url: string) => {
      if (url === '/gateway/providers') return new Promise(() => {});
      if (url === '/gateway/sessions') {
        return Promise.resolve({
          data: {
            sessions: [{ key: 'provider:codex:pending-catalog', status: 'active', title: 'History without catalog' }],
          },
        });
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    const user = userEvent.setup();
    render(<AgentSelector value="CODEX" onChange={vi.fn()} onViewSession={vi.fn()} />);

    const history = screen.getByTitle('Codex sessions');
    await user.click(history);

    expect(await screen.findByText('History without catalog')).toBeInTheDocument();
    expect(mocks.clientGet).toHaveBeenCalledWith(
      '/gateway/sessions',
      expect.objectContaining({ params: { provider: 'CODEX' } }),
    );
  });

  it('keeps native history independently retryable when the provider catalog rejects', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    let sessionRequestCount = 0;
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/providers') throw new Error('provider catalog unavailable');
      if (url === '/gateway/sessions') {
        sessionRequestCount += 1;
        if (sessionRequestCount === 1) throw new Error('session list temporarily unavailable');
        return {
          data: {
            sessions: [{ key: 'provider:codex:retry', status: 'active', title: 'History after retry' }],
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    const user = userEvent.setup();
    render(<AgentSelector value="CODEX" onChange={vi.fn()} onViewSession={vi.fn()} />);

    const history = screen.getByTitle('Codex sessions');
    await user.click(history);
    await waitFor(() => expect(sessionRequestCount).toBe(1));
    expect(await screen.findByRole('alert')).toHaveTextContent('Session history could not be refreshed');
    await user.click(screen.getByRole('button', { name: 'Retry session history' }));

    expect(await screen.findByText('History after retry')).toBeInTheDocument();
    expect(sessionRequestCount).toBe(2);
  });

  it('hides native history when the provider catalog explicitly denies session listing', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/providers') {
        return {
          data: {
            providers: [
              {
                name: 'CODEX',
                displayName: 'Codex',
                implemented: true,
                installed: true,
                usable: true,
                native: true,
                capabilities: { supportsSessionList: false },
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    render(<AgentSelector value="CODEX" onChange={vi.fn()} onViewSession={vi.fn()} />);

    await waitFor(() => expect(screen.queryByTitle('Codex sessions')).not.toBeInTheDocument());
    expect(mocks.clientGet).not.toHaveBeenCalledWith('/gateway/sessions', expect.anything());
  });

  it('restores the desktop trigger after Escape dismisses the shared popover', async () => {
    mockProviderAndAgentCatalogs();
    const user = userEvent.setup();
    render(<AgentSelector value="OPENCLAW" onChange={vi.fn()} />);
    const opener = screen.getByRole('button', { name: 'Select agent provider' });

    await user.click(opener);
    expect(await screen.findByRole('dialog', { name: 'Available agent providers' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Available agent providers' })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('preserves the last good provider catalog when a refresh fails', async () => {
    let providerRequestCount = 0;
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/providers') {
        providerRequestCount += 1;
        if (providerRequestCount === 1) return { data: { providers: providerCatalog } };
        throw new Error('temporary provider catalog outage');
      }
      if (url === '/gateway/agents') return { data: { agents: [{ id: 'main', name: 'Main' }] } };
      throw new Error(`Unexpected GET ${url}`);
    });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AgentSelector value="CODEX" onChange={onChange} />);

    const selector = screen.getByRole('button', { name: 'Select agent provider' });
    await user.click(selector);
    expect(await screen.findByRole('button', { name: /Agent Zero/i })).toBeVisible();
    await waitFor(() => expect(screen.queryByText(/Loading available agents and providers/i)).not.toBeInTheDocument());

    await user.click(selector);
    invalidateAgentChatProviderCatalog();
    await user.click(selector);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t refresh providers. Showing the last available list.',
    );
    expect(screen.getByRole('button', { name: /Codex/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Agent Zero/i })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not silently switch away from a provider while its row is rechecking', async () => {
    let providerRequestCount = 0;
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/providers') {
        providerRequestCount += 1;
        if (providerRequestCount === 1) return { data: { providers: providerCatalog } };
        return {
          data: {
            providers: providerCatalog.map((entry) => (
              entry.name === 'CODEX'
                ? {
                    ...entry,
                    usable: false,
                    availabilityState: 'stale',
                    checking: true,
                    stale: true,
                    lastKnownUsable: true,
                  }
                : entry
            )),
          },
        };
      }
      if (url === '/gateway/agents') return { data: { agents: [{ id: 'main', name: 'Main' }] } };
      throw new Error(`Unexpected GET ${url}`);
    });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AgentSelector value="CODEX" onChange={onChange} />);

    const selector = screen.getByRole('button', { name: 'Select agent provider' });
    await user.click(selector);
    expect(await screen.findByRole('button', { name: /Agent Zero/i })).toBeVisible();
    await waitFor(() => expect(screen.queryByText(/Loading available agents and providers/i)).not.toBeInTheDocument());

    await user.click(selector);
    invalidateAgentChatProviderCatalog();
    await user.click(selector);

    expect(await screen.findByText('Rechecking')).toBeInTheDocument();
    expect(selector).toHaveTextContent('Codex');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the current selection on a cold failure and recovers through retry', async () => {
    let providerRequestCount = 0;
    localStorage.setItem('agent-chat-agents-cache', JSON.stringify(manyOpenClawAgents));
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/providers') {
        providerRequestCount += 1;
        if (providerRequestCount === 1) throw new Error('provider catalog unavailable');
        return { data: { providers: providerCatalog } };
      }
      if (url === '/gateway/agents') return { data: { agents: manyOpenClawAgents } };
      throw new Error(`Unexpected GET ${url}`);
    });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AgentSelector value="CODEX" onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Select agent provider' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t load providers. Your current selection is unchanged.',
    );
    expect(screen.queryByRole('button', { name: /OpenClaw/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'OpenClaw agents' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Retry loading providers' }));

    expect(await screen.findByRole('button', { name: /Agent Zero/i })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(providerRequestCount).toBe(2);
  });

  it('cancels the shared provider request when its final mounted consumer unmounts', async () => {
    let requestSignal: AbortSignal | undefined;
    mocks.clientGet.mockImplementation((url: string, config?: { signal?: AbortSignal }) => {
      if (url === '/gateway/providers') {
        requestSignal = config?.signal;
        return new Promise(() => {});
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    const { unmount } = render(
      <AgentSelector
        value="CODEX"
        onChange={vi.fn()}
        onViewSession={vi.fn()}
      />,
    );
    await waitFor(() => expect(requestSignal).toBeDefined());

    unmount();

    expect(requestSignal?.aborted).toBe(true);
  });

  it('uses the shared modal sheet on mobile and restores focus after Escape', async () => {
    useMobileViewport();
    mockProviderAndAgentCatalogs();
    const user = userEvent.setup();
    const { container } = render(
      <div style={{ transform: 'translate3d(0, 0, 0)' }}>
        <AgentSelector value="OPENCLAW" onChange={vi.fn()} onViewSession={vi.fn()} />
      </div>,
    );
    const opener = screen.getByRole('button', { name: 'Select agent provider' });

    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Available agent providers' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.closest('[data-anchored-popover-mode="sheet"]')).not.toBeNull();
    expect(container).not.toContainElement(dialog);
    expect(container).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('button', { name: 'Close agent selector' })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('z-[9998]');
    expect(document.body.innerHTML).not.toContain('z-[9999]');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Available agent providers' })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());

    const sessionOpener = screen.getByTitle('OpenClaw sessions');
    await user.click(sessionOpener);
    const sessionDialog = await screen.findByRole('dialog', { name: 'OpenClaw sessions' });
    expect(sessionDialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Close session selector' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close session selector' }));
    await waitFor(() => expect(sessionDialog).not.toBeInTheDocument());
    await waitFor(() => expect(sessionOpener).toHaveFocus());
    expect(document.body.style.overflow).toBe('');
  });

  it('scopes session history to the default agent instead of every agent at once', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    const sessionParams: Array<Record<string, string> | undefined> = [];
    mocks.clientGet.mockImplementation(async (url: string, config?: any) => {
      if (url === '/gateway/providers') return { data: { providers: providerCatalog } };
      if (url === '/gateway/agents') return { data: { agents: manyOpenClawAgents } };
      if (url === '/gateway/sessions') {
        sessionParams.push(config?.params);
        return { data: { sessions: [] } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    render(
      <AgentSelector
        value="OPENCLAW"
        onChange={vi.fn()}
        onViewSession={vi.fn()}
        currentSessionKey="agent:main:main"
      />,
    );

    await waitFor(() => expect(sessionParams.length).toBeGreaterThan(0));
    // Omitting agentId made the server answer for every agent, so the main
    // agent's history came back mixed with other agents' sessions.
    expect(sessionParams[0]).toEqual({ agentId: 'main' });
  });

  it('refetches history scoped to the main agent when returning from a sub-agent', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    const requestedAgentIds: Array<string | undefined> = [];
    mocks.clientGet.mockImplementation(async (url: string, config?: any) => {
      if (url === '/gateway/providers') return { data: { providers: providerCatalog } };
      if (url === '/gateway/agents') return { data: { agents: manyOpenClawAgents } };
      if (url === '/gateway/sessions') {
        requestedAgentIds.push(config?.params?.agentId);
        return { data: { sessions: [] } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    const view = render(
      <AgentSelector
        value="OPENCLAW"
        agentId="openclaw-agent-1"
        onChange={vi.fn()}
        onViewSession={vi.fn()}
        currentSessionKey="agent:openclaw-agent-1:main"
      />,
    );
    await waitFor(() => expect(requestedAgentIds).toContain('openclaw-agent-1'));

    view.rerender(
      <AgentSelector
        value="OPENCLAW"
        onChange={vi.fn()}
        onViewSession={vi.fn()}
        currentSessionKey="agent:main:main"
      />,
    );
    await waitFor(() => expect(requestedAgentIds).toContain('main'));
  });

  it('keeps the default agent selectable while its availability row is rechecking', async () => {
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/providers') {
        return {
          data: {
            providers: [{
              name: 'OPENCLAW',
              displayName: 'OpenClaw',
              installed: true,
              implemented: true,
              usable: false,
              availabilityState: 'stale',
              checking: true,
              stale: true,
            }],
          },
        };
      }
      if (url === '/gateway/agents') {
        return {
          data: {
            agents: [
              { id: 'main', name: 'Main' },
              { id: 'helper-one', name: 'Helper One' },
            ],
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentSelector value="OPENCLAW" agentId="helper-one" onChange={onChange} />,
    );

    await user.click(screen.getByRole('button', { name: 'Select agent provider' }));
    // A sub-agent row is always selectable, so the row that returns to the
    // default agent must be too. Gating it on availability made "go back to
    // the main agent" a no-op during a routine recheck.
    const defaultAgentRow = await screen.findByRole('button', { name: /OpenClaw/i });
    expect(defaultAgentRow).toBeEnabled();
    await user.click(defaultAgentRow);
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'OPENCLAW', agentId: undefined });
  });
});
