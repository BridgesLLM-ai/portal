import http from 'http';
import express from 'express';

jest.mock('../config/env', () => ({
  config: { corsOrigin: ['https://portal.example.com'] },
}));

import { corsConfig } from './cors';

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
}

function request(
  server: http.Server,
  method: 'GET' | 'OPTIONS',
  headers: Record<string, string>,
): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/resource',
      method,
      headers,
    }, (res) => {
      res.resume();
      res.once('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

describe('Portal CORS authorization-generation headers', () => {
  let server: http.Server;

  beforeEach(async () => {
    const app = express();
    app.use(corsConfig);
    app.get('/resource', (_req, res) => {
      res.setHeader('X-Portal-Authorization-Version', '7');
      res.json({ ok: true });
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('allows the generation header on cross-origin preflight requests', async () => {
    const response = await request(server, 'OPTIONS', {
      Origin: 'https://portal.example.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'content-type,x-portal-authorization-version',
    });

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://portal.example.com');
    expect(response.headers['access-control-allow-headers']).toContain('X-Portal-Authorization-Version');
  });

  it('exposes the generation response header to cross-origin clients', async () => {
    const response = await request(server, 'GET', {
      Origin: 'https://portal.example.com',
    });

    expect(response.status).toBe(200);
    expect(response.headers['access-control-expose-headers']).toBe('X-Portal-Authorization-Version');
    expect(response.headers['x-portal-authorization-version']).toBe('7');
  });
});
