import crypto from 'crypto';
import http from 'http';
import {
  AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT,
  agentZeroProjectModelBridgeProviderPath,
  authenticateAgentZeroProjectModelBridgeCredential,
  type AgentZeroProjectModelBridgeCredentialOptions,
  type AgentZeroProjectModelBridgeCredentialRecord,
  type AgentZeroProjectOAuthProviderId,
} from './AgentZeroProjectModelBridgeCredential';

export const AGENT_ZERO_PROJECT_MODEL_BRIDGE_UPSTREAM_ORIGIN = 'http://127.0.0.1:50001';
export const AGENT_ZERO_PROJECT_MODEL_BRIDGE_AGENT = 'BridgesLLM-AgentZero-Project-Model-Bridge/1';

// The bridge must listen on every dynamic project-egress gateway address, so
// the socket cannot bind one fixed interface. Reachability is instead fenced
// at accept time: a connection is admitted only when its *local* (destination)
// address is loopback or an installer-managed Docker pool gateway. Host LAN
// and public interface addresses never match, which keeps the bridge
// unreachable from outside even when no firewall exists (--local installs).
export const AGENT_ZERO_PROJECT_MODEL_BRIDGE_LOCAL_CIDRS_ENV =
  'AGENT_ZERO_PROJECT_MODEL_BRIDGE_ALLOWED_LOCAL_CIDRS';
export const AGENT_ZERO_PROJECT_MODEL_BRIDGE_DEFAULT_LOCAL_CIDRS = Object.freeze([
  '127.0.0.0/8',
  // Installer-provisioned Docker default-address-pool (project egress planes).
  '10.201.0.0/16',
]);

interface ParsedIpv4Cidr {
  base: number;
  mask: number;
}

function parseIpv4(address: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return null;
  let value = 0;
  for (let index = 1; index <= 4; index += 1) {
    const octet = Number(match[index]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value;
}

export function parseIpv4CidrList(raw: string): ParsedIpv4Cidr[] {
  const parsed: ParsedIpv4Cidr[] = [];
  for (const entry of String(raw || '').split(',')) {
    const candidate = entry.trim();
    if (!candidate) continue;
    const match = /^([0-9.]+)\/(\d{1,2})$/.exec(candidate);
    if (!match) throw new Error(`Agent Zero bridge CIDR is invalid: ${candidate}`);
    const base = parseIpv4(match[1]);
    const prefix = Number(match[2]);
    if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      throw new Error(`Agent Zero bridge CIDR is invalid: ${candidate}`);
    }
    const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
    parsed.push({ base: (base & mask) >>> 0, mask });
  }
  return parsed;
}

export function isAllowedBridgeLocalAddress(
  localAddress: string | undefined,
  cidrs: ParsedIpv4Cidr[],
): boolean {
  let normalized = String(localAddress || '').trim();
  if (normalized.startsWith('::ffff:')) normalized = normalized.slice('::ffff:'.length);
  const value = parseIpv4(normalized);
  if (value === null) return false;
  return cidrs.some((cidr) => ((value & cidr.mask) >>> 0) === cidr.base);
}

const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENCY = 16;
const DEFAULT_MAX_PROJECT_CONCURRENCY = 2;
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 2 * 60_000;
const MAX_HEADER_BYTES = 16 * 1024;

type OutgoingRequestFactory = (
  options: http.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
) => http.ClientRequest;

export interface AgentZeroProjectModelBridgeSafeLog {
  requestId: string;
  project: string;
  provider: AgentZeroProjectOAuthProviderId | 'unknown';
  operation: 'models' | 'chat_completions' | 'responses' | 'unknown';
  status: number;
  durationMs: number;
}

export interface AgentZeroProjectModelBridgeOptions
  extends AgentZeroProjectModelBridgeCredentialOptions {
  upstreamToken: string;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxConcurrency?: number;
  maxProjectConcurrency?: number;
  rateLimit?: number;
  rateWindowMs?: number;
  upstreamTimeoutMs?: number;
  upstreamIdleTimeoutMs?: number;
  logger?: (event: AgentZeroProjectModelBridgeSafeLog) => void;
}

export interface AgentZeroProjectModelBridgeDependencies {
  request?: OutgoingRequestFactory;
}

interface AllowedRoute {
  providerId: AgentZeroProjectOAuthProviderId;
  operation: 'models' | 'chat_completions' | 'responses';
  method: 'GET' | 'POST';
  upstreamPath: string;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return selected;
}

function validateUpstreamToken(value: string): string {
  const token = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)) {
    throw new Error('Agent Zero Project model bridge upstream token is invalid.');
  }
  return token;
}

