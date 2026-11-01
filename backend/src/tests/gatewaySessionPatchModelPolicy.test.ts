import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

// POST /session-patch sent settings.model (and, for a thinking change,
// the session's recorded override) straight to sessions.patch, so it bypassed
// the enabled-model check that /session-model applies. The real route (every
// middleware after sign-in) and the real policy run against a synthetic gateway
// that accepts every model, as OpenClaw 2026.10.6 did; the host config is a
// private temporary file that is never written.
const openClawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-patch-model-policy-'));
const configPath = path.join(openClawHome, 'openclaw.json');
process.env.OPENCLAW_HOME = openClawHome;

const ENABLED = 'openai/gpt-6.1-sol';
const OTHER = 'google/gemini-3-flash-preview';
const sentFrames: Array<Record<string, any>> = [];
let gatewayRefusal: string | null = null;
let recordedOverride: { modelProvider: string; model: string } | null = null;

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
    if (frame.method === 'sessions.patch' && gatewayRefusal) {
      reply({ ok: false, error: { code: 'INVALID_REQUEST', message: gatewayRefusal } });
      return;
    }
    reply({ ok: true, payload: frame.method === 'sessions.patch' ? { ok: true, key: frame.params?.key } : {} });
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
const SUB_ADMIN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_PROJECT_KEY = `agent:portal-${USER_ID.slice(0, 8)}-demo:portal-${USER_ID}-chat`;
const SUB_ADMIN_PROJECT_KEY = `agent:portal-${SUB_ADMIN_ID.slice(0, 8)}-demo:portal-${SUB_ADMIN_ID}-chat`;
const OWNER_MAIN = `agent:main:portal-${OWNER_ID}`;
const roles: Record<string, string> = { [USER_ID]: 'USER', [SUB_ADMIN_ID]: 'SUB_ADMIN', [OWNER_ID]: 'OWNER' };
const cases: Array<[string, any, string]> = [
  ['USER', { userId: USER_ID, role: 'USER', accountStatus: 'ACTIVE', email: 'user@example.invalid', authorizationVersion: 1 }, USER_PROJECT_KEY],
  ['sandboxed SUB_ADMIN', { userId: SUB_ADMIN_ID, role: 'SUB_ADMIN', sandboxEnabled: true, accountStatus: 'ACTIVE', email: 'sub@example.invalid', authorizationVersion: 1 }, SUB_ADMIN_PROJECT_KEY],
  ['OWNER', { userId: OWNER_ID, role: 'OWNER', accountStatus: 'ACTIVE', email: 'owner@example.invalid', authorizationVersion: 1 }, OWNER_MAIN],
];
const NOT_ENABLED_BODY = {
  error: "This model isn't enabled on this server. An admin can enable it in Model Providers.",
  code: 'MODEL_NOT_ENABLED',
};

