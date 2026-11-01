import { Router } from 'express';
import type { Server } from 'http';
import { WebSocketServer } from 'ws';
import { getOpenClawWsUrl } from '../config/openclaw';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { requireApproved } from '../middleware/requireApproved';
import type { JwtPayload } from '../utils/jwt';
import { verifyAccessToken } from '../utils/jwt';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import { parseSafeCookieHeader } from '../utils/safeCookies';
import { isAllowedWebSocketOrigin } from '../utils/websocketOrigin';
import { isOwnerRole } from '../utils/authz';
import { getOpenClawCapabilities } from '../services/openClawCompatibility';
import { authorizeAgentBrowserWebSocketTransport, completeAuthorizedWebSocketUpgrade } from '../services/portalTransportAuthorization';
import { relayAgentWorkspaceBrowser } from '../services/agentWorkspaceBrowserRelay';
import { diagnoseDisplayToolPolicy } from '../services/displayToolPolicy';

type Authorize = (key: string, user: JwtPayload) => Promise<void>;
type Rpc = typeof gatewayRpcCall;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TARGET = /^[A-Za-z0-9._:-]{1,128}$/;
export const AGENT_WORKSPACE_BROWSER_STREAM_PATH = '/api/agent-workspace/browser/stream';
const MAX_BROWSER_VIEWERS = 8;

/** OpenClaw's native browser service, reached through the Portal's own Gateway connection. */
export function openClawBrowserServiceAvailable(methods: readonly string[] = getOpenClawCapabilities().methods): boolean {
  return methods.includes('browser.request');
}

function browserUnavailable(error: unknown): string {
  const text = String(error || '');
  if (/not running|attachOnly|ECONNREFUSED|no browser|not available|unavailable/i.test(text)) return 'The agent browser is not running right now. It starts when the agent uses it.';
  return 'The agent browser is unavailable.';
}

/**
 * Agent workspace: a live view of the OpenClaw-managed browser an Agent Chat
 * drives. Same elevated, owned-session contract as chat widgets; nothing here
 * grants a tool, sends a prompt or touches the shared desktop browser lease.
 */
export function createAgentWorkspaceRouter(authorize: Authorize, rpc: Rpc = gatewayRpcCall, browserAvailable = () => openClawBrowserServiceAvailable()) {
  const router = Router();
  router.use(authenticateToken, requireApproved, requireAdmin);
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

  /** Read-only: whether this chat's agent's own tool policy hides the display tools. Never writes policy. */
  router.get('/sessions/:key/widget-policy', async (req, res) => {
    try { await authorize(req.params.key, req.user!); }
    catch { res.status(404).json({ error: 'Chat unavailable' }); return; }
    const agentId = /^agent:([^:]+):/.exec(req.params.key)?.[1];
    try {
      const result = agentId ? await rpc('config.get', {}, 15_000) : null;
      const config = result?.data?.config ?? result?.data?.parsed;
      if (!agentId || !result?.ok || result.data?.valid === false || !config || typeof config !== 'object') throw new Error('unverified');
      res.json({ checked: true, agentId, findings: diagnoseDisplayToolPolicy(config, agentId) });
    } catch {
      // Nothing is claimed when the policy cannot be read right now.
      res.json({ checked: false, findings: [] });
    }
  });

  /** Tabs of the browser profile this chat's agent used, read through the native browser service. */
  router.get('/sessions/:key/browser/tabs', async (req, res) => {
    const profile = typeof req.query.profile === 'string' && req.query.profile ? req.query.profile : undefined;
    if (profile !== undefined && !PROFILE.test(profile)) { res.status(400).json({ code: 'BROWSER_INVALID', error: 'Invalid browser profile' }); return; }
    try { await authorize(req.params.key, req.user!); }
    catch { res.status(404).json({ code: 'BROWSER_UNAVAILABLE', error: 'Chat unavailable' }); return; }
    if (!browserAvailable()) {
      res.status(503).json({ code: 'BROWSER_UNSUPPORTED', error: 'This OpenClaw Gateway does not offer its browser service to the Portal.' }); return;
    }
    const result = await rpc('browser.request', { method: 'GET', path: '/tabs', ...(profile ? { query: { profile } } : {}), timeoutMs: 8000 }, 10_000);
    if (!result.ok) { res.status(503).json({ code: 'BROWSER_UNAVAILABLE', error: browserUnavailable(result.error) }); return; }
    const tabs = Array.isArray(result.data?.tabs) ? result.data.tabs : Array.isArray(result.data) ? result.data : [];
    res.json({ profile: profile ?? null, running: result.data?.running !== false, tabs: tabs
      .filter((tab: any) => typeof tab?.targetId === 'string' && TARGET.test(tab.targetId) && (tab.type === undefined || tab.type === 'page'))
      .slice(0, 50)
      .map((tab: any) => ({ targetId: tab.targetId, title: String(tab.title || 'Untitled').slice(0, 300), url: String(tab.url || '').slice(0, 2048) })) });
  });
  return router;
}

