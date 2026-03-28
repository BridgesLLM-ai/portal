import { Router, Request, Response } from 'express';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { execSync } from 'child_process';
import fs from 'fs';
import { authenticateToken } from '../middleware/auth';
import { isElevatedRole } from '../utils/authz';
import { verifyAccessToken, type JwtPayload } from '../utils/jwt';
import { prisma } from '../config/database';
import { isAllowedWebSocketOrigin } from '../utils/websocketOrigin';
import WebSocket, { WebSocketServer } from 'ws';

const router = Router();

const CDP_HTTP_URL = 'http://127.0.0.1:18801/json/list';
const CDP_WS_BASE = 'ws://127.0.0.1:18801/devtools/page';
const SCREENSHOT_INTERVAL_MS = 500;
const SCREENSHOT_TIMEOUT_MS = 4000;

type CdpTarget = {
  id: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type BrowserPage = {
  targetId: string;
  title: string;
  url: string;
};

type StreamClientMessage = {
  targetId?: string;
};

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const key = pair.substring(0, idx).trim();
      const value = pair.substring(idx + 1).trim();
      cookies[key] = decodeURIComponent(value);
    }
  });

  return cookies;
}

function getTargetWsUrl(target: Pick<CdpTarget, 'id' | 'webSocketDebuggerUrl'>): string {
  return target.webSocketDebuggerUrl || `${CDP_WS_BASE}/${encodeURIComponent(target.id)}`;
}

async function fetchCdpTargets(): Promise<CdpTarget[]> {
  const response = await fetch(CDP_HTTP_URL, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) {
    throw new Error(`CDP list request failed (${response.status})`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error('CDP list response was not an array');
  }

  return data.filter((target): target is CdpTarget => Boolean(target?.id && target?.type === 'page'));
}

function toBrowserPage(target: CdpTarget): BrowserPage {
  return {
    targetId: target.id,
    title: target.title || 'Untitled tab',
    url: target.url || '',
  };
}

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function captureScreenshotFromTarget(target: CdpTarget): Promise<Buffer> {
  const wsUrl = getTargetWsUrl(target);

  return await new Promise<Buffer>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const requestId = 1;
    let settled = false;
    let openTimer: NodeJS.Timeout | null = null;
    let responseTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (openTimer) clearTimeout(openTimer);
      if (responseTimer) clearTimeout(responseTimer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      } catch {
        // Ignore cleanup-time websocket close errors.
      }
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    openTimer = setTimeout(() => {
      finish(() => reject(new Error('Timed out connecting to CDP target')));
    }, SCREENSHOT_TIMEOUT_MS);

    ws.on('open', () => {
      if (openTimer) clearTimeout(openTimer);

      ws.send(JSON.stringify({ id: requestId, method: 'Page.enable' }));
      ws.send(JSON.stringify({
        id: requestId + 1,
        method: 'Page.captureScreenshot',
        params: {
          format: 'jpeg',
          quality: 60,
          captureBeyondViewport: false,
          fromSurface: true,
        },
      }));

      responseTimer = setTimeout(() => {
        finish(() => reject(new Error('Timed out waiting for screenshot')));
      }, SCREENSHOT_TIMEOUT_MS);
    });

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.id === requestId + 1) {
          if (message.error) {
            finish(() => reject(new Error(message.error.message || 'Screenshot failed')));
            return;
          }

          const data = message.result?.data;
          if (!data) {
            finish(() => reject(new Error('Screenshot response missing image data')));
            return;
          }

          finish(() => resolve(Buffer.from(data, 'base64')));
        }
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error('Invalid CDP response')));
      }
    });

    ws.on('error', (error) => {
      finish(() => reject(error instanceof Error ? error : new Error('CDP connection failed')));
    });

    ws.on('close', () => {
      if (!settled) {
        finish(() => reject(new Error('CDP target closed before screenshot completed')));
      }
    });
  });
}

async function getAuthorizedAdminFromUpgrade(req: IncomingMessage): Promise<JwtPayload | null> {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.accessToken;
  if (!token) return null;

  const user = verifyAccessToken(token);
  if (!user) return null;

  const dbUser = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { id: true, email: true, role: true, accountStatus: true, isActive: true, sandboxEnabled: true },
  } as any);

  if (!dbUser || !dbUser.isActive || !isElevatedRole(dbUser.role)) {
    return null;
  }

  return {
    userId: dbUser.id,
    email: dbUser.email,
    role: dbUser.role,
    accountStatus: (dbUser as any).accountStatus,
    sandboxEnabled: !!(dbUser as any).sandboxEnabled,
  } satisfies JwtPayload;
}

