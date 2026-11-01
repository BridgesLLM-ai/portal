import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import router, {
  createToolsReconcileHandler, createToolsRunHandler, createToolsRunReportHandler, createToolsRunStopHandler, createToolsStatusHandler,
} from '../routes/system-maintenance';
import { ToolsStatusService, writeToolsRunRequest, type ToolsPaths } from '../services/toolsStatus';

jest.mock('../config/database', () => ({
  prisma: { agentJob: { findFirst: jest.fn(async () => null) }, systemSetting: { findUnique: jest.fn() } },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'fixture-owner', role: req.headers['x-fixture-role'] || 'OWNER', authorizationVersion: 1 };
    next();
  },
}));
jest.mock('../middleware/requireAdmin', () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../services/agentJobs', () => ({
  startAgentJob: jest.fn(async () => ({ id: 'fixture-job', status: 'running' })),
}));
jest.mock('../services/backup.service', () => ({
  getConfiguredBackupRoot: jest.fn(),
  expectedBackupOwnerIdentity: jest.fn(),
  listBackupFiles: jest.fn(),
  reauthenticateBackupClassification: jest.fn(),
}));

const POLICY_PATH = path.resolve(__dirname, '../../../installer/tools/tool-policy.v2.json');
const RUN_ID = '0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e01';
const VERIFIED_BACKUP = {
  backup: {
    path: '/var/backups/portal-comprehensive-20261030-110000-data-0a1b2c3d.tar.gz', filename: 'x', createdAt: '2026-10-30T11:00:00Z',
    ageHours: 1, size: 10, device: '1', inode: '2', mtimeNs: '3', receiptDigest: 'r'.repeat(64), fingerprintDigest: 'f'.repeat(64),
  },
  backupRejection: null,
  degradedComponents: [],
};

let root: string;
let paths: ToolsPaths;
let server: http.Server;
let service: ToolsStatusService;
let launcher: jest.Mock;
let stopper: jest.Mock;
let starter: jest.Mock;
let inspectBackup: jest.Mock;
let release: jest.Mock;
let acquireAdmission: jest.Mock;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-run-http-'));
  fs.mkdirSync(path.join(root, 'var/lib/bridgesllm'), { recursive: true });
  fs.mkdirSync(path.join(root, 'usr/lib/node_modules/openclaw'), { recursive: true });
  fs.writeFileSync(path.join(root, 'usr/lib/node_modules/openclaw/package.json'), JSON.stringify({ version: '2026.9.9' }));
  for (const [dir, version] of [['@openai/codex', '0.163.0'], ['@anthropic-ai/claude-code', '2.1.309']]) {
    fs.mkdirSync(path.join(root, 'usr/lib/node_modules', dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'usr/lib/node_modules', dir, 'package.json'), JSON.stringify({ version }));
  }
  paths = {
    stateRoot: path.join(root, 'var/lib/bridgesllm/tools'),
    installerStateRoot: path.join(root, 'var/lib/bridgesllm-installer'),
    gatewayFenceMarker: path.join(root, 'var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1'),
    gatewayFencePermit: path.join(root, 'run/bridgesllm/openclaw-gateway-migration-permit.v1'),
    openclawStateDir: path.join(root, 'root/.openclaw'),
    // The shipped policy with the OpenClaw core update on: 5.2.0 holds it (openclaw.coreUpdates) and these tests cover
    // the K7 flow behind that flag; the held-policy test writes the shipped file here.
    policyPath: path.join(root, 'tool-policy.v2.json'),
    npmGlobalRoot: path.join(root, 'usr/lib/node_modules'),
    toolctlPath: path.join(root, 'opt/portal/installer/tools/bridgesllm-toolctl.py'),
    toolsUnitPaths: [path.join(root, 'etc/systemd/system/bridgesllm-tools@.service')],
  };
  for (const file of [paths.toolctlPath, paths.toolsUnitPaths[0]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture\n');
  }
  const corePolicy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  delete corePolicy.openclaw.coreUpdates;
  fs.writeFileSync(paths.policyPath, JSON.stringify(corePolicy, null, 2));
  service = new ToolsStatusService({ paths, processAlive: () => true, nowMs: () => Date.parse('2026-10-30T12:00:00Z') });
  launcher = jest.fn(async () => undefined);
  stopper = jest.fn(async () => undefined);
  starter = jest.fn((_args: string[], done: (error: Error | null) => void) => done(null));
  inspectBackup = jest.fn(async () => VERIFIED_BACKUP);
  release = jest.fn();
  acquireAdmission = jest.fn(async () => ({ release }));
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { userId: 'fixture-owner', role: req.headers['x-fixture-role'] || 'OWNER', authorizationVersion: 1 };
    next();
  });
  app.get('/tools', createToolsStatusHandler(service));
  app.get('/tools/runs/:runId', createToolsRunReportHandler(service));
  app.post('/tools/runs/:runId/stop', createToolsRunStopHandler({ statusService: service, stopper }));
  app.post('/tools/run', createToolsRunHandler({
    statusService: service, launcher, inspectBackup, acquireAdmission: acquireAdmission as any,
    newRunId: () => RUN_ID, nowMs: () => Date.parse('2026-10-30T12:00:00Z'), portalVersion: () => '5.2.0-test',
  }));
  app.post('/tools/reconcile', createToolsReconcileHandler({
    statusService: service, acquireAdmission: acquireAdmission as any, starter, nowMs: () => Date.parse('2026-10-30T12:00:00Z'),
  }));
  app.use('/maintenance', router);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

