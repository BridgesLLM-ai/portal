// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../contexts/AuthContext';
import { __resetAgentChatProviderCatalogForTests } from '../../utils/agentChatProviderCatalog';
import AgentSelector from './AgentSelector';

const mocks = vi.hoisted(() => ({ clientGet: vi.fn() }));
vi.mock('../../api/client', () => ({ default: { get: mocks.clientGet } }));

const originalInnerWidth = window.innerWidth;
const providerCatalog = [
  { name: 'OPENCLAW', displayName: 'OpenClaw', implemented: true, installed: true, usable: true },
];

const OWN_WEBSITE = `p4oc-${'a1'.repeat(20)}`;
const MEMBER_WEBSITE = `p4oc-${'b2'.repeat(20)}`;
const OWN_REPORT = `p4oc-${'c3'.repeat(20)}`;
const UNAVAILABLE_ONE = `p4oc-${'d4'.repeat(20)}`;
const UNAVAILABLE_TWO = `p4oc-${'e5'.repeat(20)}`;

const describedAgents = [
  { id: 'main', name: 'Main' },
  { id: 'parity', name: 'Parity', model: 'anthropic/claude-opus-5-5' },
  { id: 'kernel', name: 'Kernel' },
  { id: OWN_WEBSITE, projectAgent: { projectName: 'Website redesign', ownChat: true } },
  { id: MEMBER_WEBSITE, projectAgent: { projectName: 'Website redesign', ownChat: false } },
  { id: OWN_REPORT, projectAgent: { projectName: 'Quarterly report', ownChat: true } },
  { id: UNAVAILABLE_ONE, projectAgent: { projectName: null, ownChat: false } },
  { id: UNAVAILABLE_TWO, projectAgent: { projectName: null, ownChat: false } },
];

