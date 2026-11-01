import fs from 'fs';
import childProcess from 'child_process';

// TEST P1: OpenClaw maintenance pauses Portal diagnostics. The Dashboard's
// background version probe used to reject unhandled and exit the backend.
// Here the pause is the real lease check reading a synthetic blocker; the CLI
// child and the setup readiness pass are the only fakes.
process.env.PORTAL_OPENCLAW_VERSION_STATUS_TTL_MS = '0';

jest.mock('../config/database', () => {
  const delegate = () => ({ findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() });
  const prisma = { user: delegate(), agentSession: delegate() };
  return { prisma, default: prisma };
});
jest.mock('../agents/providers/PersistentGatewayWs', () => ({
  ...jest.requireActual('../agents/providers/PersistentGatewayWs'),
  isConnected: () => false,
}));

const lease = require('../utils/openclawDiagnosticLease') as typeof import('../utils/openclawDiagnosticLease');
const readinessModule = require('../services/openclawSetupReadiness');
const gateway = require('../routes/gateway');
const { getOpenClawVersionStatus, runOpenClawCli } = gateway.__gatewayVersionProbeTest;

let paused = false;
const leasePaths = new Set<string>([...lease.OPENCLAW_DIAGNOSTIC_BLOCKERS, lease.OPENCLAW_DIAGNOSTIC_LOCK]);
const realLstat = fs.lstatSync;
const readiness = {
  version: '2026.10.9', corePackageVersion: '2026.10.9', runningVersion: '2026.10.9',
  codexPluginVersion: null, codexPluginInstallSpec: null, gatewayProbeError: null, gatewayProbeOk: true,
  testedPairReady: true, blockers: [], testedCorePackageVersion: '2026.10.9',
  testedRuntimeVersion: '2026.10.9', testedCodexPluginVersion: 'x',
};

function healthHandler(): (req: any, res: any) => Promise<void> {
  const layer = (gateway.default as any).stack.find((entry: any) => entry.route?.path === '/health');
  return layer.route.stack.at(-1).handle;
}
async function health() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload: any) => { res.body = payload; return res; });
  await healthHandler()({ query: {}, headers: {}, user: { userId: 'u', role: 'OWNER' } }, res);
  return res;
}
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 20)); };

describe('OpenClaw diagnostics paused by maintenance', () => {
  let unhandled: jest.Mock;
  let execFile: jest.SpyInstance;
  let getReadiness: jest.SpyInstance;

  beforeEach(() => {
    paused = false;
    unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    jest.spyOn(fs, 'lstatSync').mockImplementation(((target: any, ...rest: any[]) => {
      if (leasePaths.has(String(target))) {
        if (paused && String(target) !== lease.OPENCLAW_DIAGNOSTIC_LOCK) return { isFile: () => true } as any;
        throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
      }
      return (realLstat as any)(target, ...rest);
    }) as any);
    execFile = jest.spyOn(childProcess, 'execFile').mockImplementation(((...args: any[]) => {
      const callback = args.find((arg) => typeof arg === 'function');
      setImmediate(() => callback(null, '{"channel":{"value":"stable"}}', ''));
      return {} as any;
    }) as any);
    getReadiness = jest.spyOn(readinessModule, 'getOpenClawSetupReadiness').mockResolvedValue(readiness as any);
    (globalThis as any).fetch = jest.fn(async () => { throw new Error('no gateway in this test'); });
  });
  afterEach(async () => {
    await settle();
    process.off('unhandledRejection', unhandled);
    jest.restoreAllMocks();
  });

  test('the CLI runner answers a paused lease instead of rejecting', async () => {
    paused = true;
    await expect(runOpenClawCli(['update', 'status', '--json'])).resolves.toMatchObject({
      ok: false, diagnosticsPaused: true, error: expect.stringMatching(/paused during maintenance/),
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  test('maintenance that starts mid-probe never becomes an unhandled rejection (background probe)', async () => {
    getReadiness.mockImplementation(async () => { paused = true; return readiness; });
    const first = await getOpenClawVersionStatus();
    expect(first.lightweight).toBe(true);
    await settle();
    expect(unhandled).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(await getOpenClawVersionStatus()).toMatchObject({ stale: true, staleReason: expect.stringMatching(/paused/) });
  });

  test('a forced probe interrupted by maintenance answers stale instead of rejecting', async () => {
    getReadiness.mockImplementation(async () => { paused = true; return readiness; });
    await expect(getOpenClawVersionStatus({ force: true })).resolves.toMatchObject({ stale: true });
  });

  test('any other background probe failure is handled too', async () => {
    getReadiness.mockRejectedValue(new Error('synthetic readiness failure'));
    await getOpenClawVersionStatus();
    await settle();
    expect(unhandled).not.toHaveBeenCalled();
  });

  test('while paused, /health answers with the last known version marked stale and runs no CLI', async () => {
    const known = await getOpenClawVersionStatus({ force: true });
    expect(known).toMatchObject({ installedVersion: '2026.10.9', updateChannel: 'stable' });
    expect(known.stale).toBeUndefined();
    paused = true;
    getReadiness.mockClear();
    execFile.mockClear();
    const res = await health();
    expect(res.statusCode).toBe(200);
    expect(res.body.openclawVersion).toMatchObject({
      installedVersion: '2026.10.9', updateChannel: 'stable', stale: true,
      staleReason: 'OpenClaw diagnostics are paused during maintenance or recovery.',
    });
    expect(getReadiness).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    await settle();
    expect(unhandled).not.toHaveBeenCalled();
  });
});