function url(route: string) {
  return `http://127.0.0.1:${(server.address() as any).port}${route}`;
}

async function post(body: Record<string, unknown>, role = 'OWNER') {
  const response = await fetch(url('/tools/run'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-role': role }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

async function get(route = '/tools', role = 'OWNER') {
  const response = await fetch(url(route), { headers: { 'x-fixture-role': role } });
  return { status: response.status, body: await response.json() as any };
}

const UPDATE = { tool: 'openclaw', confirmation: 'UPDATE OPENCLAW', maintenanceWindowAcknowledged: true };
const runDir = () => path.join(paths.stateRoot, 'runs', RUN_ID);

test('owner queues an OpenClaw update; the runner unit is launched with the run id', async () => {
  const response = await post(UPDATE);
  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({
    runId: RUN_ID,
    run: { state: 'queued', phase: 'queued', tool: 'openclaw' },
    request: { tool: 'openclaw', action: 'update', target: 'recommended', channel: 'stable' },
    preflight: { maintenanceWindowAcknowledged: true, backup: { receiptDigest: 'r'.repeat(64) } },
  });
  expect(launcher).toHaveBeenCalledWith(RUN_ID);
  expect(release).toHaveBeenCalledTimes(1);
  const request = JSON.parse(fs.readFileSync(path.join(runDir(), 'request.json'), 'utf8'));
  const policySha = require('crypto').createHash('sha256').update(fs.readFileSync(paths.policyPath)).digest('hex');
  expect(request).toEqual({
    schema: 'bridgesllm.tools.request.v1', runId: RUN_ID, tool: 'openclaw', action: 'update', target: 'recommended',
    channel: 'stable', requestedBy: 'fixture-owner', requestedAt: '2026-10-30T12:00:00.000Z', portalVersion: '5.2.0-test',
    policySha256: policySha, acknowledgements: { confirmation: true, maintenanceWindow: true, nodeRuntime: false },
    backup: { path: VERIFIED_BACKUP.backup.path, receiptDigest: 'r'.repeat(64) },
  });
  // The next status read shows the queued run and offers no update (P7).
  const status = await get();
  expect(status.body.activeRun).toMatchObject({ runId: RUN_ID, state: 'queued' });
  expect(status.body.tools.flatMap((tool: any) => tool.actions)).toEqual([]);
  expect(status.body.summary).toMatchObject({ status: 'attention', text: 'OpenClaw is updating.' });
  const second = await post(UPDATE);
  expect(second).toMatchObject({ status: 409, body: { code: 'MAINTENANCE_BUSY' } });
});

test('the shipped 5.2.0 policy holds the OpenClaw core update: no update or pre-flight is queued', async () => {
  fs.copyFileSync(POLICY_PATH, paths.policyPath);
  const read = await get('/tools', 'OWNER');
  expect(read.body.tools.find((tool: any) => tool.id === 'openclaw')).toMatchObject({
    status: 'needs-portal-release', actions: [], runActions: [], heldForLaterRelease: true,
    statusReason: 'Updating OpenClaw from Maintenance comes in a later Portal release. OpenClaw keeps working; '
      + 'this Portal works with OpenClaw 2026.9.1 and newer.',
  });
  for (const body of [UPDATE, { tool: 'openclaw', action: 'preflight' }, { tool: 'openclaw', action: 'retry-checks' }]) {
    const response = await post(body);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('TOOLS_ACTION_UNAVAILABLE');
  }
  const repair = await post({ tool: 'openclaw', action: 'recover-native', confirmed: true });
  expect([repair.status, repair.body.code]).toEqual([409, 'NOTHING_TO_RECOVER']);
  expect(launcher).not.toHaveBeenCalled();
  expect(fs.existsSync(runDir())).toBe(false);
});

test('admins can read status but not start runs', async () => {
  const status = await get('/tools', 'ADMIN');
  expect(status.status).toBe(200);
  expect(status.body).toMatchObject({ schema: 'bridgesllm.tools.status.v1', recovery: null });
  expect(status.body.tools.find((tool: any) => tool.id === 'openclaw')).toMatchObject({
    installed: { version: '2026.9.9' }, status: 'update-available', actions: ['update-recommended', 'update-newest'],
  });
  const response = await post(UPDATE, 'ADMIN');
  expect(response.status).toBe(403);
  expect(launcher).not.toHaveBeenCalled();
  expect(acquireAdmission).not.toHaveBeenCalled();
});

test.each([
  [{ tool: 'openclaw', maintenanceWindowAcknowledged: true }, 400, undefined],
  [{ tool: 'openclaw', confirmation: 'UPDATE OPENCLAW' }, 400, 'MAINTENANCE_WINDOW_REQUIRED'],
  [{ ...UPDATE, tool: 'not-a-tool' }, 400, 'TOOL_NOT_SUPPORTED'],
  [{ ...UPDATE, tool: '__proto__' }, 400, 'TOOL_NOT_SUPPORTED'],
  [{ tool: 'codex', action: 'recover-native', confirmed: true }, 400, 'TOOLS_ACTION_INVALID'],
  [{ tool: 'openclaw', action: 'requalify' }, 400, 'TOOLS_ACTION_INVALID'],
  [{ tool: 'codex', action: 'retry-checks' }, 400, 'TOOLS_ACTION_INVALID'],
  [{ tool: 'codex', action: 'preflight' }, 400, 'TOOLS_ACTION_INVALID'],
  [{ tool: 'codex' }, 400, 'CONFIRMATION_REQUIRED'],
  [{ tool: 'codex', confirmed: 'yes' }, 400, 'CONFIRMATION_REQUIRED'],
  [{ tool: 'openclaw', action: 'recover-native' }, 400, 'CONFIRMATION_REQUIRED'],
  [{ tool: 'codex', confirmed: true, channel: 'stable' }, 400, 'TOOLS_CHANNEL_INVALID'],
  [{ tool: 'codex', confirmed: true, acknowledgements: { nodeRuntime: true } }, 400, 'TOOLS_ACKNOWLEDGEMENT_INVALID'],
  [{ tool: 'openclaw', action: 'preflight', acknowledgements: { nodeRuntime: true } }, 400, 'TOOLS_ACKNOWLEDGEMENT_INVALID'],
  [{ ...UPDATE, acknowledgements: { nodeRuntime: 'yes' } }, 400, 'TOOLS_ACKNOWLEDGEMENT_INVALID'],
  [{ ...UPDATE, acknowledgements: [true] }, 400, 'TOOLS_ACKNOWLEDGEMENT_INVALID'],
  [{ ...UPDATE, target: '2026.10.9' }, 400, 'TOOLS_TARGET_INVALID'],
  [{ ...UPDATE, action: 'purge' }, 400, 'TOOLS_ACTION_INVALID'],
  [{ ...UPDATE, channel: 'beta' }, 400, 'TOOLS_CHANNEL_INVALID'],
])('rejects %j before admission or any write', async (body, status, code) => {
  const response = await post(body);
  expect(response.status).toBe(status);
  if (code) expect(response.body.code).toBe(code);
  expect(launcher).not.toHaveBeenCalled();
  expect(inspectBackup).not.toHaveBeenCalled();
  expect(fs.existsSync(paths.stateRoot)).toBe(false);
});

test('an open legacy ledger allows only recovery: no update is queued', async () => {
  fs.writeFileSync(paths.gatewayFenceMarker, '{}');
  const status = await get();
  expect(status.body.recovery).toMatchObject({ kind: 'legacy-ledger', action: { id: 'recover-legacy' } });
  expect(status.body.summary.status).toBe('recovery-required');
  expect(status.body.tools.flatMap((tool: any) => tool.actions)).toEqual([]);
  const response = await post(UPDATE);
  expect(response).toMatchObject({ status: 409, body: { code: 'RECOVERY_REQUIRED', recovery: { kind: 'legacy-ledger' } } });
  expect(acquireAdmission).not.toHaveBeenCalled();
  expect(launcher).not.toHaveBeenCalled();
  expect(fs.existsSync(paths.stateRoot)).toBe(false);
});

test('a ledger that appears during admission still wins over the update', async () => {
  inspectBackup.mockImplementation(async () => {
    fs.mkdirSync(path.join(paths.installerStateRoot, 'native-cli-bundle-v1'), { recursive: true });
    return VERIFIED_BACKUP;
  });
  const response = await post(UPDATE);
  expect(response).toMatchObject({ status: 409, body: { code: 'RECOVERY_REQUIRED', recovery: { roots: ['native-cli-bundle-v1'] } } });
  expect(launcher).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(paths.stateRoot, 'runs'))).toBe(false);
});

test('a run queued by a concurrent request during admission wins over this one', async () => {
  inspectBackup.mockImplementation(async () => {
    writeToolsRunRequest(paths, {
      schema: 'bridgesllm.tools.request.v1', runId: '5d1f8a3c-6b72-4e19-8c40-7a2e9f0d3b12', tool: 'openclaw', action: 'update',
      target: 'recommended', channel: 'stable', requestedBy: 'other-owner', requestedAt: '2026-10-30T11:59:59.000Z',
      portalVersion: null, policySha256: null, acknowledgements: { confirmation: true, maintenanceWindow: true }, backup: null,
    });
    return VERIFIED_BACKUP;
  });
  const response = await post(UPDATE);
  expect(response).toMatchObject({ status: 409, body: { code: 'MAINTENANCE_BUSY', activeRun: { runId: '5d1f8a3c-6b72-4e19-8c40-7a2e9f0d3b12' } } });
  expect(launcher).not.toHaveBeenCalled();
  expect(fs.existsSync(runDir())).toBe(false);
});

test('an update needs a verified maintenance backup', async () => {
  inspectBackup.mockResolvedValue({ backup: null, backupRejection: 'NO_COMPREHENSIVE_CANDIDATE', degradedComponents: [] });
  const response = await post(UPDATE);
  expect(response).toMatchObject({ status: 409, body: { code: 'FRESH_VERIFIED_BACKUP_REQUIRED' } });
  expect(launcher).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

test('a read-only check run needs neither the confirmation phrase nor a backup', async () => {
  const response = await post({ tool: 'openclaw', action: 'preflight', channel: 'extended-stable', target: 'newest' });
  expect(response.status).toBe(202);
  expect(inspectBackup).not.toHaveBeenCalled();
  const request = JSON.parse(fs.readFileSync(path.join(runDir(), 'request.json'), 'utf8'));
  expect(request).toMatchObject({ action: 'preflight', channel: 'extended-stable', target: 'newest', backup: null,
    acknowledgements: { confirmation: false, maintenanceWindow: false } });
});

test('a launcher failure marks the run failed and reports that nothing changed', async () => {
  launcher.mockRejectedValue(new Error('Unit bridgesllm-tools@.service not found.'));
  const response = await post(UPDATE);
  expect(response).toMatchObject({ status: 503, body: { code: 'TOOLS_RUN_LAUNCH_FAILED', runId: RUN_ID } });
  const status = JSON.parse(fs.readFileSync(path.join(runDir(), 'status.json'), 'utf8'));
  expect(status).toMatchObject({ state: 'failed', error: { id: 'TOOLS_RUN_LAUNCH_FAILED' } });
  const after = await get();
  expect(after.body.activeRun).toBeNull();
  expect(after.body.tools.find((tool: any) => tool.id === 'openclaw')).toMatchObject({ status: 'failed-last-run' });
  expect(after.body.history[0]).toMatchObject({ runId: RUN_ID, errorId: 'TOOLS_RUN_LAUNCH_FAILED' });
});

test('the default router exposes GET /tools to owner and admin reads', async () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    BRIDGESLLM_TOOLS_STATE_ROOT: paths.stateRoot,
    BRIDGESLLM_INSTALLER_STATE_ROOT: paths.installerStateRoot,
    BRIDGESLLM_GATEWAY_FENCE_MARKER: paths.gatewayFenceMarker,
    BRIDGESLLM_GATEWAY_FENCE_PERMIT: paths.gatewayFencePermit,
    BRIDGESLLM_OPENCLAW_STATE_DIR: paths.openclawStateDir,
    BRIDGESLLM_TOOL_POLICY: paths.policyPath,
    BRIDGESLLM_NPM_GLOBAL_ROOT: paths.npmGlobalRoot,
    BRIDGESLLM_TOOLCTL: paths.toolctlPath,
    BRIDGESLLM_TOOLS_UNIT: paths.toolsUnitPaths[0],
  });
  try {
    const response = await get('/maintenance/tools?refresh=1', 'ADMIN');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ schema: 'bridgesllm.tools.status.v1', policy: { valid: true, defaultChannel: 'stable' } });
    const denied = await fetch(url('/maintenance/tools/run'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-role': 'ADMIN' }, body: JSON.stringify(UPDATE),
    });
    expect(denied.status).toBe(403);
  } finally {
    process.env = previous;
  }
});

