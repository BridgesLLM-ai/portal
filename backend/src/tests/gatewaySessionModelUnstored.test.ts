import gatewayRouter from '../routes/gateway';
import { prisma } from '../config/database';
import * as rpc from '../utils/openclawGatewayRpc';
import * as admission from '../services/openClawExecutionAdmission';

// Real /session-model route, authorization and claim path. Only the DB and the
// gateway transport are synthetic: no database or gateway connection.
jest.mock('../config/database', () => {
  const delegate = () => ({ findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() });
  const prisma = {
    user: delegate(), agentSession: delegate(), projectChatProviderBinding: delegate(),
    projectChatSession: delegate(), projectChatMessage: delegate(), projectChatTurn: delegate(),
    legacyOpenClawProjectImport: delegate(), legacyOpenClawProjectQuarantine: delegate(),
  };
  return { prisma, default: prisma };
});

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actor = { userId: OWNER, role: 'OWNER', email: 'owner@example.invalid', authorizationVersion: 1 };
// An unclaimed main session resolves to the actor's own Portal chat key.
const OWN_MAIN = `agent:main:portal-${OWNER}`;
const MODEL = 'openai/gpt-5.6-sol';

function handler(): (req: any, res: any) => Promise<void> {
  const layer = (gatewayRouter as any).stack.find((entry: any) => entry.route?.path === '/session-model');
  return layer.route.stack.at(-1).handle;
}
async function switchModel(session: string, body: Record<string, unknown> = { model: MODEL }) {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload: any) => { res.body = payload; return res; });
  await handler()({ body: { provider: 'OPENCLAW', session, ...body }, query: {}, headers: {}, user: actor }, res);
  return res;
}

describe('first model switch on a chat the gateway has not stored yet', () => {
  let info: jest.SpyInstance;
  let patch: jest.SpyInstance;
  let create: jest.SpyInstance;
  let stored: Set<string>;

  beforeEach(() => {
    stored = new Set();
    for (const delegate of Object.values(prisma) as any[]) {
      for (const fn of Object.values(delegate) as jest.Mock[]) fn.mockReset();
      delegate.findFirst.mockResolvedValue(null);
    }
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ role: 'OWNER', accountStatus: 'ACTIVE', isActive: true, authorizationVersion: 1 });
    (prisma.agentSession.create as jest.Mock).mockImplementation(async ({ data }: any) => ({ id: 'claim-1', ...data }));
    jest.spyOn(admission, 'assertOpenClawExecutionAdmitted').mockResolvedValue(undefined as any);
    jest.spyOn(rpc, 'listGatewayModels').mockResolvedValue({ ok: false, models: [] } as any);
    jest.spyOn(rpc, 'gatewayRpcCall').mockImplementation(async (method: string) => { throw new Error(`Unexpected RPC ${method}`); });
    create = jest.spyOn(rpc, 'createSession').mockResolvedValue({ ok: false, error: 'not expected' });
    info = jest.spyOn(rpc, 'getSessionInfo').mockImplementation(async (key: string) => (stored.has(key)
      ? { ok: true, data: { key, modelProvider: 'openai', model: 'gpt-5.6-sol' } }
      : { ok: false, error: 'Session not found' }));
    patch = jest.spyOn(rpc, 'patchSessionModel').mockImplementation(async (key: string) => {
      stored.add(key);
      return { ok: true, resolved: { modelProvider: 'openai', model: 'gpt-5.6-sol' } };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  test.each(['agent:main:main', 'main'])('session %s: the patch materializes the chat instead of answering 404', async session => {
    const res = await switchModel(session);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, resolved: { modelProvider: 'openai', model: 'gpt-5.6-sol' },
      session: { key: OWN_MAIN }, reset: false });
    expect(patch).toHaveBeenCalledWith(OWN_MAIN, MODEL);
    expect(create).not.toHaveBeenCalled();
  });

  test('a reset on an unstored chat is accepted too', async () => {
    const res = await switchModel('agent:main:main', { reset: true });
    expect(res.statusCode).toBe(200);
    expect(patch).toHaveBeenCalledWith(OWN_MAIN, null);
  });

  test('a stored chat keeps its existing path', async () => {
    stored.add(OWN_MAIN);
    const res = await switchModel(OWN_MAIN);
    expect(res.statusCode).toBe(200);
    expect(patch).toHaveBeenCalledWith(OWN_MAIN, MODEL);
  });

  test('a :new- chat keeps its create-first path: a failed create still answers 404 without a patch', async () => {
    // An owned agent:<id>:new-<ts> key is the one shape that keeps ':new-' after resolution.
    const NEW_CHAT = 'agent:main:new-1';
    (prisma.agentSession.findFirst as jest.Mock).mockImplementation(async ({ where }: any) =>
      (where?.externalId === NEW_CHAT ? { id: 'claim-new', userId: OWNER } : null));
    const res = await switchModel(NEW_CHAT);
    expect(create).toHaveBeenCalledWith(NEW_CHAT);
    expect(res.statusCode).toBe(404);
    expect(patch).not.toHaveBeenCalled();
  });

  test('a gateway that could not answer is not treated as "no row"', async () => {
    info.mockResolvedValue({ ok: false, error: 'Gateway request timeout' });
    const res = await switchModel('agent:main:main');
    expect(res.statusCode).toBe(502);
    expect(patch).not.toHaveBeenCalled();
  });

  test('a describe failure that is not "no row" keeps the 404', async () => {
    info.mockResolvedValue({ ok: false, error: 'sessions.describe failed' });
    const res = await switchModel('agent:main:main');
    expect(res.statusCode).toBe(404);
    expect(patch).not.toHaveBeenCalled();
  });

  test.each(['agent:main:subagent:synthetic-missing', 'agent:main:cron:synthetic-missing'])('unstored %s is never materialized', async session => {
    const res = await switchModel(session);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Session not found' });
    expect(patch).not.toHaveBeenCalled();
  });
});
