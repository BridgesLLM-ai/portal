import express from 'express';
import { createServer } from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { Server as SocketIOServer } from 'socket.io';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { captureBoundedMultipartBody } from './utils/proxyMultipartBody';
import {
  APP_API_ID_HEADER,
  addConfiguredAppApiSecret,
  buildAppApiTargetUrl,
  configuredAppApiTarget,
} from './utils/appApiProxyAuth';
import { createAppApiAbortContext, serializeAppApiRequestBody, streamAppApiResponse } from './utils/appApiProxy';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { config } from './config/env';
import { corsConfig } from './middleware/cors';
import { errorHandler } from './middleware/errorHandler';
import { prisma } from './config/database';
import authRoutes from './routes/auth';
import fileRoutes, { initializeFileStorage } from './routes/files';
import appsRoutes, { initializeAppsStorage, shareRouter } from './routes/apps';
import activityRoutes from './routes/activity';
import chunkedUploadRoutes, { initializeChunkedUploadRuntime, shutdownChunkedUploadRuntime } from './routes/chunked-upload';
import projectsRoutes, {
  initializeProjectStorage,
  recoverInterruptedCurrentProjectCreations,
} from './routes/projects';
import aiRoutes from './routes/ai';
import terminalRoutes from './routes/terminal';
// Legacy Guacamole routes removed — noVNC/Xtigervnc is the active remote desktop stack.
import gatewayRoutes, { attachPortalWebSocket } from './routes/gateway';
import alertsRoutes from './routes/alerts';
import systemStatsRoutes from './routes/system-stats';
import systemMaintenanceRoutes from './routes/system-maintenance';
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
import askUserPluginRoutes from './routes/askUserPlugin';
import remoteDesktopRoutes, { reconcilePortalVisibleBrowserDefaults, reconcileRemoteDesktopLauncherAssets } from './routes/remote-desktop';
import { retireInternalProjectIdentityDebris } from './services/projectIdentity';
import { provisionAgentZeroDesktopLauncherSecret } from './services/agentZeroDesktopLaunch';
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
import {
  initializeAgentJobsRuntime,
  initializeAgentJobsStorage,
  onAgentJobOutput,
  onAgentJobStatus,
  readTranscript,
  shutdownAgentJobsRuntime,
} from './services/agentJobs';
import {
  initializeHostAgentRunRuntime,
  initializeHostAgentRunStorage,
  shutdownHostAgentRunRuntime,
} from './services/hostAgentRunJournal';
import {
  initializeTerminalSystemdScopeRuntime,
  shutdownTerminalSystemdScopeRuntime,
} from './services/terminalSystemdScopeBoundary';
import { initializeOpenClawHostRunJournal } from './services/openClawHostRunJournal';
import { initializeProjectAuthorizationTransitionRuntime } from './services/projectAuthorizationTransition';
import {
  getAppTarget,
  initializeAppProcessRuntime,
  shutdownAll as shutdownAppProcesses,
} from './services/app-process.service';
import { initializeLegacyProjectContinuityAdoption } from './services/legacyProjectContinuityAdoption';
import { ollamaPullManager } from './services/ollamaPullManager';
import { setupLocalOllamaPullManager } from './services/setupLocalOllamaPullManager';
import { initPersistentGatewayWs, shutdownPersistentGatewayWs } from './agents/providers/PersistentGatewayWs';
import { stopDefaultAgentZeroHostGateway } from './agents/providers/agentZero/AgentZeroHostGateway';
import { canAccessPortal, canUseInteractivePortal, isElevatedRole } from './utils/authz';
import { isAllowedWebSocketOrigin } from './utils/websocketOrigin';
import { startTelemetryService, stopTelemetryService } from './services/telemetryService';
import { startAudioProxy, stopAudioProxy } from './services/audioProxy';
import { isExactWebSocketPath, normalizeAudioProxyPort } from './services/remoteDesktopPolicy';
import { initializeBackupConfiguration } from './services/backup.service';
import {
  isBlockedAppStaticPath,
  isPathWithin,
  resolveExistingAppDirectory,
  resolveExistingPathWithin,
} from './utils/appFileSecurity';
import { ASSETS_ROOT, initializeImageAssetStorage, isSafeMutableImageAssetPath } from './services/imageAssets';
import { ensureRuntimeDirectory } from './utils/runtimeDirectory';
import {
  appContentIsolationIsDistinct,
  appContentRedirectUrl,
  configuredAppContentOrigin,
  configuredPortalOrigin,
  HostedTicketReplayGuard,
  hostedAccessCookieName,
  isAppContentRequest,
  issueHostedAccessToken,
  rejectCookieAuthenticatedCrossOriginMutation,
  verifyHostedAccessToken,
} from './utils/appContentSecurity';
import { getWorkspaceOwnerId } from './utils/workspaceScope';
import { parseSafeCookieHeader } from './utils/safeCookies';
import { encryptStoredSecretsAtBoot } from './services/storedSecretBackfill';
import { PORTAL_VERSION } from './version';
import {
  getMailboxReconciliationReadiness,
  initializeMailboxReconciliationRuntime,
  shutdownMailboxReconciliationRuntime,
} from './services/mailboxReconciliation';
import {
  initializeProjectChatRestartRecoveryRuntime,
  shutdownProjectChatRestartRecoveryRuntime,
} from './services/projectChatRestartRecovery';
import {
  admitWorkspaceAuthorizationMutation,
  admitWorkspaceAuthorizationRead,
  settleWorkspaceAuthorizationRequest,
  settleWorkspaceAuthorizationRequestIfResponseEnded,
  subscribeToGlobalWorkspaceAuthorizationFence,
} from './services/workspaceAuthorizationBarrier';
import {
  subscribeToAuthorizationChanges,
  type AuthorizationChangedEvent,
} from './services/authorizationChangeBus';
import {
  beginLegacyOpenClawProjectMigration,
  legacyOpenClawProjectMigrationRetryDelayMs,
  LegacyOpenClawProjectRetirementError,
  shouldRetryLegacyOpenClawProjectMigration,
} from './services/legacyOpenClawProjectRetirement';
import {
  startStartupStatusServer,
  stopStartupStatusServer,
  setStartupPhase,
} from './services/startupStatusServer';

export const PORTAL_UPDATE_VALIDATION_MODE = process.env.PORTAL_UPDATE_VALIDATION_MODE === '1';
export const PORTAL_UPDATE_VALIDATION_CONTRACT = 'BRIDGESLLM_UPDATE_VALIDATION_CONTRACT_V1';

type MetricsModule = typeof import('./routes/metrics');
// routes/metrics owns a six-hour database cleanup timer at module scope. A
// transient update candidate must not even load that module: validation can
// run for an arbitrarily long time after an interrupted installer.
const metricsModule: MetricsModule | null = PORTAL_UPDATE_VALIDATION_MODE
  ? null
  : require('./routes/metrics') as MetricsModule;

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
  // A transaction candidate exists only to prove the new runtime and database
  // on a private loopback port. Reject Socket.IO before any namespace auth or
  // route logic can run.
  ...(PORTAL_UPDATE_VALIDATION_MODE
    ? {
      allowRequest: (_req: unknown, callback: (error: string | null, success: boolean) => void) => {
        callback('Update validation mode serves health checks only', false);
      },
    }
    : {}),
});

app.set('io', io);

// Setup terminal namespace
setupTerminalNamespace(io);