test('the Node.js tick travels to the runner only on an OpenClaw update', async () => {
  const response = await post({ ...UPDATE, acknowledgements: { nodeRuntime: true } });
  expect(response.status).toBe(202);
  expect(response.body.request.acknowledgements).toEqual({ confirmation: true, maintenanceWindow: true, nodeRuntime: true });
  const request = JSON.parse(fs.readFileSync(path.join(runDir(), 'request.json'), 'utf8'));
  expect(request.acknowledgements).toEqual({ confirmation: true, maintenanceWindow: true, nodeRuntime: true });
});

test('an npm CLI update needs one confirm, no phrase, no backup and no channel', async () => {
  const response = await post({ tool: 'codex', confirmed: true, target: 'newest' });
  expect(response.status).toBe(202);
  expect(inspectBackup).not.toHaveBeenCalled();
  const request = JSON.parse(fs.readFileSync(path.join(runDir(), 'request.json'), 'utf8'));
  expect(request).toMatchObject({ tool: 'codex', action: 'update', target: 'newest', channel: null, backup: null,
    acknowledgements: { confirmation: true, maintenanceWindow: false } });
  expect(request.acknowledgements).not.toHaveProperty('nodeRuntime');
});

test('"Update to newest" is refused for every tool but the npm CLIs before any run is queued (5.2.0)', async () => {
  for (const tool of ['opencode', 'hermes', 'grok-build', 'antigravity', 'ollama', 'agent-zero']) {
    expect(await post({ tool, confirmed: true, target: 'newest' })).toMatchObject({ status: 400, body: {
      code: 'NEWEST_NOT_OFFERED', error: 'This tool updates only to the version this Portal release qualified.' } });
  }
  expect(launcher).not.toHaveBeenCalled();
  expect(fs.existsSync(runDir())).toBe(false);
});

