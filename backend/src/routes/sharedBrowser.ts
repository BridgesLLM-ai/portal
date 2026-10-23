import { Router } from 'express';
import type { Server } from 'http';
import fs from 'fs';
import net from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { authenticateToken } from '../middleware/auth';
import { isElevatedRole } from '../utils/authz';
import { verifyAccessToken, type JwtPayload } from '../utils/jwt';
import { parseSafeCookieHeader } from '../utils/safeCookies';
import { isAllowedWebSocketOrigin } from '../utils/websocketOrigin';
import { assertExistingGatewaySessionAccess } from './gateway';
import { isOpenClawSessionActorScopedTo } from '../agents/openclawSessionOwnership';
import { authorizeAccessTokenPayload } from '../services/accessTokenAuthorization';
import { authorizeAgentBrowserWebSocketTransport, completeAuthorizedWebSocketUpgrade } from '../services/portalTransportAuthorization';
import { subscribeToAuthorizationChanges } from '../services/authorizationChangeBus';
import { sharedBrowserEnabled, sharedBrowserOwnerId, sharedBrowserRuntimeReady, startSharedBrowserBroker } from '../services/sharedBrowserBroker';
import { SharedBrowserError, SHARED_BROWSER_CDP, SHARED_BROWSER_VNC_SOCKET, sharedInteractiveBrowser as browser, type BrowserCaller } from '../services/sharedInteractiveBrowser';
import { captureScreenshotFromTarget, fetchCdpTargets } from './agentBrowser';

const router: Router = Router();
let selectingIdentity: JwtPayload | null = null;
let unsubscribeSelection: (() => void) | null = null;
export async function authorizeSharedBrowserCaller(caller: BrowserCaller): Promise<void> {
  browser.ownsCaller(caller);
  if (!selectingIdentity) throw new SharedBrowserError(403, 'Selection authority unavailable');
  const result = await authorizeAccessTokenPayload(selectingIdentity);
  if (!result.ok || !isElevatedRole(result.identity.role)) {
    browser.revoke(selectingIdentity.userId); throw new SharedBrowserError(403, 'Selection authority revoked');
  }
  await assertExistingGatewaySessionAccess(caller.sessionKey, result.identity);
}
let portalBroker: import('http').Server | null = null;
export async function startPortalSharedBrowserBroker(): Promise<void> {
  portalBroker = await startSharedBrowserBroker(authorizeSharedBrowserCaller);
}
export async function stopPortalSharedBrowserBroker(): Promise<void> {
  const owner = sharedBrowserOwnerId();
  if (owner) browser.revoke(owner);
  selectingIdentity = null; unsubscribeSelection?.(); unsubscribeSelection = null;
  const server = portalBroker; portalBroker = null;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
router.use(authenticateToken);
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!isElevatedRole(req.user?.role)) { res.status(403).json({ error: 'Admin role required' }); return; }
  if (!sharedBrowserEnabled() || sharedBrowserOwnerId() !== req.user?.userId.toLowerCase()) { res.status(404).json({ error: 'Shared interactive browser not commissioned' }); return; }
  if (!sharedBrowserRuntimeReady()) { res.status(503).json({ error: 'Shared browser lease broker unavailable' }); return; }
  next();
});
router.get('/state', (req, res) => {
  try { res.json({ enabled: true, lease: browser.snapshot(req.user!.userId), profile: 'portal-shared', target: 'host' }); }
  catch { res.status(404).json({ error: 'Shared browser unavailable' }); }
});
router.post('/select', async (req, res) => {
  try {
    const key = req.body?.sessionKey;
    if (typeof key !== 'string' || key.length > 512 || !/^agent:[^:]+:portal-[^:]+$/.test(key) || !isOpenClawSessionActorScopedTo(key, req.user!.userId)) throw new SharedBrowserError(404, 'Select your own Portal Agent Chat session');
    const agentId = /^agent:([a-z0-9][a-z0-9_-]{0,63}):/.exec(key)?.[1];
    if (!agentId) throw new SharedBrowserError(400, 'Invalid agent');
    await assertExistingGatewaySessionAccess(key, req.user!);
    const live = await authorizeAccessTokenPayload(req.user!);
    if (!live.ok || !isElevatedRole(live.identity.role)) throw new SharedBrowserError(403, 'Selection authority revoked');
    const lease = browser.select(req.user!.userId, key, agentId);
    selectingIdentity = { ...req.user! };
    unsubscribeSelection?.();
    unsubscribeSelection = subscribeToAuthorizationChanges(req.user!.userId, () => browser.revoke(req.user!.userId));
    res.json({ lease });
  } catch (error) { res.status(error instanceof SharedBrowserError ? error.status : 404).json({ error: error instanceof SharedBrowserError ? error.message : 'Session unavailable' }); }
});
router.post('/control', (req, res) => {
  try {
    const { revision, action } = req.body || {};
    if (!Number.isSafeInteger(revision) || !['take', 'return', 'decline', 'release'].includes(action)) throw new SharedBrowserError(400, 'Invalid control');
    const lease = browser.control(req.user!.userId, revision, action);
    if (!lease) { selectingIdentity = null; unsubscribeSelection?.(); unsubscribeSelection = null; }
    res.json({ lease });
  } catch (error) { res.status(error instanceof SharedBrowserError ? error.status : 503).json({ error: error instanceof Error ? error.message : 'Control unavailable' }); }
});
router.get('/pages', async (req, res) => {
  try { const lease = browser.snapshot(req.user!.userId);
    if (!lease || lease.mode === 'revoked') throw new SharedBrowserError(409, 'Select an authorized session first');
    await assertExistingGatewaySessionAccess(lease.sessionKey, req.user!);
    const pages = await fetchCdpTargets(SHARED_BROWSER_CDP);
    const current = browser.snapshot(req.user!.userId);
    if (!current || current.revision !== lease.revision || current.mode === 'revoked') throw new SharedBrowserError(404, 'Selection changed');
    res.json({ pages: pages.map(page => ({ targetId: page.id, title: page.title || 'Untitled', url: page.url || '' })) });
  } catch (error) { res.status(error instanceof SharedBrowserError ? error.status : 503).json({ error: 'Shared browser unavailable' }); }
});
router.get('/screenshot/:targetId', async (req, res) => {
  try { const lease = browser.snapshot(req.user!.userId);
    if (!lease || lease.mode === 'revoked') throw new SharedBrowserError(409, 'Select an authorized session first');
    await assertExistingGatewaySessionAccess(lease.sessionKey, req.user!);
    const page = (await fetchCdpTargets(SHARED_BROWSER_CDP)).find(item => item.id === req.params.targetId);
    if (!page) throw new SharedBrowserError(404, 'Selected browser tab is no longer open');
    const image = await captureScreenshotFromTarget(page, SHARED_BROWSER_CDP);
    // Re-check after the asynchronous capture to avoid delivering a released/reselected browser.
    const current = browser.snapshot(req.user!.userId);
    if (!current || current.sessionKey !== lease.sessionKey || current.revision !== lease.revision || current.mode === 'revoked') throw new SharedBrowserError(404, 'Selection changed');
    const live = await authorizeAccessTokenPayload(req.user!);
    if (!live.ok || !isElevatedRole(live.identity.role)) throw new SharedBrowserError(403, 'Selection authority revoked');
    const finalLease = browser.snapshot(req.user!.userId);
    if (!finalLease || finalLease.revision !== lease.revision || finalLease.mode === 'revoked') throw new SharedBrowserError(404, 'Selection changed');
    res.type('image/jpeg').send(image);
  } catch (error) { res.status(error instanceof SharedBrowserError ? error.status : 503).json({ error: 'Browser preview unavailable' }); }
});

