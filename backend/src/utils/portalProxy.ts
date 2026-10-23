import { createProxyServer, type ProxyServerOptions } from 'httpxy';
import type { IncomingMessage, ServerResponse, ClientRequest } from 'node:http';
import type { Socket } from 'node:net';
import type { RequestHandler } from 'express';

interface PortalProxyOptions {
  target: NonNullable<ProxyServerOptions['target']>;
  changeOrigin?: boolean;
  timeout?: number;
  proxyTimeout?: number;
  ws?: boolean;
  pathRewrite?: Record<string, string>;
  logger?: Pick<Console, 'error'>;
  on?: {
    proxyReq?: (proxyReq: ClientRequest, req: IncomingMessage, res: ServerResponse) => void;
    proxyRes?: (proxyRes: IncomingMessage, req: IncomingMessage, res: ServerResponse) => void;
    error?: (error: Error, req: IncomingMessage, res: ServerResponse | Socket) => void;
  };
}

// Portal routes already perform admission and path matching. Do not add glob
// parsing or automatic server 'upgrade' listeners: WS admission is explicit.
export function createProxyMiddleware(options: PortalProxyOptions): RequestHandler & {
  upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void;
} {
  const proxyOptions: ProxyServerOptions = {
    target: options.target,
    changeOrigin: options.changeOrigin,
    timeout: options.timeout,
    proxyTimeout: options.proxyTimeout,
  };
  const proxy = createProxyServer(proxyOptions);
  const rewrites = Object.entries(options.pathRewrite || {}).map(([pattern, replacement]) => ({
    pattern: new RegExp(pattern), replacement,
  }));
  const rewrite = (req: IncomingMessage) => {
    for (const { pattern, replacement } of rewrites) {
      if (pattern.test(req.url || '')) {
        req.url = (req.url || '').replace(pattern, replacement);
        break;
      }
    }
  };
  const fail = (error: Error, req: IncomingMessage, transport: ServerResponse | Socket) => {
    options.logger?.error('[Portal proxy]', error.message);
    options.on?.error?.(error, req, transport);
    if ('writeHead' in transport) {
      if (transport.writableEnded || transport.destroyed) return;
      if (!transport.headersSent) transport.writeHead(502, { 'Content-Type': 'text/plain' });
      transport.end('Upstream unavailable');
    } else {
      transport.destroy();
    }
  };
  proxy.on('error', (error, req, transport) => {
    if (req && transport) fail(error, req, transport);
  });
  if (options.on?.proxyReq) proxy.on('proxyReq', options.on.proxyReq);
  proxy.on('proxyRes', (upstream, req, res) => {
    // Preserve streaming cancellation, including a client leaving an SSE page.
    res.once('close', () => { if (!res.writableEnded) upstream.destroy(); });
    options.on?.proxyRes?.(upstream, req, res);
  });
  const middleware = ((req, res, next) => {
    rewrite(req);
    void proxy.web(req, res).catch(next);
  }) as ReturnType<typeof createProxyMiddleware>;
  middleware.upgrade = (req, socket, head) => {
    rewrite(req);
    void proxy.ws(req, socket, proxyOptions, head).catch((error) => fail(error, req, socket));
  };
  return middleware;
}
