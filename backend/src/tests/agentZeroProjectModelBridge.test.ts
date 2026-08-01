import { EventEmitter } from 'events';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import {
  AGENT_ZERO_PROJECT_MODEL_BRIDGE_DEFAULT_LOCAL_CIDRS,
  attachBridgeLocalAddressFence,
  createAgentZeroProjectModelBridgeServer,
  isAllowedBridgeLocalAddress,
  parseIpv4CidrList,
  type AgentZeroProjectModelBridgeSafeLog,
} from '../agents/providers/agentZero/AgentZeroProjectModelBridge';
import {
  issueAgentZeroProjectModelBridgeCredential,
} from '../agents/providers/agentZero/AgentZeroProjectModelBridgeCredential';

const PROJECT_KEY = 'a'.repeat(64);
const UPSTREAM_TOKEN = 'U'.repeat(43);
const NOW = Date.parse('2026-07-20T04:00:00.000Z');

let root: string;
let server: http.Server;
let origin: string;
let token: string;
let logs: AgentZeroProjectModelBridgeSafeLog[];
let upstreamRequests: Array<{ options: http.RequestOptions; body: string }>;
let upstreamHandler: (options: http.RequestOptions, body: string) => {
  status?: number;
  contentType?: string;
  body: string;
};

function fakeRequestFactory(
  options: http.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
): http.ClientRequest {
  const request = new EventEmitter() as http.ClientRequest & {
    chunks: Buffer[];
  };
  request.chunks = [];
  (request as any).setTimeout = jest.fn(() => request);
  (request as any).write = (chunk: Buffer | string) => {
    request.chunks.push(Buffer.from(chunk));
    return true;
  };
  (request as any).end = (chunk?: Buffer | string) => {
    if (chunk) request.chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(request.chunks).toString('utf8');
    upstreamRequests.push({ options, body });
    const value = upstreamHandler(options, body);
    const responseStream = new PassThrough();
    const response = responseStream as unknown as http.IncomingMessage;
    response.statusCode = value.status || 200;
    response.headers = {
      'content-type': value.contentType || 'application/json',
      'content-length': String(Buffer.byteLength(value.body)),
    };
    (response as any).setTimeout = jest.fn(() => response);
    callback(response);
    responseStream.end(value.body);
    request.emit('close');
  };
  (request as any).destroy = (error?: Error) => {
    if (error) request.emit('error', error);
    request.emit('close');
    return request;
  };
  return request;
}

