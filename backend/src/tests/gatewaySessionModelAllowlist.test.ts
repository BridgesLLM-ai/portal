import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

// OpenClaw 2026.10.6 accepted a session model patch outside
// the server's enabled models, so the Portal checks the server's configuration
// itself before sessions.patch. The real /session-model route and the real patch
// helper run against a synthetic gateway that accepts every model, as 10.6 did;
// the host config is a private temporary file that is never written.
const openClawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-model-allowlist-'));
const configPath = path.join(openClawHome, 'openclaw.json');
process.env.OPENCLAW_HOME = openClawHome;

const ENABLED = 'openai/gpt-6.1-sol';
const OTHER = 'google/gemini-3-flash-preview';
const sentFrames: Array<Record<string, any>> = [];
let gatewayRefusal: string | null = null;

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
    const [modelProvider, ...rest] = String(frame.params?.model || 'openai/gpt-6.1-sol').split('/');
    reply({ ok: true, payload: frame.method === 'sessions.patch'
      ? { ok: true, resolved: { modelProvider, model: rest.join('/') } }
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
const policy = require('../services/openclawSessionModelPolicy') as typeof import('../services/openclawSessionModelPolicy');
const admission = require('../services/openClawExecutionAdmission');
const gatewayRouter = require('../routes/gateway').default;

const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_KEY = `agent:portal-${USER_ID.slice(0, 8)}-demo:portal-${USER_ID}-chat`;
const OWNER_MAIN = `agent:main:portal-${OWNER_ID}`;
const roles: Record<string, string> = { [USER_ID]: 'USER', [OWNER_ID]: 'OWNER' };
// The ADMIN is the authz_1 rig's sandboxed ADMIN on its own Project chat.
const cases: Array<[string, any, string]> = [
  ['USER', { userId: USER_ID, role: 'USER', email: 'user@example.invalid', authorizationVersion: 1 }, PROJECT_KEY],
  ['ADMIN', { userId: USER_ID, role: 'ADMIN', sandboxEnabled: true, email: 'admin@example.invalid', authorizationVersion: 1 }, PROJECT_KEY],
  ['OWNER', { userId: OWNER_ID, role: 'OWNER', email: 'owner@example.invalid', authorizationVersion: 1 }, OWNER_MAIN],
];
const NOT_ENABLED_BODY = {
  error: "This model isn't enabled on this server. An admin can enable it in Model Providers.",
  code: 'MODEL_NOT_ENABLED',
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
let configBytes: Buffer;
function writeConfig(config: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  configBytes = fs.readFileSync(configPath);
}

describe('a chat model switch stays within the server\'s allowlist although OpenClaw accepts the patch (B3)', () => {
  beforeEach(() => {
    sentFrames.length = 0;
    gatewayRefusal = null;
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
    jest.spyOn(rpc, 'createSession').mockResolvedValue({ ok: false, error: 'not expected' });
    jest.spyOn(rpc, 'getSessionInfo').mockImplementation(async (key: string) => (
      [PROJECT_KEY, OWNER_MAIN].includes(key)
        ? { ok: true, data: { key, modelProvider: 'openai', model: 'gpt-6.1-sol' } }
        : { ok: false, error: 'Session not found' }));
  });
  afterEach(() => {
    expect(fs.readFileSync(configPath).equals(configBytes)).toBe(true);
    expect(fs.readdirSync(openClawHome)).toEqual(['openclaw.json']);
    jest.restoreAllMocks();
  });
  afterAll(() => fs.rmSync(openClawHome, { recursive: true, force: true }));

  describe('with enabled models (agents.defaults.models, the TEST D3 shape)', () => {
    beforeEach(() => writeConfig({ agents: { defaults: { models: { [ENABLED]: {} } } } }));

    test.each(cases)('%s: a model outside it is refused before any patch', async (_name, user, session) => {
      const res = await switchModel(user, session, OTHER);
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual(NOT_ENABLED_BODY);
      expect(patchFrames()).toHaveLength(0);
    }, 20000);

    test.each(cases)('%s: an enabled model still switches', async (_name, user, session) => {
      const res = await switchModel(user, session, ENABLED);
      expect(res.statusCode).toBe(200);
      expect(patchFrames().map((frame) => frame.params)).toEqual([expect.objectContaining({ key: session, model: ENABLED })]);
    }, 20000);
  });

  describe('with no restriction configured', () => {
    beforeEach(() => writeConfig({ agents: { defaults: { model: { primary: ENABLED } } } }));

    test.each(cases)('%s: any model goes to OpenClaw as before', async (_name, user, session) => {
      const res = await switchModel(user, session, OTHER);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ ok: true, resolved: { modelProvider: 'google', model: 'gemini-3-flash-preview' } });
      expect(patchFrames().map((frame) => frame.params)).toEqual([expect.objectContaining({ key: session, model: OTHER })]);
    }, 20000);
  });

  describe('with OpenClaw\'s explicit modelPolicy.allow', () => {
    beforeEach(() => writeConfig({ agents: { defaults: { modelPolicy: { allow: ['anthropic/*', ENABLED] } } } }));

    test.each(cases)('%s: a model outside the policy is refused before any patch', async (_name, user, session) => {
      const res = await switchModel(user, session, OTHER);
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual(NOT_ENABLED_BODY);
      expect(patchFrames()).toHaveLength(0);
    }, 20000);

    test('an exact ref and a provider wildcard are admitted', async () => {
      expect((await switchModel(cases[0][1], PROJECT_KEY, ENABLED)).statusCode).toBe(200);
      expect((await switchModel(cases[2][1], OWNER_MAIN, 'anthropic/claude-fable-5-1')).statusCode).toBe(200);
      expect(patchFrames()).toHaveLength(2);
    }, 20000);
  });

  test('OpenClaw\'s own 2026.8.1+ refusal wording is the same plain 409', async () => {
    writeConfig({});
    gatewayRefusal = `Model override "${OTHER}" is not allowed by agents.defaults.modelPolicy.allow.`;
    const res = await switchModel(cases[2][1], OWNER_MAIN, OTHER);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(NOT_ENABLED_BODY);
    expect(patchFrames()).toHaveLength(1);
  }, 20000);

  test('the helper itself refuses for every caller, and clearing an override is not a switch', async () => {
    writeConfig({ agents: { defaults: { models: { [ENABLED]: {} } } } });
    expect(await rpc.patchSessionModel(PROJECT_KEY, OTHER))
      .toEqual({ ok: false, error: rpc.OPENCLAW_MODEL_NOT_ENABLED_MESSAGE, code: 'MODEL_NOT_ENABLED' });
    expect(patchFrames()).toHaveLength(0);
    expect((await rpc.patchSessionModel(PROJECT_KEY, null)).ok).toBe(true);
    expect(patchFrames()).toHaveLength(1);
  }, 20000);
});

describe('openClawSessionModelAllowed', () => {
  const allowed = policy.openClawSessionModelAllowed;
  test('no restriction: any model', () => {
    expect(allowed('main', OTHER, {})).toBe(true);
    expect(allowed('main', OTHER, { agents: { defaults: { models: {}, modelPolicy: { allow: [] } } } })).toBe(true);
  });
  test('enabled models include the primary and fallbacks; legacy refs compare canonically', () => {
    const config = { agents: { defaults: { models: { 'openai-codex/gpt-5.5': {} }, model: { primary: 'anthropic/claude-fable-5-1', fallbacks: ['xai/grok-4.3'] } } } };
    expect(allowed('main', 'openai/gpt-5.5', config)).toBe(true);
    expect(allowed('main', 'anthropic/claude-fable-5-1', config)).toBe(true);
    expect(allowed('main', 'xai/grok-4.3', config)).toBe(true);
    expect(allowed('main', OTHER, config)).toBe(false);
  });
  test('a per-agent policy replaces the default one, including [] for any model', () => {
    const config = { agents: { defaults: { modelPolicy: { allow: ['anthropic/*'] } },
      entries: { main: { modelPolicy: { allow: [] } }, work: { modelPolicy: { allow: ['google/*'] } } },
      list: [{ id: 'legacy', modelPolicy: { allow: [ENABLED] } }] } };
    expect(allowed('main', OTHER, config)).toBe(true);
    expect(allowed('work', OTHER, config)).toBe(true);
    expect(allowed('work', 'anthropic/claude-fable-5-1', config)).toBe(false);
    expect(allowed('legacy', ENABLED, config)).toBe(true);
    expect(allowed('legacy', OTHER, config)).toBe(false);
    expect(allowed('portal-bbbbbbbb-demo', 'anthropic/claude-fable-5-1', config)).toBe(true);
    expect(allowed('portal-bbbbbbbb-demo', OTHER, config)).toBe(false);
    expect(allowed(null, OTHER, config)).toBe(false);
  });
  test('a wildcard needs its whole prefix; a malformed restriction refuses every model', () => {
    const config = { agents: { defaults: { modelPolicy: { allow: ['google/gemini-3/*', '*'] } } } };
    expect(allowed('main', 'google/gemini-3/flash', config)).toBe(true);
    expect(allowed('main', OTHER, config)).toBe(false);
    expect(allowed('main', OTHER, { agents: { defaults: { modelPolicy: { allow: 'google/*' } } } })).toBe(false);
    expect(allowed('main', OTHER, { agents: { defaults: { models: ['google/gemini-3-flash-preview'] } } })).toBe(false);
  });
});