/** noVNC speaks RFB via a private Unix socket, only while this exact user holds human control. */
export function attachSharedBrowserDesktop(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.split('?')[0] !== '/api/shared-browser/desktop') return;
    const payload = verifyAccessToken(parseSafeCookieHeader(req.headers.cookie).accessToken || '');
    if (!sharedBrowserRuntimeReady() || !payload || sharedBrowserOwnerId() !== payload.userId.toLowerCase() || !isAllowedWebSocketOrigin(req.headers.origin, req.headers.host)) { socket.destroy(); return; }
    completeAuthorizedWebSocketUpgrade({ socket,
      authorize: onRevoke => authorizeAgentBrowserWebSocketTransport(payload, onRevoke),
      onAuthorized: result => {
        if (!browser.humanCanConnect(result.identity.userId) || wss.clients.size >= 4) { socket.destroy(); return; }
        let stat: fs.Stats;
        let directory: fs.Stats;
        let parent: fs.Stats;
        let browserUid: number;
        try { stat = fs.lstatSync(SHARED_BROWSER_VNC_SOCKET);
          directory = fs.lstatSync('/run/bridges-shared-desktop/transport');
          parent = fs.lstatSync('/run/bridges-shared-desktop');
          browserUid = Number(fs.readFileSync('/etc/passwd', 'utf8').split('\n').find(line => line.startsWith('bridgesbrowser:'))?.split(':')[2]);
        } catch { socket.destroy(); return; }
        if (!Number.isSafeInteger(browserUid) || browserUid <= 0 || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o022) !== 0
          || !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== browserUid || (directory.mode & 0o7777) !== 0o700
          || !stat.isSocket() || stat.isSymbolicLink() || stat.uid !== browserUid || (stat.mode & 0o7777) !== 0o600) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => {
          const leaseRevision = browser.snapshot(result.identity.userId)?.revision;
          const vnc = net.createConnection(SHARED_BROWSER_VNC_SOCKET);
          const close = () => { vnc.destroy(); ws.close(); };
          const changed = () => {
            if (!browser.humanCanConnect(result.identity.userId) || browser.snapshot(result.identity.userId)?.revision !== leaseRevision) close();
          };
          browser.on('changed', changed);
          ws.on('message', (data, binary) => {
            if (!binary || !browser.humanCanConnect(result.identity.userId) || vnc.writableLength > 2 * 1024 * 1024) { close(); return; }
            vnc.write(data as Buffer);
          });
          vnc.on('data', chunk => { if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 2 * 1024 * 1024) close(); else ws.send(chunk, { binary: true }); });
          vnc.on('error', close); vnc.on('close', () => ws.close()); ws.on('error', close);
          ws.on('close', () => { browser.off('changed', changed); vnc.destroy(); });
        });
      },
    });
  });
}
export default router;