async function bridgeRequest(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'a0-project-model-bridge-'));
  fs.chmodSync(root, 0o750);
  token = issueAgentZeroProjectModelBridgeCredential({
    projectKey: PROJECT_KEY,
    actorUserId: 'owner-user-id',
    projectIdentityId: '11111111-1111-4111-8111-111111111111',
  }, {
    providerId: 'codex_oauth',
    model: 'gpt-5.2-codex',
  }, {
    credentialRoot: root,
    now: () => NOW,
    tokenFactory: () => 'T'.repeat(43),
    generationFactory: () => '22222222-2222-4222-8222-222222222222',
  }).token;
  logs = [];
  upstreamRequests = [];
  upstreamHandler = () => ({
    body: JSON.stringify({
      object: 'list',
      data: [
        { id: 'gpt-5.2-codex', object: 'model' },
        { id: 'not-selected', object: 'model' },
      ],
    }),
  });
  server = createAgentZeroProjectModelBridgeServer({
    upstreamToken: UPSTREAM_TOKEN,
    credentialRoot: root,
    now: () => NOW + 1,
    logger: (event) => logs.push(event),
    rateLimit: 10,
  }, { request: fakeRequestFactory });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Bridge did not bind a TCP port.');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Agent Zero Project model bridge', () => {
  test('allows only the fixed models route and returns only the credential-bound model', async () => {
    const response = await bridgeRequest('/oauth/codex/v1/models');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: 'list',
      data: [{
        id: 'gpt-5.2-codex',
        object: 'model',
        created: 0,
        owned_by: 'codex_oauth',
      }],
    });
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0].options).toMatchObject({
      hostname: '127.0.0.1',
      port: 50001,
      method: 'GET',
      path: '/oauth/codex/v1/models',
    });
    expect((upstreamRequests[0].options.headers as Record<string, string>).authorization)
      .toBe(`Bearer ${UPSTREAM_TOKEN}`);
    expect(JSON.stringify(upstreamRequests[0])).not.toContain(token);
    expect(logs[0]).toMatchObject({ provider: 'codex_oauth', operation: 'models', status: 200 });
    expect(JSON.stringify(logs)).not.toContain(token);

    expect((await bridgeRequest('/oauth/codex/v1/health')).status).toBe(404);
    expect((await bridgeRequest('/oauth/codex/v1/models?all=true')).status).toBe(404);
    expect((await bridgeRequest('/oauth/xai-grok/v1/models')).status).toBe(401);
  });

  test('forwards a bounded exact-model completion stream without forwarding client headers', async () => {
    upstreamHandler = (_options, body) => ({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ model: JSON.parse(body).model, choices: [] })}\n\ndata: [DONE]\n\n`,
    });
    const response = await bridgeRequest('/oauth/codex/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.2-codex', messages: [{ role: 'user', content: 'hello' }], stream: true }),
      headers: { cookie: 'must-not-forward', 'x-api-key': 'must-not-forward' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toContain('data: [DONE]');
    expect(upstreamRequests[0].options.headers).not.toHaveProperty('cookie');
    expect(upstreamRequests[0].options.headers).not.toHaveProperty('x-api-key');
  });

  test('rejects model substitution, oversized requests, bad credentials, and raw upstream errors', async () => {
    const mismatch = await bridgeRequest('/oauth/codex/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'not-selected', input: 'hello' }),
    });
    expect(mismatch.status).toBe(403);
    expect(upstreamRequests).toHaveLength(0);

    const unauthorized = await fetch(`${origin}/oauth/codex/v1/models`, {
      headers: { authorization: 'Bearer a0p_' + PROJECT_KEY + '_' + 'X'.repeat(43) },
    });
    expect(unauthorized.status).toBe(401);

    upstreamHandler = () => ({
      status: 502,
      body: JSON.stringify({ error: { message: `secret ${UPSTREAM_TOKEN}` } }),
    });
    const failed = await bridgeRequest('/oauth/codex/v1/models');
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(UPSTREAM_TOKEN);
  });
});

describe('local-address fence', () => {
  const cidrs = parseIpv4CidrList(AGENT_ZERO_PROJECT_MODEL_BRIDGE_DEFAULT_LOCAL_CIDRS.join(','));

  test('parses CIDR lists strictly and rejects malformed entries', () => {
    expect(parseIpv4CidrList('127.0.0.0/8, 10.201.0.0/16')).toHaveLength(2);
    expect(parseIpv4CidrList('')).toHaveLength(0);
    expect(() => parseIpv4CidrList('not-a-cidr')).toThrow(/invalid/);
    expect(() => parseIpv4CidrList('10.0.0.0/33')).toThrow(/invalid/);
    expect(() => parseIpv4CidrList('999.0.0.0/8')).toThrow(/invalid/);
  });

  test('admits loopback and Docker pool gateway destinations only', () => {
    expect(isAllowedBridgeLocalAddress('127.0.0.1', cidrs)).toBe(true);
    expect(isAllowedBridgeLocalAddress('::ffff:127.0.0.1', cidrs)).toBe(true);
    expect(isAllowedBridgeLocalAddress('10.201.0.1', cidrs)).toBe(true);
    expect(isAllowedBridgeLocalAddress('::ffff:10.201.255.254', cidrs)).toBe(true);

    // Host LAN, public, IPv6, adjacent-range, and garbage destinations are refused.
    expect(isAllowedBridgeLocalAddress('192.168.1.10', cidrs)).toBe(false);
    expect(isAllowedBridgeLocalAddress('203.0.113.7', cidrs)).toBe(false);
    expect(isAllowedBridgeLocalAddress('10.200.0.1', cidrs)).toBe(false);
    expect(isAllowedBridgeLocalAddress('10.202.0.1', cidrs)).toBe(false);
    expect(isAllowedBridgeLocalAddress('::1', cidrs)).toBe(false);
    expect(isAllowedBridgeLocalAddress(undefined, cidrs)).toBe(false);
    expect(isAllowedBridgeLocalAddress('', cidrs)).toBe(false);
    expect(isAllowedBridgeLocalAddress('bogus', cidrs)).toBe(false);
  });

  test('destroys sockets whose destination address is outside the allowlist', () => {
    const fenced = http.createServer(() => {});
    attachBridgeLocalAddressFence(fenced, cidrs);

    const admit = (localAddress: string) => {
      const socket = new EventEmitter() as any;
      socket.localAddress = localAddress;
      socket.destroy = jest.fn();
      fenced.emit('connection', socket);
      return socket.destroy as jest.Mock;
    };

    expect(admit('127.0.0.1')).not.toHaveBeenCalled();
    expect(admit('10.201.4.1')).not.toHaveBeenCalled();
    expect(admit('192.168.1.10')).toHaveBeenCalledTimes(1);
    expect(admit('203.0.113.7')).toHaveBeenCalledTimes(1);
  });
});