function routeTable(): ReadonlyMap<string, AllowedRoute> {
  const values = new Map<string, AllowedRoute>();
  const providers: AgentZeroProjectOAuthProviderId[] = [
    'codex_oauth',
    'github_copilot_oauth',
    'gemini_api_oauth',
    'xai_grok_oauth',
  ];
  for (const providerId of providers) {
    const base = agentZeroProjectModelBridgeProviderPath(providerId);
    for (const [method, suffix, operation] of [
      ['GET', '/models', 'models'],
      ['POST', '/chat/completions', 'chat_completions'],
      ['POST', '/responses', 'responses'],
    ] as const) {
      const upstreamPath = `${base}${suffix}`;
      values.set(`${method} ${upstreamPath}`, { providerId, operation, method, upstreamPath });
    }
  }
  return values;
}

const ROUTES = routeTable();

function writeError(
  res: http.ServerResponse,
  status: number,
  code: string,
  retryAfter?: number,
): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify({
    error: { message: code, type: code, code },
  }));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    connection: 'close',
    'x-content-type-options': 'nosniff',
    ...(retryAfter ? { 'retry-after': String(retryAfter) } : {}),
  });
  res.end(body);
}

function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer (a0p_[a-f0-9]{64}_[A-Za-z0-9_-]{43})$/);
  return match?.[1] || null;
}

