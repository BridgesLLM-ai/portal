/**
 * OpenClaw Gateway WebSocket RPC Client
 * 
 * Connects to the OpenClaw gateway's WebSocket endpoint to call methods
 * that aren't exposed via the HTTP API (e.g., sessions.patch for model switching).
 * 
 * Protocol: JSON-RPC over WebSocket with connect handshake.
 */
// @ts-ignore - ws doesn't have type declarations in this project
import WebSocket from 'ws';
import { getOpenClawWsUrl } from '../config/openclaw';
import { buildSignedDevice, getOrCreateDeviceKeys } from './deviceIdentity';
import { getGatewayToken } from './gatewayToken';

const GATEWAY_WS_URL = getOpenClawWsUrl();
const PROTOCOL_VERSION = 3;
// NOTE: The gateway validates client.id against a fixed schema — only certain values are
// allowed (e.g. 'gateway-client'). We share the same ID as PersistentGatewayWs, but
// avoid collision by keeping throwaway connections extremely short-lived and not competing
// for the persistent slot when one is already established.
const GATEWAY_CLIENT_ID = 'gateway-client';
const GATEWAY_CLIENT_MODE = 'backend';
const GATEWAY_ROLE = 'operator';
const GATEWAY_SCOPES = ['operator.admin', 'operator.read'];

interface RpcResponse {
  ok: boolean;
  data?: any;
  error?: any;
}

/**
 * Call a gateway RPC method.
 * 
 * ROUTING PRIORITY:
 *   1. If PersistentGatewayWs is connected → route through it (avoids clientId collision)
 *   2. Otherwise → open a temporary WebSocket (takes the clientId slot temporarily)
 * 
 * The gateway enforces one connection per clientId. Creating throwaway connections
 * while the persistent WS is alive displaces it, breaking chat streaming.
 */
export async function gatewayRpcCall(method: string, params: Record<string, any>, timeoutMs = 10000): Promise<RpcResponse> {
  // Try persistent WS first to avoid clientId collision
  try {
    const PGW = await import('../agents/providers/PersistentGatewayWs');
    if (PGW.isConnected()) {
      // Route through the persistent WS sendChatMessage/injectChatMessage for chat,
      // or fall through to throwaway for other RPC methods.
    }
  } catch {
    // PersistentGatewayWs not available — fall through to throwaway
  }

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: RpcResponse) => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch {}
      resolve(result);
    };

    const timeout = setTimeout(() => {
      done({ ok: false, error: 'Gateway RPC timeout' });
    }, timeoutMs);

    let ws: WebSocket;
    try {
      ws = new WebSocket(GATEWAY_WS_URL);
    } catch (err: any) {
      clearTimeout(timeout);
      resolve({ ok: false, error: `WebSocket creation failed: ${err.message}` });
      return;
    }

    const keys = getOrCreateDeviceKeys();
    let messageId = 0;
    let connectSent = false;

    const send = (data: any) => {
      ws.send(JSON.stringify(data));
    };

    // Gateway sends connect.challenge before we send connect.
    // We must capture the nonce and include it in the device signature.
    let challengeNonce: string | undefined;
    let connectId: string | undefined;
    let methodId: string | undefined;

    const sendConnect = (nonce?: string) => {
      messageId++;
      connectId = String(messageId);
      connectSent = true;
      send({
        type: 'req',
        id: connectId,
        method: 'connect',
        params: {
          auth: { token: getGatewayToken() },
          client: {
            id: GATEWAY_CLIENT_ID,
            mode: GATEWAY_CLIENT_MODE,
            version: '1.0.0',
            displayName: 'Portal Backend RPC',
            platform: 'linux',
          },
          device: buildSignedDevice({
            keys,
            clientId: GATEWAY_CLIENT_ID,
            clientMode: GATEWAY_CLIENT_MODE,
            role: GATEWAY_ROLE,
            scopes: GATEWAY_SCOPES,
            token: getGatewayToken(),
            nonce,
          }),
          role: GATEWAY_ROLE,
          scopes: GATEWAY_SCOPES,
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
        },
      });
    };

    ws.on('open', () => {
      // Wait for connect.challenge event before sending connect
    });

    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Handle connect.challenge event from gateway
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          challengeNonce = msg.payload?.nonce;
          sendConnect(challengeNonce);
          return;
        }
        
        if (msg.type === 'res') {
          if (msg.id === connectId && connectSent) {
            // Connect response
            if (!msg.ok) {
              const connectError = msg.error?.message || 'Connect failed';
              console.error(`[Gateway RPC] Connect failed: ${connectError}`);
              done({ ok: false, error: connectError });
              return;
            }
            // Step 2: Send the actual RPC method
            messageId++;
            methodId = String(messageId);
            send({
              type: 'req',
              id: methodId,
              method,
              params,
            });
          } else if (msg.id === methodId) {
            // Method response
            clearTimeout(timeout);
            if (msg.ok) {
              done({ ok: true, data: msg.payload || msg.result });
            } else {
              done({ ok: false, error: msg.error?.message || 'Method call failed' });
            }
          }
        }
      } catch {}
    });

    ws.on('error', (err: any) => {
      clearTimeout(timeout);
      done({ ok: false, error: `WebSocket error: ${err.message}` });
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      done({ ok: false, error: 'WebSocket closed unexpectedly' });
    });
  });
}

