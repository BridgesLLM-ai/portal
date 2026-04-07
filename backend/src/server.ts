import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { config } from './config/env';
import { corsConfig } from './middleware/cors';
import { errorHandler } from './middleware/errorHandler';
import { prisma } from './config/database';
import authRoutes from './routes/auth';
import fileRoutes from './routes/files';
import metricsRoutes, { collectMetrics } from './routes/metrics';
import appsRoutes, { shareRouter } from './routes/apps';
import activityRoutes from './routes/activity';
import chunkedUploadRoutes from './routes/chunked-upload';
import projectsRoutes from './routes/projects';
import aiRoutes from './routes/ai';
import terminalRoutes from './routes/terminal';
// Legacy Guacamole routes removed — noVNC/Xtigervnc is the active remote desktop stack.
import gatewayRoutes, { attachPortalWebSocket } from './routes/gateway';
import alertsRoutes from './routes/alerts';
import systemStatsRoutes from './routes/system-stats';
import systemReadinessRoutes from './routes/system-readiness';
import backupsRoutes from './routes/backups';
import usersRoutes from './routes/users';
import adminRoutes from './routes/admin';
import setupRoutes, { requireSetupPending, requireSetupToken } from './routes/setup-v3';
import { createAiSetupRouter } from './routes/ai-setup';
import systemControlRoutes from './routes/system-control';
import settingsPublicRoutes from './routes/settings-public';
import agentJobsRoutes from './routes/agent-jobs';
import agentToolsRoutes from './routes/agent-tools';
import agentRuntimeRoutes from './routes/agent-runtime';
import ollamaRoutes from './routes/ollama';
import remoteDesktopRoutes, { reconcilePortalVisibleBrowserDefaults } from './routes/remote-desktop';
import agentBrowserRoutes, { attachAgentBrowserWebSocket } from './routes/agentBrowser';
import systemRemediationRoutes from './routes/system-remediation';
import mailRoutes from './routes/mail';
import automationsRoutes from './routes/automations';
import skillsRoutes from './routes/skills';
import { requireSetupComplete } from './middleware/requireSetupComplete';
import { initializeCronJobs, shutdownCronJobs } from './cron-jobs';
import { setupTerminalNamespace } from './routes/exec';
import { startLogWatcher, stopLogWatcher, onAlert } from './utils/logWatcher';
import { startStatusWatcher, stopStatusWatcher, onAgentStatus } from './utils/openclawStatusWatcher';
import { blockedIPs, extractIP, loadBlockedIPs } from './utils/auth-tracking';
import { verifyAccessToken } from './utils/jwt';
import { onAgentJobOutput } from './services/agentJobs';
import { getAppPort, restoreRunningApps, shutdownAll as shutdownApps } from './services/app-process.service';
import { initPersistentGatewayWs, shutdownPersistentGatewayWs } from './agents/providers/PersistentGatewayWs';
import { canAccessPortal, canUseInteractivePortal, isElevatedRole } from './utils/authz';
import { isAllowedWebSocketOrigin } from './utils/websocketOrigin';
import { startTelemetryService, stopTelemetryService } from './services/telemetryService';
import { startAudioProxy, stopAudioProxy } from './services/audioProxy';

const app = express();
const httpServer = createServer(app);

// Socket.io
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: config.corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Disable perMessageDeflate - Cloudflare's proxy interferes with
  // compressed WebSocket frames, causing "Invalid frame header" errors
  perMessageDeflate: false,
});

app.set('io', io);

// Setup terminal namespace
setupTerminalNamespace(io);

// Shared Socket.IO auth middleware — same pattern as /terminal namespace
const socketAuthMiddleware = (socket: any, next: (err?: any) => void) => {
  let token = socket.handshake.auth?.token;

  if (!token || typeof token !== 'string') {
    const cookieHeader = socket.handshake.headers?.cookie || '';
    const cookies = parseCookies(cookieHeader);
    token = cookies.accessToken;
  }

  if (!token || typeof token !== 'string') return next(new Error('Auth required'));
  const payload = verifyAccessToken(token);
  if (!payload) return next(new Error('Invalid or expired token'));
  prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, role: true, accountStatus: true, isActive: true },
  } as any).then((user) => {
    if (!user || !canUseInteractivePortal(user.role, (user as any).accountStatus, user.isActive)) {
      return next(new Error('Account is not permitted for interactive access'));
    }
    socket.data.user = { userId: user.id, email: user.email, role: user.role, accountStatus: (user as any).accountStatus };
    next();
  }).catch((err) => next(err));
};