function parseRoute(req: http.IncomingMessage): AllowedRoute | null {
  const method = String(req.method || '').toUpperCase();
  if (!req.url || /[\u0000-\u0020\u007f]/.test(req.url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(req.url, 'http://agent-zero-project-bridge.invalid');
  } catch {
    return null;
  }
  if (parsed.search || parsed.hash) return null;
  return ROUTES.get(`${method} ${parsed.pathname}`) || null;
}

async function readBoundedBody(
  req: http.IncomingMessage,
  maximumBytes: number,
): Promise<Buffer> {
  const declared = Number.parseInt(String(req.headers['content-length'] || ''), 10);
  if (Number.isFinite(declared) && (declared < 0 || declared > maximumBytes)) {
    throw Object.assign(new Error('request_too_large'), { status: 413 });
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > maximumBytes) {
      throw Object.assign(new Error('request_too_large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function validateJsonRequest(
  body: Buffer,
  credential: AgentZeroProjectModelBridgeCredentialRecord,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
  const model = String((parsed as Record<string, unknown>).model || '').trim();
  if (model !== credential.model) {
    throw Object.assign(new Error('model_binding_mismatch'), { status: 403 });
  }
}

function filteredModelsResponse(
  body: Buffer,
  credential: AgentZeroProjectModelBridgeCredentialRecord,
): Buffer | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    const data = Array.isArray(parsed?.data) ? parsed.data : [];
    const selected = data.find((entry) => (
      entry && typeof entry === 'object'
      && String((entry as Record<string, unknown>).id || '') === credential.model
    ));
    if (!selected) return null;
    return Buffer.from(JSON.stringify({
      object: 'list',
      data: [{
        id: credential.model,
        object: 'model',
        created: 0,
        owned_by: credential.providerId,
      }],
    }));
  } catch {
    return null;
  }
}

function safeContentType(value: string | undefined): string | null {
  const normalized = String(value || '').split(';')[0].trim().toLowerCase();
  if (normalized === 'application/json') return 'application/json';
  if (normalized === 'text/event-stream') return 'text/event-stream';
  return null;
}

function projectLogFingerprint(projectKey: string): string {
  return crypto.createHash('sha256').update(projectKey).digest('hex').slice(0, 16);
}

export function createAgentZeroProjectModelBridgeServer(
  options: AgentZeroProjectModelBridgeOptions,
  dependencies: AgentZeroProjectModelBridgeDependencies = {},
): http.Server {
  const upstreamToken = validateUpstreamToken(options.upstreamToken);
  const maxRequestBytes = positiveInteger(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 'maxRequestBytes');
  const maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 'maxResponseBytes');
  const maxConcurrency = positiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY, 'maxConcurrency');
  const maxProjectConcurrency = positiveInteger(
    options.maxProjectConcurrency,
    DEFAULT_MAX_PROJECT_CONCURRENCY,
    'maxProjectConcurrency',
  );
  const rateLimit = positiveInteger(options.rateLimit, DEFAULT_RATE_LIMIT, 'rateLimit');
  const rateWindowMs = positiveInteger(options.rateWindowMs, DEFAULT_RATE_WINDOW_MS, 'rateWindowMs');
  const upstreamTimeoutMs = positiveInteger(
    options.upstreamTimeoutMs,
    DEFAULT_UPSTREAM_TIMEOUT_MS,
    'upstreamTimeoutMs',
  );
  const upstreamIdleTimeoutMs = positiveInteger(
    options.upstreamIdleTimeoutMs,
    DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
    'upstreamIdleTimeoutMs',
  );
  const requestFactory = dependencies.request || http.request;
  const logger = options.logger || ((event: AgentZeroProjectModelBridgeSafeLog) => {
    process.stdout.write(`${JSON.stringify({ service: AGENT_ZERO_PROJECT_MODEL_BRIDGE_AGENT, ...event })}\n`);
  });
  const activeByProject = new Map<string, number>();
  const windows = new Map<string, RateWindow>();
  let active = 0;

  const server = http.createServer({
    maxHeaderSize: MAX_HEADER_BYTES,
    requireHostHeader: true,
  }, async (req, res) => {
    const startedAt = Date.now();
    const requestId = crypto.randomBytes(12).toString('hex');
    const route = parseRoute(req);
    const provider: AgentZeroProjectOAuthProviderId | 'unknown' = route?.providerId || 'unknown';
    const operation: AgentZeroProjectModelBridgeSafeLog['operation'] = route?.operation || 'unknown';
    let project = 'unauthenticated';
    let finalStatus = 500;
    let released = false;
    let projectKey = '';
    const release = () => {
      if (released || !projectKey) return;
      released = true;
      active = Math.max(0, active - 1);
      const count = Math.max(0, (activeByProject.get(projectKey) || 1) - 1);
      if (count) activeByProject.set(projectKey, count);
      else activeByProject.delete(projectKey);
    };
    const finishLog = () => logger({
      requestId,
      project,
      provider,
      operation,
      status: finalStatus,
      durationMs: Math.max(0, Date.now() - startedAt),
    });

    try {
      if (!route) {
        finalStatus = 404;
        writeError(res, finalStatus, 'route_not_allowed');
        return;
      }
      if (route.method === 'POST') {
        const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/json' || req.headers['content-encoding']) {
          finalStatus = 415;
          writeError(res, finalStatus, 'json_request_required');
          return;
        }
      } else if (req.headers['content-length'] || req.headers['transfer-encoding']) {
        finalStatus = 400;
        writeError(res, finalStatus, 'request_body_not_allowed');
        return;
      }
      const token = bearerToken(req.headers.authorization);
      const credential = token
        ? authenticateAgentZeroProjectModelBridgeCredential(token, route.providerId, options)
        : null;
      if (!credential) {
        finalStatus = 401;
        writeError(res, finalStatus, 'invalid_project_credential');
        return;
      }
      projectKey = credential.projectKey;
      project = projectLogFingerprint(projectKey);
      const now = Date.now();
      const window = windows.get(projectKey);
      const currentWindow = !window || now - window.startedAt >= rateWindowMs
        ? { startedAt: now, count: 0 }
        : window;
      if (currentWindow.count >= rateLimit) {
        windows.set(projectKey, currentWindow);
        finalStatus = 429;
        writeError(res, finalStatus, 'project_rate_limit', Math.max(1, Math.ceil(
          (rateWindowMs - (now - currentWindow.startedAt)) / 1000,
        )));
        return;
      }
      currentWindow.count += 1;
      windows.set(projectKey, currentWindow);
      if (windows.size > maxConcurrency * 256) {
        for (const [key, value] of windows) {
          if (now - value.startedAt >= rateWindowMs) windows.delete(key);
        }
      }
      if (active >= maxConcurrency || (activeByProject.get(projectKey) || 0) >= maxProjectConcurrency) {
        finalStatus = 503;
        writeError(res, finalStatus, 'bridge_capacity');
        return;
      }
      active += 1;
      activeByProject.set(projectKey, (activeByProject.get(projectKey) || 0) + 1);

      const body = route.method === 'POST' ? await readBoundedBody(req, maxRequestBytes) : Buffer.alloc(0);
      if (route.method === 'POST') validateJsonRequest(body, credential);

      await new Promise<void>((resolve) => {
        let responseBytes = 0;
        let responseStarted = false;
        let settled = false;
        let timedOut = false;
        const totalTimer: { current?: NodeJS.Timeout } = {};
        const settle = () => {
          if (settled) return false;
          settled = true;
          if (totalTimer.current) clearTimeout(totalTimer.current);
          resolve();
          return true;
        };
        const upstream = requestFactory({
          protocol: 'http:',
          hostname: '127.0.0.1',
          port: 50_001,
          method: route.method,
          path: route.upstreamPath,
          headers: {
            authorization: `Bearer ${upstreamToken}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'content-length': body.length,
            'user-agent': AGENT_ZERO_PROJECT_MODEL_BRIDGE_AGENT,
            connection: 'close',
          },
          agent: false,
        }, (upstreamResponse) => {
          const status = upstreamResponse.statusCode || 502;
          const contentType = safeContentType(upstreamResponse.headers['content-type']);
          const declared = Number.parseInt(String(upstreamResponse.headers['content-length'] || ''), 10);
          if (status < 200 || status >= 300) {
            upstreamResponse.resume();
            finalStatus = status === 429 ? 429 : status === 401 || status === 403 ? 503 : 502;
            writeError(res, finalStatus, 'oauth_provider_unavailable');
            settle();
            return;
          }
          if (!contentType || (Number.isFinite(declared) && declared > maxResponseBytes)) {
            upstreamResponse.destroy();
            finalStatus = Number.isFinite(declared) && declared > maxResponseBytes ? 502 : 502;
            writeError(res, finalStatus, 'invalid_upstream_response');
            settle();
            return;
          }

          if (route.operation === 'models') {
            const chunks: Buffer[] = [];
            let tooLarge = false;
            upstreamResponse.on('data', (raw: Buffer) => {
              const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
              responseBytes += chunk.length;
              if (responseBytes > maxResponseBytes) {
                tooLarge = true;
                upstreamResponse.destroy(new Error('response_too_large'));
              }
              else chunks.push(chunk);
            });
            upstreamResponse.on('end', () => {
              if (settled || tooLarge) return;
              const filtered = filteredModelsResponse(Buffer.concat(chunks, responseBytes), credential);
              if (!filtered) {
                finalStatus = 503;
                writeError(res, finalStatus, 'selected_model_unavailable');
              } else {
                finalStatus = 200;
                res.writeHead(200, {
                  'content-type': 'application/json',
                  'content-length': filtered.length,
                  connection: 'close',
                  'x-content-type-options': 'nosniff',
                });
                res.end(filtered);
              }
              settle();
            });
            upstreamResponse.on('aborted', () => {
              if (!settle()) return;
              finalStatus = 502;
              writeError(res, finalStatus, 'upstream_stream_failed');
            });
            upstreamResponse.on('error', () => {
              if (!settle()) return;
              finalStatus = 502;
              writeError(res, finalStatus, tooLarge
                ? 'upstream_response_too_large'
                : 'upstream_stream_failed');
            });
            upstreamResponse.setTimeout(upstreamIdleTimeoutMs, () => {
              timedOut = true;
              upstreamResponse.destroy(new Error('upstream_idle_timeout'));
            });
            return;
          }

          finalStatus = status;
          responseStarted = true;
          res.writeHead(status, {
            'content-type': contentType,
            'cache-control': 'no-store',
            connection: 'close',
            'x-content-type-options': 'nosniff',
          });
          upstreamResponse.on('data', (raw: Buffer) => {
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            responseBytes += chunk.length;
            if (responseBytes > maxResponseBytes) {
              upstreamResponse.destroy(new Error('response_too_large'));
              res.destroy();
              return;
            }
            if (!res.destroyed) res.write(chunk);
          });
          upstreamResponse.on('end', () => {
            if (!res.destroyed) res.end();
            settle();
          });
          upstreamResponse.on('error', () => {
            if (!settle()) return;
            if (!responseStarted) {
              finalStatus = timedOut ? 504 : 502;
              writeError(res, finalStatus, timedOut ? 'upstream_timeout' : 'upstream_stream_failed');
            } else {
              res.destroy();
            }
          });
          upstreamResponse.setTimeout(upstreamIdleTimeoutMs, () => {
            timedOut = true;
            upstreamResponse.destroy(new Error('upstream_idle_timeout'));
          });
        });
        totalTimer.current = setTimeout(() => {
          timedOut = true;
          upstream.destroy(new Error('upstream_timeout'));
        }, upstreamTimeoutMs);
        totalTimer.current.unref();
        upstream.setTimeout(upstreamIdleTimeoutMs, () => {
          timedOut = true;
          upstream.destroy(new Error('upstream_idle_timeout'));
        });
        upstream.on('error', () => {
          if (!settle()) return;
          if (!res.headersSent) {
            finalStatus = timedOut ? 504 : 502;
            writeError(res, finalStatus, timedOut ? 'upstream_timeout' : 'upstream_unavailable');
          } else {
            res.destroy();
          }
        });
        upstream.on('close', () => {
          if (totalTimer.current) clearTimeout(totalTimer.current);
        });
        req.on('aborted', () => upstream.destroy());
        res.on('close', () => {
          if (!res.writableEnded) {
            finalStatus = 499;
            upstream.destroy();
            settle();
          }
        });
        if (body.length) upstream.end(body);
        else upstream.end();
      });
    } catch (error: any) {
      finalStatus = Number.isSafeInteger(error?.status) ? error.status : 500;
      writeError(res, finalStatus, String(error?.message || 'bridge_request_failed').replace(/[^a-z0-9_]/gi, '_'));
    } finally {
      release();
      finishLog();
    }
  });

  server.maxConnections = maxConcurrency * 2;
  server.requestTimeout = upstreamTimeoutMs + 5_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 1_000;
  return server;
}

export function attachBridgeLocalAddressFence(
  server: http.Server,
  cidrs: ParsedIpv4Cidr[],
): void {
  server.on('connection', (socket) => {
    if (!isAllowedBridgeLocalAddress(socket.localAddress, cidrs)) {
      socket.destroy();
    }
  });
}

export function startAgentZeroProjectModelBridgeFromEnvironment(): http.Server {
  const port = Number(process.env.AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT || AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT is invalid.');
  }
  const configuredCidrs = String(
    process.env[AGENT_ZERO_PROJECT_MODEL_BRIDGE_LOCAL_CIDRS_ENV] || '',
  ).trim();
  const cidrs = parseIpv4CidrList(
    configuredCidrs || AGENT_ZERO_PROJECT_MODEL_BRIDGE_DEFAULT_LOCAL_CIDRS.join(','),
  );
  if (cidrs.length === 0) {
    throw new Error('Agent Zero bridge local-address allowlist cannot be empty.');
  }
  const server = createAgentZeroProjectModelBridgeServer({
    upstreamToken: String(process.env.AGENT_ZERO_PROJECT_MODEL_BRIDGE_UPSTREAM_TOKEN || ''),
    credentialRoot: process.env.AGENT_ZERO_PROJECT_MODEL_BRIDGE_CREDENTIAL_ROOT,
  });
  attachBridgeLocalAddressFence(server, cidrs);
  server.listen(port, '0.0.0.0');
  return server;
}

if (require.main === module) {
  const server = startAgentZeroProjectModelBridgeFromEnvironment();
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export const __agentZeroProjectModelBridgeTest = {
  ROUTES,
  bearerToken,
  parseRoute,
  filteredModelsResponse,
  validateJsonRequest,
};
