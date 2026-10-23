import express, { NextFunction, Request, Response } from 'express';
import http from 'http';

const activityCreate = jest.fn();
const management = {
  readBackupPolicy: jest.fn(),
  saveBackupPolicy: jest.fn(),
  previewBackupCleanup: jest.fn(),
  runBackupCleanup: jest.fn(),
};
const schedules = {
  readBackupScheduleSettings: jest.fn(),
  updateBackupSchedule: jest.fn(),
};

jest.mock('../config/database', () => ({
  prisma: { activityLog: { create: (...args: unknown[]) => activityCreate(...args) } },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-1',
      email: 'owner@example.com',
      role: String(req.headers['x-test-role'] || 'OWNER'),
      accountStatus: 'ACTIVE',
    } as any;
    next();
  },
}));

jest.mock('../services/backupManagement.service', () => ({
  ...jest.requireActual('../services/backupManagement.service'),
  readBackupPolicy: (...args: unknown[]) => management.readBackupPolicy(...args),
  saveBackupPolicy: (...args: unknown[]) => management.saveBackupPolicy(...args),
  previewBackupCleanup: (...args: unknown[]) => management.previewBackupCleanup(...args),
  runBackupCleanup: (...args: unknown[]) => management.runBackupCleanup(...args),
}));

jest.mock('../services/backupSchedule.service', () => ({
  ...jest.requireActual('../services/backupSchedule.service'),
  readBackupScheduleSettings: (...args: unknown[]) => schedules.readBackupScheduleSettings(...args),
  updateBackupSchedule: (...args: unknown[]) => schedules.updateBackupSchedule(...args),
}));

jest.mock('../services/backup.service', () => ({
  ...jest.requireActual('../services/backup.service'),
  readLegacyBackupCron: async () => ({ active: [], disabled: [] }),
}));

import backupsRouter from '../routes/backups';
import { BackupManagementError } from '../services/backupManagement.service';
import { BackupScheduleError } from '../services/backupSchedule.service';

