import express, { Router } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
const mockCards: any[] = [];
let mockActor = 'owner'; let mockRole = 'OWNER'; let mockVersion = 1;
let mockProject: any;
const mockMatches = (row: any, where: any): boolean => row && Object.entries(where).every(([key, val]: any) =>
  val && typeof val === 'object' ? Array.isArray(val.in) ? val.in.includes(row[key]) : true : row[key] === val);
const mockRoot = jest.fn();
const mockNative = jest.fn();
const mockHistory = jest.fn((..._args: any[]) => [] as any[]);
jest.mock('../services/RuntimeTurnEventHistory', () => ({ ...jest.requireActual('../services/RuntimeTurnEventHistory'), readRuntimeTurnEvents: (...args: any[]) => mockHistory(...args) }));
jest.mock('../config/database', () => ({ prisma: {
  projectWorkCard: {
    findFirst: jest.fn(async ({ where }: any) => { const row = mockCards.find((entry) => mockMatches(entry, where)); return row ? { ...row, projectIdentity: mockProject } : null; }),
    findUnique: jest.fn(async ({ where }: any) => mockCards.find((entry) => entry.id === where.id) || null),
    findMany: jest.fn(async ({ where }: any) => mockCards.filter((entry) => mockMatches(entry, where)).map((row) => ({ ...row, projectIdentity: mockProject }))),
    create: jest.fn(async ({ data }: any) => { const row = { status: 'DRAFT', response: '', events: null, sessionId: null, ...data, createdAt: new Date() }; mockCards.push(row); return row; }),
    update: jest.fn(async ({ where, data }: any) => { const row = mockCards.find((entry) => mockMatches(entry, where)); Object.assign(row, data); return row; }),
    updateMany: jest.fn(async ({ where, data }: any) => { const rows = mockCards.filter((entry) => mockMatches(entry, where)); rows.forEach((row) => Object.assign(row, data)); return { count: rows.length }; }),
  },
  projectIdentity: { findFirst: jest.fn(async ({ where }: any) => mockMatches(mockProject, where) ? mockProject : null) },
  projectChatTurn: { findFirst: jest.fn(async () => null) },
  hostAgentRun: { findUnique: jest.fn(async () => null) },
  openClawHostRun: { findUnique: jest.fn(async () => null) },
} }));
jest.mock('../services/nativeAskUserQuestionChannel', () => ({ syncAskUserQuestionsForActor: jest.fn(async () => []) }));
jest.mock('../agents/providers/NativeSessionStore', () => ({ loadNativeSessionMetadata: (...args: any[]) => mockNative(...args) }));
jest.mock('../middleware/auth', () => ({ authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: mockActor, role: mockRole, authorizationVersion: mockVersion }; next(); } }));
jest.mock('../middleware/requireApproved', () => ({ requireApproved: (_req: any, _res: any, next: any) => next() }));
jest.mock('../services/projectIdentity', () => ({ assertProjectIdentityRoot: (...args: any[]) => mockRoot(...args) }));
import { createProjectWorkRouter } from '../routes/project-work';
import { prisma } from '../config/database';
import { streamEventBus } from '../services/StreamEventBus';
import { AgentAbortError } from '../agents/AgentProvider.interface';
import { withProjectWorkScope, assertProjectWorkScope } from '../services/projectWorkScope';
import { projectWorkEvents, bindProjectWorkHostSession, currentProjectWork, withProjectWorkHost, trackProjectWorkDispatch, readProjectWorkReplay } from '../services/projectWorkHost';
import { adoptProjectWorkDraft } from '../services/projectWorkDraft';
let server: http.Server; let base: string; let dispatched: any[] = [];
async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); return { status: response.status, data: text ? JSON.parse(text) : null };
}
function payload(extra: object = {}) { return { id: randomUUID(), originProvider: 'OPENCLAW', originSessionKey: 'agent:main:one', projectIdentityId: 'project-a', projectGeneration: 1, provider: 'CODEX', prompt: 'Build the contact form', ...extra }; }
beforeAll(async () => {
  const app = express(); app.use(express.json()); const project = Router(); const gateway = Router();
  project.all('/:name/*', async (req, res) => { await Promise.resolve(); assertProjectWorkScope(mockProject); res.json({ name: req.params.name, action: req.params[0], query: req.query, ...(req.params[0] === 'git' ? { method: req.method, body: req.body } : {}) }); });
  gateway.post('/send', async (req, res) => { await Promise.resolve(); const card = currentProjectWork(); const data = { body: req.body, workId: card?.id, requestId: card?.requestId }; dispatched.push(data); res.json(data); });
  gateway.post('/chat/abort', (req, res) => res.json(req.body));
  app.use('/work', createProjectWorkRouter(project, gateway));
  server = await new Promise<http.Server>((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  jest.clearAllMocks(); mockHistory.mockReturnValue([]); mockCards.length = 0; dispatched = []; mockActor = 'owner'; mockRole = 'OWNER'; mockVersion = 1;
  mockProject = { id: 'project-a', workspaceOwnerId: 'owner', projectName: 'studio', generation: 1, lifecycleStatus: 'ACTIVE', canonicalRoot: '/test/studio' };
  mockRoot.mockImplementation(() => undefined);
  mockNative.mockImplementation(() => ({ userId: 'owner', executionContext: { scope: 'HOST_OPERATOR' }, cwd: '/test/studio', metadata: { projectIdentityId: 'project-a', projectGeneration: 1 } }));
});

test('create/list/reload do not dispatch; duplicate send claims the same identity once', async () => {
  const data = payload(); const first = await request('POST', '/work', data);
  expect(first.status).toBe(201); expect(dispatched).toEqual([]);
  expect((await request('POST', '/work', data)).data.requestId).toBe(first.data.requestId);
  expect((await request('POST', '/work', { ...data, prompt: 'different' })).status).toBe(409);
  expect((await request('GET', '/work?originProvider=OPENCLAW&originSessionKey=agent%3Amain%3Aone')).data.cards).toHaveLength(1);
  expect((await request('GET', `/work/${data.id}/poll`)).data.status).toBe('not_started');
  expect(dispatched).toEqual([]);
  await Promise.all([request('POST', `/work/${data.id}/send`, {}), request('POST', `/work/${data.id}/send`, {})]);
  expect(dispatched).toHaveLength(1);
});
test('direct route ignores a forged target, prompt, worker, session and cwd; sandbox prepare is not exposed', async () => {
  const card = (await request('POST', '/work', payload())).data;
  const result = await request('POST', `/work/${card.id}/send`, { provider: 'GROK', session: 'another', cwd: '/etc', projectName: 'sibling', message: 'edit /etc', requestId: 'replacement' });
  expect(result.status).toBe(200); expect(result.data.workId).toBe(card.id);
  expect(result.data.body.provider).toBe('CODEX'); expect(result.data.body.session).toBe('');
  expect(result.data.body.message).toContain('Working directory: "/test/studio"');
  expect(result.data.body.message).toContain('not an isolated Project Chat sandbox');
  expect(result.data.body.message.endsWith('Build the contact form')).toBe(true);
  expect(result.data.requestId).toBe(card.requestId);
});
test('another actor, demoted role, changed generation and changed authorization cannot operate a card', async () => {
  const card = (await request('POST', '/work', payload())).data;
  mockActor = 'other'; expect((await request('POST', `/work/${card.id}/send`, {})).status).toBe(404);
  mockActor = 'owner'; mockRole = 'USER'; expect((await request('POST', `/work/${card.id}/send`, {})).status).toBe(403);
  mockRole = 'OWNER'; mockProject.generation = 2; expect((await request('POST', `/work/${card.id}/send`, {})).status).toBe(409);
  mockProject.generation = 1; mockVersion = 2; expect((await request('POST', `/work/${card.id}/send`, {})).status).toBe(409);
  expect(dispatched).toEqual([]);
});
test('folder reattachment failure blocks dispatch and file controls stay project-bound', async () => {
  const card = (await request('POST', '/work', payload())).data;
  expect((await request('GET', `/work/${card.id}/files?path=src&projectName=sibling`)).data).toEqual({ name: 'studio', action: 'tree', query: { path: 'src' } });
  mockRoot.mockImplementation(() => { throw new Error('root replaced'); });
  expect((await request('POST', `/work/${card.id}/send`, {})).status).toBe(503); expect(dispatched).toHaveLength(0);
});
test('stop is pinned to the card run, not a newer or caller-supplied run', async () => {
  const card = (await request('POST', '/work', payload())).data;
  Object.assign(mockCards[0], { status: 'RUNNING', sessionId: 'native-work' });
  const result = await request('POST', `/work/${card.id}/stop`, { session: 'other', runId: 'newer' });
  expect(result.data).toEqual({ provider: 'CODEX', session: 'native-work', runId: card.requestId });
  Object.assign(mockCards[0], { status: 'COMPLETED' });
  expect((await request('POST', `/work/${card.id}/stop`, {})).data.ok).toBe(false);
});
test('native work starts in the attested folder and follow-up reuses only that project conversation', async () => {
  const card = (await request('POST', '/work', payload())).data;
  const context = { scope: 'HOST_OPERATOR', source: 'PORTAL_SERVER', userId: 'owner' } as const;
  const provider: any = { providerName: 'CODEX', startSession: jest.fn(async () => 'native-work') };
  const bound = { ...card, projectIdentity: mockProject };
  await withProjectWorkHost(bound, async () => {
    expect(await bindProjectWorkHostSession(provider, context)).toBe('native-work');
    expect(provider.startSession).toHaveBeenCalledWith('owner', expect.objectContaining({ executionContext: context,
      metadata: expect.objectContaining({ cwd: '/test/studio', projectIdentityId: 'project-a' }) }));
    const send = jest.fn(async () => ({ fullText: 'Contact form complete' }));
    await trackProjectWorkDispatch({ provider, sessionId: 'native-work', sender: { userId: 'owner', authorizationVersion: 1, requestId: card.requestId } }, send);
    expect(send).toHaveBeenCalledTimes(1);
  });
  expect(mockCards[0].status).toBe('COMPLETED'); expect(mockCards[0].response).toBe('Contact form complete');
  const follow = (await request('POST', '/work', payload({ parentCardId: card.id }))).data;
  await withProjectWorkHost({ ...follow, projectIdentity: mockProject }, async () => expect(await bindProjectWorkHostSession(provider, context)).toBe('native-work'));
  expect(provider.startSession).toHaveBeenCalledTimes(1);
  mockNative.mockReturnValueOnce({ userId: 'owner', executionContext: context, cwd: '/test/sibling', metadata: { projectIdentityId: 'project-a', projectGeneration: 1 } });
  await expect(withProjectWorkHost({ ...follow, projectIdentity: mockProject }, () => bindProjectWorkHostSession(provider, context))).rejects.toThrow('not bound');
});
test('project replacement between admission and final provider IO fails without calling the provider', async () => {
  const card = (await request('POST', '/work', payload())).data; const send = jest.fn(); mockProject.generation = 2;
  await expect(withProjectWorkHost({ ...card, sessionId: 'native-work', projectIdentity: mockProject }, () => trackProjectWorkDispatch({ provider: { providerName: 'CODEX' } as any, sessionId: 'native-work', sender: { userId: 'owner', requestId: card.requestId, authorizationVersion: 1 } }, send))).rejects.toThrow('project changed');
  expect(send).not.toHaveBeenCalled();
});
test('only a native placeholder is adopted into its real conversation, never another actor or existing conversation', async () => {
  const card = (await request('POST', '/work', payload({ originProvider: 'CODEX', originSessionKey: 'main' }))).data;
  await adoptProjectWorkDraft({ actorUserId: 'other', provider: 'CODEX', draftSession: 'main', session: 'native-other' });
  expect(mockCards[0].originSessionKey).toBe('main');
  await adoptProjectWorkDraft({ actorUserId: 'owner', provider: 'CODEX', draftSession: 'main', session: 'native-owner' });
  expect(mockCards[0].originSessionKey).toBe('native-owner'); expect(mockCards[0].requestId).toBe(card.requestId);
  await adoptProjectWorkDraft({ actorUserId: 'owner', provider: 'CODEX', draftSession: 'native-owner', session: 'unrelated' });
  expect(mockCards[0].originSessionKey).toBe('native-owner');
});
test('file scope follows await and remains isolated between concurrent requests', async () => {
  const a = { id: 'a', generation: 1, workspaceOwnerId: 'owner', projectName: 'a' };
  const b = { ...a, id: 'b', projectName: 'b' };
  await Promise.all([a, b].map((binding) => withProjectWorkScope(binding, async () => {
    await new Promise((resolve) => setImmediate(resolve)); expect(() => assertProjectWorkScope(binding)).not.toThrow();
    expect(() => assertProjectWorkScope({ ...binding, id: 'replacement' })).toThrow('project changed');
  })));
  expect(() => assertProjectWorkScope(null)).not.toThrow();
});

test('an aborted worker retains its claim until the host journal confirms quiescence', async () => {
  const card = (await request('POST', '/work', payload())).data;
  const bound = { ...card, sessionId: 'native-work', projectIdentity: mockProject };
  (prisma.hostAgentRun.findUnique as jest.Mock).mockResolvedValueOnce({ settledAt: null });
  const send = jest.fn(async () => { throw new AgentAbortError(); });
  await expect(withProjectWorkHost(bound, () => trackProjectWorkDispatch({ provider: { providerName: 'CODEX' } as any,
    sessionId: 'native-work', sender: { userId: 'owner', requestId: card.requestId, authorizationVersion: 1 } }, send))).rejects.toThrow(AgentAbortError);
  expect(mockCards[0].status).toBe('UNCERTAIN');
  (prisma.hostAgentRun.findUnique as jest.Mock).mockResolvedValueOnce({ settledAt: new Date() });
  const replay = await readProjectWorkReplay(mockCards[0]);
  expect(replay.complete).toBe(true); expect(replay.status).toBe('interrupted');
  expect(replay.error).toContain('Review its files');
});

test('work event replay only includes public events for its exact native/upstream run and session', () => {
  const make = (runId: string, sessionKey = 'work', visible = true): any => ({ runId, sessionKey, visible, seq: 1, type: 'tool_output', tool: { name: 'read', result: 'project content' } });
  const events = [make('old'), make('request'), make('upstream'), make('upstream', 'sibling'), make('upstream', 'work', false)];
  expect(projectWorkEvents(events, 'work', ['request', 'upstream'])).toEqual(events.slice(1, 3));
});
test('Git views cannot turn a read into a caller-selected operation or project', async () => {
  const card = (await request('POST', '/work', payload())).data;
  expect((await request('GET', `/work/${card.id}/git-status?action=push&projectName=sibling`)).data)
    .toEqual({ name: 'studio', action: 'git', method: 'POST', body: { action: 'status', details: true }, query: {} });
  expect((await request('GET', `/work/${card.id}/diff?path=index.html&action=reset`)).data.body)
    .toEqual({ action: 'diff', file: 'index.html' });
  mockProject.generation = 2;
  expect((await request('GET', `/work/${card.id}/git-status`)).status).toBe(409);
});

test('OpenClaw upstream activity and outputs persist on the card without adopting a different run', async () => {
  const card = (await request('POST', '/work', payload({ provider: 'OPENCLAW' }))).data;
  const bound = { ...card, sessionId: 'work-upstream', projectIdentity: mockProject };
  const tool: any = { schema: 'bridgesllm.runtime-turn-event.v1', sessionKey: bound.sessionId, runId: 'upstream-owned', seq: 2, ts: Date.now(), type: 'tool_output', visible: true, tool: { id: 'read-1', name: 'read', status: 'done', result: 'Exact project contents' } };
  mockHistory.mockReturnValue([ { ...tool, runId: 'older-work' }, tool ]);
  (prisma.openClawHostRun.findUnique as jest.Mock).mockResolvedValue({ upstreamRunId: 'upstream-owned' });
  streamEventBus.startStream(bound.sessionId, 'upstream-owned', { phase: 'tool', toolName: 'read', statusText: 'Reading the selected project' });
  try {
    await withProjectWorkHost(bound, () => trackProjectWorkDispatch({ provider: { providerName: 'OPENCLAW' } as any,
      sessionId: bound.sessionId, sender: { userId: 'owner', requestId: card.requestId, authorizationVersion: 1 } }, async () => ({ fullText: 'Finished' }) as any));
    expect(mockCards[0].events).toEqual([tool]);
    expect((prisma.openClawHostRun.findUnique as jest.Mock)).toHaveBeenCalledWith({ where: { id: card.requestId }, select: { upstreamRunId: true } });
    expect((await readProjectWorkReplay(mockCards[0])).events).toEqual([tool]);
  } finally {
    streamEventBus.publish(bound.sessionId, { type: 'done', runId: 'upstream-owned', content: 'Finished' });
    (prisma.openClawHostRun.findUnique as jest.Mock).mockResolvedValue(null);
  }
});

test('media reads retain the exact card scope and cannot choose a sibling project', async () => {
  const card = (await request('POST', '/work', payload())).data;
  expect((await request('GET', `/work/${card.id}/raw?path=media%2Fsample.wav&projectName=sibling`)).data)
    .toEqual({ name: 'studio', action: 'raw', query: { path: 'media/sample.wav' } });
  mockProject.generation = 2;
  expect((await request('GET', `/work/${card.id}/raw?path=sample.wav`)).status).toBe(409);
});