test('a re-check (requalify) is owner-only and installs nothing, so it needs no confirm', async () => {
  const denied = await post({ tool: 'claude-code', action: 'requalify' }, 'ADMIN');
  expect(denied.status).toBe(403);
  const response = await post({ tool: 'claude-code', action: 'requalify' });
  expect(response.status).toBe(202);
  expect(inspectBackup).not.toHaveBeenCalled();
  const request = JSON.parse(fs.readFileSync(path.join(runDir(), 'request.json'), 'utf8'));
  expect(request).toMatchObject({ tool: 'claude-code', action: 'requalify', channel: null,
    acknowledgements: { confirmation: false, maintenanceWindow: false } });
});

test('OpenCode gets its own update (one confirm) and re-check; harnesses not run yet stay refused', async () => {
  const runtimes = path.join(root, 'usr/local/lib/bridgesllm-runtimes');
  const bin = path.join(root, 'usr/local/bin');
  fs.mkdirSync(path.join(runtimes, 'opencode', '1.19.4'), { recursive: true });
  fs.writeFileSync(path.join(runtimes, 'opencode', '1.19.4', 'opencode'), '#!/bin/sh\n');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(runtimes, 'opencode', '1.19.4', 'opencode'), path.join(bin, 'opencode'));
  Object.assign(paths, { harnessRuntimeRoot: runtimes, harnessBinDir: bin });
  expect(await post({ tool: 'opencode' })).toMatchObject({ status: 400, body: { code: 'CONFIRMATION_REQUIRED' } });
  const response = await post({ tool: 'opencode', confirmed: true });
  expect(response.status).toBe(202);
  expect(inspectBackup).not.toHaveBeenCalled();
  const request = JSON.parse(fs.readFileSync(path.join(runDir(), 'request.json'), 'utf8'));
  expect(request).toMatchObject({ tool: 'opencode', action: 'update', target: 'recommended', channel: null, backup: null,
    acknowledgements: { confirmation: true, maintenanceWindow: false } });
});