function request(server: http.Server, method: string, url: string, body?: unknown, role = 'OWNER') {
  const address = server.address() as { port: number };
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: address.port, method, path: `/backups${url}`,
      headers: {
        'x-test-role': role,
        ...(encoded ? { 'content-type': 'application/json', 'content-length': String(encoded.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : undefined, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

const destructive = () => [management.runBackupCleanup, schedules.updateBackupSchedule, management.saveBackupPolicy]
  .map((mock) => mock.mock.calls.length);

describe('owner backup management routes', () => {
  let server: http.Server;
  const token = 'a'.repeat(64);

  beforeEach(async () => {
    jest.clearAllMocks();
    activityCreate.mockResolvedValue({});
    const app = express();
    app.use(express.json());
    app.use('/backups', backupsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each(['USER', 'ADMIN', 'SUB_ADMIN'])('refuses every management route to %s', async (role) => {
    for (const [method, url, body] of [
      ['GET', '/settings'], ['PUT', '/settings', {}], ['GET', '/cleanup/preview'],
      ['POST', '/cleanup', { planToken: token, confirm: true }], ['PUT', '/schedules/daily', { enabled: false, time: '02:00' }],
    ] as const) {
      expect((await request(server, method, url, body, role)).status).toBe(403);
    }
    expect([...Object.values(management), ...Object.values(schedules)].every((mock) => mock.mock.calls.length === 0)).toBe(true);
  });

  it('saves settings without previewing or deleting anything', async () => {
    const body = { keep: { daily: 2, weekly: 1, monthly: 1, comprehensive: 1 }, autoCleanup: true, reserveGiB: 10 };
    management.saveBackupPolicy.mockResolvedValue({ policy: body, source: 'saved' });
    const response = await request(server, 'PUT', '/settings', body);
    expect(response.status).toBe(200);
    expect(management.saveBackupPolicy).toHaveBeenCalledWith(body);
    expect(management.previewBackupCleanup).not.toHaveBeenCalled();
    expect(management.runBackupCleanup).not.toHaveBeenCalled();
    expect(activityCreate.mock.calls[0][0].data).toMatchObject({ action: 'BACKUP_SETTINGS_UPDATED', metadata: { policy: body } });
  });

  it('passes the program refusal through and records nothing', async () => {
    management.saveBackupPolicy.mockRejectedValue(new BackupManagementError(400, 'POLICY_INVALID', 'Keep limits must be whole numbers from 1 to 100'));
    const response = await request(server, 'PUT', '/settings', { keep: { daily: 0 } });
    expect(response).toMatchObject({ status: 400, body: { code: 'POLICY_INVALID', error: 'Keep limits must be whole numbers from 1 to 100' } });
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it('previews without deleting and forbids caching', async () => {
    management.previewBackupCleanup.mockResolvedValue({ token, count: 0, archives: [] });
    const response = await request(server, 'GET', '/cleanup/preview');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(destructive()).toEqual([0, 0, 0]);
  });

  it.each([
    [{ planToken: token }],
    [{ confirm: true }],
    [{ planToken: token, confirm: 'true' }],
    [{ planToken: 7, confirm: true }],
  ])('requires an explicit confirmation of a reviewed plan: %j', async (body) => {
    const response = await request(server, 'POST', '/cleanup', body);
    expect(response.status).toBe(400);
    expect(management.runBackupCleanup).not.toHaveBeenCalled();
  });

  it('runs exactly the reviewed plan and records what was deleted', async () => {
    management.runBackupCleanup.mockResolvedValue({ deleted: ['a.tar.gz'], deletedCount: 1, deletedBytes: 10, freedBytes: 8, heldBytes: 2 });
    const response = await request(server, 'POST', '/cleanup', { planToken: token, confirm: true });
    expect(response).toMatchObject({ status: 200, body: { deletedCount: 1, heldBytes: 2 } });
    expect(management.runBackupCleanup).toHaveBeenCalledWith(token);
    expect(activityCreate.mock.calls[0][0].data).toMatchObject({
      action: 'BACKUP_CLEANUP', metadata: { deleted: ['a.tar.gz'], deletedBytes: 10, freedBytes: 8 },
    });
  });

  it('reports a stale review as a conflict', async () => {
    management.runBackupCleanup.mockRejectedValue(new BackupManagementError(409, 'STALE', 'Backups changed since you reviewed them.'));
    const response = await request(server, 'POST', '/cleanup', { planToken: token, confirm: true });
    expect(response).toMatchObject({ status: 409, body: { code: 'STALE' } });
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it('serializes changes to one schedule and maps validation errors', async () => {
    let release!: () => void;
    schedules.updateBackupSchedule.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ type: 'daily', enabled: true, time: '03:00', weekday: null, dayOfMonth: null });
    }));
    const first = request(server, 'PUT', '/schedules/daily', { enabled: true, time: '03:00' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await request(server, 'PUT', '/schedules/daily', { enabled: true, time: '04:00' });
    expect(second).toMatchObject({ status: 409, body: { code: 'BUSY' } });
    release();
    expect((await first).status).toBe(200);
    expect(schedules.updateBackupSchedule).toHaveBeenCalledTimes(1);
    schedules.updateBackupSchedule.mockRejectedValueOnce(new BackupScheduleError(400, 'SCHEDULE_INVALID', 'Time must be HH:MM in 24-hour form'));
    expect(await request(server, 'PUT', '/schedules/daily', { enabled: true, time: '25:00' }))
      .toMatchObject({ status: 400, body: { code: 'SCHEDULE_INVALID' } });
  });

  it('includes the host time zone with the schedules', async () => {
    schedules.readBackupScheduleSettings.mockResolvedValue({ hostTimezone: 'America/New_York', schedules: [{ type: 'daily' }] });
    const response = await request(server, 'GET', '/cron-info');
    expect(response).toMatchObject({ status: 200, body: { hostTimezone: 'America/New_York', schedules: [{ type: 'daily' }] } });
  });
});
