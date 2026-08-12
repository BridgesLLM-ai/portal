import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import {
  startStartupStatusServer,
  stopStartupStatusServer,
  setStartupPhase,
  getStartupPhase,
  holdStartupStatusServerForProjectDependencyPromotionQuarantine,
  stopStartupStatusServerForShutdown,
  StartupStatusServerFailureHoldError,
  PROJECT_DEPENDENCY_PROMOTION_QUARANTINE_CODE,
  PROJECT_DEPENDENCY_PROMOTION_RECOVERY_PHASE,
} from '../services/startupStatusServer';
import { PORTAL_VERSION } from '../version';

const HOST = '127.0.0.1';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function request(
  port: number,
  path: string,
  method = 'GET'
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`http://${HOST}:${port}${path}`, { method });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

describe('startupStatusServer', () => {
  afterEach(async () => {
    try {
      await stopStartupStatusServer();
    } catch (error) {
      if (!(error instanceof StartupStatusServerFailureHoldError)) throw error;
      await stopStartupStatusServerForShutdown();
    }
    jest.restoreAllMocks();
    setStartupPhase('initializing');
  });

  it('serves starting status with the current phase on /health', async () => {
    const port = await freePort();
    await startStartupStatusServer(port, HOST);
    setStartupPhase('legacy-project-retirement');

    const res = await request(port, '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('starting');
    expect(res.body.phase).toBe('legacy-project-retirement');
    expect(res.body.version).toBe(PORTAL_VERSION);
  });

  it('reports starting (not ready) on the authenticated readiness path', async () => {
    const port = await freePort();
    await startStartupStatusServer(port, HOST);

    const res = await request(port, '/health/update-ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('starting');
    // The updater must never mistake bootstrap output for real readiness.
    expect(res.body).not.toMatchObject({ status: 'ready', database: 'ready' });
  });

  it('fails closed with 503 for every non-health path and method', async () => {
    const port = await freePort();
    await startStartupStatusServer(port, HOST);

    for (const [method, path] of [
      ['GET', '/api/auth/login'],
      ['POST', '/health'],
      ['GET', '/api/admin'],
      ['GET', '/'],
    ] as const) {
      const res = await request(port, path, method);
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('starting');
    }
  });

  it('releases the port so the real server can bind after stop', async () => {
    const port = await freePort();
    await startStartupStatusServer(port, HOST);
    await stopStartupStatusServer();

    const real = createServer((_req, res) => {
      res.writeHead(200);
      res.end('real');
    });
    await new Promise<void>((resolve, reject) => {
      real.once('error', reject);
      real.listen(port, HOST, () => resolve());
    });
    const res = await fetch(`http://${HOST}:${port}/anything`);
    expect(res.status).toBe(200);
    await new Promise<void>((resolve) => real.close(() => resolve()));
  });

  it('is idempotent for double start and double stop', async () => {
    const port = await freePort();
    await startStartupStatusServer(port, HOST);
    await expect(startStartupStatusServer(port, HOST)).resolves.toBeUndefined();
    await stopStartupStatusServer();
    await expect(stopStartupStatusServer()).resolves.toBeUndefined();
    expect(getStartupPhase()).toBeDefined();
  });

  it('irreversibly holds every route on a sanitized Project promotion quarantine', async () => {
    const ref = jest.spyOn(Server.prototype, 'ref');
    const port = await freePort();
    await startStartupStatusServer(port, HOST);
    setStartupPhase('/private/owner/project/path');

    holdStartupStatusServerForProjectDependencyPromotionQuarantine();
    holdStartupStatusServerForProjectDependencyPromotionQuarantine();
    setStartupPhase('finalizing');

    expect(ref).toHaveBeenCalled();
    expect(getStartupPhase()).toBe(PROJECT_DEPENDENCY_PROMOTION_RECOVERY_PHASE);
    for (const [method, path] of [
      ['GET', '/health'],
      ['GET', '/health/update-ready?owner=private'],
      ['POST', '/health'],
      ['GET', '/api/auth/login'],
      ['DELETE', '/private/owner/project/path'],
      ['GET', '/'],
    ] as const) {
      const res = await request(port, path, method);
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('retry-after')).toBe('60');
      expect(res.body).toMatchObject({
        status: 'unavailable',
        code: PROJECT_DEPENDENCY_PROMOTION_QUARANTINE_CODE,
        phase: PROJECT_DEPENDENCY_PROMOTION_RECOVERY_PHASE,
      });
      expect(Object.keys(res.body).sort()).toEqual([
        'code', 'phase', 'startedAt', 'status', 'timestamp', 'version',
      ]);
      expect(JSON.stringify(res.body)).not.toContain('/private/owner/project/path');
      expect(JSON.stringify(res.body)).not.toContain('owner=private');
    }

    await expect(stopStartupStatusServer()).rejects.toBeInstanceOf(
      StartupStatusServerFailureHoldError,
    );
  });
});
