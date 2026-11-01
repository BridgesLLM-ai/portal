import { capabilitiesFromHello, supportsOpenClawInlineWidgets } from './openClawCompatibility';
import { consumePortalHostTurnAuthority } from './portalHostTurnAuthority';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { configuredPortalOrigin } from '../utils/appContentSecurity';
import { getOpenClawWsUrl } from '../config/openclaw';
import { getGatewayToken } from '../utils/gatewayToken';
import { buildSignedDevice, getOrCreateDeviceKeys, validateGatewayChallenge } from '../utils/deviceIdentity';

/** Server-owned bridge origin; never trust an incoming browser Origin/Host here.
 * A local Gateway uses its explicit native loopback-origin policy. Remote Gateways
 * require the configured Portal origin to be admitted by their own origin policy.
 * Token/device authentication and the exact Canvas contract remain mandatory.
 */
export function portalWidgetBridgeOrigin(wsUrl: string): string {
  const endpoint = new URL(wsUrl);
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new Error('Invalid widget Gateway endpoint');
  if (['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname.toLowerCase())) {
    endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
    return endpoint.origin;
  }
  const origin = configuredPortalOrigin();
  if (!origin) throw new Error('Remote widget Gateway requires a configured Portal origin');
  return origin;
}

/** One owned Agent Chat dispatch, never shared with Project agents, cron, or generic RPC. */
export async function openPortalWidgetTurnSocket(sessionKey: string, onEvent: (event: string, payload: any) => void) {
  const assertRequesterCurrent = consumePortalHostTurnAuthority(sessionKey);
  return new Promise<{ send(data: string): void; close(): void }>((resolve, reject) => {
    const wsUrl = getOpenClawWsUrl();
    const ws = new WebSocket(wsUrl, { maxPayload: 12 * 1024 * 1024, origin: portalWidgetBridgeOrigin(wsUrl) });
    const connectId = `portal-widget-connect-${randomUUID()}`;
    // Match the already-admitted elevated Host operator, not a generic rich UI.
    // Native9.9 creation requires admin + actual local/authenticated provenance.
    // The one-dispatch in-process capability excludes Project/cron/reconnect.
    const scopes = ['operator.admin', 'operator.read', 'operator.write', 'operator.questions'];
    let accepted = false;
    let dispatched = false;
    let responseId = '';
    let closed = false;
    const close = () => { if (closed) return; closed = true; clearTimeout(deadline); clearTimeout(lifetime); ws.close(); };
    const deadline = setTimeout(() => { close(); reject(new Error('Widget transport unavailable')); }, 10000);
    const lifetime = setTimeout(close, 60 * 60 * 1000);
    lifetime.unref();
    ws.on('error', () => { close(); if (!accepted) reject(new Error('Widget transport unavailable')); });
    ws.on('close', () => { close(); if (!accepted) reject(new Error('Widget transport unavailable')); });
    ws.on('message', bytes => {
      try {
        const frame = JSON.parse(bytes.toString());
        if (frame.type === 'event' && frame.event === 'connect.challenge' && !accepted) {
          assertRequesterCurrent();
          const challenge = validateGatewayChallenge(frame.payload);
          const token = getGatewayToken();
          const clientId = 'webchat'; const clientMode = 'webchat';
          ws.send(JSON.stringify({ type: 'req', id: connectId, method: 'connect', params: {
            auth: { token }, client: { id: clientId, mode: clientMode, version: '1.0.0', platform: 'linux',
              displayName: 'Portal inline widget turn', instanceId: connectId },
            device: buildSignedDevice({ keys: getOrCreateDeviceKeys(), clientId, clientMode, role: 'operator',
              scopes, token, nonce: challenge.nonce, signedAt: challenge.ts }),
            role: 'operator', scopes, caps: ['tool-events', 'inline-widgets'], minProtocol: 3, maxProtocol: 4,
          } }));
        } else if (frame.type === 'res' && frame.id === connectId && !accepted) {
          if (!frame.ok) {
            // Do not expose an arbitrary upstream message (which may contain secrets).
            const code = frame.error?.details?.code;
            const reason = code === 'CONTROL_UI_ORIGIN_NOT_ALLOWED' ? 'Gateway rejected the Portal widget connection origin'
              : code === 'PAIRING_REQUIRED' ? 'Gateway requires pairing for the Portal widget connection'
              : 'Gateway rejected the Portal widget connection';
            close(); reject(new Error(reason)); return;
          }
          if (!supportsOpenClawInlineWidgets(capabilitiesFromHello(frame.payload))) {
            close(); reject(new Error('Inline widgets require the qualified stable Canvas contract')); return;
          }
          accepted = true; clearTimeout(deadline);
          resolve({ close, send(data: string) {
            assertRequesterCurrent();
            const request = JSON.parse(data);
            if (closed || dispatched || request.method !== 'chat.send' || request.params?.sessionKey !== sessionKey)
              throw new Error('Widget transport scope mismatch');
            dispatched = true; responseId = request.id; ws.send(data);
          } });
        } else if (accepted && frame.type === 'res' && frame.id === responseId) {
          onEvent('response', frame);
        } else if (accepted && dispatched && frame.type === 'event'
          && ['agent', 'chat', 'session.tool'].includes(frame.event) && frame.payload?.sessionKey === sessionKey) {
          onEvent(frame.event, frame.payload);
        }
      } catch { close(); if (!accepted) reject(new Error('Widget transport unavailable')); }
    });
  });
}