router.use(authenticateToken);
router.use((req, res, next) => {
  if (!req.user || !isElevatedRole(req.user.role)) {
    res.status(403).json({ error: 'Admin role required' });
    return;
  }
  next();
});

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const targets = await fetchCdpTargets();
    res.json({
      running: true,
      pages: targets.map(toBrowserPage),
    });
  } catch (error: any) {
    res.json({
      running: false,
      pages: [],
      error: error?.message || 'Agent browser is not available',
    });
  }
});

router.get('/screenshot/:targetId', async (req: Request, res: Response) => {
  try {
    const targets = await fetchCdpTargets();
    const target = targets.find((item) => item.id === req.params.targetId);
    if (!target) {
      res.status(404).json({ error: 'Target not found' });
      return;
    }

    const image = await captureScreenshotFromTarget(target);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.send(image);
  } catch (error: any) {
    const message = error?.message || 'Failed to capture screenshot';
    const status = /Target not found/i.test(message) ? 404 : 503;
    res.status(status).json({ error: message });
  }
});

router.post('/open-in-desktop', async (req: Request, res: Response) => {
  try {
    const requestedUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const safeUrl = requestedUrl && /^https?:\/\//i.test(requestedUrl) ? requestedUrl : '';
    const launcher = '/usr/local/bin/bridges-rd-shared-chrome.sh';

    if (!fs.existsSync(launcher)) {
      res.status(503).json({ error: 'Shared browser launcher not found' });
      return;
    }

    // Use centralized desktop env to ensure DISPLAY, PULSE_SERVER, etc. are set
    const { desktopExecDetached } = require('../utils/desktopEnv');
    // Shell-quote the URL properly — JSON.stringify is NOT safe for shell contexts
    const shellQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    const chromeCmd = `${launcher} ${safeUrl ? shellQuote(safeUrl) : ''} >/tmp/bridges-agent-browser.log 2>&1`;
    desktopExecDetached(chromeCmd);

    res.json({ ok: true, url: safeUrl || null, mode: 'remote-desktop-shared-browser', cdpPort: 18801, sharedProfileDir: '/tmp/bridges-agent-browser/profile', launcher });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to open browser in remote desktop' });
  }
});

export function attachAgentBrowserWebSocket(httpServer: import('http').Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  wss.on('connection', (ws) => {
    let selectedTargetId: string | null = null;
    let interval: NodeJS.Timeout | null = null;
    let inFlight = false;

    const stopLoop = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const captureAndSend = async () => {
      if (inFlight || ws.readyState !== WebSocket.OPEN) return;
      inFlight = true;

      try {
        const targets = await fetchCdpTargets();
        const pages = targets.map(toBrowserPage);
        const target = (selectedTargetId && targets.find((item) => item.id === selectedTargetId)) || targets[0];

        if (!target) {
          sendJson(ws, { type: 'status', running: true, pages, targetId: null, title: '', url: '', message: 'No browser tabs are open' });
          return;
        }

        selectedTargetId = target.id;
        sendJson(ws, {
          type: 'status',
          running: true,
          pages,
          targetId: target.id,
          title: target.title || 'Untitled tab',
          url: target.url || '',
        });

        const image = await captureScreenshotFromTarget(target);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(image, { binary: true });
        }
      } catch (error: any) {
        sendJson(ws, {
          type: 'status',
          running: false,
          pages: [],
          targetId: null,
          title: '',
          url: '',
          error: error?.message || 'Agent browser stream unavailable',
        });
      } finally {
        inFlight = false;
      }
    };

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as StreamClientMessage;
        if (message.targetId && typeof message.targetId === 'string') {
          selectedTargetId = message.targetId;
          void captureAndSend();
        }
      } catch {
        sendJson(ws, { type: 'error', error: 'Invalid stream control message' });
      }
    });

    ws.on('close', stopLoop);
    ws.on('error', stopLoop);

    void captureAndSend();
    interval = setInterval(() => {
      void captureAndSend();
    }, SCREENSHOT_INTERVAL_MS);
  });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url || '';
    if (!url.startsWith('/api/agent-browser/stream')) return;

    const origin = req.headers.origin;
    if (!isAllowedWebSocketOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    void getAuthorizedAdminFromUpgrade(req).then((user) => {
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      (req as any).__portalUser = user;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }).catch(() => {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
  });

  return wss;
}

export default router;
