import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getStalwartDkimSigningConfig,
  provisionStalwartDkim,
  readStoredStalwartDkimRecords,
} from '../services/stalwartDkim';

const DOMAIN = 'portal.example.test';
const RSA_KEY = Buffer.alloc(270, 7).toString('base64');
const ED25519_KEY = Buffer.alloc(32, 9).toString('base64');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createStalwartMock(options: { createStatus?: number } = {}) {
  const keys = new Map<string, string>();
  const requests: Array<{ method: string; pathname: string; body?: any }> = [];
  const fetchImpl = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    const request = {
      method,
      pathname: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(request);

    if (method === 'GET' && url.pathname.startsWith('/api/dkim/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/dkim/'.length));
      return keys.has(id) ? jsonResponse({ data: keys.get(id) }) : jsonResponse({ error: 'notFound' }, 404);
    }

    if (method === 'POST' && url.pathname === '/api/dkim') {
      const body = request.body;
      keys.set(body.id, body.algorithm === 'Rsa' ? RSA_KEY : ED25519_KEY);
      const status = options.createStatus ?? 200;
      return jsonResponse(status === 200 ? { data: null } : { error: 'alreadyExists' }, status);
    }

    return jsonResponse({ error: 'notFound' }, 404);
  }) as unknown as typeof fetch;

  return { fetchImpl, keys, requests };
}

describe('Stalwart DKIM provisioning', () => {
  let mailDir: string;

  beforeEach(() => {
    mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-stalwart-dkim-'));
  });

  afterEach(() => {
    fs.rmSync(mailDir, { recursive: true, force: true });
  });

  test('creates, verifies, and persists both Portal-owned signatures', async () => {
    const mock = createStalwartMock();
    const records = await provisionStalwartDkim({
      domain: DOMAIN,
      adminPass: 'admin-secret',
      mailDir,
      fetchImpl: mock.fetchImpl,
    });

    expect(records).toEqual([
      expect.objectContaining({
        algorithm: 'rsa',
        signatureId: `portal-rsa-${DOMAIN}`,
        selector: 'portal-rsa',
        name: 'portal-rsa._domainkey',
        value: `v=DKIM1; k=rsa; p=${RSA_KEY}`,
      }),
      expect.objectContaining({
        algorithm: 'ed25519',
        signatureId: `portal-ed25519-${DOMAIN}`,
        selector: 'portal-ed25519',
        name: 'portal-ed25519._domainkey',
        value: `v=DKIM1; k=ed25519; p=${ED25519_KEY}`,
      }),
    ]);
    expect(mock.requests.filter(request => request.method === 'POST')).toHaveLength(2);
    expect(readStoredStalwartDkimRecords(mailDir, DOMAIN)).toEqual(records);
    expect(fs.readFileSync(path.join(mailDir, 'dkim-dns-record.txt'), 'utf8').trim())
      .toBe(`v=DKIM1; k=rsa; p=${RSA_KEY}`);
  });

  test('is idempotent and reuses the exact existing Stalwart signatures', async () => {
    const mock = createStalwartMock();
    const options = {
      domain: DOMAIN,
      adminPass: 'admin-secret',
      mailDir,
      fetchImpl: mock.fetchImpl,
    };
    await provisionStalwartDkim(options);
    await provisionStalwartDkim(options);

    expect(mock.requests.filter(request => request.method === 'POST')).toHaveLength(2);
    expect(mock.requests.filter(request => request.method === 'GET')).toHaveLength(6);
  });

  test('reconciles a concurrent create race by reading the exact persisted key', async () => {
    const mock = createStalwartMock({ createStatus: 400 });
    await expect(provisionStalwartDkim({
      domain: DOMAIN,
      adminPass: 'admin-secret',
      mailDir,
      fetchImpl: mock.fetchImpl,
    })).resolves.toHaveLength(2);
  });

  test('fails closed without emitting placeholder DNS records', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ error: 'broken' }, 500)) as unknown as typeof fetch;
    await expect(provisionStalwartDkim({
      domain: DOMAIN,
      adminPass: 'admin-secret',
      mailDir,
      fetchImpl,
    })).rejects.toThrow('could not verify');

    expect(readStoredStalwartDkimRecords(mailDir, DOMAIN)).toEqual([]);
    expect(fs.existsSync(path.join(mailDir, 'dkim-public-records.json'))).toBe(false);
  });

  test('refuses to send the admin credential to a non-loopback endpoint', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    await expect(provisionStalwartDkim({
      domain: DOMAIN,
      adminPass: 'admin-secret',
      mailDir,
      baseUrl: 'https://mail.example.test',
      fetchImpl,
    })).rejects.toThrow('loopback');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('keeps signing identifiers aligned with provisioned signature IDs', () => {
    expect(getStalwartDkimSigningConfig()).toContain('"portal-rsa-" + sender_domain');
    expect(getStalwartDkimSigningConfig()).toContain('"portal-ed25519-" + sender_domain');
    expect(getStalwartDkimSigningConfig()).not.toContain('["rsa-" + sender_domain');
  });
});
