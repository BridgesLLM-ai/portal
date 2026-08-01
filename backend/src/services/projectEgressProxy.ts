import crypto from 'crypto';
import http from 'http';
import https from 'https';
import net from 'net';
import type { Duplex } from 'stream';
import {
  ProjectEgressPolicyError,
  resolveProjectEgressTarget,
  type ProjectEgressResolver,
  type ResolvedProjectEgressTarget,
} from './projectEgressPolicy';

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 128;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RESOLVE_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_TLS_CLIENT_HELLO_BYTES = 64 * 1024;
const PROXY_AGENT = 'BridgesLLM-Project-Egress/1';

type OutgoingRequestFactory = (
  options: http.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
) => http.ClientRequest;

type SocketFactory = (
  options: net.NetConnectOpts,
  callback: () => void,
) => net.Socket;

export interface ProjectEgressProxyOptions {
  token: string;
  extraDeniedCidrs?: readonly string[];
  resolver?: ProjectEgressResolver;
  maxRequestBytes?: number;
  maxConnections?: number;
  connectTimeoutMs?: number;
  resolveTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface ProjectEgressProxyDependencies {
  httpRequest?: OutgoingRequestFactory;
  httpsRequest?: OutgoingRequestFactory;
  connectSocket?: SocketFactory;
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

export function validateProjectEgressProxyToken(token: string): string {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') < 43 || token.length > 256) {
    throw new Error('Project egress proxy token must contain at least 256 bits of entropy');
  }
  return token;
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftDigest = crypto.createHash('sha256').update(left).digest();
  const rightDigest = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest) && left.length === right.length;
}

export function isAuthorizedProjectEgressRequest(
  header: string | string[] | undefined,
  expectedToken: string,
): boolean {
  if (typeof header !== 'string') return false;
  const bearer = header.match(/^Bearer ([A-Za-z0-9_-]{43,256})$/);
  if (bearer) return timingSafeTextEqual(bearer[1], expectedToken);
  const basic = header.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/);
  if (!basic) return false;
  try {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator >= 0
      && decoded.slice(0, separator) === 'portal'
      && timingSafeTextEqual(decoded.slice(separator + 1), expectedToken);
  } catch {
    return false;
  }
}

function connectionHeaderTokens(headers: http.IncomingHttpHeaders): Set<string> {
  const raw = headers.connection;
  const value = Array.isArray(raw) ? raw.join(',') : raw || '';
  return new Set(value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function sanitizeProjectEgressRequestHeaders(
  headers: http.IncomingHttpHeaders,
  target: ResolvedProjectEgressTarget,
): http.OutgoingHttpHeaders {
  const dynamicHopHeaders = connectionHeaderTokens(headers);
  const output: http.OutgoingHttpHeaders = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || dynamicHopHeaders.has(normalized) || value === undefined) continue;
    output[normalized] = value;
  }
  output.host = target.url.host;
  output.via = PROXY_AGENT;
  return output;
}

function sanitizeResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const dynamicHopHeaders = connectionHeaderTokens(headers);
  const output: http.OutgoingHttpHeaders = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || dynamicHopHeaders.has(normalized) || value === undefined) continue;
    output[normalized] = value;
  }
  output.via = PROXY_AGENT;
  return output;
}

export function buildPinnedProjectEgressRequestOptions(
  req: http.IncomingMessage,
  target: ResolvedProjectEgressTarget,
): http.RequestOptions & Pick<https.RequestOptions, 'servername' | 'rejectUnauthorized'> {
  const options: http.RequestOptions & Pick<https.RequestOptions, 'servername' | 'rejectUnauthorized'> = {
    protocol: target.url.protocol,
    hostname: target.selectedAddress,
    port: target.port,
    family: target.selectedFamily,
    method: req.method || 'GET',
    path: `${target.url.pathname}${target.url.search}`,
    headers: sanitizeProjectEgressRequestHeaders(req.headers, target),
    lookup: (_hostname, _options, callback) => {
      callback(null, target.selectedAddress, target.selectedFamily);
    },
  };
  if (target.url.protocol === 'https:') {
    options.servername = target.hostname;
    options.rejectUnauthorized = true;
  }
  return options;
}

function writeSocketResponse(socket: Duplex, status: number, reason: string, headers: string[] = []): void {
  if (socket.destroyed) return;
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    `Proxy-Agent: ${PROXY_AGENT}`,
    'Connection: close',
    'Content-Length: 0',
    ...headers,
    '',
    '',
  ];
  socket.end(lines.join('\r\n'));
}

function writeHttpError(res: http.ServerResponse, status: number, code: string): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify({ error: code }));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    connection: 'close',
    'proxy-agent': PROXY_AGENT,
  });
  res.end(body);
}

