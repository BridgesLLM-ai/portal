import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import router from '../routes/system-maintenance';
import { getCompatibleAiPrerequisites } from '../services/compatibleAiPrerequisites';
import { startAgentJob } from '../services/agentJobs';
import { getConfiguredBackupRoot } from '../services/backup.service';

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
jest.mock('../services/compatibleAiPrerequisites', () => ({
  getCompatibleAiPrerequisites: jest.fn(),
}));
jest.mock('../services/backup.service', () => ({
  getConfiguredBackupRoot: jest.fn(),
  expectedBackupOwnerIdentity: jest.fn(),
  listBackupFiles: jest.fn(),
  reauthenticateBackupClassification: jest.fn(),
}));

let root: string;
let server: http.Server;
const originalRoot = process.env.PORTAL_ROOT;
beforeEach(async () => {
  jest.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-maintenance-http-'));
  process.env.PORTAL_ROOT = root;
  const app = express();
  app.use(express.json());
  app.use('/maintenance', router);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalRoot === undefined) delete process.env.PORTAL_ROOT;
  else process.env.PORTAL_ROOT = originalRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function post(action = 'update-compatible-ai-tools', role = 'OWNER') {
  const address = server.address() as any;
  const response = await fetch(`http://127.0.0.1:${address.port}/maintenance/actions/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-role': role },
    body: JSON.stringify({ confirmation: 'UPDATE COMPATIBLE AI TOOLS', maintenanceWindowAcknowledged: true }),
  });
  return { status: response.status, body: await response.json() as any };
}

test.each([
  ['NODE_VERSION_UNSUPPORTED', 409],
  ['NODE_RUNTIME_UNSAFE', 409],
  ['NODE_CHECK_UNAVAILABLE', 503],
])('HTTP action refuses %s before backup work or job launch', async (code, expectedStatus) => {
  (getCompatibleAiPrerequisites as jest.Mock).mockResolvedValue({
    ready: false, code, nodeVersion: 'v24.21.0',
    requiredNodeRange: '>=24.22.1 <25 || >=26.12.1', message: 'Resolve the Node.js prerequisite.',
  });
  const response = await post();
  expect(response).toMatchObject({ status: expectedStatus, body: { code, error: 'Resolve the Node.js prerequisite.' } });
  expect(startAgentJob).not.toHaveBeenCalled();
  expect(getConfiguredBackupRoot).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(root, 'backend/.data/locks/system-maintenance.lock'))).toBe(false);
});

test('owner-only mutation boundary stays ahead of prerequisite diagnostics', async () => {
  expect((await post('update-compatible-ai-tools', 'SUB_ADMIN')).status).toBe(403);
  expect(getCompatibleAiPrerequisites).not.toHaveBeenCalled();
  expect(startAgentJob).not.toHaveBeenCalled();
});

test('unrelated read-only maintenance plan remains available', async () => {
  expect((await post('generate-maintenance-plan')).status).toBe(202);
  expect(getCompatibleAiPrerequisites).not.toHaveBeenCalled();
  expect(startAgentJob).toHaveBeenCalledTimes(1);
});
