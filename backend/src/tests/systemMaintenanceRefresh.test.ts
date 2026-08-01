import http from 'http';
import express from 'express';
import {
  createMaintenanceStatusHandler,
  MaintenanceRefreshCoordinator,
} from '../routes/system-maintenance';

type HttpResult = {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
};

async function request(server: http.Server, route: string): Promise<HttpResult> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  return new Promise<HttpResult>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'GET',
      path: route,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode || 0,
          body: text ? JSON.parse(text) : undefined,
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function startStatusServer(coordinator: MaintenanceRefreshCoordinator<any>): Promise<http.Server> {
  const app = express();
  app.get('/system/maintenance', createMaintenanceStatusHandler(coordinator));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('system maintenance refresh backoff', () => {
  test('returns Retry-After and blocks forced refreshes during a cold-start cooldown', async () => {
    let nowMs = 30_000;
    const collect = jest.fn(async () => {
      throw new Error('persistent package probe failure');
    });
    const coordinator = new MaintenanceRefreshCoordinator(collect, { nowMs: () => nowMs });
    const server = await startStatusServer(coordinator);

    try {
      const initial = await request(server, '/system/maintenance');
      expect(initial.status).toBe(202);
      expect(initial.body).toMatchObject({ ready: false, refreshing: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(collect).toHaveBeenCalledTimes(1);

      for (let repeatedForce = 0; repeatedForce < 4; repeatedForce += 1) {
        const blocked = await request(server, '/system/maintenance?refresh=true');
        expect(blocked.status).toBe(202);
        expect(blocked.headers['retry-after']).toBe('5');
        expect(blocked.body).toMatchObject({
          ready: false,
          refreshing: false,
          refreshError: 'persistent package probe failure',
          retryAfterMs: 5_000,
          summary: 'Server checks are paused after a failed refresh.',
        });
      }
      expect(collect).toHaveBeenCalledTimes(1);

      nowMs += 4_001;
      const nearlyDue = await request(server, '/system/maintenance?refresh=true');
      expect(nearlyDue.headers['retry-after']).toBe('1');
      expect(nearlyDue.body.retryAfterMs).toBe(999);
      expect(collect).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(server);
    }
  });

  test('preserves a cached snapshot while exposing background-failure Retry-After state', async () => {
    const nowMs = 40_000;
    let fail = false;
    const collect = jest.fn(async () => {
      if (fail) throw new Error('background package probe failure');
      return {
        checkedAt: '2026-07-21T08:00:00.000Z',
        status: 'healthy',
        summary: 'No server maintenance drift detected.',
        host: { hostname: 'test', os: 'Test Linux', kernel: '6.8.0', uptimeSeconds: 1 },
        issues: [],
        actions: [],
      };
    });
    const coordinator = new MaintenanceRefreshCoordinator(collect, { nowMs: () => nowMs });
    const server = await startStatusServer(coordinator);

    try {
      await request(server, '/system/maintenance');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(coordinator.snapshot().cache).not.toBeNull();

      fail = true;
      await request(server, '/system/maintenance?refresh=true');
      await new Promise<void>((resolve) => setImmediate(resolve));
      const cachedFailure = await request(server, '/system/maintenance?refresh=true');

      expect(cachedFailure.status).toBe(200);
      expect(cachedFailure.headers['retry-after']).toBe('5');
      expect(cachedFailure.body).toMatchObject({
        ready: true,
        cached: true,
        checkedAt: '2026-07-21T08:00:00.000Z',
        refreshing: false,
        refreshError: 'background package probe failure',
        retryAfterMs: 5_000,
      });
      expect(collect).toHaveBeenCalledTimes(2);
    } finally {
      await closeServer(server);
    }
  });
});