// Shared Socket.IO auth middleware — same pattern as /terminal namespace
const socketAuthMiddleware = (socket: any, next: (err?: any) => void) => {
  let token = socket.handshake.auth?.token;

  if (!token || typeof token !== 'string') {
    const cookieHeader = socket.handshake.headers?.cookie || '';
    const cookies = parseSafeCookieHeader(cookieHeader);
    token = cookies.accessToken;
  }

  if (!token || typeof token !== 'string') return next(new Error('Auth required'));
  const payload = verifyAccessToken(token);
  if (!payload) return next(new Error('Invalid or expired token'));
  const authorizationNamespace = socket.nsp?.name === '/authorization';
  const pendingEvents: AuthorizationChangedEvent[] = [];
  let authorizationRevoked = false;
  let unsubscribed = false;
  const revokeInteractiveAuthority = () => {
    authorizationRevoked = true;
    try {
      socket.disconnect(true);
    } catch {
      // The post-query check still rejects a handshake already being torn down.
    }
  };
  let unsubscribeGlobalFence = () => {};
  let unsubscribeAuthorization = () => {};
  // Keep only the non-privileged revocation relay alive long enough to deliver
  // the committed generation. Every namespace with read or execution
  // authority is synchronously disconnected by the global fence.
  if (!authorizationNamespace) {
    unsubscribeGlobalFence = subscribeToGlobalWorkspaceAuthorizationFence(
      revokeInteractiveAuthority,
    );
    if (authorizationRevoked) {
      unsubscribeGlobalFence();
      return next(new Error('Workspace authorization is changing'));
    }
  }
  unsubscribeAuthorization = subscribeToAuthorizationChanges(payload.userId, (event) => {
    authorizationRevoked = true;
    if (authorizationNamespace) {
      const relay = socket.data.authorizationChangeRelay as
        | ((changed: AuthorizationChangedEvent) => void)
        | null
        | undefined;
      if (relay) relay(event);
      else pendingEvents.push(event);
      return;
    }
    socket.disconnect(true);
  });
  const cleanupAuthorization = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    socket.conn?.removeListener?.('close', cleanupAuthorization);
    unsubscribeGlobalFence();
    unsubscribeAuthorization();
  };
  socket.data.authorizationPendingEvents = pendingEvents;
  socket.data.authorizationChangeRelay = null;
  socket.data.authorizationUnsubscribe = cleanupAuthorization;
  socket.conn?.once?.('close', cleanupAuthorization);

  prisma.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      email: true,
      role: true,
      accountStatus: true,
      isActive: true,
      authorizationVersion: true,
    },
  } as any).then((user) => {
    if (!user || !canUseInteractivePortal(user.role, (user as any).accountStatus, user.isActive)) {
      cleanupAuthorization();
      return next(new Error('Account is not permitted for interactive access'));
    }
    const authorizationVersion = Number((user as any).authorizationVersion ?? 1);
    if ((payload.authorizationVersion ?? 1) !== authorizationVersion) {
      cleanupAuthorization();
      return next(new Error('Authorization changed; sign in again'));
    }
    // Subscription deliberately precedes the database lookup. A commit in the
    // query-to-subscribe gap would otherwise be lost and admit a stale socket.
    if (authorizationRevoked) {
      cleanupAuthorization();
      return next(new Error('Authorization changed during connection'));
    }
    socket.data.user = {
      userId: user.id,
      email: user.email,
      role: user.role,
      accountStatus: (user as any).accountStatus,
      authorizationVersion,
    };
    socket.once('disconnect', cleanupAuthorization);
    next();
  }).catch((err) => {
    cleanupAuthorization();
    next(err);
  });
};

// Namespace middleware runs in registration order, so this executes only
// after socketAuthMiddleware has reloaded the current user from the database.
// Server-wide alerts and OpenClaw status are operator telemetry and must match
// their elevated REST/UI boundary even when a client connects directly.
const socketElevatedRoleMiddleware = (socket: any, next: (err?: any) => void) => {
  if (!isElevatedRole(socket.data.user?.role)) {
    socket.data.authorizationUnsubscribe?.();
    next(new Error('Elevated role required'));
    return;
  }
  next();
};

// Metrics streaming namespace
const metricsNs = io.of('/metrics');
metricsNs.use(socketAuthMiddleware);
metricsNs.on('connection', (socket) => {
  console.log('Metrics client connected');
  socket.on('disconnect', () => console.log('Metrics client disconnected'));
});

// Every authenticated shell keeps this narrow channel open. Authorization
// changes are pushed to the exact target user so stale Files/Projects state can
// be quarantined before another interaction.
const authorizationNs = io.of('/authorization');
authorizationNs.use(socketAuthMiddleware);
authorizationNs.on('connection', (socket) => {
  const user = socket.data.user;
  const relay = (event: AuthorizationChangedEvent) => {
    socket.emit('authorization_changed', event);
  };
  socket.data.authorizationChangeRelay = relay;
  const pendingEvents = socket.data.authorizationPendingEvents as
    | AuthorizationChangedEvent[]
    | undefined;
  if (pendingEvents?.length) {
    const latest = pendingEvents.reduce((current, event) => (
      event.authorizationVersion > current.authorizationVersion ? event : current
    ));
    pendingEvents.length = 0;
    relay(latest);
    socket.disconnect(true);
    return;
  }
  socket.emit('authorization_snapshot', {
    authorizationVersion: user.authorizationVersion,
  });
});

// Alerts streaming namespace
const alertsNs = io.of('/alerts');
alertsNs.use(socketAuthMiddleware);
alertsNs.use(socketElevatedRoleMiddleware);
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
openclawNs.use(socketElevatedRoleMiddleware);
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
agentJobsNs.use(socketElevatedRoleMiddleware);
agentJobsNs.on('connection', async (socket) => {
  socket.on('subscribe', async (payload: unknown) => {
    const jobId = typeof (payload as { jobId?: unknown })?.jobId === 'string'
      ? (payload as { jobId: string }).jobId.trim()
      : '';
    if (!jobId || jobId.length > 128) return;
    try {
      const job = await prisma.agentJob.findUnique({
        where: { id: jobId },
        select: {
          userId: true,
          status: true,
          updatedAt: true,
          finishedAt: true,
          exitCode: true,
        },
      });
      if (!job) return;
      socket.join(`job:${jobId}`);
      socket.emit('status', {
        jobId,
        status: job.status,
        exitCode: job.exitCode,
        finishedAt: job.finishedAt?.toISOString() || null,
        updatedAt: job.updatedAt.toISOString(),
      });
      const transcript = await readTranscript(jobId, { maxEntries: 500, maxReadBytes: 512 * 1024 });
      socket.emit('snapshot', { jobId, transcript });
    } catch (error) {
      console.warn('[agent-jobs] subscribe failed', error);
    }
  });

  socket.on('disconnect', () => console.log('Agent jobs client disconnected'));
});

onAgentJobOutput(({ jobId, entry }) => {
  agentJobsNs.to(`job:${jobId}`).emit('output', { jobId, entry });
});

onAgentJobStatus((event) => {
  agentJobsNs.to(`job:${event.jobId}`).emit('status', event);
});

// Caddy/Cloudflare ingress reaches the Portal through loopback. Never trust a
// caller-selected first forwarding hop from an exposed interface.
app.set('trust proxy', 'loopback');

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
    // App API responses are already streamed with backpressure. Compression
    // would buffer unknown/SSE bodies before their upstream Content-Type is
    // available to this filter.
    if (/^\/(?:share|hosted)\/[^/]+\/api(?:\/|\?|$)/.test(String(req.originalUrl || req.url || ''))) {
      return false;
    }
    // Use default filter for everything else
    return compression.filter(req, res);
  },
}));

// The updater's transient candidate is never a second Portal. It exposes only
// exact health probes on a private loopback port; every other request fails
// before CORS, authentication, filesystem, database, proxy, or route
// middleware.
if (PORTAL_UPDATE_VALIDATION_MODE) {
  app.use((req, res, next) => {
    if (
      req.method === 'GET'
      && (req.path === '/health' || req.path === '/health/update-ready')
    ) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.status(503).json({
      status: 'unavailable',
      code: 'UPDATE_VALIDATION_HEALTH_ONLY',
    });
  });
}

