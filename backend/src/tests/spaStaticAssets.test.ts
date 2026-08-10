import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createSpaStaticAssetMiddleware } from '../services/spaStaticAssets';

describe('SPA first-response rendering boundary', () => {
  let frontendDist: string;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    frontendDist = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-spa-static-test-'));
    fs.writeFileSync(path.join(frontendDist, 'index.html'), 'RAW_INDEX');
    fs.writeFileSync(path.join(frontendDist, 'asset.js'), 'STATIC_ASSET');

    const app = express();
    app.use(createSpaStaticAssetMiddleware(frontendDist));
    app.get('*', (req, res) => {
      res.type('html').send(`RENDERED:${req.path}`);
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (frontendDist) fs.rmSync(frontendDist, { recursive: true, force: true });
  });

  test.each([
    ['/', 'RENDERED:/'],
    ['/index.html', 'RENDERED:/index.html'],
    ['/login', 'RENDERED:/login'],
  ])('routes %s through the SPA renderer instead of raw index.html', async (requestPath, expected) => {
    const response = await fetch(`${baseUrl}${requestPath}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(expected);
  });

  test('continues to serve real frontend assets statically', async () => {
    const response = await fetch(`${baseUrl}/asset.js`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('STATIC_ASSET');
  });
});