test('a Hermes launcher not checked yet is accepted for a re-check only', async () => {
  const bin = path.join(root, 'usr/local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'hermes'), '#!/bin/sh\n');
  Object.assign(paths, { harnessBinDir: bin });
  expect(await post({ tool: 'hermes', confirmed: true })).toMatchObject({ status: 409, body: { code: 'TOOLS_ACTION_UNAVAILABLE' } });
  const response = await post({ tool: 'hermes', action: 'requalify' });
  expect(response.status).toBe(202);
  const request = JSON.parse(fs.readFileSync(path.join(runDir(), 'request.json'), 'utf8'));
  expect(request).toMatchObject({ tool: 'hermes', action: 'requalify', channel: null });
});

test.each([['grok-build', 'grok'], ['antigravity', 'agy'], ['ollama', 'ollama'], ['agent-zero', 'agent-zero.env']])('a %s launcher not checked yet is accepted for a re-check only', async (tool, executable) => {
  const bin = path.join(root, 'usr/local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, executable), '#!/bin/sh\n');
  Object.assign(paths, { harnessBinDir: bin, agentZeroEnvPath: path.join(bin, 'agent-zero.env') });
  expect(await post({ tool, confirmed: true })).toMatchObject({ status: 409, body: { code: 'TOOLS_ACTION_UNAVAILABLE' } });
  const response = await post({ tool, action: 'requalify' });
  expect(response.status).toBe(202);
  const request = JSON.parse(fs.readFileSync(path.join(runDir(), 'request.json'), 'utf8'));
  expect(request).toMatchObject({ tool, action: 'requalify', channel: null });
});

test('repair is the only run accepted while OpenClaw recovery is open; it is refused when nothing waits', async () => {
  const nothing = await post({ tool: 'openclaw', action: 'recover-native', confirmed: true });
  expect(nothing).toMatchObject({ status: 409, body: { code: 'NOTHING_TO_RECOVER' } });
  const failedRunId = '7c4e2a10-3b5d-4f61-9a82-1d0e6b3c5f27';
  fs.mkdirSync(path.join(paths.stateRoot, 'runs', failedRunId), { recursive: true });
  fs.writeFileSync(path.join(paths.stateRoot, 'runs', failedRunId, 'status.json'), JSON.stringify({
    schema: 'bridgesllm.tools.run.v1', runId: failedRunId, tool: 'openclaw', phase: 'recovery-required', state: 'recovery-required',
    phaseStartedAt: null, createdAt: '2026-10-30T11:00:00.000Z', endedAt: '2026-10-30T11:30:00.000Z', steps: [],
    error: { id: 'NATIVE_RECOVERY_REQUIRED', message: 'OpenClaw could not confirm its rollback.', nextAction: 'recover-native' },
    result: { action: 'update', from: '2026.9.9', to: null },
  }));
  service.invalidate();
  const status = await get();
  expect(status.body.recovery).toMatchObject({ action: { id: 'recover-native' } });
  const openclaw = status.body.tools.find((tool: any) => tool.id === 'openclaw');
  expect(openclaw).toMatchObject({ status: 'recovery-required', actions: [], runActions: ['recover-native'] });
  expect(status.body.tools.filter((tool: any) => tool.id !== 'openclaw').flatMap((tool: any) => tool.runActions)).toEqual([]);
  for (const body of [UPDATE, { tool: 'openclaw', action: 'preflight' }, { tool: 'codex', confirmed: true }, { tool: 'openclaw', action: 'retry-checks' }]) {
    expect(await post(body)).toMatchObject({ status: 409, body: { code: 'RECOVERY_REQUIRED' } });
  }
  expect(launcher).not.toHaveBeenCalled();
  const repair = await post({ tool: 'openclaw', action: 'recover-native', confirmed: true });
  expect(repair.status).toBe(202);
  expect(inspectBackup).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(path.join(runDir(), 'request.json'), 'utf8'))).toMatchObject({
    tool: 'openclaw', action: 'recover-native', channel: 'stable', acknowledgements: { confirmation: true, maintenanceWindow: false },
  });
  expect(launcher).toHaveBeenCalledWith(RUN_ID);
});

test('a host without the per-tool runner keeps the old path: runs are refused before any write', async () => {
  fs.rmSync(paths.toolsUnitPaths[0]);
  service.invalidate();
  const status = await get();
  expect(status.body.runner).toEqual({ installed: false, reason: 'The per-tool AI updater service is not installed on this server.' });
  expect(status.body.tools.flatMap((tool: any) => [...tool.actions, ...tool.runActions])).toEqual([]);
  const response = await post(UPDATE);
  expect(response).toMatchObject({ status: 503, body: { code: 'TOOLS_RUNNER_NOT_INSTALLED' } });
  expect(response.body.error).toContain('Update Compatible AI Tools');
  expect(acquireAdmission).not.toHaveBeenCalled();
  expect(fs.existsSync(paths.stateRoot)).toBe(false);
});