// CORS
app.use(corsConfig);

// Proxy + auth imports
import { createProxyMiddleware } from 'http-proxy-middleware';
import { authenticateToken, browserAuthRedirect } from './middleware/auth';
import { requireAdmin } from './middleware/requireAdmin';
import { mountGlobalApiRateLimit } from './middleware/rateLimitPolicy';

// noVNC architecture (March 2026 fix):
// - Static files served directly by Express from vendored /static/novnc/ (version-pinned)
// - WebSocket proxy for /novnc/websockify → host websockify on port 6080
// - Websockify no longer serves static files (--web flag removed)
// - Docker novnc-bridge container removed (was racing for port 6080)
// The authenticated Portal bridge is deliberately local-only. External
// desktops use their own explicit iframe URL and must never receive Portal
// cookies through a configurable reverse-proxy target.
const novncWsTarget = 'http://127.0.0.1:6080';
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

// Remote Desktop Audio WebSocket proxy → audio proxy on a configurable localhost port
const audioWsPort = normalizeAudioProxyPort(process.env.RD_AUDIO_PORT);
const audioWsTarget = `http://127.0.0.1:${audioWsPort}`;
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

// Body parsing. Multipart proxy bodies are captured only inside the specific
// hosted/share route after its access check has passed.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Cookie-authenticated Portal mutations are same-origin only. App content may
// be hosted on a sibling domain, which is still "same-site" to cookies; Origin
// and Fetch Metadata therefore form the CSRF boundary.
app.use((req, res, next) => {
  if (rejectCookieAuthenticatedCrossOriginMutation(req)) {
    res.status(403).json({ error: 'Cross-origin Portal mutation rejected' });
    return;
  }
  next();
});

// The dedicated app-content host is deliberately not a second Portal host.
// It can serve only isolated hosted/share surfaces, never `/api`, login, the
// SPA, or other authenticated Portal routes.
app.use((req, res, next) => {
  if (!isAppContentRequest(req)) {
    next();
    return;
  }
  if (!(req.path === '/share' || req.path.startsWith('/share/')
    || req.path === '/hosted' || req.path.startsWith('/hosted/'))) {
    res.status(404).send('Not found');
    return;
  }
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  next();
});

// Admin-gated noVNC — portal JWT required and elevated role only
// WebSocket proxies must be registered BEFORE the static handler to avoid path conflicts
app.use('/novnc/websockify', authenticateToken, requireAdmin, novncWsProxy);
app.use('/novnc/audio', authenticateToken, requireAdmin, audioWsProxy);