// Metrics streaming namespace
const metricsNs = io.of('/metrics');
metricsNs.use(socketAuthMiddleware);
metricsNs.on('connection', (socket) => {
  console.log('Metrics client connected');
  socket.on('disconnect', () => console.log('Metrics client disconnected'));
});

// Alerts streaming namespace
const alertsNs = io.of('/alerts');
alertsNs.use(socketAuthMiddleware);
alertsNs.on('connection', (socket) => {
  console.log('Alerts client connected');
  socket.on('disconnect', () => console.log('Alerts client disconnected'));
});

// Push alerts to connected clients
onAlert((alert) => {
  alertsNs.emit('alert', alert);
});

// OpenClaw agent status namespace
const openclawNs = io.of('/openclaw-status');
openclawNs.use(socketAuthMiddleware);
openclawNs.on('connection', (socket) => {
  console.log('OpenClaw status client connected');
  socket.on('disconnect', () => console.log('OpenClaw status client disconnected'));
});

onAgentStatus((status) => {
  openclawNs.emit('status', status);
});


// Agent jobs streaming namespace
const agentJobsNs = io.of('/ws/agent-jobs');
agentJobsNs.use(socketAuthMiddleware);
agentJobsNs.on('connection', async (socket) => {
  socket.on('subscribe', async ({ jobId }: { jobId?: string }) => {
    if (!jobId) return;
    try {
      const job = await prisma.agentJob.findUnique({ where: { id: jobId }, select: { userId: true } });
      if (!job) return;
      const user = socket.data.user;
      if (!isElevatedRole(user?.role) && user?.userId !== job.userId) return;
      socket.join(`job:${jobId}`);
    } catch (error) {
      console.warn('[agent-jobs] subscribe failed', error);
    }
  });

  socket.on('subscribe-tool-install', ({ toolId }: { toolId?: string }) => {
    if (!toolId) return;
    if (!isElevatedRole(socket.data.user?.role)) return;
    socket.join(`tool-install-${toolId}`);
  });

  socket.on('disconnect', () => console.log('Agent jobs client disconnected'));
});

onAgentJobOutput(({ jobId, entry }) => {
  agentJobsNs.to(`job:${jobId}`).emit('output', { jobId, entry });
});

// Trust proxy (for Cloudflare tunnel)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://cdn.sheetjs.com"], // Vite/React needs these + Monaco CDN loader + SheetJS for Excel viewer worker
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"], // Inline styles for theming + Google Fonts stylesheet + Monaco editor CSS
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "wss:", "ws:"],
      mediaSrc: ["'self'", "blob:", "data:"],
      workerSrc: ["'self'", "blob:"],
      frameSrc: ["'self'", "blob:", "data:", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      // Only upgrade insecure requests when actually serving over HTTPS.
      // On plain HTTP (pre-domain setup), this directive makes browsers
      // try HTTPS for every asset → ERR_CONNECTION_REFUSED.
      upgradeInsecureRequests: process.env.CORS_ORIGIN?.startsWith('https') ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  // Disable COOP and Origin-Agent-Cluster on plain HTTP — they're ignored by
  // browsers and just spam the console with warnings on non-secure origins.
  crossOriginOpenerPolicy: process.env.CORS_ORIGIN?.startsWith('https') ? { policy: 'same-origin' } : false,
  originAgentCluster: process.env.CORS_ORIGIN?.startsWith('https'),
}));

// Compression middleware with SSE exclusion
// SSE responses MUST NOT be compressed because:
// 1. Compression buffers data waiting for more content before flushing
// 2. This breaks real-time streaming (causes 524 timeouts through Cloudflare)
// 3. SSE is already low-bandwidth text, compression benefit is minimal
app.use(compression({
  filter: (req: any, res: any) => {
    // Skip compression for SSE responses
    const contentType = res.getHeader('Content-Type');
    if (contentType && String(contentType).includes('text/event-stream')) {
      return false;
    }
    // Skip compression for gateway stream requests (before Content-Type is set)
    if (req.url?.includes('/gateway/send') && req.query?.stream === '1') {
      return false;
    }
    // Use default filter for everything else
    return compression.filter(req, res);
  },
}));