test('with the per-tool runner installed the old all-tools update is not a second path', async () => {
  const previous = { ...process.env };
  const legacy = () => fetch(url('/maintenance/actions/update-compatible-ai-tools'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-role': 'OWNER' }, body: JSON.stringify({}),
  });
  try {
    Object.assign(process.env, { BRIDGESLLM_TOOLCTL: paths.toolctlPath, BRIDGESLLM_TOOLS_UNIT: paths.toolsUnitPaths[0] });
    const refused = await legacy();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'PER_TOOL_UPDATER_INSTALLED' });
    // Without the runner today's behaviour stays: the old action still asks for its typed phrase.
    Object.assign(process.env, { BRIDGESLLM_TOOLS_UNIT: path.join(root, 'missing.service') });
    const old = await legacy();
    expect(old.status).toBe(400);
    expect(await old.json()).toMatchObject({ confirmationPhrase: 'UPDATE COMPATIBLE AI TOOLS' });
  } finally {
    process.env = previous;
  }
});

test('history names who started each run; the report is owner-only and lists evidence names only', async () => {
  expect((await post(UPDATE)).status).toBe(202);
  const dir = runDir();
  fs.writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ checks: [] }));
  fs.writeFileSync(path.join(dir, '.status.json.123.tmp'), '{}');
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    ...status, state: 'refused', phase: 'refused', endedAt: '2026-10-30T12:01:00.000Z',
    error: { id: 'PF8_DISK', message: 'Needs 49 GB free on /, has 19 GB.' }, result: { action: 'update', from: '2026.9.9', to: null },
  }));
  fs.writeFileSync(path.join(paths.stateRoot, 'history.jsonl'), `${JSON.stringify({
    runId: RUN_ID, tool: 'openclaw', action: 'update', from: '2026.9.9', to: null, outcome: 'refused', errorId: 'PF8_DISK',
    startedAt: '2026-10-30T12:00:00.000Z', endedAt: '2026-10-30T12:01:00.000Z', durationMs: 60_000,
  })}\n`);
  service.invalidate();
  const read = await get('/tools', 'ADMIN');
  expect(read.body.history).toEqual([expect.objectContaining({ runId: RUN_ID, outcome: 'refused', initiator: 'fixture-owner', durationMs: 60_000 })]);
  expect((await get(`/tools/runs/${RUN_ID}`, 'ADMIN')).status).toBe(403);
  const report = await get(`/tools/runs/${RUN_ID}`);
  expect(report.status).toBe(200);
  expect(report.body.run).toMatchObject({ runId: RUN_ID, state: 'refused', error: { id: 'PF8_DISK' } });
  expect(report.body.evidence).toEqual(['preflight.json', 'status.json']);
  for (const bad of ['..%2F..%2Fetc', 'not-a-run', '5d1f8a3c-6b72-4e19-8c40-7a2e9f0d3b12']) {
    expect((await get(`/tools/runs/${bad}`)).status).toBe(404);
  }
});

test('a tool that is not installed, or whose version cannot be read, cannot be updated or re-checked', async () => {
  for (const body of [{ tool: 'clawhub', confirmed: true }, { tool: 'clawhub', action: 'requalify' }]) {
    const response = await post(body);
    expect(response).toMatchObject({ status: 409, body: { code: 'TOOLS_ACTION_UNAVAILABLE' } });
    expect(response.body.error).toContain('Not installed on this server.');
  }
  fs.writeFileSync(path.join(root, 'usr/lib/node_modules/openclaw/package.json'), '{"version":');
  service.invalidate();
  expect(await post(UPDATE)).toMatchObject({ status: 409, body: { code: 'TOOLS_ACTION_UNAVAILABLE' } });
  expect((await post({ tool: 'openclaw', action: 'preflight' })).status).toBe(202);
  expect(inspectBackup).not.toHaveBeenCalled();
});

test('an owner installs a missing CLI with one confirm: the recommended version only, then the run is busy', async () => {
  // This Portal's policy as shipped: ClawHub's recommended version is not qualified, and Install admits it as Update would.
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  const recommended = policy.tools.find((tool: any) => tool.id === 'clawhub').newestProven.version;
  const read = await get('/tools', 'ADMIN');
  expect(read.body.tools.find((tool: any) => tool.id === 'clawhub')).toMatchObject({
    status: 'not-installed', statusReason: 'Not installed on this server.', actions: ['install'], runActions: ['install'],
    installVersion: recommended,
  });
  expect(await post({ tool: 'clawhub', action: 'install', confirmed: true }, 'ADMIN')).toMatchObject({ status: 403 });
  expect(await post({ tool: 'clawhub', action: 'install' })).toMatchObject({ status: 400, body: { code: 'CONFIRMATION_REQUIRED' } });
  expect(await post({ tool: 'clawhub', action: 'install', confirmed: true, target: 'newest' }))
    .toMatchObject({ status: 400, body: { code: 'TOOLS_TARGET_INVALID', error: 'Install installs the recommended version only.' } });
  expect(launcher).not.toHaveBeenCalled();
  const response = await post({ tool: 'clawhub', action: 'install', confirmed: true });
  expect(response.status).toBe(202);
  expect(inspectBackup).not.toHaveBeenCalled();
  expect(launcher).toHaveBeenCalledWith(RUN_ID);
  expect(JSON.parse(fs.readFileSync(path.join(runDir(), 'request.json'), 'utf8'))).toMatchObject({
    tool: 'clawhub', action: 'install', target: 'recommended', channel: null, backup: null,
    acknowledgements: { confirmation: true, maintenanceWindow: false },
  });
  // One tools run at a time: nothing else is offered or accepted while it is queued.
  const busy = await get();
  expect(busy.body.tools.flatMap((tool: any) => [...tool.actions, ...tool.runActions])).toEqual([]);
  expect(await post({ tool: 'clawhub', action: 'install', confirmed: true })).toMatchObject({ status: 409, body: { code: 'MAINTENANCE_BUSY' } });
});