/** The route as mounted, minus authenticateToken (req.user is the signed-in actor). */
async function patchSession(user: any, session: string, settings: Record<string, unknown>) {
  const layer = (gatewayRouter as any).stack.find((entry: any) => entry.route?.path === '/session-patch');
  const handlers = layer.route.stack.map((entry: any) => entry.handle);
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload: any) => { res.body = payload; return res; });
  const req = { body: { provider: 'OPENCLAW', session, settings }, query: {}, headers: {}, user };
  for (const handle of handlers.slice(1)) {
    let advanced = false;
    await handle(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}
const patchFrames = () => sentFrames.filter((frame) => frame.method === 'sessions.patch');
let configBytes: Buffer;
function writeConfig(config: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  configBytes = fs.readFileSync(configPath);
}
const ENABLED_MAP = { agents: { defaults: { models: { [ENABLED]: {} } } } };

describe('/session-patch sends only enabled models, for every role', () => {
  beforeEach(() => {
    sentFrames.length = 0;
    gatewayRefusal = null;
    recordedOverride = null;
    for (const delegate of Object.values(prisma) as any[]) {
      for (const fn of Object.values(delegate) as jest.Mock[]) fn.mockReset();
      delegate.findFirst.mockResolvedValue(null);
    }
    (prisma.user.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => ({
      role: roles[where?.id] || 'USER', accountStatus: 'ACTIVE', isActive: true, authorizationVersion: 1,
    }));
    (prisma.agentSession.create as jest.Mock).mockImplementation(async ({ data }: any) => ({ id: 'claim-1', ...data }));
    jest.spyOn(admission, 'assertOpenClawExecutionAdmitted').mockResolvedValue(undefined as any);
    jest.spyOn(rpc, 'listGatewayModels').mockResolvedValue({ ok: false, models: [] } as any);
    jest.spyOn(rpc, 'getSessionInfo').mockImplementation(async (key: string) => (
      [USER_PROJECT_KEY, SUB_ADMIN_PROJECT_KEY, OWNER_MAIN].includes(key)
        ? { ok: true, data: { key, ...(recordedOverride || {}) } }
        : { ok: false, error: 'Session not found' }));
  });
  afterEach(() => {
    expect(fs.readFileSync(configPath).equals(configBytes)).toBe(true);
    expect(fs.readdirSync(openClawHome)).toEqual(['openclaw.json']);
    jest.restoreAllMocks();
  });
  afterAll(() => fs.rmSync(openClawHome, { recursive: true, force: true }));

  describe.each(cases)('%s', (_label, user, sessionKey) => {
    it('refuses a model outside the enabled map with 409 and patches nothing, even together with other settings', async () => {
      writeConfig(ENABLED_MAP);
      for (const settings of [{ model: OTHER }, { model: OTHER, thinking: 'high', fastMode: 'on' }]) {
        const res = await patchSession(user, sessionKey, settings);
        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual(NOT_ENABLED_BODY);
      }
      expect(patchFrames()).toEqual([]);
    });

    it('refuses a thinking change that would re-send a recorded override that is not enabled', async () => {
      writeConfig(ENABLED_MAP);
      recordedOverride = { modelProvider: 'google', model: 'gemini-3-flash-preview' };
      const res = await patchSession(user, sessionKey, { thinking: 'high' });
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual(NOT_ENABLED_BODY);
      expect(patchFrames()).toEqual([]);
    });

    it('still patches an enabled model, and a thinking change on an enabled override', async () => {
      writeConfig(ENABLED_MAP);
      const switched = await patchSession(user, sessionKey, { model: ENABLED });
      expect(switched.statusCode).toBe(200);
      recordedOverride = { modelProvider: 'openai', model: 'gpt-6.1-sol' };
      const thought = await patchSession(user, sessionKey, { thinking: 'high' });
      expect(thought.statusCode).toBe(200);
      expect(patchFrames().map((frame) => frame.params)).toEqual([
        expect.objectContaining({ key: sessionKey, model: ENABLED }),
        expect.objectContaining({ key: sessionKey, model: ENABLED, thinkingLevel: 'high' }),
      ]);
    });

    it('refuses outside an explicit modelPolicy.allow and admits a listed model', async () => {
      writeConfig({ agents: { defaults: { modelPolicy: { allow: [ENABLED] } } } });
      const refused = await patchSession(user, sessionKey, { model: OTHER });
      expect(refused.statusCode).toBe(409);
      expect(patchFrames()).toEqual([]);
      const admitted = await patchSession(user, sessionKey, { model: ENABLED });
      expect(admitted.statusCode).toBe(200);
      expect(patchFrames()).toHaveLength(1);
    });

    it('changes nothing when the server restricts no model', async () => {
      writeConfig({ agents: { defaults: {} } });
      const res = await patchSession(user, sessionKey, { model: OTHER });
      expect(res.statusCode).toBe(200);
      expect(patchFrames()).toEqual([expect.objectContaining({ params: expect.objectContaining({ model: OTHER }) })]);
    });

    it('maps OpenClaw\'s own model-policy refusal to the same plain 409', async () => {
      writeConfig({ agents: { defaults: {} } });
      gatewayRefusal = `Model override "${OTHER}" is not allowed by agents.defaults.modelPolicy.allow`;
      const res = await patchSession(user, sessionKey, { model: OTHER });
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual(NOT_ENABLED_BODY);
    });
  });

  it('a thinking-only change on a session without an override is not a model change', async () => {
    writeConfig(ENABLED_MAP);
    const res = await patchSession(cases[0][1], USER_PROJECT_KEY, { thinking: 'high' });
    expect(res.statusCode).toBe(200);
    expect(patchFrames()).toHaveLength(1);
    expect(patchFrames()[0].params).not.toHaveProperty('model');
  });
});
