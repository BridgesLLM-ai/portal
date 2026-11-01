import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { exec } from 'child_process';
import router, { toolsRunBusyRefusal } from '../routes/system-maintenance';
import * as toolsStatusModule from '../services/toolsStatus';
import { startAgentJob } from '../services/agentJobs';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  // Every shell probe fails here, so apt reads as unavailable and nothing on the host is asked.
  exec: jest.fn((_command: string, _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(new Error('no shell in this test'), '', '');
  }),
}));
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
const SECURITY = { confirmation: 'APPLY SECURITY UPDATES', maintenanceWindowAcknowledged: true };
const ENV_KEYS = [
  'PORTAL_ROOT', 'BRIDGESLLM_TOOLS_STATE_ROOT', 'BRIDGESLLM_INSTALLER_STATE_ROOT', 'BRIDGESLLM_GATEWAY_FENCE_MARKER',
  'BRIDGESLLM_GATEWAY_FENCE_PERMIT', 'BRIDGESLLM_OPENCLAW_STATE_DIR', 'BRIDGESLLM_TOOL_POLICY', 'BRIDGESLLM_NPM_GLOBAL_ROOT',
  'BRIDGESLLM_HARNESS_RUNTIME_ROOT', 'BRIDGESLLM_HARNESS_BIN_DIR', 'BRIDGESLLM_AGENT_ZERO_ENV', 'BRIDGESLLM_TOOLCTL', 'BRIDGESLLM_TOOLS_UNIT',
] as const;
const previousEnv: Record<string, string | undefined> = {};

let root: string;
let stateRoot: string;
let server: http.Server;

beforeEach(async () => {
  jest.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-actions-tools-'));
  stateRoot = path.join(root, 'var/lib/bridgesllm/tools');
  // portalRoot() takes PORTAL_ROOT only when it holds backend/package.json; the admission lock then lives here.
  fs.mkdirSync(path.join(root, 'portal/backend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'portal/backend/package.json'), '{}\n');
  const toolctl = path.join(root, 'portal/installer/tools/bridgesllm-toolctl.py');
  const unit = path.join(root, 'etc/systemd/system/bridgesllm-tools@.service');
  for (const file of [toolctl, unit]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture\n');
  }
  for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
  Object.assign(process.env, {
    PORTAL_ROOT: path.join(root, 'portal'),
    BRIDGESLLM_TOOLS_STATE_ROOT: stateRoot,
    BRIDGESLLM_INSTALLER_STATE_ROOT: path.join(root, 'var/lib/bridgesllm-installer'),
    BRIDGESLLM_GATEWAY_FENCE_MARKER: path.join(root, 'var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1'),
    BRIDGESLLM_GATEWAY_FENCE_PERMIT: path.join(root, 'run/bridgesllm/openclaw-gateway-migration-permit.v1'),
    BRIDGESLLM_OPENCLAW_STATE_DIR: path.join(root, 'root/.openclaw'),
    BRIDGESLLM_TOOL_POLICY: POLICY_PATH,
    BRIDGESLLM_NPM_GLOBAL_ROOT: path.join(root, 'usr/lib/node_modules'),
    BRIDGESLLM_HARNESS_RUNTIME_ROOT: path.join(root, 'usr/local/lib/bridgesllm-runtimes'),
    BRIDGESLLM_HARNESS_BIN_DIR: path.join(root, 'usr/local/bin'),
    BRIDGESLLM_AGENT_ZERO_ENV: path.join(root, 'etc/bridgesllm/agent-zero.env'),
    BRIDGESLLM_TOOLCTL: toolctl,
    BRIDGESLLM_TOOLS_UNIT: unit,
  });
  const app = express();
  app.use(express.json());
  app.use('/maintenance', router);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

async function post(actionId: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/maintenance/actions/${actionId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-role': 'OWNER' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

/** A Codex update in its swap step; bootId null = this boot, so a live pid keeps it running (not stale). */
function toolsRun(bootId: string | null) {
  const runDir = path.join(stateRoot, 'runs', RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({
    schema: 'bridgesllm.tools.run.v1', runId: RUN_ID, tool: 'codex', phase: 'swap', phaseStartedAt: null, state: 'running',
    createdAt: new Date(Date.now() - 60_000).toISOString(), steps: [], error: null, result: null,
  }));
  fs.writeFileSync(path.join(stateRoot, 'lock.owner.json'), JSON.stringify({ runId: RUN_ID, pid: process.pid, bootId }));
}

const lockPath = () => path.join(root, 'portal/backend/.data/locks/system-maintenance.lock');

test('a running tools update refuses other maintenance actions before any work or job launch', async () => {
  toolsRun(null);
  for (const [actionId, body] of [['apply-security-updates', SECURITY], ['generate-maintenance-plan', {}]] as const) {
    const response = await post(actionId, body);
    expect([actionId, response.status]).toEqual([actionId, 409]);
    expect(response.body).toMatchObject({
      code: 'MAINTENANCE_BUSY', error: 'An AI tools update is running. Start this action after it finishes.',
      activeRun: { runId: RUN_ID, tool: 'codex', stale: false },
    });
  }
  expect(startAgentJob).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
  expect(fs.existsSync(lockPath())).toBe(false);
});

test('an interrupted tools run (runner gone) also waits, and says to check it first', async () => {
  toolsRun('boot-that-ended');
  const response = await post('apply-security-updates', SECURITY);
  expect(response).toMatchObject({ status: 409, body: { code: 'MAINTENANCE_BUSY', activeRun: { runId: RUN_ID, stale: true } } });
  expect(response.body.error).toBe('An AI tools update stopped unexpectedly and has not been checked yet. Check the interrupted update under AI tools first.');
  expect(startAgentJob).not.toHaveBeenCalled();
});

test('without a tools run the actions behave as before', async () => {
  // A finished run is history, not a running update.
  fs.mkdirSync(path.join(stateRoot, 'runs', RUN_ID), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'runs', RUN_ID, 'status.json'), JSON.stringify({
    schema: 'bridgesllm.tools.run.v1', runId: RUN_ID, tool: 'codex', phase: 'succeeded', phaseStartedAt: null, state: 'succeeded',
    createdAt: '2026-10-30T11:00:00.000Z', steps: [], error: null, result: { action: 'update' },
  }));
  // Security updates reach their apt check exactly as before (apt reads as unavailable in this test).
  expect(await post('apply-security-updates', SECURITY)).toMatchObject({ status: 400, body: { error: 'Apt is not available on this host.' } });
  expect(exec).toHaveBeenCalled();
  expect(startAgentJob).not.toHaveBeenCalled();
  expect((await post('generate-maintenance-plan')).status).toBe(202);
  expect(startAgentJob).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(lockPath())).toBe(false);
});

test('when the tools status cannot be read the action is refused (fail closed)', async () => {
  jest.spyOn(toolsStatusModule, 'readToolsSnapshot').mockImplementation(() => { throw new Error('EIO'); });
  const response = await post('generate-maintenance-plan');
  expect(response).toMatchObject({ status: 503, body: { code: 'TOOLS_STATUS_UNAVAILABLE' } });
  expect(response.body.error).toBe('AI tools status could not be read, so this action was not started. Try again in a minute.');
  expect(startAgentJob).not.toHaveBeenCalled();
  expect(fs.existsSync(lockPath())).toBe(false);
  expect(toolsRunBusyRefusal(() => { throw new Error('EIO'); })).toMatchObject({ status: 503, payload: { code: 'TOOLS_STATUS_UNAVAILABLE' } });
});
