import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { execFileSync } from 'child_process';

const mockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-file-boundary-'));
const mockProjectRoot = path.join(mockRoot, 'projects', 'owner', 'studio');
const mockOutside = path.join(mockRoot, 'outside');
const envNames = ['PORTAL_PROJECTS_ROOT', 'APPS_ROOT', 'PORTAL_PROJECT_ZIPS_ROOT', 'PORTAL_UPLOAD_TEMP_ROOT', 'DATABASE_URL'];
const oldEnv = envNames.map(name => process.env[name]);
process.env.DATABASE_URL = 'postgresql://127.0.0.1/portal_test';
process.env.PORTAL_PROJECTS_ROOT = path.join(mockRoot, 'projects');
process.env.APPS_ROOT = path.join(mockRoot, 'apps');
process.env.PORTAL_PROJECT_ZIPS_ROOT = path.join(mockRoot, 'zips');
process.env.PORTAL_UPLOAD_TEMP_ROOT = path.join(mockRoot, 'uploads');
let mockIdentity: any;
let mockAfterMiddleware = false;
let mockAfterGit = false;
const mockDatabase = {
  $queryRaw: jest.fn(async () => []),
  projectIdentity: { findUnique: jest.fn(async () => mockIdentity), findFirst: jest.fn(async () => mockIdentity) },
  projectWorkCard: { findFirst: jest.fn(async ({ where }: any) => where.id === 'card' && where.actorUserId === 'owner' ? {
    id: 'card', actorUserId: 'owner', projectIdentityId: 'project-1', projectName: 'studio',
    projectGeneration: 1, projectIdentity: mockIdentity, status: 'COMPLETED',
  } : null) },
  activityLog: { create: jest.fn(async () => ({})) },
};
jest.mock('../config/database', () => ({ prisma: mockDatabase }));
jest.mock('../middleware/auth', () => {
  const authenticateToken = (req: any, _res: any, next: any) => {
    req.user = { userId: 'owner', role: 'OWNER', authorizationVersion: 1 }; next();
  };
  return { authenticateToken, browserAuthRedirect: authenticateToken };
});
jest.mock('../middleware/requireApproved', () => ({ requireApproved: (_req: any, _res: any, next: any) => next() }));
jest.mock('../utils/workspaceScope', () => ({ getWorkspaceOwnerId: async (user: any) => user.userId }));
jest.mock('../middleware/pathSandbox', () => {
  const actual = jest.requireActual('../middleware/pathSandbox');
  return { ...actual, projectPathSandbox: (req: any, res: any, next: any) => actual.projectPathSandbox(req, res, () => {
    mockAfterMiddleware = true; next();
  }) };
});
jest.mock('../services/projectDeletionLock', () => ({
  ...jest.requireActual('../services/projectDeletionLock'),
  acquireProjectDeletionLock: async () => () => undefined,
}));
// Only the container-launch transport is replaced. These are real Git commands
// in this test-owned repository; both empty diffs must reach the actual fallback.
jest.mock('../services/project-git.service', () => ({
  ...jest.requireActual('../services/project-git.service'),
  runProjectGitCommand: async ({ workspace, args }: any) => {
    const result = execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    if (args.includes('--cached')) mockAfterGit = true;
    return result;
  },
}));
const { attestProjectRoot } = require('../services/projectIdentity');
const projectRoutes = require('../routes/projects').default;
const { createProjectWorkRouter } = require('../routes/project-work');
let server: http.Server;
let origin: string;

beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use('/api/projects', projectRoutes);
  app.use('/api/project-work', createProjectWorkRouter(projectRoutes, express.Router()));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
});
beforeEach(() => {
  fs.rmSync(mockProjectRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(mockProjectRoot, 'nested'), { recursive: true });
  fs.mkdirSync(mockOutside, { recursive: true });
  fs.writeFileSync(path.join(mockProjectRoot, 'nested', 'proof.txt'), 'PROJECT_ONLY\n');
  fs.writeFileSync(path.join(mockOutside, 'proof.txt'), 'OUTSIDE_MUST_NEVER_BE_SERVED\n');
  execFileSync('git', ['init', '-q', mockProjectRoot]);
  execFileSync('git', ['-C', mockProjectRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '--allow-empty', '-qm', 'baseline']);
  mockIdentity = { id: 'project-1', workspaceOwnerId: 'owner', projectName: 'studio',
    ...attestProjectRoot(mockProjectRoot), generation: 1, lifecycleStatus: 'ACTIVE', legacyOpenClawMigrationStatus: 'CURRENT' };
  mockAfterMiddleware = false; mockAfterGit = false;
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(mockRoot, { recursive: true, force: true });
  envNames.forEach((name, i) => oldEnv[i] === undefined ? delete process.env[name] : process.env[name] = oldEnv[i]);
});

