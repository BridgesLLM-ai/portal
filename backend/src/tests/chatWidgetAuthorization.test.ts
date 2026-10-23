import { authorizeChatWidgetSession, mutateAgentSessionWork } from '../routes/gateway';
import { createChatWidgetsRouter } from '../routes/chatWidgets';
import { prisma } from '../config/database';
import * as rpc from '../utils/openclawGatewayRpc';
import * as work from '../services/openClawSessionWork';

// Keep actual router, authorization, lineage and document reader. Only the
// persistence/native transport edges are synthetic: no DB/Gateway connection.
jest.mock('../config/database', () => {
  const delegate = () => ({ findFirst: jest.fn(), findUnique: jest.fn() });
  const prisma = {
    user: delegate(), agentSession: delegate(), projectChatProviderBinding: delegate(),
    projectChatSession: delegate(), projectChatMessage: delegate(), projectChatTurn: delegate(),
    legacyOpenClawProjectImport: delegate(), legacyOpenClawProjectQuarantine: delegate(),
  };
  return { prisma, default: prisma };
});

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT = `agent:p4oc-${'1'.repeat(40)}:portal-project-relay-v1`;
const OWNED = `agent:main:portal-${OWNER}`;
const actor = { userId: OWNER, role: 'OWNER', email: 'owner@example.invalid', authorizationVersion: 1 };
const receipt = { kind: 'canvas', presentation: { target: 'assistant_message', title: 'Synthetic', sandbox: 'scripts' },
  view: { id: 'cv_owned', url: '/__openclaw__/canvas/documents/cv_owned/index.html' } };
const rows = [ { role: 'assistant', content: [{ type: 'toolCall', id: 'call-owned', name: 'show_widget' }] },
  { role: 'toolResult', toolCallId: 'call-owned', toolName: 'show_widget', details: receipt } ];
const page = (key: string) => ({ ok: true, data: { sessionKey: key, sessionId: 'physical-owned', messages: rows, hasMore: false } });

function endpoint() {
  const router = createChatWidgetsRouter(authorizeChatWidgetSession);
  const layer = router.stack.find((entry: any) => entry.route?.path === '/sessions/:key/tools/:toolCallId/document') as any;
  return layer.route.stack.at(-1).handle;
}
async function read(key: string, options: { query?: any; user?: any; toolCallId?: string } = {}) {
  const res: any = { statusCode: 200, body: undefined, headers: {} };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  res.set = jest.fn((key: string, value: string) => { res.headers[key] = value; return res; });
  // JWT/approved/admin middleware has admitted an OWNER. Exercise the real
  // terminal endpoint and its actual gateway authorization, never a stub grant.
  await endpoint()({ params: { key, toolCallId: options.toolCallId ?? 'call-owned' },
    query: options.query ?? {}, user: options.user ?? actor }, res);
  return res;
}