function serveCatalogs(agents: unknown = describedAgents) {
  mocks.clientGet.mockImplementation(async (url: string) => {
    if (url === '/gateway/harnesses') return { data: { providers: providerCatalog } };
    if (url === '/gateway/agents') {
      if (agents instanceof Promise) return agents;
      return { data: { agents } };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Choose agent' }));
  await screen.findByRole('button', { name: /Parity/ });
  return screen.getByRole('dialog', { name: 'Choose an agent' });
}

const projectToggle = () => screen.getByRole('button', { name: /^Project agents/ });
const rowLabels = (container: HTMLElement) => within(container).getAllByRole('button')
  .map((row) => row.querySelector('.font-medium')?.textContent);

describe('AgentSelector Project agents', () => {
  beforeEach(() => {
    // Project names are shown only to the signed-in actor they were read for.
    useAuthStore.setState({
      user: { id: 'owner-1', email: 'owner@example.invalid', username: 'owner', role: 'OWNER', authorizationVersion: 1 } as any,
      isAuthenticated: true,
    });
  });

  afterEach(() => {
    __resetAgentChatProviderCatalogForTests();
    mocks.clientGet.mockReset();
    useAuthStore.setState({ user: null, isAuthenticated: false });
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  });

  it('keeps generated Project agents in a collapsed group while regular agents stay visible', async () => {
    serveCatalogs();
    const user = userEvent.setup();
    render(<AgentSelector value="OPENCLAW" onChange={vi.fn()} />);
    const dialog = await openPicker(user);

    expect(screen.getByRole('button', { name: /Parity/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Kernel/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Main agent/ })).toBeVisible();
    expect(projectToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(projectToggle()).toHaveTextContent('5');
    expect(screen.queryByRole('group', { name: 'Project agents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Website redesign|Quarterly report/ })).not.toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/p4oc/i);
  });

  it('expands to readable, disambiguated Project names and routes the exact agent id', async () => {
    serveCatalogs();
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AgentSelector value="OPENCLAW" onChange={onChange} />);
    await openPicker(user);

    await user.click(projectToggle());
    expect(projectToggle()).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', { name: 'Project agents' });
    expect(projectToggle()).toHaveAttribute('aria-controls', group.id);
    expect(rowLabels(group)).toEqual([
      'Quarterly report',
      'Unavailable Project · d4d4d4',
      'Unavailable Project · e5e5e5',
      'Website redesign · b2b2b2',
      'Website redesign · yours',
    ]);
    expect(within(group).getByRole('button', { name: /Website redesign · yours/ })).toHaveTextContent('Your Project Chat');
    expect(within(group).getByRole('button', { name: /Website redesign · b2b2b2/ })).toHaveTextContent('Another member’s Project Chat');
    expect(within(group).getByRole('button', { name: /d4d4d4/ })).toHaveTextContent('Project removed or outside your workspace');
    expect(group.textContent).not.toMatch(/p4oc/i);

    await user.click(within(group).getByRole('button', { name: /Website redesign · yours/ }));
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'OPENCLAW', agentId: OWN_WEBSITE });
    expect(localStorage.getItem('agent-chat-agentId')).toBe(OWN_WEBSITE);
    expect(screen.queryByRole('dialog', { name: 'Choose an agent' })).not.toBeInTheDocument();
  });

  it('keeps unavailable Projects selectable without exposing the id as a name', async () => {
    serveCatalogs();
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AgentSelector value="OPENCLAW" onChange={onChange} />);
    await openPicker(user);
    await user.click(projectToggle());

    await user.click(screen.getByRole('button', { name: /Unavailable Project · e5e5e5/ }));
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'OPENCLAW', agentId: UNAVAILABLE_TWO });
  });

  it('starts collapsed again each time the picker opens', async () => {
    serveCatalogs();
    const user = userEvent.setup();
    render(<AgentSelector value="OPENCLAW" onChange={vi.fn()} />);
    await openPicker(user);
    await user.click(projectToggle());
    expect(projectToggle()).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose an agent' })).not.toBeInTheDocument());
    await openPicker(user);
    expect(projectToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Project agents' })).not.toBeInTheDocument();
  });

  it('expands, collapses and selects with the keyboard alone', async () => {
    serveCatalogs();
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AgentSelector value="OPENCLAW" onChange={onChange} />);
    await openPicker(user);

    projectToggle().focus();
    await user.keyboard('{Enter}');
    expect(projectToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(projectToggle()).toHaveFocus();
    await user.keyboard(' ');
    expect(projectToggle()).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Enter}');
    await user.tab();
    expect(screen.getByRole('button', { name: /Quarterly report/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'OPENCLAW', agentId: OWN_REPORT });
  });

  it('finds Project agents by name or id from search without opening the group', async () => {
    serveCatalogs();
    const user = userEvent.setup();
    render(<AgentSelector value="OPENCLAW" onChange={vi.fn()} />);
    await openPicker(user);
    const search = screen.getByRole('searchbox', { name: 'Find an agent' });

    await user.type(search, 'website');
    const matches = screen.getByRole('group', { name: 'Project agents' });
    expect(rowLabels(matches)).toEqual(['Website redesign · b2b2b2', 'Website redesign · yours']);
    expect(screen.queryByRole('button', { name: /^Project agents/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Parity/ })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, OWN_REPORT.slice(0, 12));
    expect(rowLabels(screen.getByRole('group', { name: 'Project agents' }))).toEqual(['Quarterly report']);

    await user.clear(search);
    await user.type(search, 'parity');
    expect(screen.getByRole('button', { name: /Parity/ })).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Project agents' })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'no such agent');
    expect(screen.getByText('No agents match this search.')).toBeInTheDocument();

    await user.clear(search);
    expect(projectToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('names the selected Project agent on the closed trigger and marks it in the collapsed group', async () => {
    let releaseAgents!: (value: unknown) => void;
    serveCatalogs(new Promise((resolve) => { releaseAgents = resolve; }));
    const user = userEvent.setup();
    render(<AgentSelector value="OPENCLAW" agentId={OWN_REPORT} onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Choose agent' });

    expect(trigger).toHaveTextContent('Project agent');
    expect(trigger.textContent).not.toMatch(/p4oc/i);
    await waitFor(() => expect(mocks.clientGet).toHaveBeenCalledWith('/gateway/agents', expect.anything()));
    expect(mocks.clientGet.mock.calls.map(([url]) => url)).toEqual(['/gateway/agents']);

    releaseAgents({ data: { agents: describedAgents } });
    await waitFor(() => expect(trigger).toHaveTextContent('Quarterly report'));
    serveCatalogs();
    await openPicker(user);
    expect(projectToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(projectToggle()).toHaveTextContent('Current');
    expect(trigger).toHaveTextContent('Quarterly report');

    await user.click(projectToggle());
    expect(projectToggle()).not.toHaveTextContent('Current');
    expect(screen.getByRole('button', { name: /Quarterly report/ })).toHaveClass('accent-active');
  });

  it('keeps Project names out of the shared agents cache and labels cached rows safely', async () => {
    serveCatalogs();
    const user = userEvent.setup();
    const first = render(<AgentSelector value="OPENCLAW" onChange={vi.fn()} />);
    await openPicker(user);
    await waitFor(() => expect(localStorage.getItem('agent-chat-agents-cache')).toContain(OWN_REPORT));
    const cache = localStorage.getItem('agent-chat-agents-cache') || '';
    expect(cache).not.toMatch(/Website redesign|Quarterly report/);
    expect(JSON.parse(cache).find((agent: { id: string }) => agent.id === OWN_REPORT)).toEqual({ id: OWN_REPORT, projectAgent: {} });
    expect(JSON.parse(cache).find((agent: { id: string }) => agent.id === 'parity')).toEqual(describedAgents[1]);
    first.unmount();
    __resetAgentChatProviderCatalogForTests();

    // A later visit, before (or without) a fresh description: cached rows only.
    serveCatalogs(new Promise(() => undefined));
    const onChange = vi.fn();
    render(<AgentSelector value="OPENCLAW" agentId={OWN_WEBSITE} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Choose agent' })).toHaveTextContent('Project agent');
    await user.click(screen.getByRole('button', { name: 'Choose agent' }));
    await user.click(await screen.findByRole('button', { name: /^Project agents/ }));
    const group = screen.getByRole('group', { name: 'Project agents' });
    expect(rowLabels(group)).toEqual([
      'Project agent · a1a1a1',
      'Project agent · b2b2b2',
      'Project agent · c3c3c3',
      'Project agent · d4d4d4',
      'Project agent · e5e5e5',
    ]);
    await user.click(within(group).getByRole('button', { name: /c3c3c3/ }));
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'OPENCLAW', agentId: OWN_REPORT });
  });

  it('groups generated agents from an older cache that has no Project marker', async () => {
    localStorage.setItem('agent-chat-agents-cache', JSON.stringify([
      { id: 'main' }, { id: 'parity', name: 'Parity' }, { id: OWN_REPORT },
    ]));
    serveCatalogs(new Promise(() => undefined));
    const user = userEvent.setup();
    render(<AgentSelector value="OPENCLAW" onChange={vi.fn()} />);
    await openPicker(user);
    expect(projectToggle()).toHaveTextContent('1');
    await user.click(projectToggle());
    expect(rowLabels(screen.getByRole('group', { name: 'Project agents' }))).toEqual(['Project agent']);
    expect(screen.getByRole('dialog', { name: 'Choose an agent' }).textContent).not.toMatch(/p4oc/i);
  });

  it('leaves regular and main agent routing unchanged', async () => {
    serveCatalogs();
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AgentSelector value="OPENCLAW" agentId={OWN_REPORT} onChange={onChange} />);
    await openPicker(user);
    await user.click(screen.getByRole('button', { name: /Parity/ }));
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'OPENCLAW', agentId: 'parity' });
    expect(localStorage.getItem('agent-chat-agentId')).toBe('parity');

    await openPicker(user);
    await user.click(screen.getByRole('button', { name: /Main agent/ }));
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'OPENCLAW', agentId: undefined });
    expect(localStorage.getItem('agent-chat-agentId')).toBeNull();
  });

  it('labels the selected Project agent’s conversations without the generated id', async () => {
    serveCatalogs();
    const { unmount } = render(
      <AgentSelector
        value="OPENCLAW"
        agentId={OWN_REPORT}
        onChange={vi.fn()}
        onViewSession={vi.fn()}
        currentSessionKey={`agent:${OWN_REPORT}:portal-new-1760000000000`}
      />,
    );
    await waitFor(() => expect(screen.getByTitle('Quarterly report sessions')).toHaveTextContent(/^Quarterly report \/ New chat/));
    expect(document.body.textContent).not.toMatch(/p4oc/i);
    unmount();

    render(
      <AgentSelector value="OPENCLAW" agentId="parity" onChange={vi.fn()} onViewSession={vi.fn()} currentSessionKey="agent:parity:main" />,
    );
    expect(screen.getByTitle('Parity sessions')).toHaveTextContent('parity / main session');
  });

  it('scrolls the list just far enough to show an opened group, never past its header', async () => {
    serveCatalogs();
    // jsdom has no layout, so give the list, the group header and the group a geometry.
    const geometry = { listTop: 100, listBottom: 520, toggleTop: 480, groupBottom: 820 };
    const box = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 336, width: 336, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const rects = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('overflow-y-auto') && this.closest('[role="dialog"]')) return box(geometry.listTop, geometry.listBottom);
      if (this.getAttribute('aria-expanded') !== null && this.textContent?.startsWith('Project agents')) return box(geometry.toggleTop, geometry.toggleTop + 40);
      if (this.getAttribute('role') === 'group') return box(geometry.toggleTop + 40, geometry.groupBottom);
      return box(0, 0);
    });
    try {
      const user = userEvent.setup();
      render(<AgentSelector value="OPENCLAW" onChange={vi.fn()} />);
      const dialog = await openPicker(user);
      const list = dialog.querySelector('.overflow-y-auto') as HTMLElement;

      await user.click(projectToggle());
      expect(list.scrollTop).toBe(300); // all 300px of hidden rows, header stays 80px below the top

      await user.click(projectToggle());
      list.scrollTop = 0;
      Object.assign(geometry, { toggleTop: 140, groupBottom: 1000 });
      await user.click(projectToggle());
      expect(list.scrollTop).toBe(40); // capped so the header lands at the top of the list

      await user.click(projectToggle());
      list.scrollTop = 0;
      Object.assign(geometry, { toggleTop: 200, groupBottom: 400 });
      await user.click(projectToggle());
      expect(list.scrollTop).toBe(0); // already visible: no scroll
    } finally {
      rects.mockRestore();
    }
  });

  it('works the same in the mobile sheet', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 720 });
    serveCatalogs();
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AgentSelector value="OPENCLAW" onChange={onChange} />);
    await openPicker(user);
    expect(projectToggle()).toHaveAttribute('aria-expanded', 'false');
    await user.click(projectToggle());
    await user.click(screen.getByRole('button', { name: /Website redesign · b2b2b2/ }));
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'OPENCLAW', agentId: MEMBER_WEBSITE });
  });
});
