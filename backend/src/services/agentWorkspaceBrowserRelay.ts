import WebSocket from 'ws';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import { acquireWorkspaceAuthorizationMutationLease } from './workspaceAuthorizationBarrier';
import { browserInputAction, parseBrowserInput, readBrowserFrame, type BrowserFrame } from './agentWorkspaceBrowserInput';

type Rpc = (method: string, params: Record<string, any>, timeoutMs?: number) => Promise<{ ok: boolean; data?: any; error?: string }>;
const SAFE_INPUT_ERRORS = new Set([
  'Wait for a live browser picture.', 'Page changed. Click the current page before typing.',
  'Browser input was not accepted. The page may have changed or browser policy may block this action.',
]);
export const BROWSER_INPUT_OWNER_ONLY = 'Browser input is limited to the Portal owner. You can still watch this view.';

/**
 * Why the relay ended a live view: one close code per reason, so the viewer can
 * say what happened and what to do (WorkspaceBrowserTab maps the same codes).
 * Native 4003 (page blocked) and 4004 (tab closed) pass through unchanged.
 */
export const BROWSER_RELAY_CLOSE = {
  invalidInput: { code: 4400, reason: 'invalid_input' },
  sessionEnded: { code: 4410, reason: 'session_ended' },
  inputRateLimit: { code: 4429, reason: 'input_rate_limit' },
  browserUnavailable: { code: 4503, reason: 'browser_unavailable' },
} as const;
const NATIVE_PASS_THROUGH_CLOSE = new Set([4003, 4004]);
/** Native: the Gateway connection that started this screencast is gone. */
const NATIVE_AUTHORITY_REVOKED = 4006;

function relayCloseForUpstream(code: number, reason: string): { code: number; reason: string } {
  if (NATIVE_PASS_THROUGH_CLOSE.has(code)) return { code, reason: reason.slice(0, 100) };
  if (code === NATIVE_AUTHORITY_REVOKED) return BROWSER_RELAY_CLOSE.sessionEnded;
  // Unsupported, unknown or abnormal native ends all mean the same to a viewer.
  return BROWSER_RELAY_CLOSE.browserUnavailable;
}

// One Portal input controller per native tab. This does not pause agent
// automation and is separate from the shared desktop browser's control lease.
const browserControllers = new Map<string, { client: WebSocket; touched: number }>();

/**
 * Relay native screencast frames unchanged and accept only the bounded human
 * input protocol. Every action re-authorizes the owned session, re-reads the
 * native tab list and requires the page URL the user saw; nothing a viewer
 * sends ever reaches the screencast socket.
 */