// CORS
app.use(corsConfig);

// Proxy + auth imports
import { createProxyMiddleware } from 'http-proxy-middleware';
import { authenticateToken, browserAssetAuth, browserAuthRedirect } from './middleware/auth';
import { requireAdmin } from './middleware/requireAdmin';

// Simple cookie parser for WebSocket upgrade handler (no express req.cookies available)
function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const key = pair.substring(0, idx).trim();
      const val = pair.substring(idx + 1).trim();
      cookies[key] = decodeURIComponent(val);
    }
  });
  return cookies;
}

// noVNC architecture (March 2026 fix):
// - Static files served directly by Express from vendored /static/novnc/ (version-pinned)
// - WebSocket proxy for /novnc/websockify → host websockify on port 6080
// - Websockify no longer serves static files (--web flag removed)
// - Docker novnc-bridge container removed (was racing for port 6080)
const novncWsTarget = process.env.RD_NOVNC_TARGET || process.env.NOVNC_TARGET || 'http://127.0.0.1:6080';
const novncWsProxy = createProxyMiddleware({
  target: novncWsTarget,
  ws: true,
  changeOrigin: true,
  pathRewrite: { '^/novnc/websockify': '/' },
  on: {
    error: (err: Error, _req: any, res: any) => {
      console.error('[noVNC WS] Proxy error:', err.message);
      if (res && typeof res.writeHead === 'function') {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('noVNC websocket bridge unavailable');
      }
    },
  },
} as any);

// Remote Desktop Audio WebSocket proxy → audio proxy on port 4714
const audioWsTarget = process.env.RD_AUDIO_TARGET || 'http://127.0.0.1:4714';
const audioWsProxy = createProxyMiddleware({
  target: audioWsTarget,
  ws: true,
  changeOrigin: true,
  pathRewrite: { '^/novnc/audio': '/' },
  on: {
    error: (err: Error, _req: any, res: any) => {
      console.error('[Audio WS] Proxy error:', err.message);
      if (res && typeof res.writeHead === 'function') {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Audio bridge unavailable');
      }
    },
  },
} as any);

// Cookie parsing — must be before any auth middleware that reads req.cookies
app.use(cookieParser());

// Body parsing

// Capture raw body for multipart requests ONLY on hosted proxy routes.
// These proxies need the raw buffer to forward file uploads to upstream apps.
// IMPORTANT: Do NOT apply globally — it drains the stream and breaks multer on
// all other routes (avatar uploads, logo uploads, etc.).
function captureRawBody(req: any, _res: any, next: any) {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });
    req.on('error', next);
  } else {
    next();
  }
}
app.use('/hosted', captureRawBody);
app.use('/share', captureRawBody);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Auth-gated noVNC — portal JWT required (after cookieParser so req.cookies is available)
// WebSocket proxies must be registered BEFORE the static handler to avoid path conflicts
app.use('/novnc/websockify', authenticateToken, novncWsProxy);
app.use('/novnc/audio', authenticateToken, audioWsProxy);

// Serve noVNC static files directly (version-pinned, cache-busting headers)
app.use('/novnc', authenticateToken, express.static(path.join(__dirname, '../../static/novnc'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
}));

// Rate limiting — strict for auth endpoints, relaxed for authenticated users
if (config.nodeEnv === 'production') {
  const authLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 login attempts per minute (brute force protection)
    message: 'Too many requests from this IP, please try again later.',
  });
  app.use('/api/auth/', authLimiter);

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute (matches assistant poll window)
    max: 600, // 600 req/min allows heavy interactive use while blocking runaway scripts
    message: 'Too many requests from this IP, please try again later.',
  });
  app.use('/api/', apiLimiter);
}