function statusForProxyError(error: unknown): number {
  if (!(error instanceof ProjectEgressPolicyError)) return 502;
  if (error.code === 'DNS_TIMEOUT') return 504;
  if (error.code.startsWith('DNS_')) return 403;
  return 400;
}

function safeProxyErrorCode(error: unknown): string {
  return error instanceof ProjectEgressPolicyError ? error.code : 'UPSTREAM_UNAVAILABLE';
}

function parseDenyCidrs(raw: string | undefined): string[] {
  if (!raw) return [];
  if (raw.trim().startsWith('[')) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('PROJECT_EGRESS_DENY_CIDRS must be a JSON string array');
    }
    return parsed;
  }
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

export type ProjectEgressTlsHelloResult =
  | { status: 'need-more' }
  | { status: 'valid'; serverName: string }
  | { status: 'invalid' };

function readUint24(buffer: Buffer, offset: number): number {
  return (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
}

/**
 * Validate the first TLS handshake without terminating TLS. CONNECT remains
 * end-to-end encrypted, but arbitrary cleartext/public-port tunnels never get
 * forwarded and the ClientHello must name the URL that passed DNS policy.
 */
export function validateProjectEgressTlsClientHello(
  buffer: Buffer,
  expectedHostname: string,
): ProjectEgressTlsHelloResult {
  if (buffer.length > MAX_TLS_CLIENT_HELLO_BYTES) return { status: 'invalid' };
  const handshakeChunks: Buffer[] = [];
  let offset = 0;
  let handshakeBytes = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 5) return { status: 'need-more' };
    const contentType = buffer[offset];
    const major = buffer[offset + 1];
    const recordLength = buffer.readUInt16BE(offset + 3);
    if (contentType !== 22 || major !== 3 || recordLength < 1 || recordLength > 18_432) {
      return { status: 'invalid' };
    }
    if (buffer.length - offset - 5 < recordLength) return { status: 'need-more' };
    const payload = buffer.subarray(offset + 5, offset + 5 + recordLength);
    handshakeChunks.push(payload);
    handshakeBytes += payload.length;
    const handshake = Buffer.concat(handshakeChunks, handshakeBytes);
    if (handshake.length >= 4) {
      if (handshake[0] !== 1) return { status: 'invalid' };
      const helloLength = readUint24(handshake, 1);
      if (helloLength < 34 || helloLength > MAX_TLS_CLIENT_HELLO_BYTES - 4) return { status: 'invalid' };
      if (handshake.length >= helloLength + 4) {
        const hello = handshake.subarray(4, helloLength + 4);
        let cursor = 34;
        if (cursor >= hello.length) return { status: 'invalid' };
        const sessionIdLength = hello[cursor];
        cursor += 1 + sessionIdLength;
        if (cursor + 2 > hello.length) return { status: 'invalid' };
        const cipherLength = hello.readUInt16BE(cursor);
        if (cipherLength < 2 || cipherLength % 2 !== 0) return { status: 'invalid' };
        cursor += 2 + cipherLength;
        if (cursor >= hello.length) return { status: 'invalid' };
        const compressionLength = hello[cursor];
        cursor += 1 + compressionLength;
        if (cursor + 2 > hello.length) return { status: 'invalid' };
        const extensionsLength = hello.readUInt16BE(cursor);
        cursor += 2;
        if (cursor + extensionsLength !== hello.length) return { status: 'invalid' };
        const extensionsEnd = cursor + extensionsLength;
        while (cursor < extensionsEnd) {
          if (cursor + 4 > extensionsEnd) return { status: 'invalid' };
          const extensionType = hello.readUInt16BE(cursor);
          const extensionLength = hello.readUInt16BE(cursor + 2);
          cursor += 4;
          if (cursor + extensionLength > extensionsEnd) return { status: 'invalid' };
          if (extensionType === 0) {
            if (extensionLength < 5) return { status: 'invalid' };
            const listLength = hello.readUInt16BE(cursor);
            if (listLength !== extensionLength - 2) return { status: 'invalid' };
            let nameCursor = cursor + 2;
            const nameEnd = cursor + extensionLength;
            while (nameCursor < nameEnd) {
              if (nameCursor + 3 > nameEnd) return { status: 'invalid' };
              const nameType = hello[nameCursor];
              const nameLength = hello.readUInt16BE(nameCursor + 1);
              nameCursor += 3;
              if (nameCursor + nameLength > nameEnd) return { status: 'invalid' };
              if (nameType === 0) {
                const serverName = hello.subarray(nameCursor, nameCursor + nameLength).toString('ascii').toLowerCase();
                if (!serverName || /[^a-z0-9.-]/.test(serverName)) return { status: 'invalid' };
                return serverName === expectedHostname.toLowerCase()
                  ? { status: 'valid', serverName }
                  : { status: 'invalid' };
              }
              nameCursor += nameLength;
            }
            return { status: 'invalid' };
          }
          cursor += extensionLength;
        }
        return { status: 'invalid' };
      }
    }
    offset += 5 + recordLength;
  }
  return { status: 'need-more' };
}