export function relayAgentWorkspaceBrowser(client: WebSocket, upstreamUrl: string, scope: {
  target: string; profile: string; authorize: () => Promise<void>; userId: string;
  /** The managed browser profile is host-wide; only the owner may act in it. */
  inputAllowed: boolean;
}, rpc: Rpc = gatewayRpcCall): void {
  const upstream = new WebSocket(upstreamUrl, { maxPayload: 8 * 1024 * 1024 });
  let frame: BrowserFrame | null = null;
  let ended = false, queued = 0, generation = 0, rateStart = Date.now(), rateCount = 0;
  let chain = Promise.resolve();
  const send = (value: unknown) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); };
  const ownsInput = () => browserControllers.get(scope.target)?.client === client;
  const releaseInput = () => {
    generation++;
    if (ownsInput()) browserControllers.delete(scope.target);
    send({ type: 'control', enabled: false });
  };
  const close = (code = 1000, reason = '') => {
    if (ended) return;
    ended = true;
    releaseInput();
    if (client.readyState === WebSocket.OPEN) client.close(code, reason);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  };
  const closeFor = ({ code, reason }: { code: number; reason: string }) => close(code, reason);
  client.on('message', (data, binary) => {
    if (binary) { closeFor(BROWSER_RELAY_CLOSE.invalidInput); return; }
    let input;
    try { input = parseBrowserInput(JSON.parse(data.toString())); } catch { input = null; }
    if (!input) { closeFor(BROWSER_RELAY_CLOSE.invalidInput); return; }
    if (Date.now() - rateStart >= 1000) { rateStart = Date.now(); rateCount = 0; }
    if (++rateCount > 80) { closeFor(BROWSER_RELAY_CLOSE.inputRateLimit); return; }
    if (input.type === 'control') {
      if (!input.enabled) { releaseInput(); return; }
      if (!scope.inputAllowed) { send({ type: 'control', enabled: false, message: BROWSER_INPUT_OWNER_ONLY }); return; }
      const owner = browserControllers.get(scope.target);
      if (owner && owner.client !== client && owner.client.readyState === WebSocket.OPEN && Date.now() - owner.touched < 60_000) {
        send({ type: 'control', enabled: false, message: 'Another Portal viewer is using this tab. Try again when they finish.' }); return;
      }
      if (owner && owner.client !== client && owner.client.readyState === WebSocket.OPEN) owner.client.send(JSON.stringify({ type: 'control', enabled: false }));
      browserControllers.set(scope.target, { client, touched: Date.now() });
      send({ type: 'control', enabled: true });
      return;
    }
    const actionInput = input;
    const epoch = generation;
    if (!ownsInput() || queued >= 32) { send({ type: 'input', id: input.id, ok: false, message: 'Input is paused. Enable input again.' }); return; }
    browserControllers.get(scope.target)!.touched = Date.now();
    queued++;
    chain = chain.then(async () => {
      if (ended || epoch !== generation || !ownsInput() || client.readyState !== WebSocket.OPEN) return;
      let release: (() => void) | undefined;
      try {
        release = acquireWorkspaceAuthorizationMutationLease(scope.userId);
        await scope.authorize();
        if (ended || epoch !== generation || !ownsInput()) return;
        if (!frame) throw new Error('Wait for a live browser picture.');
        const action = browserInputAction(actionInput, frame);
        const current = await rpc('browser.request', { method: 'GET', path: '/tabs',
          ...(scope.profile ? { query: { profile: scope.profile } } : {}), timeoutMs: 8000 }, 10_000);
        const tabs = Array.isArray(current.data?.tabs) ? current.data.tabs : Array.isArray(current.data) ? current.data : [];
        if (!current.ok || !tabs.some((tab: any) => tab?.targetId === scope.target && tab?.url === actionInput.url)) {
          throw new Error('Page changed. Click the current page before typing.');
        }
        if (ended || epoch !== generation || !ownsInput()) return;
        let result = await rpc('browser.request', { method: 'POST', path: '/act',
          body: { ...action, targetId: scope.target, ...(scope.profile ? { profile: scope.profile } : {}) }, timeoutMs: 8000 }, 10_000);
        if (!result.ok && actionInput.action === 'scroll' && /ACT_EVALUATE_DISABLED|evaluateEnabled=false/.test(String(result.error))) {
          result = await rpc('browser.request', { method: 'POST', path: '/act', body: { kind: 'press',
            key: actionInput.deltaY < 0 ? 'PageUp' : 'PageDown', targetId: scope.target, ...(scope.profile ? { profile: scope.profile } : {}) }, timeoutMs: 8000 }, 10_000);
        }
        if (!result.ok) throw new Error('Browser input was not accepted. The page may have changed or browser policy may block this action.');
        send({ type: 'input', id: actionInput.id, ok: true });
      } catch (error) {
        // Never echo native errors: they can contain page or typed data.
        send({ type: 'input', id: actionInput.id, ok: false,
          message: error instanceof Error && SAFE_INPUT_ERRORS.has(error.message) ? error.message : 'Browser input is unavailable.' });
        releaseInput();
      } finally { release?.(); }
    }).finally(() => { queued--; });
  });
  client.on('close', () => close());
  client.on('error', () => close());
  upstream.on('message', (data, binary) => {
    if (client.readyState !== WebSocket.OPEN) { close(); return; }
    // Drop frames for a slow viewer instead of buffering the whole stream.
    if (binary && client.bufferedAmount > 2 * 1024 * 1024) return;
    if (binary) frame = readBrowserFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    client.send(data, { binary });
  });
  upstream.on('close', (code, reason) => closeFor(relayCloseForUpstream(code, reason.toString())));
  upstream.on('error', () => closeFor(BROWSER_RELAY_CLOSE.browserUnavailable));
}
