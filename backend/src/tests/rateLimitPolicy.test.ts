import express from 'express';
import type { Server } from 'http';
import { mountGlobalApiRateLimit } from '../middleware/rateLimitPolicy';

describe('global API rate-limit policy', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
    server = undefined;
  });

  it('does not apply a special low ceiling to routine auth session reads', async () => {
    const app = express();
    mountGlobalApiRateLimit(app, { windowMs: 60_000, max: 20 });
    app.get('/api/auth/me', (_req, res) => res.json({ ok: true }));

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 15; attempt += 1) {
      statuses.push((await fetch(`http://127.0.0.1:${address.port}/api/auth/me`)).status);
    }

    expect(statuses).toEqual(Array(15).fill(200));
  });

  it('still caps runaway traffic at the configured broad API limit', async () => {
    const app = express();
    mountGlobalApiRateLimit(app, { windowMs: 60_000, max: 2 });
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');

    const first = await fetch(`http://127.0.0.1:${address.port}/api/ping`);
    const second = await fetch(`http://127.0.0.1:${address.port}/api/ping`);
    const third = await fetch(`http://127.0.0.1:${address.port}/api/ping`);

    expect([first.status, second.status, third.status]).toEqual([200, 200, 429]);
  });
});
