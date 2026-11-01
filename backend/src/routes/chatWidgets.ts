import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireApproved } from '../middleware/requireApproved';
import { requireAdmin } from '../middleware/requireAdmin';
import type { JwtPayload } from '../utils/jwt';
import { gatewayRpcCall, getSessionHistory } from '../utils/openclawGatewayRpc';
import { readOwnedWidgetDocument, WidgetReadError } from '../services/chatWidgetDocument';
import { WIDGET_SANDBOX_HTML, WIDGET_SHELL_CSP } from '../services/chatWidgetSandbox';
import { acquireWorkspaceAuthorizationMutationLease } from '../services/workspaceAuthorizationBarrier';
import { BOARD_NAME_PATTERN, WIDGET_REFERENCE_SCHEMA } from '../services/chatWidgetProjection';
import { readBoardWidgetHtml, readLiveWidgetDocument } from '../services/chatWidgetLive';
import { getOpenClawCapabilities } from '../services/openClawCompatibility';
import { getOpenClawApiUrl } from '../config/openclaw';
import { resolveOwnedNativeSession } from '../agents/chatBridge/nativeSessionOwnership';
import { readChatBridgeWidgetDocument } from '../agents/chatBridge/widgetStore';
export function createChatWidgetsRouter(authorize: (key: string, user: JwtPayload) => Promise<void>) {
  const router = Router();
  // Public static shell has NO authenticated data, endpoints, or capability grants.
  router.get('/sandbox', (_req, res) => {
    res.set({ 'Content-Security-Policy': WIDGET_SHELL_CSP, 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()' });
    res.type('html').send(WIDGET_SANDBOX_HTML);
  });
  router.use(authenticateToken, requireApproved, requireAdmin);
  // Native harness widgets come from the Portal Chat Bridge store, bound to the
  // harness's own tool-call id by that turn's stream; never from client input.
  router.get('/native/sessions/:sessionId/tools/:toolCallId/document', (req, res) => {
    const { sessionId, toolCallId } = req.params;
    if (Object.keys(req.query).length || !sessionId || sessionId.length > 512 || !toolCallId || toolCallId.length > 256
      || /[\u0000-\u001f\u007f]/.test(sessionId + toolCallId)) { res.status(400).json({ code: 'WIDGET_INVALID' }); return; }
    let release: (() => void) | undefined;
    try {
      release = acquireWorkspaceAuthorizationMutationLease(req.user!.userId);
      const owned = resolveOwnedNativeSession(sessionId, req.user!.userId);
      const document = owned
        ? readChatBridgeWidgetDocument({ provider: owned.provider, portalSessionId: owned.sessionId, toolCallId })
        : null;
      if (!document) {
        res.status(404).json({ code: 'WIDGET_NOT_FOUND', error: 'Widget unavailable. Reload or ask the agent to recreate it.' });
        return;
      }
      res.set('Cache-Control', 'private, no-store').json({
        v: 1,
        reference: { schema: WIDGET_REFERENCE_SCHEMA, toolCallId, title: document.title, mode: 'inline' },
        html: document.html,
      });
    } catch {
      res.status(404).json({ code: 'WIDGET_NOT_FOUND', error: 'Widget unavailable. Reload or ask the agent to recreate it.' });
    } finally { release?.(); }
  });
  router.get('/sessions/:key/tools/:toolCallId/document', async (req, res) => {
    const { key, toolCallId } = req.params;
    if (Object.keys(req.query).length || !key || key.length > 512 || !toolCallId || toolCallId.length > 256
      || /[\u0000-\u001f\u007f]/.test(key + toolCallId)) { res.status(400).json({ code: 'WIDGET_INVALID' }); return; }
    let release: (() => void) | undefined;
    try {
      release = acquireWorkspaceAuthorizationMutationLease(req.user!.userId);
      const result = await readOwnedWidgetDocument(toolCallId, {
        authorize: () => authorize(key, req.user!),
        history: offset => getSessionHistory(key, { limit: 250, offset }),
        view: docId => gatewayRpcCall('canvas.document.view', { docId }),
      });
      res.set('Cache-Control', 'private, no-store').json(result);
    } catch (error) {
      const typed = error instanceof WidgetReadError ? error : new WidgetReadError(404, 'WIDGET_NOT_FOUND');
      res.status(typed.status).json({ code: typed.code, error: 'Widget unavailable. Reload or ask the agent to recreate it.' });
    } finally { release?.(); }
  });
  // Live (pinned) widget: the newest version carrying this board name, under
  // the same owner check, attested transcript read and opaque sandbox.
  router.get('/sessions/:key/boards/:boardName/document', async (req, res) => {
    const { key, boardName } = req.params;
    if (Object.keys(req.query).length || !key || key.length > 512 || /[\u0000-\u001f\u007f]/.test(key)
      || !BOARD_NAME_PATTERN.test(boardName || '')) { res.status(400).json({ code: 'WIDGET_INVALID' }); return; }
    const capabilities = getOpenClawCapabilities();
    if (!capabilities.liveWidgets) {
      res.status(409).json({ code: 'WIDGET_LIVE_UNAVAILABLE',
        error: capabilities.disabledReasons.liveWidgets || 'This OpenClaw Gateway does not offer live widgets.' });
      return;
    }
    let release: (() => void) | undefined;
    try {
      release = acquireWorkspaceAuthorizationMutationLease(req.user!.userId);
      const result = await readLiveWidgetDocument(boardName, {
        authorize: () => authorize(key, req.user!),
        history: offset => getSessionHistory(key, { limit: 250, offset }),
        view: docId => gatewayRpcCall('canvas.document.view', { docId }),
        board: () => readBoardWidgetHtml(key, boardName, { rpc: gatewayRpcCall, gatewayHttpBase: getOpenClawApiUrl() }),
      });
      res.set('Cache-Control', 'private, no-store').json(result);
    } catch (error) {
      const typed = error instanceof WidgetReadError ? error : new WidgetReadError(404, 'WIDGET_NOT_FOUND');
      res.status(typed.status).json({ code: typed.code, error: 'Widget unavailable. Reload or ask the agent to recreate it.' });
    } finally { release?.(); }
  });
  return router;
}
