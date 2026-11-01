import fs from 'fs';
import os from 'os';
import path from 'path';

// Per user-text entry point and role: Agent Chat sends and the
// Project assistant reach OpenClaw through OpenClawProvider.sendMessage, and
// Agent Chat live input through POST /session-steer. Each must hand the
// transport the sender's command authority: plain text for a USER (and for a
// missing role), OpenClaw command handling for Owner and Admin (SUB_ADMIN,
// sandboxed or not; Model Providers admits both). The transport's frames for
// each value are pinned in openclawChatCommandAuthority.test.ts.
const openClawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-command-entry-points-'));
process.env.OPENCLAW_HOME = openClawHome;
fs.writeFileSync(path.join(openClawHome, 'openclaw.json'), '{}');

const transport = {
  connected: true,
  sends: [] as Array<{ sessionKey: string; message: string; allowChatCommands: unknown }>,
  steers: [] as Array<{ sessionKey: string; message: string; allowChatCommands: unknown }>,
};
jest.mock('../agents/providers/PersistentGatewayWs', () => ({
  ...jest.requireActual('../agents/providers/PersistentGatewayWs'),
  isConnected: () => transport.connected,
  callGatewayRpc: jest.fn(),
  sendChatMessage: jest.fn(async (...args: any[]) => {
    transport.sends.push({ sessionKey: args[0], message: args[1], allowChatCommands: args[9] });
    throw new Error('fixture transport stops here');
  }),
  steerSessionMessage: jest.fn(async (...args: any[]) => {
    transport.steers.push({ sessionKey: args[0], message: args[2], allowChatCommands: args[4] });
    return { mode: 'native-steer', outcome: 'unconfirmed', interruptedActiveRun: false, replayed: false,
      requestId: 'fixture-request', steerRunId: 'fixture-steer' };
  }),
}));
jest.mock('../services/projectChatProviderRegistry', () => {
  const actual = jest.requireActual('../services/projectChatProviderRegistry');
  return {
    ...actual,
    getProjectChatProviderAdapter: () => {
      const { OpenClawProvider } = jest.requireActual('../agents/providers/OpenClawProvider');
      return new OpenClawProvider();
    },
  };
});
jest.mock('../utils/gatewayToken', () => ({ getGatewayToken: () => 'test-token', hasGatewayToken: () => true }));
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
const admission = require('../services/openClawExecutionAdmission');
const { OpenClawProvider } = require('../agents/providers/OpenClawProvider');
const { startProjectNativeRun } = require('../services/projectNativeRunBroker');
const gatewayRouter = require('../routes/gateway').default;

const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUB_ADMIN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_PROJECT_KEY = `agent:portal-${USER_ID.slice(0, 8)}-demo:portal-${USER_ID}-chat`;
const SUB_ADMIN_PROJECT_KEY = `agent:portal-${SUB_ADMIN_ID.slice(0, 8)}-demo:portal-${SUB_ADMIN_ID}-chat`;
const OWNER_MAIN = `agent:main:portal-${OWNER_ID}`;
const roles: Record<string, string> = { [USER_ID]: 'USER', [SUB_ADMIN_ID]: 'SUB_ADMIN', [OWNER_ID]: 'OWNER' };
const actors: Array<[string, any, string, boolean]> = [
  ['USER', { userId: USER_ID, role: 'USER', accountStatus: 'ACTIVE', email: 'user@example.invalid', authorizationVersion: 1 }, USER_PROJECT_KEY, false],
  ['sandboxed SUB_ADMIN', { userId: SUB_ADMIN_ID, role: 'SUB_ADMIN', sandboxEnabled: true, accountStatus: 'ACTIVE', email: 'sub@example.invalid', authorizationVersion: 1 }, SUB_ADMIN_PROJECT_KEY, true],
  // An unsandboxed SUB_ADMIN works in the Owner's workspace.
  ['SUB_ADMIN', { userId: SUB_ADMIN_ID, role: 'SUB_ADMIN', accountStatus: 'ACTIVE', email: 'sub@example.invalid', authorizationVersion: 1 }, OWNER_MAIN, true],
  ['OWNER', { userId: OWNER_ID, role: 'OWNER', accountStatus: 'ACTIVE', email: 'owner@example.invalid', authorizationVersion: 1 }, OWNER_MAIN, true],
];
const DIRECTIVES = [
  '/model openai/gpt-6.1-sol -g',
  'Draft the summary, then /model openai/gpt-6.1-sol --global',
  '/opus -g',
];

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  transport.connected = true;
  transport.sends.length = 0;
  transport.steers.length = 0;
  for (const delegate of Object.values(prisma) as any[]) {
    for (const fn of Object.values(delegate) as jest.Mock[]) fn.mockReset();
    delegate.findFirst.mockResolvedValue(null);
  }
  (prisma.user.findFirst as jest.Mock).mockImplementation(async ({ where }: any) => (
    where?.role === 'OWNER' ? { id: OWNER_ID } : null));
  (prisma.user.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => ({
    role: roles[where?.id] || 'USER', accountStatus: 'ACTIVE', isActive: true, authorizationVersion: 1,
  }));
  jest.spyOn(admission, 'assertOpenClawExecutionAdmitted').mockResolvedValue(undefined as any);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fs.rmSync(openClawHome, { recursive: true, force: true }));

