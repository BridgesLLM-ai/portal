// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkCard, ProjectWorkActivity, ProjectWorkAttention, ProjectWorkDock, mergeProjectWorkTimeline, ProjectWorkComposer, useProjectWork, type WorkCard } from './ProjectWork';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), list: vi.fn(),
  user: { id: 'owner', role: 'OWNER', authorizationVersion: 1 } as any,
  selectProviderAgent: vi.fn(), selectSession: vi.fn(), setSession: vi.fn(), preference: vi.fn(async () => ({})),
}));
vi.mock('../../api/client', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('../../api/endpoints', () => ({ projectsAPI: { list: mocks.list }, gatewayAPI: {} }));
vi.mock('../../contexts/AuthContext', () => ({ useAuthStore: Object.assign((select: any) => select({ user: mocks.user }), { getState: () => ({ user: mocks.user }) }) }));
vi.mock('../../contexts/ChatStateProvider', () => ({ useChatState: () => ({ selectProviderAgent: mocks.selectProviderAgent, selectSession: mocks.selectSession, setSession: mocks.setSession }) }));
vi.mock('../../api/agentHarnessPreference', () => ({ loadAndApplyDefaultAgentHarness: mocks.preference }));
vi.mock('./MarkdownRenderer', () => ({ default: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('./AskUserQuestionCard', () => ({ default: ({ request }: any) => <p>{request.questions[0].question}</p> }));
const projects = ['studio', 'shop'].map((name, i) => ({ name, identity: { id: `project-${i}`, generation: 1 }, deployedUrl: '', availability: { available: true } }));
const saved: WorkCard = { id: 'a3fcc771-4a00-4fbe-b448-305388042f26', originProvider: 'CODEX', originSessionKey: 'main',
  projectIdentityId: 'project-0', projectGeneration: 1, provider: 'CODEX', model: 'model-one', projectName: 'studio',
  prompt: 'Add a contact form', createdAt: new Date().toISOString(), parentCardId: null,
  projectIdentity: { projectName: 'studio', generation: 1, lifecycleStatus: 'ACTIVE' }, scopeValid: true, turn: null };
let cards: WorkCard[]; let statuses: Record<string, string>;
let controller: ReturnType<typeof useProjectWork>;
function App({ provider = 'CODEX', session = 'main' }: { provider?: string; session?: string }) {
  const work = useProjectWork(provider, session, 'model-one'); controller = work;
  return <><ProjectWorkDock work={work} /><ProjectWorkComposer work={work} />{work.activeCards.map(card => <ProjectWorkAttention key={card.id} card={card} active={true} />)}<output data-testid="rail">{work.activity?.statusText}</output>{mergeProjectWorkTimeline([], work.cards, work.replays).map(item => item.kind === 'work' ? <ProjectWorkCard key={item.card.id} card={item.card} work={work} /> : item.kind === 'work-activity' ? <ProjectWorkActivity key={`${item.card.id}:${item.activity.id}`} card={item.card} activity={item.activity} active={Boolean(work.replays[item.card.id]?.active)} /> : null)}</>;
}
const mount = (props = {}) => render(<MemoryRouter><App {...props} /></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks(); HTMLElement.prototype.scrollIntoView = vi.fn(); cards = []; statuses = {}; mocks.user = { id: 'owner', role: 'OWNER', authorizationVersion: 1 };
  mocks.list.mockResolvedValue({ projects });
  mocks.get.mockImplementation(async (url: string) => {
    if (url === '/project-work') return { data: { cards: [...cards] } };
    if (url.endsWith('/poll')) {
      const id = url.split('/')[2]; const status = statuses[id] || 'not_started';
      return { data: { status, active: status === 'running', complete: status === 'completed', events: [], text: status === 'completed' ? 'The requested contact form is ready.' : '', lineCount: 0 } };
    }
    if (url.endsWith('/approvals')) return { data: { approvals: [] } };
    if (url.endsWith('/questions')) return { data: { questions: [] } };
    if (url.endsWith('/files')) return { data: { tree: [{ name: 'index.html', path: 'index.html', type: 'file', gitStatus: 'M' }] } };
    if (url.endsWith('/file')) return { data: { content: '<h1>Studio project</h1>' } };
    throw new Error(`Unexpected GET ${url}`);
  });
  mocks.post.mockImplementation(async (url: string, body: any) => {
    if (url === '/gateway/session-create') return { data: { ok: true, key: 'codex-conversation-one' } };
    if (url === '/project-work') {
      const project = projects.find((entry) => entry.identity.id === body.projectIdentityId)!;
      const card = { ...saved, ...body, model: body.model || null, projectName: project.name, projectIdentity: { ...saved.projectIdentity, projectName: project.name } };
      cards.push(card); return { data: card };
    }
    if (url.endsWith('/send')) { statuses[url.split('/')[2]] = 'running'; return { data: { accepted: true } }; }
    if (url.endsWith('/stop')) return { data: { ok: true } };
    throw new Error(`Unexpected POST ${url}`);
  });
});
afterEach(() => vi.useRealTimers());
describe('Project work inside Agent Chat', () => {
  it('selects one explicit folder and sends direct work without any sandbox startup calls', async () => {
    const user = userEvent.setup(); mount();
    await user.click(screen.getByRole('button', { name: 'Work in a project' }));
    await user.click(await screen.findByRole('button', { name: 'studio' }));
    expect(screen.getByText('Project working folder · Agent Chat permissions')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Project request for studio' }), 'Make the contact form');
    await user.click(screen.getByRole('button', { name: 'Start project work' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(expect.stringMatching(/\/send$/), {}, expect.any(Object)));
    const admission = mocks.post.mock.calls.find(([url]) => url === '/project-work')![1];
    expect(admission).toMatchObject({ projectIdentityId: 'project-0', projectGeneration: 1, provider: 'CODEX', prompt: 'Make the contact form' });
    expect(JSON.stringify(mocks.post.mock.calls)).not.toMatch(/qualify|prepare|assistant\/send|chat\/provider/);
    expect(await screen.findByTestId('project-work-card')).toHaveTextContent('studio');
    expect(screen.queryByLabelText('Project request for studio')).not.toBeInTheDocument();
  });
  it('reload displays persisted work and completion without dispatching or resending', async () => {
    cards = [saved]; statuses[saved.id] = 'completed'; mount();
    expect(await screen.findByText('The requested contact form is ready.')).toBeInTheDocument();
    expect(within(screen.getByTestId('project-work-card')).getByRole('status')).toHaveTextContent('Agent finished');
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('switching projects while admission is pending cannot retarget the submitted work', async () => {
    mount({ session: 'codex-existing' }); await waitFor(() => expect(controller.projects).toHaveLength(2));
    let finish: (value: any) => void = () => {};
    mocks.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => controller.choose(projects[0] as any));
    let pending: Promise<boolean>;
    act(() => { pending = controller.submit('Only studio'); });
    act(() => controller.choose(projects[1] as any));
    await act(async () => { finish({ data: { ...saved, prompt: 'Only studio' } }); await pending; });
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ projectIdentityId: 'project-0', prompt: 'Only studio' });
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(`/project-work/${saved.id}/send`, {}, expect.any(Object)));
  });
  it('a replaced project has no execution or file actions', async () => {
    cards = [{ ...saved, scopeValid: false }]; mount();
    expect((await screen.findAllByText('Project changed')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Open workspace' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Start work' })).not.toBeInTheDocument();
    expect(mocks.get.mock.calls.some(([url]) => String(url).endsWith('/poll'))).toBe(false);
  });
  it('opening a workspace reads through the card, and renders file contents as text', async () => {
    const user = userEvent.setup(); cards = [saved]; statuses[saved.id] = 'completed'; mount();
    await user.click(await screen.findByRole('button', { name: 'Open workspace' }));
    expect(await screen.findByRole('region', { name: 'Project workspace dock' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Preview index.html' }));
    expect(await screen.findByText('<h1>Studio project</h1>')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith(`/project-work/${saved.id}/file`, expect.objectContaining({ params: { path: 'index.html' } }));
    expect(screen.queryByRole('heading', { name: 'Studio project' })).not.toBeInTheDocument();
  });
  it('follow-up pins the previous worker, model and project', async () => {
    cards = [saved]; statuses[saved.id] = 'completed'; const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole('button', { name: 'Continue this work' }));
    expect(screen.getByRole('button', { name: 'Project worker' })).toHaveTextContent('Codex');
    await user.type(screen.getByRole('textbox', { name: 'Project request for studio' }), 'Make it accessible');
    await user.click(screen.getByRole('button', { name: 'Start project work' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/project-work', expect.objectContaining({ parentCardId: saved.id, model: 'model-one', projectIdentityId: 'project-0' }), expect.any(Object)));
  });
  it('hides project work controls from a non-admin actor', () => {
    mocks.user = { id: 'regular-user', role: 'USER', authorizationVersion: 1 }; mount();
    expect(screen.queryByTestId('project-work-composer')).not.toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

it('creates a durable native parent before its first project-only conversation, without inference', async () => {
  mount();
  await waitFor(() => expect(controller.projects).toHaveLength(2));
  act(() => controller.choose(projects[0] as any));
  await act(async () => { await controller.submit('Update the studio'); });
  const calls = mocks.post.mock.calls;
  expect(calls[0]).toEqual(['/gateway/session-create', { provider: 'CODEX', session: 'main', model: 'model-one' }, expect.anything()]);
  const create = calls.find(([url]) => url === '/project-work');
  expect(create?.[1].originSessionKey).toBe('codex-conversation-one');
  expect(mocks.setSession).toHaveBeenCalledWith('codex-conversation-one');
  expect(calls.some(([url]) => url === '/gateway/send')).toBe(false);
});

it('worker activity belongs in the conversation and rail, with a persistent project dock', async () => {
  cards = [saved]; statuses[saved.id] = 'running';
  const fallback = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, config: any) => {
    if (!url.endsWith('/poll')) return fallback(url, config);
    return { data: { status: 'running', active: true, complete: false, text: '', phase: 'tool', activeToolCall: 'read', statusText: 'Inspecting the form', events: [
      { schema: 'bridgesllm.runtime-turn-event.v1', type: 'assistant_reasoning', runId: 'r', seq: 1, ts: Date.now(), visible: true, text: 'Checking the existing form.' },
      { schema: 'bridgesllm.runtime-turn-event.v1', type: 'tool_output', runId: 'r', seq: 2, ts: Date.now()+1, visible: true, tool: { id: 't', name: 'read', status: 'done', result: 'Project file contents' } },
    ] } };
  });
  mount();
  expect(await screen.findByText('Checking the existing form.')).toBeInTheDocument();
  expect(screen.getAllByTestId('project-work-activity')).toHaveLength(2);
  expect(screen.getByTestId('project-work-card')).not.toHaveTextContent('Checking the existing form.');
  expect(screen.getByTestId('rail')).toHaveTextContent('studio · Inspecting the form');
  expect(screen.getByTestId('project-work-dock')).toHaveTextContent('In progress');
  expect(mocks.post).not.toHaveBeenCalled();
});
it('the themed worker chooser selects an actual worker without dispatching', async () => {
  const user = userEvent.setup(); mount();
  await waitFor(() => expect(controller.projects).toHaveLength(2));
  act(() => controller.choose(projects[0] as any));
  await user.click(screen.getByRole('button', { name: 'Project worker' }));
  const dialog = screen.getByRole('dialog', { name: 'Choose project worker' });
  await user.click(within(dialog).getByRole('button', { name: /Claude Code/ }));
  expect(screen.getByRole('button', { name: 'Project worker' })).toHaveTextContent('Claude Code');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(mocks.post).not.toHaveBeenCalled();
});

it('a project question stays beside the composer instead of inside the old request card', async () => {
  cards = [saved]; statuses[saved.id] = 'running';
  const fallback = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, config: any) => url.endsWith('/questions') ? { data: { questions: [{ id: 'question', questions: [{ question: 'Which address should the form use?' }] }] } } : fallback(url, config));
  mount();
  expect(await screen.findByText('Which address should the form use?')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'studio needs your input' })).toHaveTextContent('Which address');
  expect(screen.getByTestId('project-work-card')).not.toHaveTextContent('Which address');
  expect(screen.getByRole('button', { name: 'Stop project work' })).toBeInTheDocument();
});

it('file rows show line counts and metadata, link into Projects, and preview media in the card scope', async () => {
  const user = userEvent.setup(); cards = [saved]; statuses[saved.id] = 'completed';
  mocks.list.mockResolvedValue({ projects: [{ ...projects[0], hasGit: true }] });
  const fallback = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, config: any) => {
    if (url.endsWith('/files')) return { data: { tree: [
      { name: 'guide.md', path: 'docs/guide.md', type: 'file', size: 2048, modifiedAt: '2026-09-07T12:00:00Z', gitStatus: 'modified' },
      { name: 'cover.png', path: 'cover.png', type: 'file', size: 400 },
      { name: 'sample.wav', path: 'sample.wav', type: 'file', size: 8000 },
    ] } };
    if (url.endsWith('/git-status')) return { data: { branch: 'main', files: [ { path: 'docs/guide.md', status: 'modified', added: 12, removed: 3, size: 2048, modifiedAt: '2026-09-07T12:00:00Z' } ] } };
    if (url.endsWith('/file')) return { data: { content: '# Project guide' } };
    return fallback(url, config);
  });
  mount(); await user.click(await screen.findByRole('button', { name: 'Open workspace' }));
  expect(await screen.findByLabelText('12 lines added, 3 lines removed')).toBeInTheDocument();
  expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  expect(screen.getByText(/Modified Sep/).tagName).toBe('TIME');
  await user.click(screen.getByRole('button', { name: 'Preview docs/guide.md' }));
  expect(await screen.findByText('# Project guide')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '← Back to files' }));
  await user.click(screen.getByRole('button', { name: 'Preview cover.png' }));
  expect(screen.getByRole('img', { name: 'cover.png' })).toHaveAttribute('src', expect.stringContaining(`/project-work/${saved.id}/raw?path=cover.png`));
  await user.click(screen.getByRole('button', { name: '← Back to files' }));
  await user.click(screen.getByRole('button', { name: 'Play sample.wav' }));
  expect(screen.getByLabelText('Play sample.wav')).toHaveAttribute('controls');
  expect(screen.getByLabelText('Play sample.wav')).toHaveAttribute('src', expect.stringContaining(`/project-work/${saved.id}/raw?path=sample.wav`));
  await user.click(screen.getByRole('button', { name: '← Back to files' }));
  await user.click(screen.getByRole('link', { name: 'guide.md' }));
  const registry = JSON.parse(sessionStorage.getItem('portal:workspace-navigation:v1') || '{}');
  expect(registry.entries.at(-1)).toMatchObject({ actorUserId: 'owner', authorizationVersion: 1, target: { project: 'studio', file: 'docs/guide.md' } });
});