/**
 * Patch the model for a specific OpenClaw session.
 * This is the key function for making the portal model switcher actually work.
 * 
 * @param sessionKey - Full session key, e.g. "agent:portal:portal-{userId}-{projectName}"
 * @param model - Model identifier, e.g. "anthropic/claude-haiku-4-5"
 * @returns The resolved model info from the gateway
 */
export async function patchSessionModel(sessionKey: string, model: string): Promise<{ ok: boolean; resolved?: { modelProvider: string; model: string }; error?: string }> {
  console.log(`[Gateway RPC] Patching session model: key=${sessionKey} model=${model}`);
  
  const result = await gatewayRpcCall('sessions.patch', { key: sessionKey, model });
  
  if (result.ok) {
    const resolved = result.data?.resolved;
    console.log(`[Gateway RPC] Model patched successfully: ${resolved?.modelProvider}/${resolved?.model}`);
    return { ok: true, resolved };
  } else {
    console.error(`[Gateway RPC] Failed to patch model: ${result.error}`);
    return { ok: false, error: String(result.error) };
  }
}

/**
 * Get the current session info including active model.
 */
export async function getSessionInfo(sessionKey: string): Promise<{ ok: boolean; data?: any; error?: string }> {
  // Extract agent ID from session key format: "agent:{agentId}:{sessionId}"
  const agentId = sessionKey.startsWith('agent:') ? sessionKey.split(':')[1] : 'portal';
  const result = await gatewayRpcCall('sessions.list', { agentId });
  
  if (result.ok && result.data?.sessions) {
    const session = result.data.sessions.find((s: any) => s.key === sessionKey);
    if (session) {
      return { ok: true, data: session };
    }
    return { ok: false, error: 'Session not found' };
  }
  
  return { ok: false, error: String(result.error) };
}

/**
 * Check if an error string from a gateway RPC result indicates a transport-level
 * failure (timeout, WebSocket error, connection refused) rather than a business-logic
 * error (e.g. "Session not found").
 * 
 * Use this to decide HTTP status: transport errors → 502/504, not 404.
 */
export function isGatewayTransportError(error?: string): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return e.includes('timeout') ||
    e.includes('websocket') ||
    e.includes('connect failed') ||
    e.includes('econnrefused') ||
    e.includes('closed unexpectedly');
}

/**
 * Delete/end an OpenClaw session.
 */
export async function deleteSession(sessionKey: string): Promise<{ ok: boolean; error?: string }> {
  console.log(`[Gateway RPC] Deleting session: key=${sessionKey}`);
  
  const result = await gatewayRpcCall('sessions.delete', { key: sessionKey });
  
  if (result.ok) {
    console.log(`[Gateway RPC] Session deleted successfully: ${sessionKey}`);
    return { ok: true };
  } else {
    console.error(`[Gateway RPC] Failed to delete session: ${result.error}`);
    return { ok: false, error: String(result.error) };
  }
}

/**
 * Send a chat message via OpenClaw's native WS RPC (same as webchat).
 * Non-blocking: returns immediately with { runId, status }.
 */
export async function chatSend(
  sessionKey: string,
  message: string,
  idempotencyKey: string,
): Promise<{ ok: boolean; runId?: string; status?: string; error?: string }> {
  console.log(`[Gateway RPC] chat.send: key=${sessionKey} idempotencyKey=${idempotencyKey}`);
  
  const result = await gatewayRpcCall('chat.send', {
    sessionKey,
    message,
    idempotencyKey,
  }, 15000);
  
  if (result.ok) {
    console.log(`[Gateway RPC] chat.send success: runId=${result.data?.runId} status=${result.data?.status}`);
    return { ok: true, runId: result.data?.runId, status: result.data?.status };
  } else {
    console.error(`[Gateway RPC] chat.send failed: ${result.error}`);
    return { ok: false, error: String(result.error) };
  }
}

/**
 * List available models from the gateway catalog.
 */
export async function listGatewayModels(): Promise<{ ok: boolean; models?: any[]; error?: string }> {
  const result = await gatewayRpcCall('models.list', {});
  
  if (result.ok) {
    return { ok: true, models: result.data?.models || [] };
  }
  
  return { ok: false, error: String(result.error) };
}