test('install is refused for an installed tool and during recovery, and never exists for OpenClaw', async () => {
  const present = await post({ tool: 'codex', action: 'install', confirmed: true });
  expect(present).toMatchObject({ status: 409, body: { code: 'TOOLS_ACTION_UNAVAILABLE' } });
  for (const tool of ['openclaw', 'agent-zero']) {
    expect([tool, (await post({ tool, action: 'install', confirmed: true })).body.code]).toEqual([tool, 'TOOLS_ACTION_INVALID']);
  }
  const failedRunId = '7c4e2a10-3b5d-4f61-9a82-1d0e6b3c5f29';
  fs.mkdirSync(path.join(paths.stateRoot, 'runs', failedRunId), { recursive: true });
  fs.writeFileSync(path.join(paths.stateRoot, 'runs', failedRunId, 'status.json'), JSON.stringify({
    schema: 'bridgesllm.tools.run.v1', runId: failedRunId, tool: 'codex', phase: 'recovery-required', state: 'recovery-required',
    phaseStartedAt: null, createdAt: '2026-10-30T11:00:00.000Z', endedAt: '2026-10-30T11:30:00.000Z', steps: [],
    error: { id: 'NPM_SWAP_BACK_FAILED', message: 'The previous version could not be put back.', nextAction: null },
    result: { action: 'update', from: '0.163.0', to: null },
  }));
  service.invalidate();
  expect(await post({ tool: 'clawhub', action: 'install', confirmed: true })).toMatchObject({ status: 409, body: { code: 'RECOVERY_REQUIRED' } });
  expect(launcher).not.toHaveBeenCalled();
});

test('a finished recovery-required run of another tool accepts only that tool\'s Re-check, with no confirm', async () => {
  const failedRunId = '7c4e2a10-3b5d-4f61-9a82-1d0e6b3c5f28';
  fs.mkdirSync(path.join(paths.stateRoot, 'runs', failedRunId), { recursive: true });
  // ClawHub is not even installed in this fixture: its Re-check is still the way out.
  fs.writeFileSync(path.join(paths.stateRoot, 'runs', failedRunId, 'status.json'), JSON.stringify({
    schema: 'bridgesllm.tools.run.v1', runId: failedRunId, tool: 'clawhub', phase: 'recovery-required', state: 'recovery-required',
    phaseStartedAt: null, createdAt: '2026-10-30T11:00:00.000Z', endedAt: '2026-10-30T11:30:00.000Z', steps: [],
    error: { id: 'NPM_TREE_MISSING', message: 'The ClawHub files are missing.', nextAction: null },
    result: { action: 'update', from: '0.9.0', to: null },
  }));
  service.invalidate();
  const status = await get();
  expect(status.body.recovery).toMatchObject({ action: { id: 'requalify', label: 'Re-check ClawHub' }, tool: 'clawhub' });
  expect(status.body.tools.find((tool: any) => tool.id === 'clawhub')).toMatchObject({ runActions: ['requalify'], actions: [] });
  expect(status.body.tools.filter((tool: any) => tool.id !== 'clawhub').flatMap((tool: any) => tool.runActions)).toEqual([]);
  for (const body of [{ tool: 'clawhub', confirmed: true }, { tool: 'codex', action: 'requalify' }, { tool: 'openclaw', action: 'preflight' }, UPDATE]) {
    expect(await post(body)).toMatchObject({ status: 409, body: { code: 'RECOVERY_REQUIRED' } });
  }
  expect(launcher).not.toHaveBeenCalled();
  const recheck = await post({ tool: 'clawhub', action: 'requalify' });
  expect(recheck.status).toBe(202);
  expect(JSON.parse(fs.readFileSync(path.join(runDir(), 'request.json'), 'utf8'))).toMatchObject({
    tool: 'clawhub', action: 'requalify', acknowledgements: { confirmation: false, maintenanceWindow: false },
  });
  expect(launcher).toHaveBeenCalledWith(RUN_ID);
  expect(inspectBackup).not.toHaveBeenCalled();
});

