import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { createAttestedBackupRoot } from './backupRunnerFixture';

// Real listing and the real lock/delete routes over a disposable root-owned
// store. PostgreSQL and the session are doubles. The backup mutation lock is
// real, so its paths are bound to the fixture before the service loads; the
// defaults are the live Portal's state directory and host lock.
const attested = createAttestedBackupRoot('backup-lock-marker');
const fixtureRoot = attested.fixtureRoot;
const portalRoot = path.join(fixtureRoot, 'portal');
const stateDirectory = path.join(portalRoot, 'backend', '.data', 'backups');
const mockBackupRoot = path.join(fixtureRoot, 'backups');
fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
process.env.PORTAL_ROOT = portalRoot;
process.env.BACKUP_STATE_DIR = stateDirectory;
process.env.BACKUP_CONFIG_FILE = path.join(stateDirectory, 'backup-base-path');
process.env.PORTAL_OPERATION_LOCK_FILE = path.join(fixtureRoot, 'portal-operation.lock');

const mockQueryRaw = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    activityLog: { create: jest.fn(async () => ({})) },
    systemSetting: { findUnique: jest.fn(async () => ({ value: mockBackupRoot })) },
  },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER', accountStatus: 'ACTIVE' } as any;
    next();
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const backup = require('../services/backup.service') as typeof import('../services/backup.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const routes = require('../routes/backups') as typeof import('../routes/backups');

const outside = path.join(fixtureRoot, 'outside-file');

const UNEXPECTED: Array<[string, (marker: string) => void]> = [
  ['a symbolic link to a file', (marker) => fs.symlinkSync(outside, marker)],
  ['a dangling symbolic link', (marker) => fs.symlinkSync(path.join(fixtureRoot, 'missing'), marker)],
  ['a directory', (marker) => fs.mkdirSync(marker, { mode: 0o700 })],
  ['a world-readable file', (marker) => { fs.writeFileSync(marker, 'x'); fs.chmodSync(marker, 0o644); }],
  ['a second hard link', (marker) => fs.linkSync(outside, marker)],
  ['a file owned by another user', (marker) => { fs.writeFileSync(marker, 'x', { mode: 0o600 }); fs.chownSync(marker, 1, 1); }],
];
const NOT_A_FILE = UNEXPECTED.slice(0, 3);

let server: http.Server;
let root: string;
let consoleError: jest.SpyInstance;

let archives = 0;

// A fresh name per test: a route keeps its per-file busy marker until the
// mutation lock is released, which is after the response.
function archive(): string {
  archives += 1;
  const suffix = archives.toString(16).padStart(8, '0');
  const file = path.join(root, 'daily', `portal-daily-20260901-020000-data-${suffix}.tar.gz`);
  fs.writeFileSync(file, 'archive bytes', { mode: 0o600 });
  return file;
}

function request(method: string, url: string): Promise<{ status: number; body: any }> {
  const { port } = server.address() as { port: number };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: `/backups${url}` }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  fs.writeFileSync(outside, 'not a lock', { mode: 0o600 });
  const app = express();
  app.use('/backups', routes.default);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(attested.cleanupRoot, { recursive: true, force: true });
});

beforeEach(() => {
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockQueryRaw.mockReset().mockResolvedValue([{ exists: false }]);
  fs.rmSync(mockBackupRoot, { recursive: true, force: true });
  root = backup.ensureBackupLayout(mockBackupRoot);
});

afterEach(() => consoleError.mockRestore());

describe('backup lock markers', () => {
  it('lists a backup with nothing at its lock path as unlocked', () => {
    archive();
    expect(backup.listBackupFiles(root).map((file) => file.locked)).toEqual([false]);
  });

  it.each(UNEXPECTED)('lists a backup whose lock is %s as locked', (_label, make) => {
    const file = archive();
    make(`${file}.locked`);
    const files = backup.listBackupFiles(root);
    expect(files.map((entry) => [entry.filename, entry.locked])).toEqual([[path.basename(file), true]]);
    expect(routes.buildBackupListResponse(root, files).backups[0].locked).toBe(true);
  });

  it.each(UNEXPECTED)('refuses to delete a backup whose lock is %s', async (_label, make) => {
    const file = archive();
    make(`${file}.locked`);
    const response = await request('DELETE', `/${path.basename(file)}`);
    expect(response).toMatchObject({ status: 400, body: { error: 'Cannot delete locked backup. Unlock it first.' } });
    expect(fs.readFileSync(file, 'utf8')).toBe('archive bytes');
    expect(fs.lstatSync(`${file}.locked`)).toBeTruthy();
  });

  it('deletes an unlocked backup through the same route', async () => {
    const file = archive();
    const response = await request('DELETE', `/${path.basename(file)}`);
    expect(response).toMatchObject({ status: 200, body: { success: true } });
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each(NOT_A_FILE)('keeps a backup locked when its lock is %s', async (_label, make) => {
    const file = archive();
    const marker = `${file}.locked`;
    make(marker);
    const before = fs.lstatSync(marker);
    const response = await request('POST', `/lock/${path.basename(file)}`);
    expect(response).toMatchObject({ status: 409, body: { code: 'BACKUP_LOCK_UNEXPECTED' } });
    const after = fs.lstatSync(marker);
    expect([after.ino, after.mode]).toEqual([before.ino, before.mode]);
    expect(fs.readFileSync(outside, 'utf8')).toBe('not a lock');
    expect(backup.listBackupFiles(root)[0].locked).toBe(true);
  });

  it('unlocks a regular lock file on an explicit owner request', async () => {
    const file = archive();
    fs.writeFileSync(`${file}.locked`, 'x');
    fs.chmodSync(`${file}.locked`, 0o644);
    expect(await request('POST', `/lock/${path.basename(file)}`)).toMatchObject({ status: 200, body: { locked: false } });
    expect(fs.existsSync(`${file}.locked`)).toBe(false);
  });

  it('locks an unlocked backup with a private lock file', async () => {
    const file = archive();
    expect(await request('POST', `/lock/${path.basename(file)}`)).toMatchObject({ status: 200, body: { locked: true } });
    expect(fs.lstatSync(`${file}.locked`).mode & 0o777).toBe(0o600);
  });
});