async function request(kind: string, name = 'nested/proof.txt', headers = {}) {
  const response = kind === 'diff'
    ? await fetch(`${origin}/api/projects/studio/git`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'diff', file: name }) })
    : await fetch(`${origin}/api/project-work/card/raw?path=${encodeURIComponent(name)}`, { headers });
  return { status: response.status, body: await response.text(), headers: response.headers };
}
const swap = () => {
  fs.renameSync(path.join(mockProjectRoot, 'nested'), path.join(mockProjectRoot, 'original'));
  fs.symlinkSync(mockOutside, path.join(mockProjectRoot, 'nested'));
};

test.each(['diff', 'raw'])('%s serves nested regular content through the real route', async kind => {
  const result = await request(kind);
  expect(result.status).toBe(200); expect(result.body).toContain('PROJECT_ONLY');
});
test.each(['diff', 'raw'])('%s refuses an intermediate repository symlink', async kind => {
  swap();
  const result = await request(kind);
  expect(result.body).not.toContain('OUTSIDE_MUST_NEVER_BE_SERVED');
  expect(result.body).not.toContain('PROJECT_ONLY');
});
test.each(['diff', 'raw'])('%s pins directory ancestry across a concurrent rename/symlink replacement', async kind => {
  let swapped = false;
  const doSwap = () => { if (!swapped) { swapped = true; swap(); } };
  const originalOpen = fs.openSync;
  const originalRealpath = fs.realpathSync;
  const originalStat = fs.lstatSync;
  // Deterministic interleaving of a separate project writer at filesystem-call
  // boundaries; no sleeps and no probabilistic success from a missed race.
  jest.spyOn(fs, 'openSync').mockImplementation(((name: any, ...args: any[]) => {
    const fd = (originalOpen as any)(name, ...args);
    if (String(name).startsWith('/proc/self/fd/') && String(name).endsWith('/nested')) doSwap();
    return fd;
  }) as any);
  jest.spyOn(fs, 'realpathSync').mockImplementation(((name: any, ...args: any[]) => {
    const result = (originalRealpath as any)(name, ...args);
    if (kind === 'raw' && mockAfterMiddleware && name === path.join(mockProjectRoot, 'nested/proof.txt')) doSwap();
    return result;
  }) as any);
  fs.realpathSync.native = originalRealpath.native;
  jest.spyOn(fs, 'lstatSync').mockImplementation(((name: any, ...args: any[]) => {
    const result = (originalStat as any)(name, ...args);
    if (kind === 'diff' && mockAfterGit && name === path.join(mockProjectRoot, 'nested/proof.txt')) doSwap();
    return result;
  }) as any);
  const result = await request(kind);
  expect(swapped).toBe(true);
  expect(result.body).not.toContain('OUTSIDE_MUST_NEVER_BE_SERVED');
  // Pinned reads may finish from the original directory; a fail-closed response
  // is also valid. Reading the replacement's target is never valid.
  if (result.status === 200 && result.body) expect(result.body).toContain('PROJECT_ONLY');
});
test('raw preserves byte ranges, empty responses and active-content controls', async () => {
  const range = await request('raw', 'nested/proof.txt', { Range: 'bytes=0-6' });
  expect(range.status).toBe(206); expect(range.body).toBe('PROJECT');
  expect(range.headers.get('content-range')).toBe('bytes 0-6/13');
  fs.writeFileSync(path.join(mockProjectRoot, 'empty.txt'), '');
  expect((await request('raw', 'empty.txt')).body).toBe('');
  fs.writeFileSync(path.join(mockProjectRoot, 'active.svg'), '<svg/>');
  const active = await request('raw', 'active.svg');
  expect(active.headers.get('content-type')).toBe('application/octet-stream');
  expect(active.headers.get('content-disposition')).toContain('attachment');
  expect(active.headers.get('x-content-type-options')).toBe('nosniff');
});