// IP blocking middleware — check all requests against blocked IP list
app.use((req, res, next) => {
  const ip = extractIP(req);
  if (blockedIPs.has(ip)) {
    // Allow unblock endpoint through
    if (req.path === '/api/activity/unblock-ip') return next();
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  next();
});

// Share routes (NO AUTH - must be before auth middleware)
app.use('/share', shareRouter);

// Static assets (avatars, branding) — not dependent on Files DB
// Uses /static-assets to avoid collision with Vite's /assets build output
// Assets live at INSTALL_ROOT/assets (e.g. /opt/bridgesllm/assets), NOT inside the portal dir.
// In dev, PORTAL_ROOT is the repo root, so assets/ is alongside backend/.
const STATIC_ASSETS_ROOT = path.join(
  process.env.INSTALL_ROOT || process.env.PORTAL_ROOT || '/root/bridgesllm-product',
  'assets'
);
app.use('/static-assets', express.static(STATIC_ASSETS_ROOT, {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    const rel = filePath.replace(`${STATIC_ASSETS_ROOT}/`, '');
    // User-mutable assets must not be cached aggressively.
    if (rel.startsWith('avatars/') || rel.startsWith('branding/')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return;
    }
    // Other static files can be cached.
    res.setHeader('Cache-Control', 'public, max-age=604800');
  },
}));

// Do not let SPA fallback return HTML for missing user-uploaded assets.
app.get(['/static-assets/avatars/*', '/static-assets/branding/*'], (_req, res) => {
  res.status(404).json({ error: 'Asset not found' });
});

// Hosted apps - serve static files from /var/www/bridgesllm-apps/{id}/
const HOSTED_APPS_DIR = process.env.APPS_ROOT || '/var/www/bridgesllm-apps';
import fs from 'fs';
if (!fs.existsSync(HOSTED_APPS_DIR)) fs.mkdirSync(HOSTED_APPS_DIR, { recursive: true });

/**
 * Resolve API backend target for any hosted/shared app.
 * Convention: set env APP_API_TARGET_{NAMESPACE} where NAMESPACE is the
 * first path segment after /api/, uppercased with dashes to underscores.
 * Example: APP_API_TARGET_MY_APP=http://127.0.0.1:5005
 *
 * Fallback: managed fullstack port -> portal self-proxy.
 */
function resolveAppApiTarget(proxiedPath: string, target: string, req: any): string {
  const slashIdx = proxiedPath.indexOf('/');
  const namespace = slashIdx >= 0 ? proxiedPath.slice(0, slashIdx) : proxiedPath;
  const envKey = 'APP_API_TARGET_' + namespace.toUpperCase().replace(/-/g, '_');
  const envTarget = process.env[envKey];
  if (envTarget) return envTarget + target;
  const port = getAppPort(namespace);
  if (port) return `http://127.0.0.1:${port}${target}`;
  return req.protocol + '://' + req.get('host') + target;
}

// Hosted apps — API proxy: route /hosted/:deployId/api/* to the real backend.
app.use('/hosted/:deployId/api/*', browserAuthRedirect, async (req: any, res: any) => {
  const proxiedPath = req.params[0] || '';
  const qsIndex = req.originalUrl.indexOf('?');
  const query = qsIndex >= 0 ? req.originalUrl.slice(qsIndex) : '';
  const target = '/api/' + proxiedPath + query;
  const targetUrl = resolveAppApiTarget(proxiedPath, target, req);

  const method = req.method.toUpperCase();
  const shouldSendBody = !['GET', 'HEAD'].includes(method);
  const incomingHeaders = req.headers as Record<string, any>;
  const upstreamHeaderAllowlist = new Set([
    'accept',
    'accept-language',
    'content-type',
    'if-match',
    'if-none-match',
    'if-modified-since',
    'if-unmodified-since',
    'range',
    'x-requested-with',
  ]);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(incomingHeaders)) {
    const key = k.toLowerCase();
    if (!v || !upstreamHeaderAllowlist.has(key)) continue;
    headers[key] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  headers['x-internal-service'] = 'hosted-proxy';
  headers['x-portal-proxy'] = 'hosted-app-api';
  if (req.user) {
    headers['x-user-id'] = req.user.userId;
    if (req.user.role) headers['x-portal-role'] = String(req.user.role);
  }

  try {
    // For multipart/form-data uploads, use the raw body buffer captured before
    // express.json() consumed the stream. For JSON, serialize as before.
    let body: any = undefined;
    if (shouldSendBody) {
      const incomingCt = req.headers['content-type'] || '';
      if (incomingCt.includes('multipart/form-data') && req.rawBody) {
        body = req.rawBody;
      } else {
        body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      }
    }

    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
    });

    res.status(upstream.status);
    // Forward content headers
    const ct = upstream.headers.get('content-type');
    const cd = upstream.headers.get('content-disposition');
    if (ct) res.setHeader('Content-Type', ct);
    if (cd) res.setHeader('Content-Disposition', cd);

    // Stream the response (handles binary PDF responses correctly)
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err: any) {
    console.error('[Hosted API Proxy] Error:', err.message);
    res.status(502).json({ error: 'Backend unavailable' });
  }
});

