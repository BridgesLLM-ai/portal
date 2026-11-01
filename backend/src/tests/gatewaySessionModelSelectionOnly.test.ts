import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A chat model change only selects among models the host has enabled.
// The real /session-model route and the real sessions.patch helper run against
// a synthetic gateway that refuses non-allowlisted models; the host config is
// a private temporary copy whose bytes must never change.
const openClawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-model-selection-'));
const configPath = path.join(openClawHome, 'openclaw.json');
process.env.OPENCLAW_HOME = openClawHome;
fs.writeFileSync(configPath, JSON.stringify({
  agents: { defaults: { model: { primary: 'openai/gpt-5.6-sol' }, models: { 'openai/gpt-5.6-sol': {} } } },
}, null, 2));
const configBytes = fs.readFileSync(configPath);

const ALLOWED = 'openai/gpt-5.6-sol';
const NOT_ENABLED = 'openai/gpt-operator-excluded';
const sentFrames: Array<Record<string, any>> = [];

class FakeGatewaySocket extends EventEmitter {
  constructor() {
    super();
    setImmediate(() => {
      this.emit('open');
      this.emit('message', Buffer.from(JSON.stringify({
        type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture-gateway-challenge-nonce', ts: Date.now() },
      })));
    });
  }
  send(raw: string): void {
    const frame = JSON.parse(raw);
    sentFrames.push(frame);
    const reply = (body: Record<string, unknown>) => setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({
      type: 'res', id: frame.id, ...body,
    }))));
    if (frame.method === 'connect') {
      reply({ ok: true, payload: { auth: { role: 'operator', scopes: ['operator.admin', 'operator.read', 'operator.write'] } } });
      return;
    }
    if (frame.method === 'sessions.patch' && frame.params?.model && frame.params.model !== ALLOWED) {
      reply({ ok: false, error: { code: 'INVALID_REQUEST', message: `model not allowed: ${frame.params.model}` } });
      return;
    }
    reply({ ok: true, payload: frame.method === 'sessions.patch'
      ? { ok: true, resolved: { modelProvider: 'openai', model: 'gpt-5.6-sol' } }
      : {} });
  }
  close(): void {}
}

jest.mock('ws', () => ({ __esModule: true, default: jest.fn().mockImplementation(() => new FakeGatewaySocket()) }));
jest.mock('../config/openclaw', () => ({ ...jest.requireActual('../config/openclaw'), getOpenClawWsUrl: () => 'ws://127.0.0.1:18789' }));
jest.mock('../utils/gatewayToken', () => ({ getGatewayToken: () => 'test-token', hasGatewayToken: () => true }));
jest.mock('../utils/deviceIdentity', () => ({
  ...jest.requireActual('../utils/deviceIdentity'),
  getOrCreateDeviceKeys: () => ({ publicKey: 'pk', privateKey: 'sk' }),
  buildSignedDevice: () => ({ id: 'device', signature: 'sig' }),
}));
jest.mock('../agents/providers/PersistentGatewayWs', () => ({
  ...jest.requireActual('../agents/providers/PersistentGatewayWs'),
  isConnected: () => false,
  callGatewayRpc: jest.fn(),
}));
jest.mock('../config/database', () => {
  const delegate = () => ({ findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() });
  const prisma = {
    user: delegate(), agentSession: delegate(), projectChatProviderBinding: delegate(),
    projectChatSession: delegate(), projectChatMessage: delegate(), projectChatTurn: delegate(),
    legacyOpenClawProjectImport: delegate(), legacyOpenClawProjectQuarantine: delegate(),
  };
  return { prisma, default: prisma };
});

const { prisma } = require('../config/database');
const rpc = require('../utils/openclawGatewayRpc') as typeof import('../utils/openclawGatewayRpc');
const admission = require('../services/openClawExecutionAdmission');
const gatewayRouter = require('../routes/gateway').default;

const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_KEY = `agent:portal-${USER_ID.slice(0, 8)}-demo:portal-${USER_ID}-chat`;
const NEVER_RUN_PROJECT_KEY = `agent:portal-${USER_ID.slice(0, 8)}-demo:portal-${USER_ID}-never-run`;
const OWNER_MAIN = `agent:main:portal-${OWNER_ID}`;
const actors: Record<string, any> = {
  USER: { userId: USER_ID, role: 'USER', email: 'user@example.invalid', authorizationVersion: 1 },
  'sandboxed ADMIN': { userId: USER_ID, role: 'ADMIN', sandboxEnabled: true, email: 'admin@example.invalid', authorizationVersion: 1 },
  OWNER: { userId: OWNER_ID, role: 'OWNER', email: 'owner@example.invalid', authorizationVersion: 1 },
};