// Serve noVNC static files directly (version-pinned, cache-busting headers)
app.use('/novnc', authenticateToken, requireAdmin, express.static(path.join(__dirname, '../../static/novnc'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(self), clipboard-write=(self), fullscreen=(self)');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

// Broad API abuse guard. Brute-force-sensitive auth mutations have their own
// endpoint-specific limiters in routes/auth.ts; do not throttle the entire
// /api/auth namespace because it also carries routine session reads/refreshes.
if (config.nodeEnv === 'production' && !PORTAL_UPDATE_VALIDATION_MODE) {
  mountGlobalApiRateLimit(app);
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

// Share routes (NO PORTAL AUTH) execute only on the isolated app-content
// origin. Requests to the Portal origin are method-preserving redirects; an
// absent/misconfigured isolation origin fails closed instead of serving active
// user content beside Portal credentials.
app.use('/share', (req, res, next) => {
  if (!appContentIsolationIsDistinct(config.corsOrigin)) {
    res.status(503).send('App content origin is not configured');
    return;
  }
  if (isAppContentRequest(req)) {
    next();
    return;
  }
  const redirectUrl = appContentRedirectUrl(req.originalUrl);
  if (!redirectUrl) {
    res.status(503).send('App content origin is unavailable');
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(307, redirectUrl);
}, shareRouter);

// Static assets (avatars, branding) — not dependent on Files DB
// Uses /static-assets to avoid collision with Vite's /assets build output
// Assets live at INSTALL_ROOT/assets (e.g. /opt/bridgesllm/assets), NOT inside the portal dir.
// In dev, PORTAL_ROOT is the repo root, so assets/ is alongside backend/.
const STATIC_ASSETS_ROOT = ASSETS_ROOT;
app.use('/static-assets', (req, res, next): void => {
  let requestPath: string;
  try {
    requestPath = decodeURIComponent(req.path);
  } catch {
    res.status(400).json({ error: 'Malformed asset path' });
    return;
  }

  if ((requestPath.startsWith('/avatars/') || requestPath.startsWith('/branding/'))
      && !isSafeMutableImageAssetPath(requestPath)) {
    res.status(404).json({ error: 'Asset not found' });
    return;
  }
  if (requestPath.startsWith('/avatars/') || requestPath.startsWith('/branding/')) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  }
  next();
});
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

type HostedAppRecord = {
  id: string;
  userId: string;
  name: string;
  zipPath: string;
  port: number | null;
  isActive: boolean;
  deployType: string;
  processStatus: string;
};

const hostedTicketReplayGuard = new HostedTicketReplayGuard();

async function findHostedAppForOwner(ownerId: string, deployId: string): Promise<HostedAppRecord | null> {
  const prefix = `${ownerId}-`;
  if (!deployId.startsWith(prefix)) return null;
  const appName = deployId.slice(prefix.length);
  if (!appName || appName.length > 255 || appName.includes('/') || appName.includes('\\') || appName.includes('\0')) {
    return null;
  }
  return prisma.app.findFirst({
    where: { userId: ownerId, name: appName, isActive: true },
    select: {
      id: true,
      userId: true,
      name: true,
      zipPath: true,
      port: true,
      isActive: true,
      deployType: true,
      processStatus: true,
    },
  });
}

async function findHostedAppForAuthorizedCapability(
  capability: NonNullable<ReturnType<typeof verifyHostedAccessToken>>,
  deployId: string,
): Promise<HostedAppRecord | null> {
  const actor = await prisma.user.findUnique({
    where: { id: capability.actorUserId },
    select: {
      id: true,
      email: true,
      role: true,
      accountStatus: true,
      isActive: true,
      sandboxEnabled: true,
      authorizationVersion: true,
    },
  } as any);
  if (!actor
    || !canAccessPortal((actor as any).accountStatus, actor.isActive)
    || Number((actor as any).authorizationVersion ?? 1) !== capability.authorizationVersion) {
    return null;
  }
  const currentOwnerId = await getWorkspaceOwnerId({
    userId: actor.id,
    email: actor.email,
    role: actor.role,
    accountStatus: (actor as any).accountStatus,
    sandboxEnabled: actor.sandboxEnabled,
    authorizationVersion: Number((actor as any).authorizationVersion ?? 1),
  });
  if (currentOwnerId !== capability.userId) return null;
  return findHostedAppForOwner(currentOwnerId, deployId);
}

/**
 * Bridge authenticated Portal navigation to a narrowly scoped cookie on the
 * isolated app-content origin. The app cookie authorizes exactly one deployId
 * and cannot authenticate any Portal API.
 */
async function requireHostedAppAccess(req: any, res: any, next: any): Promise<void> {
  if (!appContentIsolationIsDistinct(config.corsOrigin)) {
    res.status(503).send('App content origin is not configured');
    return;
  }

  const deployId = typeof req.params?.deployId === 'string' ? req.params.deployId : '';
  if (!deployId || deployId.length > 512 || deployId.includes('/') || deployId.includes('\\') || deployId.includes('\0')) {
    res.status(404).send('App not found');
    return;
  }

  const appOrigin = configuredAppContentOrigin();
  if (!appOrigin) {
    res.status(503).send('App content origin is unavailable');
    return;
  }

  if (isAppContentRequest(req)) {
    // Browsers duplicate top-level GETs (prefetch, prerender, back/forward
    // restores), so ticket problems on a navigable request must recover by
    // re-entering through the Portal — never dead-end on an error page the
    // user cannot act on. A fresh ticket costs nothing; a stranded user
    // costs the feature.
    const bounceToPortal = (): boolean => {
      const portalOrigin = configuredPortalOrigin();
      if (!portalOrigin || !['GET', 'HEAD'].includes(req.method.toUpperCase())) return false;
      // Only real page navigations recover via the Portal. An app's fetch()
      // to its own API must see a clean 401, not a cross-origin redirect.
      const secFetchMode = String(req.get('sec-fetch-mode') || '').toLowerCase();
      const accepts = String(req.get('accept') || '');
      const isNavigation = secFetchMode
        ? secFetchMode === 'navigate'
        : accepts.includes('text/html');
      if (!isNavigation) return false;
      const clean = new URL(req.originalUrl, `${portalOrigin}/`);
      clean.searchParams.delete('__portal_ticket');
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, `${portalOrigin}${clean.pathname}${clean.search}`);
      return true;
    };
    const ticket = req.query?.__portal_ticket;
    if (ticket !== undefined) {
      const verifiedTicket = verifyHostedAccessToken(
        ticket,
        { kind: 'ticket', deployId },
        config.jwtSecret,
      );
      if (!verifiedTicket) {
        if (bounceToPortal()) return;
        res.status(403).send('Invalid or expired app access ticket');
        return;
      }
      if (!admitWorkspaceAuthorizationRead(req, res, verifiedTicket.actorUserId)) return;
      if (!(await findHostedAppForAuthorizedCapability(verifiedTicket, deployId))) {
        if (bounceToPortal()) return;
        res.status(403).send('Hosted app authorization changed');
        return;
      }
      if (!hostedTicketReplayGuard.consume(String(ticket), verifiedTicket.expiresAt)) {
        // A duplicate of a just-redeemed ticket usually races the request
        // that set the session cookie; if that cookie is already valid,
        // this request simply proceeds to the clean URL.
        const racedSession = verifyHostedAccessToken(
          req.cookies?.[hostedAccessCookieName(deployId)],
          { kind: 'session', deployId },
          config.jwtSecret,
        );
        if (racedSession
          && racedSession.actorUserId === verifiedTicket.actorUserId
          && racedSession.authorizationVersion === verifiedTicket.authorizationVersion
          && racedSession.userId === verifiedTicket.userId
          && await findHostedAppForAuthorizedCapability(racedSession, deployId)) {
          const cleanUrl = new URL(req.originalUrl, `${appOrigin}/`);
          cleanUrl.searchParams.delete('__portal_ticket');
          res.setHeader('Cache-Control', 'no-store');
          res.redirect(303, cleanUrl.toString());
          return;
        }
        if (bounceToPortal()) return;
        res.status(403).send('App access ticket has already been used');
        return;
      }
      const expiresAt = Date.now() + 60 * 60 * 1000;
      if (settleWorkspaceAuthorizationRequestIfResponseEnded(req, res)) return;
      const session = issueHostedAccessToken({
        kind: 'session',
        deployId,
        userId: verifiedTicket.userId,
        actorUserId: verifiedTicket.actorUserId,
        authorizationVersion: verifiedTicket.authorizationVersion,
        expiresAt,
      }, config.jwtSecret);
      res.cookie(hostedAccessCookieName(deployId), session, {
        httpOnly: true,
        secure: appOrigin.startsWith('https://'),
        // Strict cookies are withheld on the cross-site navigation chain that
        // delivers users from the Portal to the app origin — the session
        // never became visible and every visit dead-ended. Lax still keeps
        // the cookie off cross-site POSTs and subresource requests.
        sameSite: 'lax',
        maxAge: 60 * 60 * 1000,
        path: `/hosted/${deployId}`,
      });
      const cleanUrl = new URL(req.originalUrl, `${appOrigin}/`);
      cleanUrl.searchParams.delete('__portal_ticket');
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(303, cleanUrl.toString());
      return;
    }

    const verifiedSession = verifyHostedAccessToken(
      req.cookies?.[hostedAccessCookieName(deployId)],
      { kind: 'session', deployId },
      config.jwtSecret,
    );
    if (!verifiedSession) {
      // Direct visits to the app origin (bookmarks, the stored deployed URL)
      // carry no ticket. Bounce browsers through the authenticated Portal,
      // which mints a one-time ticket and returns here — instead of a dead
      // "access required" page.
      const portalOrigin = configuredPortalOrigin();
      if (portalOrigin && ['GET', 'HEAD'].includes(req.method.toUpperCase())) {
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, `${portalOrigin}${req.originalUrl}`);
        return;
      }
      res.status(401).send('Hosted app access required');
      return;
    }
    // A hosted app controls its own handlers; even GET routes can converge or
    // mutate app state. Keep the actor fence until proxy/static settlement.
    const admitted = admitWorkspaceAuthorizationMutation(
      req,
      res,
      verifiedSession.actorUserId,
    );
    if (!admitted) return;
    const appRecord = await findHostedAppForAuthorizedCapability(verifiedSession, deployId);
    if (!appRecord) {
      res.status(404).send('App not found');
      return;
    }
    if (settleWorkspaceAuthorizationRequestIfResponseEnded(req, res)) return;
    req.hostedApp = appRecord;
    next();
    return;
  }

  if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
    res.status(421).send('Open the hosted app URL before using its API');
    return;
  }

  await browserAuthRedirect(req, res, async () => {
    try {
      if (!admitWorkspaceAuthorizationRead(req, res, req.user!.userId)) return;
      const ownerId = await getWorkspaceOwnerId(req.user);
      const appRecord = await findHostedAppForOwner(ownerId, deployId);
      if (!appRecord) {
        res.status(404).send('App not found');
        return;
      }
      if (settleWorkspaceAuthorizationRequestIfResponseEnded(req, res)) return;
      const ticket = issueHostedAccessToken({
        kind: 'ticket',
        deployId,
        userId: ownerId,
        actorUserId: req.user!.userId,
        authorizationVersion: Number(req.user!.authorizationVersion ?? 1),
        expiresAt: Date.now() + 60 * 1000,
      }, config.jwtSecret);
      const redirectUrl = new URL(req.originalUrl, `${appOrigin}/`);
      redirectUrl.searchParams.set('__portal_ticket', ticket);
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(307, redirectUrl.toString());
    } catch (error) {
      next(error);
    }
  });
}

// Hosted apps — API proxy: route /hosted/:deployId/api/* to the app-bound
// backend after isolated-origin capability validation.
app.use('/hosted/:deployId/api/*', requireHostedAppAccess, async (req: any, res: any) => {
  if (!(await captureBoundedMultipartBody(req, res))) {
    settleWorkspaceAuthorizationRequest(req);
    return;
  }

  const proxiedPath = req.params[0] || '';
  const qsIndex = req.originalUrl.indexOf('?');
  const query = qsIndex >= 0 ? req.originalUrl.slice(qsIndex) : '';
  const hostedApp = req.hostedApp as HostedAppRecord;
  const deployId = String(req.params.deployId || '');
  const registeredTarget = getAppTarget(deployId);
  const baseTarget = configuredAppApiTarget(hostedApp.id)
    || registeredTarget
    || undefined;
  const targetUrl = baseTarget ? buildAppApiTargetUrl(baseTarget, proxiedPath, query) : undefined;
  if (!targetUrl) {
    res.status(502).json({ error: 'App API backend is not configured' });
    return;
  }

  const method = req.method.toUpperCase();
  const shouldSendBody = !['GET', 'HEAD'].includes(method);
  const incomingHeaders = req.headers as Record<string, any>;
  const upstreamHeaderAllowlist = new Set([
    'accept',
    'accept-language',
    'authorization',
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
  headers['x-portal-proxy'] = 'hosted-app-api';
  headers[APP_API_ID_HEADER] = hostedApp.id;
  headers['x-portal-app-owner'] = hostedApp.userId;
  addConfiguredAppApiSecret(headers, hostedApp.id);

  const abortContext = createAppApiAbortContext(req, res);
  try {
    // For multipart/form-data uploads, use the raw body buffer captured before
    // express.json() consumed the stream. For JSON, serialize as before.
    let body: any = undefined;
    if (shouldSendBody) {
      const incomingCt = String(req.headers['content-type'] || '');
      body = serializeAppApiRequestBody(incomingCt, req.body, req.rawBody);
    }

    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: abortContext.signal,
    });
    await streamAppApiResponse(upstream, res, { locationBasePath: `/hosted/${deployId}` });
  } catch (err: any) {
    console.error('[Hosted API Proxy] Error:', err.message);
    if (!res.headersSent) {
      res.status(abortContext.didTimeout() ? 504 : 502).json({ error: abortContext.didTimeout() ? 'Backend timeout' : 'Backend unavailable' });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    abortContext.cleanup();
    settleWorkspaceAuthorizationRequest(req);
  }
});

// Serve hosted app processes/static trees only after scoped access has been
// established on the isolated origin.
app.use('/hosted/:deployId', requireHostedAppAccess, async (req: any, res: any, next: any) => {
  const deployId = String(req.params.deployId || '');
  const hostedApp = req.hostedApp as HostedAppRecord;

  // A running full-stack app owns non-/api paths. Timeouts prevent a wedged
  // app from holding Portal sockets indefinitely.
  const appTarget = getAppTarget(deployId);
  if (appTarget) {
    const proxy = createProxyMiddleware({
      target: appTarget,
      changeOrigin: true,
      logger: console,
      timeout: 65_000,
      proxyTimeout: 60_000,
      on: {
        proxyReq: (proxyReq: any) => {
          const cookieName = hostedAccessCookieName(deployId);
          const portalCookieNames = new Set([cookieName, 'accessToken', 'refreshToken']);
          const filteredCookie = String(req.headers.cookie || '')
            .split(';')
            .map((value) => value.trim())
            .filter((value) => {
              if (!value) return false;
              const separator = value.indexOf('=');
              const name = separator >= 0 ? value.slice(0, separator).trim() : value;
              return !portalCookieNames.has(name) && !name.startsWith('share_password_') && !name.startsWith('share_visit_');
            })
            .join('; ');
          if (filteredCookie) proxyReq.setHeader('cookie', filteredCookie);
          else proxyReq.removeHeader('cookie');
          proxyReq.once('error', () => settleWorkspaceAuthorizationRequest(req));
        },
        proxyRes: (proxyRes: any) => {
          const settle = () => settleWorkspaceAuthorizationRequest(req);
          proxyRes.once('end', settle);
          proxyRes.once('close', settle);
        },
        error: () => settleWorkspaceAuthorizationRequest(req),
      },
    } as any);
    try {
      proxy(req, res, next);
    } catch (error) {
      settleWorkspaceAuthorizationRequest(req);
      next(error);
    }
    return;
  }

  if (hostedApp.deployType === 'fullstack') {
    res.status(503).send('Hosted app process is not running');
    return;
  }
  if (hostedApp.deployType !== 'static') {
    res.status(404).send('App is not web-hosted');
    return;
  }

  let decodedPath: string;
  try {
    decodedPath = String(req.url || '/').split('?')[0]
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    res.status(400).send('Invalid path');
    return;
  }
  const filePath = decodedPath || 'index.html';
  if (isBlockedAppStaticPath(filePath)) {
    res.status(404).send('Not found');
    return;
  }

  const expectedAppDir = path.resolve(path.join(HOSTED_APPS_DIR, deployId));
  if (path.resolve(hostedApp.zipPath) !== expectedAppDir) {
    res.status(409).send('Hosted app storage binding is inconsistent');
    return;
  }
  const appDir = resolveExistingAppDirectory(hostedApp.zipPath, [HOSTED_APPS_DIR]);
  if (!appDir) {
    res.status(404).send('App not found');
    return;
  }

  const distDir = resolveExistingPathWithin(appDir, path.join(appDir, 'dist'));
  const distIndex = distDir ? resolveExistingPathWithin(distDir, path.join(distDir, 'index.html')) : null;
  const contentRoot = distDir && distIndex && fs.statSync(distIndex).isFile() ? distDir : appDir;
  const lexicalPath = path.resolve(path.join(contentRoot, filePath));
  if (!isPathWithin(contentRoot, lexicalPath)) {
    res.status(403).send('Forbidden');
    return;
  }

  const resolvedPath = resolveExistingPathWithin(contentRoot, lexicalPath);
  if (resolvedPath && fs.statSync(resolvedPath).isFile()) {
    if (resolvedPath.toLowerCase().endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    res.sendFile(resolvedPath, (error: Error | undefined) => {
      settleWorkspaceAuthorizationRequest(req);
      if (error && !res.headersSent) next(error);
    });
    return;
  }

  // SPA fallback is for route-like paths only. Missing assets must stay 404 so
  // browsers never cache HTML as JavaScript or CSS.
  if (!path.extname(filePath)) {
    const indexPath = resolveExistingPathWithin(contentRoot, path.join(contentRoot, 'index.html'));
    if (indexPath && fs.statSync(indexPath).isFile()) {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(indexPath, (error: Error | undefined) => {
        settleWorkspaceAuthorizationRequest(req);
        if (error && !res.headersSent) next(error);
      });
      return;
    }
  }
  res.status(404).send('Not found');
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

type ExpectedPortalMigration = {
  name: string;
  checksum: string;
};

type AppliedPortalMigration = {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
};

type UpdateValidationDatabaseReadiness = {
  migrationCount: number;
  migrationHead: string;
};

const MAX_UPDATE_VALIDATION_MIGRATIONS = 512;
const MAX_UPDATE_VALIDATION_MIGRATION_BYTES = 4 * 1024 * 1024;
const MAX_UPDATE_VALIDATION_TOTAL_MIGRATION_BYTES = 32 * 1024 * 1024;
const PORTAL_MIGRATION_NAME_PATTERN = /^(?:0000|[0-9]{8,14})_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
let expectedPortalMigrations: ExpectedPortalMigration[] | null = null;

function loadExpectedPortalMigrations(): ExpectedPortalMigration[] {
  if (expectedPortalMigrations) return expectedPortalMigrations;
  const migrationsRoot = path.resolve(__dirname, '../prisma/migrations');
  const rootStat = fs.lstatSync(migrationsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Bundled Prisma migration root is unavailable');
  }
  const migrationDirectories: string[] = [];
  for (const entry of fs.readdirSync(migrationsRoot, { withFileTypes: true })) {
    if (entry.name === 'migration_lock.toml' && entry.isFile()) continue;
    if (!entry.isDirectory() || !PORTAL_MIGRATION_NAME_PATTERN.test(entry.name)) {
      throw new Error('Bundled Prisma migration inventory is invalid');
    }
    migrationDirectories.push(entry.name);
  }
  migrationDirectories.sort();
  if (
    migrationDirectories.length === 0
    || migrationDirectories.length > MAX_UPDATE_VALIDATION_MIGRATIONS
  ) {
    throw new Error('Bundled Prisma migration inventory is invalid');
  }

  let totalMigrationBytes = 0;
  const migrations = migrationDirectories.map((name) => {
    const migrationPath = path.join(migrationsRoot, name, 'migration.sql');
    const stat = fs.lstatSync(migrationPath);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.size <= 0
      || stat.size > MAX_UPDATE_VALIDATION_MIGRATION_BYTES
    ) {
      throw new Error('Bundled Prisma migration payload is invalid');
    }
    totalMigrationBytes += stat.size;
    if (totalMigrationBytes > MAX_UPDATE_VALIDATION_TOTAL_MIGRATION_BYTES) {
      throw new Error('Bundled Prisma migration inventory is too large');
    }
    const checksum = createHash('sha256').update(fs.readFileSync(migrationPath)).digest('hex');
    return { name, checksum };
  });
  expectedPortalMigrations = migrations;
  return migrations;
}

export async function verifyUpdateValidationDatabaseReadiness(): Promise<UpdateValidationDatabaseReadiness> {
  const expectedMigrations = loadExpectedPortalMigrations();
  const migrationHistory = await prisma.$queryRaw<AppliedPortalMigration[]>`
    SELECT "migration_name", "checksum", "finished_at", "rolled_back_at"
    FROM "_prisma_migrations"
    ORDER BY "started_at" ASC, "id" ASC
  `;
  if (!Array.isArray(migrationHistory)) {
    throw new Error('Database migration history is unavailable');
  }
  const appliedMigrations: AppliedPortalMigration[] = [];
  for (const migration of migrationHistory) {
    if (
      !migration
      || !PORTAL_MIGRATION_NAME_PATTERN.test(migration.migration_name)
      || !/^[a-f0-9]{64}$/.test(migration.checksum)
    ) {
      throw new Error('Database migration history is malformed');
    }
    if (migration.rolled_back_at !== null) {
      if (!(migration.rolled_back_at instanceof Date) || !Number.isFinite(migration.rolled_back_at.getTime())) {
        throw new Error('Database migration history is malformed');
      }
      continue;
    }
    if (!(migration.finished_at instanceof Date) || !Number.isFinite(migration.finished_at.getTime())) {
      throw new Error('Database contains an unfinished migration');
    }
    appliedMigrations.push(migration);
  }
  if (appliedMigrations.length !== expectedMigrations.length) {
    throw new Error('Database migration inventory does not match the bundled Portal runtime');
  }
  const appliedNames = new Set<string>();
  for (let index = 0; index < appliedMigrations.length; index += 1) {
    const migration = appliedMigrations[index];
    const expected = expectedMigrations[index];
    if (
      !migration
      || !PORTAL_MIGRATION_NAME_PATTERN.test(migration.migration_name)
      || !/^[a-f0-9]{64}$/.test(migration.checksum)
      || appliedNames.has(migration.migration_name)
    ) {
      throw new Error('Database migration history is malformed');
    }
    appliedNames.add(migration.migration_name);
    if (
      migration.migration_name !== expected.name
      || migration.checksum !== expected.checksum
    ) {
      throw new Error('Database migration history does not match the bundled Portal runtime');
    }
  }

  // Migration history can be manually falsified or drift after application.
  // Resolve representative 4.0 tables and columns without reading any rows so
  // a forged/stale history cannot pass candidate validation.
  await prisma.$queryRaw`
    SELECT
      users."authorizationVersion",
      mailbox."leaseId",
      ollama."purposeId",
      nativeOllama."grantTemplateHash",
      projects."legacyOpenClawMigrationStatus",
      turns."leaseTokenHash"
    FROM "User" AS users
    CROSS JOIN "MailboxReconciliationTask" AS mailbox
    CROSS JOIN "OllamaBackendBinding" AS ollama
    CROSS JOIN "NativeOllamaBackendBinding" AS nativeOllama
    CROSS JOIN "ProjectIdentity" AS projects
    CROSS JOIN "ProjectChatTurn" AS turns
    LIMIT 0
  `;

  return {
    migrationCount: expectedMigrations.length,
    migrationHead: expectedMigrations[expectedMigrations.length - 1].name,
  };
}

// Health check
app.get('/health', async (_req, res) => {
  if (PORTAL_UPDATE_VALIDATION_MODE) {
    try {
      const databaseReadiness = await verifyUpdateValidationDatabaseReadiness();
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.json({
        status: 'ok',
        version: PORTAL_VERSION,
        database: 'ready',
        updateValidation: true,
        updateValidationContract: PORTAL_UPDATE_VALIDATION_CONTRACT,
        ...databaseReadiness,
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.status(503).json({
        status: 'unavailable',
        version: PORTAL_VERSION,
        database: 'unavailable',
        updateValidation: true,
        updateValidationContract: PORTAL_UPDATE_VALIDATION_CONTRACT,
      });
    }
    return;
  }
  const mailboxReconciliation = await getMailboxReconciliationReadiness();
  res.json({
    status: mailboxReconciliation.ready ? 'ok' : 'degraded',
    version: PORTAL_VERSION,
    timestamp: new Date().toISOString(),
    mailboxReconciliation,
  });
});

app.get('/health/update-ready', async (req, res) => {
  if (PORTAL_UPDATE_VALIDATION_MODE) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  }
  const supplied = req.get('x-portal-update-probe') || '';
  const expected = config.updateProbeToken;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (!expected || suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    return res.status(401).json({ status: 'unauthorized' });
  }
  try {
    if (PORTAL_UPDATE_VALIDATION_MODE) {
      const databaseReadiness = await verifyUpdateValidationDatabaseReadiness();
      return res.json({
        status: 'ready',
        version: PORTAL_VERSION,
        database: 'ready',
        updateValidation: true,
        updateValidationContract: PORTAL_UPDATE_VALIDATION_CONTRACT,
        ...databaseReadiness,
      });
    }
    await prisma.$queryRaw`SELECT 1`;
    const mailboxReconciliation = await getMailboxReconciliationReadiness();
    if (!mailboxReconciliation.ready) {
      return res.status(503).json({
        status: 'degraded',
        version: PORTAL_VERSION,
        database: 'ready',
        updateValidation: false,
        updateValidationContract: PORTAL_UPDATE_VALIDATION_CONTRACT,
        mailboxReconciliation,
      });
    }
    return res.json({
      status: 'ready',
      version: PORTAL_VERSION,
      database: 'ready',
      updateValidation: false,
      updateValidationContract: PORTAL_UPDATE_VALIDATION_CONTRACT,
      mailboxReconciliation,
    });
  } catch {
    return res.status(503).json({
      status: 'unavailable',
      version: PORTAL_VERSION,
      database: 'unavailable',
      updateValidation: false,
      updateValidationContract: PORTAL_UPDATE_VALIDATION_CONTRACT,
    });
  }
});

// API Routes

app.use('/api/setup/ai', requireSetupPending, requireSetupToken, createAiSetupRouter());
app.use('/api/setup', setupRoutes);
app.use('/api', requireSetupComplete);
app.use('/api/auth', authRoutes);
app.use('/api/ai-setup', authenticateToken, requireAdmin, createAiSetupRouter());
app.use('/api/files', fileRoutes);
if (metricsModule) app.use('/api/metrics', metricsModule.default);
app.use('/api/apps', appsRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/upload', chunkedUploadRoutes);
import { projectPathSandbox, aiPathSandbox } from './middleware/pathSandbox';
app.use('/api/projects', projectPathSandbox, projectsRoutes);
app.use('/api/ai', aiPathSandbox, aiRoutes);
app.use('/api/terminal', terminalRoutes);
// Legacy Guacamole API routes removed — noVNC/Xtigervnc is the active remote desktop stack.
// the plugin-facing half of the ask-question channel authenticates
// with the gateway token, so it must be mounted ahead of the gateway router,
// which requires a signed-in user for everything it owns.
app.use('/api/gateway/ask-user', askUserPluginRoutes);
app.use('/api/gateway', gatewayRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/system/stats', systemStatsRoutes);
app.use('/api/system/maintenance', systemMaintenanceRoutes);
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
    // IMPORTANT: refresh the source HTML/cache state BEFORE computing the
    // request cache key. Otherwise a deploy can leave htmlByRequestUrl keyed
    // against the previous index.html mtime, which makes deep links keep
    // serving stale hashed bundle references until some other uncached route
    // happens to refresh the source snapshot.
    const sourceHtml = getSpaSourceHtml();

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
let legacyOpenClawMigrationRetryTimer: NodeJS.Timeout | null = null;
let legacyOpenClawMigrationCoordinatorStopped = false;
let legacyOpenClawMigrationCoordinatorRunning = false;
let legacyOpenClawMigrationFailureCount = 0;
let claimedLegacyOpenClawMigrationCoordinator: Awaited<ReturnType<
  typeof beginLegacyOpenClawProjectMigration
>> = null;

function scheduleLegacyOpenClawProjectMigration(delayMs: number): void {
  if (legacyOpenClawMigrationCoordinatorStopped) return;
  if (legacyOpenClawMigrationRetryTimer) clearTimeout(legacyOpenClawMigrationRetryTimer);
  legacyOpenClawMigrationRetryTimer = setTimeout(() => {
    legacyOpenClawMigrationRetryTimer = null;
    void runLegacyOpenClawProjectMigrationCoordinator();
  }, Math.max(1_000, Math.min(60_000, delayMs)));
  legacyOpenClawMigrationRetryTimer.unref();
}

async function runLegacyOpenClawProjectMigrationCoordinator(): Promise<void> {
  if (legacyOpenClawMigrationCoordinatorStopped || legacyOpenClawMigrationCoordinatorRunning) return;
  legacyOpenClawMigrationCoordinatorRunning = true;
  try {
    const coordinator = claimedLegacyOpenClawMigrationCoordinator
      || await beginLegacyOpenClawProjectMigration();
    claimedLegacyOpenClawMigrationCoordinator = null;
    if (!coordinator) {
      scheduleLegacyOpenClawProjectMigration(await legacyOpenClawProjectMigrationRetryDelayMs());
      return;
    }
    coordinator.start();
    await coordinator.completion;
    legacyOpenClawMigrationFailureCount = 0;
  } catch (error) {
    const shouldRetry = shouldRetryLegacyOpenClawProjectMigration(error);
    legacyOpenClawMigrationFailureCount = shouldRetry
      ? legacyOpenClawMigrationFailureCount + 1
      : 0;
    const code = error instanceof LegacyOpenClawProjectRetirementError
      ? error.code
      : 'UNAVAILABLE';
    console.warn(
      `[legacy-project-retirement] pending (${code}); source transcripts were preserved`
        + (shouldRetry
          ? ' and retry remains idempotent'
          : '; automatic retry is disabled until the next Portal start'),
    );
    if (!shouldRetry) return;
    const backoffMs = Math.min(60_000, 2_000 * (2 ** Math.min(5, legacyOpenClawMigrationFailureCount - 1)));
    scheduleLegacyOpenClawProjectMigration(Math.max(
      backoffMs,
      await legacyOpenClawProjectMigrationRetryDelayMs().catch(() => backoffMs),
    ));
  } finally {
    legacyOpenClawMigrationCoordinatorRunning = false;
  }
}

// Graceful shutdown
const shutdownHandler = async (signal: string) => {
  console.log(`\n${signal} received, shutting down gracefully...`);
  if (PORTAL_UPDATE_VALIDATION_MODE) {
    try {
      await stopStartupStatusServer();
      io.close();
      await prisma.$disconnect();
      console.log('Update-validation database connection closed');
      return process.exit(0);
    } catch (error) {
      console.error('Error during update-validation shutdown:', error);
      return process.exit(1);
    }
  }

  legacyOpenClawMigrationCoordinatorStopped = true;
  if (legacyOpenClawMigrationRetryTimer) clearTimeout(legacyOpenClawMigrationRetryTimer);
  legacyOpenClawMigrationRetryTimer = null;
  clearInterval(metricsInterval);
  stopLogWatcher();
  stopStatusWatcher();
  shutdownCronJobs();
  shutdownChunkedUploadRuntime();
  stopTelemetryService();
  stopAudioProxy();
  try {
    ollamaPullManager.cancelAll();
    setupLocalOllamaPullManager.cancelAll();
    await shutdownProjectChatRestartRecoveryRuntime();
    shutdownPersistentGatewayWs();
    await shutdownMailboxReconciliationRuntime();
    await shutdownTerminalSystemdScopeRuntime();
    await shutdownAgentJobsRuntime();
    await shutdownHostAgentRunRuntime();
    await shutdownAppProcesses();
    await stopDefaultAgentZeroHostGateway();
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

export function isUpdateValidationLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1';
}

async function listenForUpdateValidation(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.removeListener('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(config.port, config.host);
  });
  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : config.port;
  console.log(`\n🔎 Portal update-validation runtime on http://${config.host}:${boundPort}`);
  console.log(`📊 Health check: http://${config.host}:${boundPort}/health`);
}

// Start server
export const startServer = async () => {
  try {
    if (PORTAL_UPDATE_VALIDATION_MODE && !isUpdateValidationLoopbackHost(config.host)) {
      throw new Error('PORTAL_UPDATE_VALIDATION_MODE requires HOST=127.0.0.1 or HOST=::1');
    }

    // Bind the portal port with a fail-closed status-only listener before the
    // long blocking startup phases below, so the updater's health probe can
    // distinguish an in-progress migration from a dead service.
    await startStartupStatusServer(config.port, config.host);

    if (PORTAL_UPDATE_VALIDATION_MODE) {
      setStartupPhase('database-connection');
      const databaseReadiness = await verifyUpdateValidationDatabaseReadiness();
      console.log(
        `✅ Update-validation database ready (${databaseReadiness.migrationCount} migrations;`
          + ` head ${databaseReadiness.migrationHead})`,
      );
      setStartupPhase('finalizing');
      await stopStartupStatusServer();
      await listenForUpdateValidation();
      return;
    }

    setStartupPhase('storage-initialization');
    // Create and validate mutable runtime roots explicitly at server boot
    // before accepting work. The corresponding module imports stay read-only.
    initializeAppsStorage();
    initializeProjectStorage();
    initializeFileStorage();
    initializeImageAssetStorage();
    initializeAgentJobsStorage();
    initializeHostAgentRunStorage();
    initializeChunkedUploadRuntime();
    ensureRuntimeDirectory(HOSTED_APPS_DIR, { mode: 0o755 });

    setStartupPhase('database-connection');
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ Database connection successful');

    const terminalScopeRecovery = await initializeTerminalSystemdScopeRuntime();
    if (terminalScopeRecovery.recovered > 0) {
      console.warn(
        `[Terminal Scope] Recovered ${terminalScopeRecovery.recovered}`
          + ' orphaned privileged terminal scope(s)',
      );
    }
    const authorizationRecovery = await initializeProjectAuthorizationTransitionRuntime();
    if (authorizationRecovery.recovered) {
      console.warn(
        '[Authorization Transition] Recovered interrupted transition:',
        authorizationRecovery.transitionId,
      );
    }
    const openClawHostRunRecovery = await initializeOpenClawHostRunJournal();
    if (openClawHostRunRecovery.unresolved > 0) {
      console.warn(
        `[OpenClaw Host Run] Preserving ${openClawHostRunRecovery.unresolved}`
          + ' unresolved provider-authority row(s) for a future authorization transition',
      );
    }

    const projectCreationRecovery = await recoverInterruptedCurrentProjectCreations();
    if (
      projectCreationRecovery.finalized > 0
      || projectCreationRecovery.discarded > 0
      || projectCreationRecovery.orphanStagingDirectories > 0
      || projectCreationRecovery.preservedOrphanStagingDirectories > 0
    ) {
      console.warn('[Project Creation] Recovered interrupted staging state:', projectCreationRecovery);
    }

    // Enroll exact pre-4.0 Project inodes as legacy (NONE) and restore only
    // attested Project↔App foreign keys before either the legacy evidence gate
    // or the running-App reconciler can observe them. This never promotes an
    // old root to CURRENT; Project Chat remains fail-closed until its preserved
    // 3.x evidence is separately reconciled.
    setStartupPhase('legacy-project-continuity');
    const projectContinuity = await initializeLegacyProjectContinuityAdoption();
    if (
      projectContinuity.identitiesEnrolled > 0
      || projectContinuity.appsBackfilled > 0
      || projectContinuity.preservedUnownedDirectories > 0
    ) {
      console.warn('[Project Continuity] Reconciled pre-4.0 filesystem/App ownership:', projectContinuity);
    }

    // Persist the global DISCOVERING gate before the real listener can accept a
    // cached Portal 3.x mutation. The bounded Gateway work itself starts later,
    // after the persistent Gateway client and listener are established.
    claimedLegacyOpenClawMigrationCoordinator = await beginLegacyOpenClawProjectMigration();

    setStartupPhase('secret-encryption');
    await encryptStoredSecretsAtBoot();
    setStartupPhase('runtime-initialization');
    await initializeMailboxReconciliationRuntime();
    await initializeAgentJobsRuntime();
    await initializeHostAgentRunRuntime();
    await initializeAppProcessRuntime();

    try {
      await initializeBackupConfiguration();
    } catch (error) {
      console.error('[Backups] Backup storage configuration is invalid; scheduled backups will remain fail-closed:', error);
    }

    // Load blocked IPs from database
    await loadBlockedIPs();

    // Start metrics collection unless explicitly disabled for CPU containment.
    if (process.env.PORTAL_DISABLE_METRICS_COLLECTION === '1') {
      console.warn('⚠️ Metrics collection disabled by PORTAL_DISABLE_METRICS_COLLECTION=1');
    } else {
      metricsInterval = setInterval(async () => {
        const m = await metricsModule!.collectMetrics();
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
      metricsModule!.collectMetrics();
    }

    if (process.env.PORTAL_DISABLE_OPENCLAW_BACKGROUND === '1') {
      console.warn('⚠️ OpenClaw background watchers disabled by PORTAL_DISABLE_OPENCLAW_BACKGROUND=1');
    } else {
      // Start OpenClaw log watcher for system alerts
      startLogWatcher();

      // Start OpenClaw agent status watcher
      startStatusWatcher();

      // Initialize persistent WebSocket connection to OpenClaw gateway for exec approvals
      initPersistentGatewayWs();
    }

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
      if (isExactWebSocketPath(req.url, '/novnc/websockify')) {
        const origin = req.headers.origin;
        if (!isAllowedWebSocketOrigin(origin, req.headers.host)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        // Verify JWT from accessToken cookie before allowing WebSocket upgrade
        const cookies = parseSafeCookieHeader(req.headers.cookie);
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
        let authorizationRevoked = false;
        let unsubscribed = false;
        const revokeInteractiveAuthority = () => {
          authorizationRevoked = true;
          socket.destroy();
        };
        let unsubscribeGlobalFence = () => {};
        let unsubscribeAuthorization = () => {};
        unsubscribeGlobalFence = subscribeToGlobalWorkspaceAuthorizationFence(
          revokeInteractiveAuthority,
        );
        if (authorizationRevoked || socket.destroyed) {
          unsubscribeGlobalFence();
          socket.destroy();
          return;
        }
        unsubscribeAuthorization = subscribeToAuthorizationChanges(payload.userId, revokeInteractiveAuthority);
        const cleanupAuthorization = () => {
          if (unsubscribed) return;
          unsubscribed = true;
          socket.removeListener('close', cleanupAuthorization);
          unsubscribeGlobalFence();
          unsubscribeAuthorization();
        };
        socket.once('close', cleanupAuthorization);
        prisma.user.findUnique({
          where: { id: payload.userId },
          select: {
            id: true,
            role: true,
            accountStatus: true,
            isActive: true,
            authorizationVersion: true,
          },
        } as any).then((user) => {
          if (authorizationRevoked
            || socket.destroyed
            || !user
            || !canAccessPortal((user as any).accountStatus, user.isActive)
            || !isElevatedRole(user.role)
            || (payload.authorizationVersion ?? 1) !== Number((user as any).authorizationVersion ?? 1)) {
            cleanupAuthorization();
            if (!socket.destroyed) socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
          // noVNC WebSocket upgrade — only /novnc/websockify goes to websockify
          (novncWsProxy as any).upgrade(req, socket, head);
        }).catch(() => {
          cleanupAuthorization();
          if (!socket.destroyed) socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        });
      } else if (isExactWebSocketPath(req.url, '/novnc/audio')) {
        // Audio WebSocket upgrade — same auth as VNC
        const origin = req.headers.origin;
        if (!isAllowedWebSocketOrigin(origin, req.headers.host)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        const cookies = parseSafeCookieHeader(req.headers.cookie);
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
        let authorizationRevoked = false;
        let unsubscribed = false;
        const revokeInteractiveAuthority = () => {
          authorizationRevoked = true;
          socket.destroy();
        };
        let unsubscribeGlobalFence = () => {};
        let unsubscribeAuthorization = () => {};
        unsubscribeGlobalFence = subscribeToGlobalWorkspaceAuthorizationFence(
          revokeInteractiveAuthority,
        );
        if (authorizationRevoked || socket.destroyed) {
          unsubscribeGlobalFence();
          socket.destroy();
          return;
        }
        unsubscribeAuthorization = subscribeToAuthorizationChanges(payload.userId, revokeInteractiveAuthority);
        const cleanupAuthorization = () => {
          if (unsubscribed) return;
          unsubscribed = true;
          socket.removeListener('close', cleanupAuthorization);
          unsubscribeGlobalFence();
          unsubscribeAuthorization();
        };
        socket.once('close', cleanupAuthorization);
        prisma.user.findUnique({
          where: { id: payload.userId },
          select: {
            id: true,
            role: true,
            accountStatus: true,
            isActive: true,
            authorizationVersion: true,
          },
        } as any).then((user) => {
          if (authorizationRevoked
            || socket.destroyed
            || !user
            || !canAccessPortal((user as any).accountStatus, user.isActive)
            || !isElevatedRole(user.role)
            || (payload.authorizationVersion ?? 1) !== Number((user as any).authorizationVersion ?? 1)) {
            cleanupAuthorization();
            if (!socket.destroyed) socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
          (audioWsProxy as any).upgrade(req, socket, head);
        }).catch(() => {
          cleanupAuthorization();
          if (!socket.destroyed) socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        });
      }
      // Legacy Guacamole upgrade path removed; noVNC websocket handling is active above.
    });

    // Release the bootstrap status listener so the real server can bind.
    setStartupPhase('finalizing');
    await stopStartupStatusServer();
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
      // Start only after the real listener and persistent Gateway client are
      // established. Lease misses and preserved failures retry in the
      // background without blocking unrelated providers or startup health.
      scheduleLegacyOpenClawProjectMigration(1_000);
      if (process.env.PORTAL_DISABLE_OPENCLAW_BACKGROUND !== '1') {
        initializeProjectChatRestartRecoveryRuntime();
      }
      void reconcilePortalVisibleBrowserDefaults();
      void reconcileRemoteDesktopLauncherAssets();
      // Per-boot capability secret the Remote Desktop Agent Zero launcher reads
      // to request an authenticated web session over loopback.
      provisionAgentZeroDesktopLauncherSecret();
      void retireInternalProjectIdentityDebris().catch((error) => {
        console.warn('[project-identity] internal-directory debris sweep failed:', (error as Error)?.message);
      });
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    await stopStartupStatusServer().catch(() => {});
    throw error;
  }
};

if (require.main === module) {
  void startServer().catch(() => process.exit(1));
}

export default app;
export { httpServer };