// Serve hosted static assets with auth, but never HTML redirect for subresources.
// That preserves correct MIME behavior while keeping private app bundles private.
const STATIC_ASSET_RE = /\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|eot|map|json)$/i;
app.use('/hosted', async (req, res, next) => {
  if (!STATIC_ASSET_RE.test(req.path)) {
    next();
    return;
  }

  try {
    await browserAssetAuth(req, res, async () => {
      const parts = req.path.split('/').filter(Boolean);
      if (parts.length < 2) { next(); return; }
      const appId = parts[0];
      const appDir = path.resolve(path.join(HOSTED_APPS_DIR, appId));
      if (!appDir.startsWith(path.resolve(HOSTED_APPS_DIR))) { res.status(403).send('Forbidden'); return; }
      // Check dist/ first, then root
      const distDir = path.join(appDir, 'dist');
      const contentRoot = (fs.existsSync(path.join(distDir, 'index.html'))) ? distDir : appDir;
      const filePath = parts.slice(1).join('/');
      const fullPath = path.resolve(path.join(contentRoot, filePath));
      if (!fullPath.startsWith(path.resolve(contentRoot))) { res.status(403).send('Forbidden'); return; }
      if (fs.existsSync(fullPath) && !fs.statSync(fullPath).isDirectory()) {
        res.sendFile(fullPath);
      } else {
        res.status(404).send('Not found');
      }
    });
  } catch (error) {
    next(error);
  }
}, browserAuthRedirect, async (req, res, next) => {
  const parts = req.path.split('/').filter(Boolean);
  if (parts.length === 0) { res.status(404).send('Not found'); return; }

  const appId = parts[0];

  // Check if fullstack app with running process
  const appPort = getAppPort(appId);
  if (appPort) {
    const targetPath = '/' + parts.slice(1).join('/') || '/';
    req.url = targetPath;
    const proxy = createProxyMiddleware({
      target: `http://127.0.0.1:${appPort}`,
      changeOrigin: true,
      logger: console,
    });
    proxy(req, res, next);
    return;
  }

  // Look up app in database to get actual directory path
  let resolvedAppDir: string;
  try {
    const appRecord = await prisma.app.findUnique({ where: { id: appId }, select: { zipPath: true } });
    if (appRecord?.zipPath) {
      resolvedAppDir = path.resolve(appRecord.zipPath);
    } else {
      resolvedAppDir = path.resolve(path.join(HOSTED_APPS_DIR, appId));
    }
  } catch {
    resolvedAppDir = path.resolve(path.join(HOSTED_APPS_DIR, appId));
  }

  if (!resolvedAppDir.startsWith(path.resolve(HOSTED_APPS_DIR))) {
    res.status(403).send('Forbidden'); return;
  }

  if (!fs.existsSync(resolvedAppDir)) {
    res.status(404).send('App not found'); return;
  }

  // Prefer built artifacts (dist/) over source root — same logic as share handler.
  // Source-root index.html often references /src/main.tsx (Vite dev entry) which won't work.
  const distDir = path.join(resolvedAppDir, 'dist');
  const contentRoot = (fs.existsSync(path.join(distDir, 'index.html'))) ? distDir : resolvedAppDir;

  const filePath = parts.slice(1).join('/') || 'index.html';
  const fullPath = path.join(contentRoot, filePath);
  const resolvedPath = path.resolve(fullPath);

  if (!resolvedPath.startsWith(path.resolve(contentRoot))) {
    res.status(403).send('Forbidden'); return;
  }

  if (fs.existsSync(resolvedPath) && !fs.statSync(resolvedPath).isDirectory()) {
    res.sendFile(resolvedPath);
  } else {
    // SPA fallback — serve index.html for client-side routing
    const indexPath = path.join(contentRoot, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send('Not found');
    }
  }
});