export function createProjectEgressProxyServer(
  options: ProjectEgressProxyOptions,
  dependencies: ProjectEgressProxyDependencies = {},
): http.Server {
  const token = validateProjectEgressProxyToken(options.token);
  const maxRequestBytes = requirePositiveSafeInteger(
    options.maxRequestBytes || DEFAULT_MAX_REQUEST_BYTES,
    'maxRequestBytes',
  );
  const maxConnections = requirePositiveSafeInteger(
    options.maxConnections || DEFAULT_MAX_CONNECTIONS,
    'maxConnections',
  );
  const connectTimeoutMs = requirePositiveSafeInteger(
    options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS,
    'connectTimeoutMs',
  );
  const resolveTimeoutMs = requirePositiveSafeInteger(
    options.resolveTimeoutMs || DEFAULT_RESOLVE_TIMEOUT_MS,
    'resolveTimeoutMs',
  );
  const idleTimeoutMs = requirePositiveSafeInteger(
    options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS,
    'idleTimeoutMs',
  );
  const httpRequest = dependencies.httpRequest || http.request;
  const httpsRequest = dependencies.httpsRequest || https.request;
  const connectSocket = dependencies.connectSocket || net.createConnection;
  let activeConnections = 0;

  const resolveWithTimeout = async (url: string): Promise<ResolvedProjectEgressTarget> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        resolveProjectEgressTarget(url, {
          resolver: options.resolver,
          extraDeniedCidrs: options.extraDeniedCidrs,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new ProjectEgressPolicyError('DNS_TIMEOUT', 'Project egress DNS resolution timed out'));
          }, resolveTimeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const server = http.createServer(async (req, res) => {
    if (!isAuthorizedProjectEgressRequest(req.headers['proxy-authorization'], token)) {
      // Clients authenticate with Basic credentials from the proxy URL;
      // challenging with an unusable scheme makes git/libcurl abort after
      // the 407 instead of retrying with its credentials.
      res.setHeader('proxy-authenticate', 'Basic realm="BridgesLLM Project Egress"');
      writeHttpError(res, 407, 'PROXY_AUTH_REQUIRED');
      return;
    }
    if (activeConnections >= maxConnections) {
      writeHttpError(res, 503, 'PROXY_CAPACITY');
      return;
    }
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'CONNECT' || method === 'TRACE' || method === 'PRI') {
      writeHttpError(res, 405, 'METHOD_NOT_ALLOWED');
      return;
    }
    if (!req.url || !/^[a-z][a-z0-9+.-]*:\/\//i.test(req.url)) {
      writeHttpError(res, 400, 'ABSOLUTE_URL_REQUIRED');
      return;
    }

    activeConnections += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeConnections = Math.max(0, activeConnections - 1);
    };

    try {
      const target = await resolveWithTimeout(req.url);
      const factory = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
      const upstream = factory(buildPinnedProjectEgressRequestOptions(req, target), (upstreamResponse) => {
        if (res.destroyed) {
          upstreamResponse.destroy();
          return;
        }
        res.writeHead(
          upstreamResponse.statusCode || 502,
          upstreamResponse.statusMessage,
          sanitizeResponseHeaders(upstreamResponse.headers),
        );
        upstreamResponse.on('error', () => res.destroy());
        upstreamResponse.on('error', release);
        upstreamResponse.on('end', release);
        upstreamResponse.on('close', release);
        upstream.setTimeout(idleTimeoutMs, () => upstream.destroy(new Error('upstream timeout')));
        upstreamResponse.pipe(res);
      });
      upstream.setTimeout(connectTimeoutMs, () => upstream.destroy(new Error('upstream timeout')));
      upstream.on('error', () => {
        writeHttpError(res, 502, 'UPSTREAM_UNAVAILABLE');
        release();
      });
      req.on('aborted', () => {
        upstream.destroy();
        release();
      });
      req.on('error', () => {
        upstream.destroy();
        release();
      });
      res.on('close', () => {
        if (!res.writableEnded) upstream.destroy();
        release();
      });
      let received = 0;
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxRequestBytes) {
          upstream.destroy();
          writeHttpError(res, 413, 'REQUEST_TOO_LARGE');
          release();
          req.destroy();
          return;
        }
        if (!upstream.destroyed) upstream.write(chunk);
      });
      req.on('end', () => {
        if (!upstream.destroyed) upstream.end();
      });
    } catch (error) {
      writeHttpError(res, statusForProxyError(error), safeProxyErrorCode(error));
      release();
    }
  });

  server.on('connect', async (req, clientSocket, head) => {
    if (!isAuthorizedProjectEgressRequest(req.headers['proxy-authorization'], token)) {
      writeSocketResponse(clientSocket, 407, 'Proxy Authentication Required', [
        'Proxy-Authenticate: Basic realm="BridgesLLM Project Egress"',
      ]);
      return;
    }
    if (activeConnections >= maxConnections) {
      writeSocketResponse(clientSocket, 503, 'Service Unavailable');
      return;
    }
    if (!req.url || /[\u0000-\u0020\u007f]/.test(req.url)) {
      writeSocketResponse(clientSocket, 400, 'Bad Request');
      return;
    }

    activeConnections += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeConnections = Math.max(0, activeConnections - 1);
    };

    try {
      const target = await resolveWithTimeout(`https://${req.url}/`);
      const upstreamSocket = connectSocket({
        host: target.selectedAddress,
        port: target.port,
        family: target.selectedFamily,
      }, () => {
        clientSocket.write([
          'HTTP/1.1 200 Connection Established',
          `Proxy-Agent: ${PROXY_AGENT}`,
          '',
          '',
        ].join('\r\n'));
        const pending: Buffer[] = [];
        let pendingBytes = 0;
        let tunnelOpen = false;
        const rejectTunnel = () => {
          clientSocket.destroy();
          upstreamSocket.destroy();
          release();
        };
        const onClientData = (chunk: Buffer) => {
          if (tunnelOpen) return;
          pendingBytes += chunk.length;
          if (pendingBytes > MAX_TLS_CLIENT_HELLO_BYTES) {
            rejectTunnel();
            return;
          }
          pending.push(Buffer.from(chunk));
          const buffered = Buffer.concat(pending, pendingBytes);
          const validation = validateProjectEgressTlsClientHello(buffered, target.hostname);
          if (validation.status === 'need-more') return;
          if (validation.status !== 'valid') {
            rejectTunnel();
            return;
          }
          tunnelOpen = true;
          clientSocket.removeListener('data', onClientData);
          upstreamSocket.write(buffered);
          upstreamSocket.pipe(clientSocket);
          clientSocket.pipe(upstreamSocket);
        };
        clientSocket.on('data', onClientData);
        if (head.length) onClientData(head);
        clientSocket.resume();
      });
      upstreamSocket.setTimeout(idleTimeoutMs, () => upstreamSocket.destroy());
      (clientSocket as net.Socket).setTimeout(idleTimeoutMs, () => clientSocket.destroy());
      const connectTimer = setTimeout(() => upstreamSocket.destroy(new Error('connect timeout')), connectTimeoutMs);
      connectTimer.unref();
      upstreamSocket.once('connect', () => clearTimeout(connectTimer));
      upstreamSocket.once('close', release);
      clientSocket.once('close', release);
      upstreamSocket.on('error', () => {
        writeSocketResponse(clientSocket, 502, 'Bad Gateway');
        release();
      });
      clientSocket.on('error', () => {
        upstreamSocket.destroy();
        release();
      });
    } catch (error) {
      writeSocketResponse(clientSocket, statusForProxyError(error), 'Forbidden');
      release();
    }
  });

  server.maxHeadersCount = 100;
  server.headersTimeout = 15_000;
  server.requestTimeout = idleTimeoutMs;
  server.keepAliveTimeout = 5_000;
  return server;
}

function startFromEnvironment(): void {
  const token = process.env.PROJECT_EGRESS_PROXY_TOKEN || '';
  const host = process.env.PROJECT_EGRESS_PROXY_HOST || '0.0.0.0';
  const port = Number(process.env.PROJECT_EGRESS_PROXY_PORT || '3128');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PROJECT_EGRESS_PROXY_PORT is invalid');
  }
  const server = createProjectEgressProxyServer({
    token,
    extraDeniedCidrs: parseDenyCidrs(process.env.PROJECT_EGRESS_DENY_CIDRS),
  });
  server.listen(port, host, () => {
    process.stdout.write(`Project egress proxy listening on ${host}:${port}\n`);
  });
}

if (require.main === module) {
  try {
    startFromEnvironment();
  } catch (error) {
    process.stderr.write(`Project egress proxy failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}

export const __projectEgressProxyTest = {
  parseDenyCidrs,
  sanitizeResponseHeaders,
  statusForProxyError,
};