describe('widget route exact native session authorization (WIDGET-SEC-01)', () => {
  let history: jest.SpyInstance;
  let canvas: jest.SpyInstance;
  let describe: jest.SpyInstance;
  let version: number;

  beforeEach(() => {
    version = 1;
    (prisma.user.findUnique as jest.Mock).mockImplementation(async () => ({ role: 'OWNER', accountStatus: 'ACTIVE', isActive: true, authorizationVersion: version }));
    for (const delegate of [prisma.agentSession, prisma.projectChatProviderBinding, prisma.projectChatSession,
      prisma.projectChatMessage, prisma.projectChatTurn, prisma.legacyOpenClawProjectImport, prisma.legacyOpenClawProjectQuarantine]) {
      (delegate.findFirst as jest.Mock).mockReset().mockResolvedValue(null);
    }
    // Current Project is recorded only under its canonical identity, as in the
    // real DB. Gateway history folds aliases; echoing the raw key is not proof.
    (prisma.projectChatProviderBinding.findFirst as jest.Mock).mockImplementation(async ({ where }: any) =>
      where.OR.some((term: any) => term.sessionKey === PROJECT || term.externalSessionId === PROJECT) ? { id: 'project-binding' } : null);
    history = jest.spyOn(rpc, 'getSessionHistory').mockImplementation(async (key: string) => page(key));
    canvas = jest.spyOn(rpc, 'gatewayRpcCall').mockImplementation(async (method: string, args: any) => {
      if (method !== 'canvas.document.view' || args.docId !== 'cv_owned') throw new Error('Unexpected RPC');
      return { ok: true, data: { html: '<button>synthetic owned document</button>' } };
    });
    describe = jest.spyOn(work, 'describeSessionWork').mockImplementation(async (key: string) => ({ key, sessionId: 'physical-owned' }));
  });
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['canonical current Project', PROJECT],
    ['uppercase Project agent alias', PROJECT.replace('p4oc-', 'P4OC-')],
    ['uppercase Project session alias', PROJECT.replace('portal-project-relay-v1', 'PORTAL-PROJECT-RELAY-V1')],
    ['uppercase agent namespace alias', PROJECT.replace('agent:', 'AGENT:')],
    ['leading whitespace alias', ` ${PROJECT}`],
    ['trailing whitespace alias', `${PROJECT} `],
    ['unqualified alias', 'portal-project-relay-v1'],
    ['legacy Project', 'agent:portal-aaaaaaaa-demo:main'],
  ])('%s denies OWNER before history or Canvas', async (_label, key) => {
    const res = await read(key);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toHaveProperty('html');
    expect(history).not.toHaveBeenCalled();
    expect(canvas).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
  });

  test('owned canonical Agent widget survives new-router/reconnect reads using one unchanged key', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await read(OWNED);
      expect(res.statusCode).toBe(200);
      expect(res.body.html).toContain('synthetic owned');
      expect(res.headers['Cache-Control']).toBe('private, no-store');
    }
    expect(history).toHaveBeenCalledTimes(4);
    for (const args of history.mock.calls) expect(args).toEqual([OWNED, { limit: 250, offset: 0 }]);
    expect(canvas).toHaveBeenCalledTimes(2);
  });

  test.each(['agent:main:signal:group:AbC123', 'agent:main:matrix:channel:!AbC:example.org'])('canonical opaque peer case remains valid: %s', async key => {
    const res = await read(key);
    expect(res.statusCode).toBe(200);
    expect(history.mock.calls.every(args => args[0] === key)).toBe(true);
  });

  test('foreign Portal actor is denied before history/Canvas even to OWNER', async () => {
    const res = await read(`agent:main:portal-${FOREIGN}`);
    expect(res.statusCode).toBe(404);
    expect(history).not.toHaveBeenCalled(); expect(canvas).not.toHaveBeenCalled();
  });

  test('another actor claim on a canonical host session is denied', async () => {
    (prisma.agentSession.findFirst as jest.Mock).mockResolvedValue({ id: 'foreign', userId: FOREIGN });
    expect((await read('agent:main:claimed-elsewhere')).statusCode).toBe(404);
    expect(history).not.toHaveBeenCalled(); expect(canvas).not.toHaveBeenCalled();
  });

  test('unclaimed child inheriting a Project boundary is denied', async () => {
    describe.mockImplementation(async (key: string) => ({ key, spawnedBy: PROJECT }));
    expect((await read('agent:main:subagent:synthetic')).statusCode).toBe(404);
    expect(history).not.toHaveBeenCalled(); expect(canvas).not.toHaveBeenCalled();
  });

  test('cyclic native lineage cannot fall back to OWNER host visibility', async () => {
    describe.mockImplementation(async (key: string) => ({ key, spawnedBy: key }));
    expect((await read('agent:main:subagent:cycle')).statusCode).toBe(404);
    expect(history).not.toHaveBeenCalled(); expect(canvas).not.toHaveBeenCalled();
  });

  test('stale authorization version denies before history/Canvas', async () => {
    expect((await read(OWNED, { user: { ...actor, authorizationVersion: 2 } })).statusCode).toBe(404);
    expect(history).not.toHaveBeenCalled(); expect(canvas).not.toHaveBeenCalled();
  });

  test('revocation during Canvas suppresses HTML before a second history read', async () => {
    canvas.mockImplementation(async () => { version = 2; return { ok: true, data: { html: 'must not escape' } }; });
    const res = await read(OWNED);
    expect(res.statusCode).toBe(404); expect(res.body).not.toHaveProperty('html');
    expect(history).toHaveBeenCalledTimes(1);
  });

  test('Project rebinding during Canvas is denied by the real final authorization', async () => {
    canvas.mockImplementation(async () => {
      (prisma.projectChatProviderBinding.findFirst as jest.Mock).mockResolvedValue({ id: 'new-project-binding' });
      return { ok: true, data: { html: 'must not escape' } };
    });
    const res = await read(OWNED);
    expect(res.statusCode).toBe(404); expect(res.body).not.toHaveProperty('html');
    expect(history).toHaveBeenCalledTimes(1);
  });

  test.each(['physical reset', 'document rebind'])('%s after Canvas suppresses stale HTML', async mode => {
    const fresh = page(OWNED);
    if (mode === 'physical reset') fresh.data.sessionId = 'physical-reset';
    else fresh.data.messages = [];
    history.mockResolvedValueOnce(page(OWNED)).mockResolvedValueOnce(fresh);
    const res = await read(OWNED);
    expect(res.statusCode).toBe(409); expect(res.body).not.toHaveProperty('html');
  });

  test('caller document ID cannot substitute for a paired tool call', async () => {
    expect((await read(OWNED, { toolCallId: 'cv_owned' })).statusCode).toBe(404);
    expect(canvas).not.toHaveBeenCalled();
  });
  test('query-supplied document IDs are rejected before history/Canvas', async () => {
    expect((await read(OWNED, { query: { docId: 'cv_owned' } })).statusCode).toBe(400);
    expect(history).not.toHaveBeenCalled(); expect(canvas).not.toHaveBeenCalled();
  });
});

test('work broker refuses arbitrary methods and foreign parameter scope before any native read', async () => {
  await expect(mutateAgentSessionWork(OWNED, actor as any, 'canvas.document.view', { docId: 'cv_foreign' })).rejects.toMatchObject({ code: 'WORK_OPERATION_INVALID' });
  await expect(mutateAgentSessionWork(OWNED, actor as any, 'chat.send', { sessionKey: `agent:main:portal-${FOREIGN}` })).rejects.toMatchObject({ code: 'WORK_OPERATION_INVALID' });
});