// Remote desktop mock endpoint for safe/local testing
app.get('/remote-desktop-mock', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Remote Desktop Mock</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        background: radial-gradient(circle at 20% 20%, #1f2a44 0%, #0a0e27 55%, #060816 100%);
        color: #dbeafe;
        min-height: 100vh;
        display: grid;
        place-items: center;
      }
      .card {
        width: min(780px, 92vw);
        border: 1px solid rgba(255,255,255,0.16);
        border-radius: 16px;
        padding: 24px;
        background: rgba(15, 23, 42, 0.72);
        backdrop-filter: blur(8px);
      }
      .ok { color: #34d399; font-weight: 600; }
      code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 6px; color: #a7f3d0; }
      ul { line-height: 1.65; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Remote Desktop Mock Endpoint</h1>
      <p class="ok">If you can see this page inside the Remote Desktop iframe, the portal recursion guard is working.</p>
      <ul>
        <li>This endpoint is intentionally static and isolated.</li>
        <li>Use <code>VITE_REMOTE_DESKTOP_URL=/remote-desktop-mock</code> for local test runs.</li>
        <li>Allowed same-origin prefix example: <code>/remote-desktop-mock</code> is <b>not</b> in default allowlist; add it only in test env if needed.</li>
      </ul>
    </div>
  </body>
</html>`);
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes

app.use('/api/setup/ai', requireSetupPending, requireSetupToken, createAiSetupRouter());
app.use('/api/setup', setupRoutes);
app.use('/api', requireSetupComplete);
app.use('/api/auth', authRoutes);
app.use('/api/ai-setup', authenticateToken, requireAdmin, createAiSetupRouter());
app.use('/api/files', fileRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/apps', appsRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/upload', chunkedUploadRoutes);
import { projectPathSandbox, aiPathSandbox } from './middleware/pathSandbox';
app.use('/api/projects', projectPathSandbox, projectsRoutes);
app.use('/api/ai', aiPathSandbox, aiRoutes);
app.use('/api/terminal', terminalRoutes);
// Legacy Guacamole API routes removed — noVNC/Xtigervnc is the active remote desktop stack.
app.use('/api/gateway', gatewayRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/system/stats', systemStatsRoutes);
app.use('/api/system/readiness', systemReadinessRoutes);
app.use('/api/system/remediation', systemRemediationRoutes);
app.use('/api/backups', backupsRoutes);
app.use('/api/system-control', systemControlRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsPublicRoutes);
app.use('/api/agent-jobs', agentJobsRoutes);
app.use('/api/agent-tools', agentToolsRoutes);
app.use('/api/agent-runtime', agentRuntimeRoutes);
app.use('/api/ollama', ollamaRoutes);
app.use('/api/remote-desktop', remoteDesktopRoutes);
app.use('/api/mail', mailRoutes);
app.use('/api/automations', automationsRoutes);
app.use('/api/skills', skillsRoutes);
app.use('/api/agent-browser', agentBrowserRoutes);

// In production, serve built frontend from Express (single-process deployment).
if (config.nodeEnv === 'production') {
  const frontendDist = path.join(__dirname, '../../frontend/dist');
  const frontendIndexPath = path.join(__dirname, '../../frontend/dist/index.html');

  type SpaRenderCache = {
    sourceHtml: string | null;
    sourceMtimeMs: number;
    settingsSignature: string | null;
    htmlByRequestUrl: Map<string, string>;
  };

  const spaRenderCache: SpaRenderCache = {
    sourceHtml: null,
    sourceMtimeMs: 0,
    settingsSignature: null,
    htmlByRequestUrl: new Map(),
  };

  const escapeHtml = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const detectBrandingLogoPath = (): string => {
    const brandingDir = path.join(STATIC_ASSETS_ROOT, 'branding');
    const candidates = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];

    for (const ext of candidates) {
      const exact = path.join(brandingDir, `logo.${ext}`);
      if (fs.existsSync(exact)) return `/static-assets/branding/logo.${ext}`;
    }

    try {
      const entries = fs.readdirSync(brandingDir);
      const match = entries
        .filter(name => /^portal-logo-.*\.(png|jpg|jpeg|gif|svg|webp)$/i.test(name))
        .sort()
        .pop();
      if (match) return `/static-assets/branding/${match}`;
    } catch {}

    return '';
  };

  const getSpaSourceHtml = () => {
    const stat = fs.statSync(frontendIndexPath);
    if (!spaRenderCache.sourceHtml || spaRenderCache.sourceMtimeMs !== stat.mtimeMs) {
      spaRenderCache.sourceHtml = fs.readFileSync(frontendIndexPath, 'utf8');
      spaRenderCache.sourceMtimeMs = stat.mtimeMs;
      spaRenderCache.settingsSignature = null;
      spaRenderCache.htmlByRequestUrl.clear();
    }
    return spaRenderCache.sourceHtml;
  };

  const buildAbsoluteUrl = (req: express.Request, pathname: string) => `${req.protocol}://${req.get('host')}${pathname}`;

  const renderSpaHtml = async (req: express.Request) => {
    const rows = await prisma.systemSetting.findMany({
      where: {
        key: {
          in: [
            'system.siteName',
            'system.siteDescription',
            'system.logo',
            'system.searchEngineVisibility',
            'appearance.portalName',
            'appearance.logoUrl',
          ],
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const settings = new Map(rows.map((row) => [row.key, row.value]));
    const siteName = settings.get('system.siteName') || settings.get('appearance.portalName') || 'BridgesLLM Portal';
    const siteDescription = settings.get('system.siteDescription') || '';
    const searchEngineVisibility = settings.get('system.searchEngineVisibility') || 'hidden';
    const configuredLogo = settings.get('system.logo') || settings.get('appearance.logoUrl') || '';
    const detectedLogo = detectBrandingLogoPath();
    const logoPath = detectedLogo || configuredLogo;
    const absoluteLogoUrl = logoPath
      ? (logoPath.startsWith('http://') || logoPath.startsWith('https://') ? logoPath : buildAbsoluteUrl(req, logoPath))
      : '';
    const absolutePageUrl = buildAbsoluteUrl(req, req.originalUrl || req.path || '/');
    const settingsSignature = JSON.stringify({
      settings: Object.fromEntries(settings.entries()),
      updatedAt: rows[0]?.updatedAt?.toISOString?.() || '',
      sourceMtimeMs: spaRenderCache.sourceMtimeMs,
    });
    const requestCacheKey = `${req.get('host') || ''}|${req.protocol}|${req.originalUrl || req.path || '/'}|${settingsSignature}`;

    if (spaRenderCache.settingsSignature !== settingsSignature) {
      spaRenderCache.settingsSignature = settingsSignature;
      spaRenderCache.htmlByRequestUrl.clear();
    }

    const cached = spaRenderCache.htmlByRequestUrl.get(requestCacheKey);
    if (cached) return cached;

    const sourceHtml = getSpaSourceHtml();
    const metaTags = [
      `<meta property="og:title" content="${escapeHtml(siteName)}" />`,
      `<meta property="og:description" content="${escapeHtml(siteDescription)}" />`,
      `<meta property="og:type" content="website" />`,
      `<meta property="og:url" content="${escapeHtml(absolutePageUrl)}" />`,
      `<meta property="og:site_name" content="${escapeHtml(siteName)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" content="${escapeHtml(siteName)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(siteDescription)}" />`,
    ];

    if (absoluteLogoUrl) {
      metaTags.splice(2, 0, `<meta property="og:image" content="${escapeHtml(absoluteLogoUrl)}" />`);
      metaTags.push(`<meta name="twitter:image" content="${escapeHtml(absoluteLogoUrl)}" />`);
    }

    if (searchEngineVisibility === 'hidden') {
      metaTags.push('<meta name="robots" content="noindex, nofollow" />');
    }

    const injectedHtml = sourceHtml.replace('</head>', `  ${metaTags.join('\n  ')}\n</head>`);
    spaRenderCache.htmlByRequestUrl.set(requestCacheKey, injectedHtml);
    return injectedHtml;
  };

  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get('*', async (req, res, next) => {
      const nonSpaPrefixes = ['/api', '/share', '/hosted', '/novnc', '/static-assets', '/assets'];
      if (nonSpaPrefixes.some(prefix => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
        return next();
      }

      try {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.type('html').send(await renderSpaHtml(req));
      } catch (error) {
        next(error);
      }
    });
  } else {
    console.warn(`⚠️ frontend dist not found at ${frontendDist}; run frontend build before starting production server`);
  }
}

// Error handling middleware
app.use(errorHandler);

// Metrics collection interval (every 30s)
let metricsInterval: NodeJS.Timeout;

// Graceful shutdown
const shutdownHandler = async (signal: string) => {
  console.log(`\n${signal} received, shutting down gracefully...`);
  clearInterval(metricsInterval);
  stopLogWatcher();
  stopStatusWatcher();
  shutdownCronJobs();
  stopTelemetryService();
  stopAudioProxy();
  shutdownPersistentGatewayWs();
  try {
    io.close();
    await prisma.$disconnect();
    console.log('Database connection closed');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
process.on('SIGINT', () => shutdownHandler('SIGINT'));

// Start server
const startServer = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ Database connection successful');

    // Load blocked IPs from database
    await loadBlockedIPs();

    // Start metrics collection
    metricsInterval = setInterval(async () => {
      const m = await collectMetrics();
      if (m) {
        metricsNs.emit('metrics', {
          ...m,
          memoryTotal: m.memoryTotal.toString(),
          diskTotal: m.diskTotal.toString(),
          networkIn: m.networkIn.toString(),
          networkOut: m.networkOut.toString(),
        });
      }
    }, 30000);

    // Collect initial metrics
    collectMetrics();

    // Start OpenClaw log watcher for system alerts
    startLogWatcher();

    // Start OpenClaw agent status watcher
    startStatusWatcher();

    // Initialize persistent WebSocket connection to OpenClaw gateway for exec approvals
    initPersistentGatewayWs();

    // Initialize cron jobs
    initializeCronJobs();

    // Start telemetry sender
    startTelemetryService();

    // Start Remote Desktop audio proxy (PulseAudio → WebSocket)
    startAudioProxy();

    // Attach portal chat WebSocket server (browser ↔ portal)
    attachPortalWebSocket(httpServer);

    // Attach agent browser live-view WebSocket
    attachAgentBrowserWebSocket(httpServer);

    // Attach WebSocket upgrade handlers to HTTP server
    httpServer.on('upgrade', (req, socket, head) => {
      if (req.url?.startsWith('/novnc/websockify')) {
        const origin = req.headers.origin;
        if (!isAllowedWebSocketOrigin(origin)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        // Verify JWT from accessToken cookie before allowing WebSocket upgrade
        const cookies = parseCookies(req.headers.cookie || '');
        const token = cookies.accessToken;
        if (!token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const payload = verifyAccessToken(token);
        if (!payload) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        prisma.user.findUnique({
          where: { id: payload.userId },
          select: { id: true, role: true, accountStatus: true, isActive: true },
        } as any).then((user) => {
          if (!user || !canUseInteractivePortal(user.role, (user as any).accountStatus, user.isActive)) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
          // noVNC WebSocket upgrade — only /novnc/websockify goes to websockify
          (novncWsProxy as any).upgrade(req, socket, head);
        }).catch(() => {
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        });
      } else if (req.url?.startsWith('/novnc/audio')) {
        // Audio WebSocket upgrade — same auth as VNC
        const origin = req.headers.origin;
        if (!isAllowedWebSocketOrigin(origin)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        const cookies = parseCookies(req.headers.cookie || '');
        const token = cookies.accessToken;
        if (!token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const payload = verifyAccessToken(token);
        if (!payload) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        prisma.user.findUnique({
          where: { id: payload.userId },
          select: { id: true, role: true, accountStatus: true, isActive: true },
        } as any).then((user) => {
          if (!user || !canUseInteractivePortal(user.role, (user as any).accountStatus, user.isActive)) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
          (audioWsProxy as any).upgrade(req, socket, head);
        }).catch(() => {
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        });
      }
      // Legacy Guacamole upgrade path removed; noVNC websocket handling is active above.
    });

    httpServer.listen(config.port, config.host, () => {
      console.log(`\n🚀 Portal Backend running on http://${config.host}:${config.port}`);
      console.log(`📊 Health check: http://${config.host}:${config.port}/health`);
      console.log(`🔐 Auth: /api/auth/*`);
      console.log(`📁 Files: /api/files/*`);
      console.log(`📈 Metrics: /api/metrics/*`);
      console.log(`🎯 Apps: /api/apps/*`);
      console.log(`📋 Activity: /api/activity/*`);
      console.log(`💻 Terminal: ws /terminal`);
      console.log(`\nEnvironment: ${config.nodeEnv}`);
      console.log('Press Ctrl+C to stop\n');
      void reconcilePortalVisibleBrowserDefaults();
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

export default app;