describe('Agent Chat send (OpenClawProvider.sendMessage)', () => {
  it.each(actors)('%s', async (_label, user, sessionKey, allowed) => {
    for (const text of DIRECTIVES) {
      await expect(new OpenClawProvider().sendMessage(sessionKey, text, undefined, undefined, undefined, {
        label: user.email, userId: user.userId, role: user.role, authorizationVersion: 1,
      })).rejects.toThrow('fixture transport stops here');
    }
    expect(transport.sends).toEqual(DIRECTIVES.map((message) => ({ sessionKey, message, allowChatCommands: allowed })));
  });

  it('a sender without a role, or no sender at all, sends plain text', async () => {
    const provider = new OpenClawProvider();
    await expect(provider.sendMessage(USER_PROJECT_KEY, DIRECTIVES[0], undefined, undefined, undefined,
      { label: 'x', userId: USER_ID })).rejects.toThrow();
    await expect(provider.sendMessage(USER_PROJECT_KEY, DIRECTIVES[0])).rejects.toThrow();
    expect(transport.sends.map((send) => send.allowChatCommands)).toEqual([false, false]);
  });
});

describe('Project assistant send (startProjectNativeRun → OpenClawProvider)', () => {
  it.each(actors)('%s', async (_label, user, sessionKey, allowed) => {
    const onSettled = jest.fn();
    startProjectNativeRun({
      userId: user.userId,
      projectId: `fixture-project-${user.role}-${allowed}`,
      provider: 'OPENCLAW',
      runtime: 'embedded',
      sessionId: sessionKey,
      message: `[Project context]\n\n${DIRECTIVES[1]}`,
      sender: { label: user.email, userId: user.userId, role: user.role, requestId: `fixture-turn-${user.role}` },
      onSettled,
    });
    await settle();
    expect(transport.sends).toEqual([
      { sessionKey, message: `[Project context]\n\n${DIRECTIVES[1]}`, allowChatCommands: allowed },
    ]);
  });
});

describe('Agent Chat live input (POST /session-steer)', () => {
  async function steer(user: any, session: string, message: string) {
    const layer = (gatewayRouter as any).stack.find((entry: any) => entry.route?.path === '/session-steer');
    const handlers = layer.route.stack.map((entry: any) => entry.handle);
    const res: any = { statusCode: 200, body: undefined };
    res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
    res.json = jest.fn((payload: any) => { res.body = payload; return res; });
    const req = { body: { provider: 'OPENCLAW', session, message, expectedRunId: 'fixture-run' }, query: {}, headers: {}, user };
    for (const handle of handlers.slice(1)) {
      let advanced = false;
      await handle(req, res, () => { advanced = true; });
      if (!advanced) break;
    }
    return res;
  }

  // The unsandboxed SUB_ADMIN reaches no session through this rig's session
  // access fixtures (404 before any steer); its role maps like the sandboxed one.
  it.each(actors.filter(([label]) => label !== 'SUB_ADMIN'))('%s', async (_label, user, sessionKey, allowed) => {
    for (const text of DIRECTIVES) {
      const res = await steer(user, sessionKey, text);
      expect(res.statusCode).toBe(200);
    }
    expect(transport.steers).toEqual(DIRECTIVES.map((message) => ({ sessionKey, message, allowChatCommands: allowed })));
  });
});