/**
 * Live view: the native browser service mints a screencast token bound to the
 * Portal's Gateway connection; frames are relayed unchanged. Human input is a
 * separate, explicitly enabled and bounded protocol (agentWorkspaceBrowserRelay).
 */
export function attachAgentWorkspaceBrowserStream(
  server: Server,
  authorize: Authorize,
  rpc: Rpc = gatewayRpcCall,
): { viewerLoad(): { connected: number; pending: number } } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  // Upgrades still being authorized or minting a screencast hold a seat too;
  // otherwise simultaneous upgrades all pass the cap before any is connected.
  let pendingViewers = 0;
  server.on('upgrade', (req, socket, head) => {
    const [path, query = ''] = (req.url || '').split('?');
    if (path !== AGENT_WORKSPACE_BROWSER_STREAM_PATH) return;
    const params = new URLSearchParams(query);
    const session = params.get('session') || '';
    const profile = params.get('profile') || '';
    const target = params.get('target') || '';
    const payload = verifyAccessToken(parseSafeCookieHeader(req.headers.cookie).accessToken || '');
    if (!payload || !isAllowedWebSocketOrigin(req.headers.origin, req.headers.host) || !session || session.length > 512
      || (profile && !PROFILE.test(profile)) || !TARGET.test(target) || wss.clients.size + pendingViewers >= MAX_BROWSER_VIEWERS
      || !openClawBrowserServiceAvailable()) { socket.destroy(); return; }
    // Reserved before the first await; released exactly once, when the viewer
    // is connected (it then counts in wss.clients) or when the socket closes on
    // any failure path (every one of them destroys the socket).
    pendingViewers += 1;
    let reserved = true;
    const releaseReservation = () => {
      if (!reserved) return;
      reserved = false;
      pendingViewers -= 1;
    };
    socket.once('close', releaseReservation);
    completeAuthorizedWebSocketUpgrade({ socket,
      authorize: (onRevoke) => authorizeAgentBrowserWebSocketTransport(payload, onRevoke),
      onAuthorized: (result) => {
        const identity = result.identity as unknown as JwtPayload;
        void authorize(session, identity).then(async () => {
          const minted = await rpc('browser.request', { method: 'POST', path: '/screencast',
            body: { targetId: target, ...(profile ? { profile } : {}), maxWidth: 2000, maxHeight: 2000, quality: 85 }, timeoutMs: 8000 }, 10_000);
          const wsPath = minted.data?.wsPath;
          if (!minted.ok || typeof wsPath !== 'string' || !wsPath.startsWith('/browser/screencast?token=')) throw new Error('screencast unavailable');
          if (socket.destroyed) return;
          wss.handleUpgrade(req, socket, head, (client) => {
            releaseReservation();
            relayAgentWorkspaceBrowser(client, `${getOpenClawWsUrl()}${wsPath}`, {
              target, profile, authorize: () => authorize(session, identity), userId: identity.userId,
              // Viewing follows the existing elevated agent-browser policy; acting in the
              // host-wide managed profile is the owner's, like the shared browser lease.
              inputAllowed: isOwnerRole(identity.role),
            }, rpc);
          });
        }).catch(() => socket.destroy());
      },
    });
  });
  return { viewerLoad: () => ({ connected: wss.clients.size, pending: pendingViewers }) };
}