function handler(): (req: any, res: any) => Promise<void> {
  const layer = (gatewayRouter as any).stack.find((entry: any) => entry.route?.path === '/session-model');
  return layer.route.stack.at(-1).handle;
}
async function switchModel(user: any, session: string, model: string) {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload: any) => { res.body = payload; return res; });
  await handler()({ body: { provider: 'OPENCLAW', session, model }, query: {}, headers: {}, user }, res);
  return res;
}
const patchFrames = () => sentFrames.filter((frame) => frame.method === 'sessions.patch');
const expectHostConfigUntouched = () => {
  expect(fs.readFileSync(configPath).equals(configBytes)).toBe(true);
  expect(fs.readdirSync(openClawHome)).toEqual(['openclaw.json']);
};

describe('a chat model change never grows the host-wide model allowlist', () => {
  let stored: Set<string>;
  beforeEach(() => {
    sentFrames.length = 0;
    stored = new Set([PROJECT_KEY, OWNER_MAIN]);
    for (const delegate of Object.values(prisma) as any[]) {
      for (const fn of Object.values(delegate) as jest.Mock[]) fn.mockReset();
      delegate.findFirst.mockResolvedValue(null);
    }
    (prisma.user.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => ({
      role: where?.id === OWNER_ID ? 'OWNER' : 'USER', accountStatus: 'ACTIVE', isActive: true, authorizationVersion: 1,
    }));
    (prisma.agentSession.create as jest.Mock).mockImplementation(async ({ data }: any) => ({ id: 'claim-1', ...data }));
    jest.spyOn(admission, 'assertOpenClawExecutionAdmitted').mockResolvedValue(undefined as any);
    jest.spyOn(rpc, 'listGatewayModels').mockResolvedValue({ ok: false, models: [] } as any);
    jest.spyOn(rpc, 'createSession').mockResolvedValue({ ok: false, error: 'not expected' });
    jest.spyOn(rpc, 'getSessionInfo').mockImplementation(async (key: string) => (stored.has(key)
      ? { ok: true, data: { key, modelProvider: 'openai', model: 'gpt-5.6-sol' } }
      : { ok: false, error: 'Session not found' }));
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => fs.rmSync(openClawHome, { recursive: true, force: true }));

  test.each(['USER', 'sandboxed ADMIN'])('%s: a disallowed model on its Project chat is refused in plain words, config untouched', async (name) => {
    const res = await switchModel(actors[name], PROJECT_KEY, NOT_ENABLED);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: "This model isn't enabled on this server. An admin can enable it in Model Providers.",
      code: 'MODEL_NOT_ENABLED',
    });
    // The Portal refuses from the host's enabled models before any patch (B3); no declaration-and-retry.
    expect(patchFrames()).toHaveLength(0);
    expectHostConfigUntouched();
  }, 20000);

  test.each(['USER', 'sandboxed ADMIN'])('%s: a never-run Project-shaped key is not materialized', async (name) => {
    const res = await switchModel(actors[name], NEVER_RUN_PROJECT_KEY, NOT_ENABLED);
    expect(res.statusCode).toBe(404);
    expect(patchFrames()).toHaveLength(0);
    expectHostConfigUntouched();
  }, 20000);

  test('OWNER: a disallowed model is refused too; enabling it is the Model Providers path', async () => {
    const res = await switchModel(actors.OWNER, OWNER_MAIN, NOT_ENABLED);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('MODEL_NOT_ENABLED');
    expect(patchFrames()).toHaveLength(0);
    expectHostConfigUntouched();
  }, 20000);

  test.each(['USER', 'OWNER'])('%s: an allowed model still switches', async (name) => {
    const session = name === 'OWNER' ? OWNER_MAIN : PROJECT_KEY;
    const res = await switchModel(actors[name], session, ALLOWED);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, resolved: { modelProvider: 'openai', model: 'gpt-5.6-sol' } });
    expect(patchFrames()).toHaveLength(1);
    expect(patchFrames()[0].params).toMatchObject({ key: session, model: ALLOWED });
    expectHostConfigUntouched();
  }, 20000);

  test('an allowed model still materializes an unstored own direct chat', async () => {
    stored.delete(OWNER_MAIN);
    const res = await switchModel(actors.OWNER, 'agent:main:main', ALLOWED);
    expect(res.statusCode).toBe(200);
    expect(patchFrames()).toHaveLength(1);
    expectHostConfigUntouched();
  }, 20000);

  test('a gateway refusal of a model the config does not restrict is the same plain 409', async () => {
    const res = await switchModel(actors.OWNER, OWNER_MAIN, 'openai/gpt-5.6-sol-refused-by-gateway-only');
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('MODEL_NOT_ENABLED');
    expect(patchFrames()).toHaveLength(0);
    expectHostConfigUntouched();
  }, 20000);

  test('the helper itself answers a refusal without writing host config', async () => {
    const result = await rpc.patchSessionModel(OWNER_MAIN, NOT_ENABLED);
    expect(result).toEqual({ ok: false, error: rpc.OPENCLAW_MODEL_NOT_ENABLED_MESSAGE, code: 'MODEL_NOT_ENABLED' });
    expect(patchFrames()).toHaveLength(0);
    expectHostConfigUntouched();
  }, 20000);
});