describe('POST /tools/reconcile', () => {
  const reconcile = async (role = 'OWNER') => {
    const response = await fetch(url('/tools/reconcile'), { method: 'POST', headers: { 'x-fixture-role': role } });
    return { status: response.status, body: await response.json() as any };
  };
  // A run whose runner is gone: its lock owner belongs to an earlier boot.
  const staleRun = () => {
    fs.mkdirSync(runDir(), { recursive: true });
    fs.writeFileSync(path.join(runDir(), 'status.json'), JSON.stringify({
      schema: 'bridgesllm.tools.run.v1', runId: RUN_ID, tool: 'codex', phase: 'swap', phaseStartedAt: null, state: 'running',
      createdAt: '2026-10-30T11:59:00.000Z', steps: [], error: null, result: null,
    }));
    fs.writeFileSync(path.join(paths.stateRoot, 'lock.owner.json'), JSON.stringify({ runId: RUN_ID, pid: process.pid, bootId: 'boot-that-ended' }));
  };

  test('owner starts the reconcile unit (argv only) under admission while an interrupted run waits', async () => {
    staleRun();
    expect((await get()).body.recovery).toMatchObject({ action: { id: 'reconcile-tools-run', label: 'Check interrupted update' }, runId: RUN_ID });
    expect(await reconcile()).toEqual({ status: 202, body: { started: true, runId: RUN_ID } });
    expect(starter).toHaveBeenCalledTimes(1);
    expect(starter.mock.calls[0][0]).toEqual(['start', '--no-block', 'bridgesllm-tools-reconcile.service']);
    expect(acquireAdmission).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('admins are refused before anything is read or started', async () => {
    staleRun();
    expect((await reconcile('ADMIN')).status).toBe(403);
    expect(acquireAdmission).not.toHaveBeenCalled();
    expect(starter).not.toHaveBeenCalled();
  });

  test('nothing to reconcile without an interrupted run, including an open legacy ledger (text only)', async () => {
    expect(await reconcile()).toMatchObject({ status: 409, body: { code: 'NOTHING_TO_RECONCILE', recovery: null } });
    fs.mkdirSync(paths.installerStateRoot, { recursive: true });
    fs.mkdirSync(path.join(paths.installerStateRoot, 'openclaw-native-chat-v1'));
    expect(await reconcile()).toMatchObject({ status: 409, body: { code: 'NOTHING_TO_RECONCILE', recovery: { action: { id: 'recover-legacy' } } } });
    expect(starter).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(2);
  });

  test('without the per-tool runner it is 503 and nothing starts; a start failure is 503 too', async () => {
    staleRun();
    fs.rmSync(paths.toolsUnitPaths[0]);
    expect(await reconcile()).toMatchObject({ status: 503, body: { code: 'TOOLS_RUNNER_NOT_INSTALLED' } });
    expect(starter).not.toHaveBeenCalled();
    fs.writeFileSync(paths.toolsUnitPaths[0], 'fixture\n');
    starter.mockImplementationOnce((_args: string[], done: (error: Error | null) => void) => done(new Error('Unit not found')));
    expect(await reconcile()).toMatchObject({ status: 503, body: { code: 'TOOLS_RECONCILE_START_FAILED' } });
    expect(release).toHaveBeenCalledTimes(2);
  });
});

describe('POST /tools/runs/:runId/stop', () => {
  const stop = async (runId = RUN_ID, role = 'OWNER') => {
    const response = await fetch(url(`/tools/runs/${runId}/stop`), { method: 'POST', headers: { 'x-fixture-role': role } });
    return { status: response.status, body: await response.json() as any };
  };
  const liveRun = (tool: string, phase: string) => {
    fs.mkdirSync(runDir(), { recursive: true });
    fs.writeFileSync(path.join(runDir(), 'status.json'), JSON.stringify({
      schema: 'bridgesllm.tools.run.v1', runId: RUN_ID, tool, phase, phaseStartedAt: null, state: 'running',
      createdAt: '2026-10-30T11:59:00.000Z', steps: [{ id: phase, label: phase, state: 'running', startedAt: null, endedAt: null, detail: null, evidence: [] }],
      error: null, result: null,
    }));
    fs.writeFileSync(path.join(paths.stateRoot, 'lock.owner.json'), JSON.stringify({ runId: RUN_ID, pid: process.pid, bootId: null }));
  };

  test('refuses during Ollama swap with a plain reason and stops nothing; the status says the same', async () => {
    liveRun('ollama', 'swap');
    const refused = await stop();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'TOOLS_STOP_UNAVAILABLE', step: 'swap' });
    expect(refused.body.error).toMatch(/could leave Ollama stopped\. Stop is available again when this step ends\. Nothing was stopped\.$/);
    expect(stopper).not.toHaveBeenCalled();
    expect((await get()).body.activeRun.stopRefusal).toMatch(/^Ollama's installer is switching versions/);
  });

  test('stops a run in an interruptible step; owner-only; only the running run', async () => {
    liveRun('hermes', 'probe-candidate');
    expect((await stop(RUN_ID, 'SUB_ADMIN')).status).toBe(403);
    expect(await stop('0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e09')).toMatchObject({ status: 409, body: { code: 'TOOLS_RUN_NOT_ACTIVE' } });
    expect((await stop('not-a-run')).status).toBe(404);
    expect(stopper).not.toHaveBeenCalled();
    expect(await stop()).toMatchObject({ status: 202, body: { runId: RUN_ID, stopping: true } });
    expect(stopper).toHaveBeenCalledWith(RUN_ID);
  });

  test('refuses during the Hermes build (stage) and when nothing is running', async () => {
    expect(await stop()).toMatchObject({ status: 409, body: { code: 'TOOLS_RUN_NOT_ACTIVE' } });
    liveRun('hermes', 'stage');
    expect(await stop()).toMatchObject({ status: 409, body: { code: 'TOOLS_STOP_UNAVAILABLE', step: 'stage' } });
    expect(stopper).not.toHaveBeenCalled();
  });
});
