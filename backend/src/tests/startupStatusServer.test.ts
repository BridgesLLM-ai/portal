import { createServer } from 'http';
import type { AddressInfo } from 'net';
import {
  startStartupStatusServer,
  stopStartupStatusServer,
  setStartupPhase,
  getStartupPhase,
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
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://${HOST}:${port}${path}`, { method });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('startupStatusServer', () => {
  afterEach(async () => {
    await stopStartupStatusServer();
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
});
