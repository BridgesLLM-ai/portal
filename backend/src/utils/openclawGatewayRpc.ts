/**
 * OpenClaw Gateway WebSocket RPC Client
 * 
 * Connects to the OpenClaw gateway's WebSocket endpoint to call methods
 * that aren't exposed via the HTTP API (e.g., sessions.patch for model switching).
 * 
 * Protocol: JSON-RPC over WebSocket with connect handshake.
 */
import crypto from 'crypto';
import { isOpenClawExecutionCapableGatewayCall } from '../services/openClawExecutionCapableMethods';
import WebSocket from 'ws';
import { getOpenClawWsUrl } from '../config/openclaw';
import { buildSignedDevice, getOrCreateDeviceKeys, validateGatewayChallenge } from './deviceIdentity';
import { getGatewayToken } from './gatewayToken';
import { capabilitiesFromHello, getOpenClawCapabilities, type OpenClawCapabilities } from '../services/openClawCompatibility';
import { recordOpenClawHelloSnapshot } from './openclawHelloSnapshot';
import { openClawSessionModelAllowed } from '../services/openclawSessionModelPolicy';
import { OPENCLAW_PLAIN_TEXT_CHAT_PARAMS } from '../services/openclawChatCommandAuthority';

const GATEWAY_WS_URL = getOpenClawWsUrl();
const MIN_PROTOCOL_VERSION = 3;
const MAX_PROTOCOL_VERSION = 4;
// NOTE: The gateway validates client.id against a fixed schema — only certain values are
// allowed (e.g. 'gateway-client'). We share the same ID as PersistentGatewayWs, but
// avoid collision by keeping throwaway connections extremely short-lived and not competing
// for the persistent slot when one is already established.
const GATEWAY_CLIENT_ID = 'gateway-client';
const GATEWAY_CLIENT_MODE = 'backend';
const GATEWAY_ROLE = 'operator';
const GATEWAY_SCOPES = ['operator.admin', 'operator.read', 'operator.questions'];
const OPENCLAW_QUESTION_SCOPE = 'operator.questions';

function gatewayMethodRequiresQuestionScope(method: string): boolean {
  return method === 'question.list'
    || method === 'question.get'
    || method === 'question.resolve';
}

interface RpcResponse {
  ok: boolean;
  data?: any;
  error?: any;
  /** Structured gateway failure fields retained for operator diagnostics. */
  errorCode?: string;
  errorMessage?: string;
  errorDetails?: unknown;
}

/** A throwaway connection attempt plus whether no method was dispatched. */
interface RpcAttempt extends RpcResponse {
  retriable: boolean;
}

const GATEWAY_CONNECT_RETRY_BUDGET_MS = 8000;
const GATEWAY_CONNECT_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 2000];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const sessionMutationTails = new Map<string, Promise<void>>();

/**
 * Serialize Portal-owned mutations for one OpenClaw session. This makes the
 * missing-session default projection and an explicit Session Controls change
 * one ordered boundary instead of a GET -> PATCH race.
 */
export async function withOpenClawSessionMutation<T>(
  rawSessionKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const sessionKey = String(rawSessionKey || '').trim();
  if (!sessionKey) return operation();

  const previous = sessionMutationTails.get(sessionKey) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  sessionMutationTails.set(sessionKey, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    void tail.finally(() => {
      if (sessionMutationTails.get(sessionKey) === tail) {
        sessionMutationTails.delete(sessionKey);
      }
    });
  }
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
/**
 * The admission service reaches this module through its question-runtime probe,
 * so it is loaded at call time rather than imported. A failure to load it, or
 * to read the evidence, refuses the call: this guard never fails open.
 */
export function refuseDurablyBlockedExecutionRpc(
  method: string,
  params: unknown,
  binding: { generation: number } | null,
  assertNotDurablyBlocked?: () => void,
): { error: string; errorCode: string; errorMessage: string } | null {
  if (!isOpenClawExecutionCapableGatewayCall(method, params)) return null;
  try {
    if (assertNotDurablyBlocked) assertNotDurablyBlocked();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    else require('../services/openClawExecutionAdmission').assertOpenClawDispatchNotDurablyBlocked({}, { binding });
    return null;
  } catch (error: any) {
    const errorMessage = typeof error?.message === 'string' && error.message
      ? error.message
      : 'OpenClaw execution is unavailable.';
    const errorCode = typeof error?.code === 'string' && error.code.startsWith('OPENCLAW_EXECUTION_')
      ? error.code
      : 'OPENCLAW_EXECUTION_UNAVAILABLE';
    return { error: errorMessage, errorCode, errorMessage };
  }
}

function captureAdmittedDispatchBindingForRpc(method: string, params: unknown): { generation: number } | null {
  if (!isOpenClawExecutionCapableGatewayCall(method, params)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../services/openClawExecutionAdmission').captureAdmittedOpenClawDispatchBinding() || null;
  } catch {
    // The guard itself loads the same module and refuses the call if it cannot.
    return null;
  }
}

export async function gatewayRpcCall(method: string, params: Record<string, any>, timeoutMs = 10000): Promise<RpcResponse> {
  // Try persistent WS first to avoid clientId collision. If the persistent RPC
  // path accepts the call but fails/times out, surface that failure instead of
  // retrying over a throwaway connection: retrying non-idempotent methods like
  // chat.send can duplicate turns and can also evict the persistent stream WS.
  let PGW: any = null;
  try {
    PGW = await import('../agents/providers/PersistentGatewayWs');
  } catch {
    PGW = null;
  }

  if (PGW?.isConnected?.() && typeof PGW.callGatewayRpc === 'function') {
    try {
      const data = await PGW.callGatewayRpc(method, params, timeoutMs);
      return { ok: true, data };
    } catch (err: any) {
      const errorMessage = err?.errorMessage || err?.message || String(err || `${method} RPC failed`);
      const errorCode = typeof err?.errorCode === 'string' ? err.errorCode : undefined;
      return { ok: false, error: errorMessage, errorCode, errorMessage, errorDetails: err?.errorDetails };
    }
  }

  const deadline = Date.now() + GATEWAY_CONNECT_RETRY_BUDGET_MS;
  let attempt = await openThrowawayGatewayRpc(method, params, timeoutMs);
  for (let retry = 0; !attempt.ok && attempt.retriable; retry++) {
    const delay = GATEWAY_CONNECT_RETRY_DELAYS_MS[
      Math.min(retry, GATEWAY_CONNECT_RETRY_DELAYS_MS.length - 1)
    ];
    if (Date.now() + delay >= deadline) {
      return {
        ok: false,
        error: `OpenClaw gateway is restarting and did not accept a connection within `
          + `${Math.round(GATEWAY_CONNECT_RETRY_BUDGET_MS / 1000)}s (${attempt.error})`,
        errorCode: attempt.errorCode,
        errorMessage: attempt.errorMessage,
      };
    }
    await sleep(delay);
    attempt = await openThrowawayGatewayRpc(method, params, timeoutMs);
  }
  return {
    ok: attempt.ok,
    data: attempt.data,
    error: attempt.error,
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
    errorDetails: attempt.errorDetails,
  };
}

/**
 * The authenticated hello of the configured Gateway, for the readiness
 * contract check. A connected persistent socket already holds it; opening a
 * second socket would displace that one, so it is only read. Otherwise one
 * throwaway connection performs the same signed connect plus a read-only
 * `status` call and reports the hello it was granted.
 */
export async function probeGatewayHelloCapabilities(
  timeoutMs = 10_000,
): Promise<{ ok: true; capabilities: OpenClawCapabilities } | { ok: false; error: string }> {
  let PGW: any = null;
  try {
    PGW = await import('../agents/providers/PersistentGatewayWs');
  } catch {
    PGW = null;
  }
  if (PGW?.isConnected?.()) {
    const observed = getOpenClawCapabilities();
    if (observed.version) return { ok: true, capabilities: observed };
  }
  let hello: unknown = null;
  const attempt = await openThrowawayGatewayRpc('status', { includeChannelSummary: false }, timeoutMs, (payload) => {
    hello = payload;
  });
  if (hello) return { ok: true, capabilities: capabilitiesFromHello(hello) };
  return { ok: false, error: attempt.error || 'The OpenClaw Gateway did not complete an authenticated hello.' };
}

function openThrowawayGatewayRpc(
  method: string,
  params: Record<string, any>,
  timeoutMs: number,
  onHello?: (hello: unknown) => void,
): Promise<RpcAttempt> {
  // Captured here, in the caller's context: the method frame is written from a
  // socket callback, and the guard must judge the dispatch that asked for it.
  const admittedBinding = captureAdmittedDispatchBindingForRpc(method, params);
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: RpcAttempt) => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch {}
      resolve(result);
    };

    const timeout = setTimeout(() => {
      done({ ok: false, retriable: false, error: 'Gateway RPC timeout' });
    }, timeoutMs);

    let ws: WebSocket;
    try {
      ws = new WebSocket(GATEWAY_WS_URL);
    } catch (err: any) {
      clearTimeout(timeout);
      resolve({ ok: false, retriable: true, error: `WebSocket creation failed: ${err.message}` });
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

    const sendConnect = (nonce: string, signedAt: number) => {
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
            signedAt,
          }),
          role: GATEWAY_ROLE,
          scopes: GATEWAY_SCOPES,
          minProtocol: MIN_PROTOCOL_VERSION,
          maxProtocol: MAX_PROTOCOL_VERSION,
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
          const challenge = validateGatewayChallenge(msg.payload);
          challengeNonce = challenge.nonce;
          sendConnect(challengeNonce, challenge.ts);
          return;
        }
        
        if (msg.type === 'res') {
          if (msg.id === connectId && connectSent) {
            // Connect response
            if (!msg.ok) {
              const connectError = msg.error?.message || 'Connect failed';
              const connectErrorCode = typeof msg.error?.code === 'string' ? msg.error.code : undefined;
              console.error(`[Gateway RPC] Connect failed: ${connectError}`);
              done({
                ok: false,
                retriable: /starting|unavailable|not ready/i.test(connectError),
                error: connectError,
                errorCode: connectErrorCode,
                errorMessage: connectError,
              });
              return;
            }
            onHello?.(msg.payload);
            void recordOpenClawHelloSnapshot(msg.payload);
            const grantedScopes = Array.isArray(msg.payload?.auth?.scopes)
              ? msg.payload.auth.scopes.filter((scope: unknown): scope is string => (
                typeof scope === 'string'
              ))
              : [];
            if (
              gatewayMethodRequiresQuestionScope(method)
              && !grantedScopes.includes(OPENCLAW_QUESTION_SCOPE)
            ) {
              done({
                ok: false,
                retriable: false,
                error: `OpenClaw did not grant ${OPENCLAW_QUESTION_SCOPE}; refusing native question RPC.`,
                errorCode: 'FORBIDDEN',
                errorMessage: `OpenClaw did not grant ${OPENCLAW_QUESTION_SCOPE}; refusing native question RPC.`,
              });
              return;
            }
            // Step 2: Send the actual RPC method. One that starts, resumes or
            // schedules execution gets a last synchronous look at the durable
            // maintenance evidence; nothing is awaited between it and the write.
            const refusal = refuseDurablyBlockedExecutionRpc(method, params, admittedBinding);
            if (refusal) {
              done({ ok: false, retriable: false, ...refusal });
              return;
            }
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
              done({ ok: true, retriable: false, data: msg.payload || msg.result });
            } else {
              const errorMessage = msg.error?.message || 'Method call failed';
              done({
                ok: false,
                retriable: false,
                error: errorMessage,
                errorCode: typeof msg.error?.code === 'string' ? msg.error.code : undefined,
                errorMessage,
                errorDetails: msg.error?.details,
              });
            }
          }
        }
      } catch {
        clearTimeout(timeout);
        done({ ok: false, retriable: false, error: 'Invalid gateway response', errorCode: 'INVALID_RESPONSE' });
      }
    });

    const failedBeforeDispatch = () => methodId === undefined;

    ws.on('error', (err: any) => {
      clearTimeout(timeout);
      done({
        ok: false,
        retriable: failedBeforeDispatch(),
        error: `WebSocket error: ${err.message}`,
      });
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      done({
        ok: false,
        retriable: failedBeforeDispatch(),
        error: 'WebSocket closed unexpectedly',
      });
    });
  });
}

/**
 * Patch the model for a specific OpenClaw session.
 * This is the key function for making the portal model switcher actually work.
 * 
 * @param sessionKey - Full session key, e.g. "agent:portal:portal-{userId}-{projectName}"
 * @param model - Model identifier, e.g. "anthropic/claude-haiku-4-5", or null to clear the override
 * @returns The resolved model info from the gateway
 */
export interface OpenClawSessionCreationDefaults {
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'adaptive';
  reasoningLevel?: 'off' | 'on' | 'stream';
}

export const OPENCLAW_MODEL_NOT_ENABLED_MESSAGE =
  "This model isn't enabled on this server. An admin can enable it in Model Providers.";

export type OpenClawSessionModelPatchResult = {
  ok: boolean;
  resolved?: { modelProvider: string; model: string; agentRuntime?: { id?: string; source?: string } };
  error?: string;
  code?: 'MODEL_NOT_ENABLED';
};

/**
 * The plain refusal for a session model outside this server's enabled models,
 * or null when `model` may be sent. Every Portal route that sends a session
 * model to OpenClaw checks it before the native call (clearing, null, is never
 * refused).
 */
export function openClawSessionModelRefusal(
  sessionKey: string,
  model: string | null | undefined,
): OpenClawSessionModelPatchResult | null {
  if (!model || openClawSessionModelAllowed(sessionAgentIdOrNull(sessionKey), model)) return null;
  console.warn(`[Gateway RPC] Refused session model ${model}: not enabled on this server`);
  return { ok: false, error: OPENCLAW_MODEL_NOT_ENABLED_MESSAGE, code: 'MODEL_NOT_ENABLED' };
}

/**
 * OpenClaw's own refusal (a policy the Portal cannot read, such as one in an
 * included config file): "model not allowed", or since 2026.8.1 'Model
 * override "x" is not allowed by agents.defaults.modelPolicy.allow'.
 */
export function isOpenClawModelPolicyRefusal(error: unknown): boolean {
  return /model not allowed|not allowed by agents\.[\w.-]*modelPolicy/i.test(String(error || ''));
}

export async function patchSessionModelWithinMutation(
  sessionKey: string,
  model: string | null,
  creationDefaults?: OpenClawSessionCreationDefaults,
): Promise<OpenClawSessionModelPatchResult> {
  // sessions.patch can take noticeably longer than chat.send on a busy gateway,
  // especially right after auth/profile changes or when materializing a fresh
  // session. Keep a generous busy-gateway latency budget so model switching
  // does not fail spuriously during normal runtime contention.
  // A session model change only selects among models the host has enabled,
  // for every role: the Portal checks the server's configuration itself first
  // (OpenClaw 2026.10.6 accepted an operator patch outside it), and a refused
  // model is never declared into the host-wide config from here. Admins enable
  // models in Model Providers.
  const refusal = openClawSessionModelRefusal(sessionKey, model);
  if (refusal) return refusal;

  const patch = {
    key: sessionKey,
    model,
    ...(creationDefaults?.thinkingLevel ? { thinkingLevel: creationDefaults.thinkingLevel } : {}),
    ...(creationDefaults?.reasoningLevel ? { reasoningLevel: creationDefaults.reasoningLevel } : {}),
  };
  const result = await gatewayRpcCall('sessions.patch', patch, 20000);

  if (model && !result.ok && isOpenClawModelPolicyRefusal(result.error)) {
    console.warn(`[Gateway RPC] Refused session model ${model}: not enabled on this server`);
    return { ok: false, error: OPENCLAW_MODEL_NOT_ENABLED_MESSAGE, code: 'MODEL_NOT_ENABLED' };
  }

  if (result.ok) {
    const resolved = result.data?.resolved;
    console.log(`[Gateway RPC] Model patched successfully: ${resolved?.modelProvider}/${resolved?.model}`);
    return { ok: true, resolved };
  } else {
    console.error(`[Gateway RPC] Failed to patch model: ${result.error}`);
    return { ok: false, error: String(result.error) };
  }
}

export async function patchSessionModel(
  sessionKey: string,
  model: string | null,
  creationDefaults?: OpenClawSessionCreationDefaults,
): Promise<OpenClawSessionModelPatchResult> {
  return withOpenClawSessionMutation(sessionKey, () => (
    patchSessionModelWithinMutation(sessionKey, model, creationDefaults)
  ));
}

/**
 * Create or materialize an OpenClaw session entry so session metadata can be
 * patched before the first message is sent.
 */
export async function createSession(sessionKey: string, agentId?: string): Promise<{ ok: boolean; key?: string; error?: string }> {
  console.log(`[Gateway RPC] Creating session: key=${sessionKey}${agentId ? ` agent=${agentId}` : ''}`);

  const params: Record<string, any> = { key: sessionKey };
  if (agentId) params.agentId = agentId;

  const result = await gatewayRpcCall('sessions.create', params);

  if (result.ok) {
    const key = typeof result.data?.key === 'string' ? result.data.key.trim() : sessionKey;
    console.log(`[Gateway RPC] Session created: key=${key}`);
    return { ok: true, key };
  }

  console.error(`[Gateway RPC] Failed to create session: ${result.error}`);
  return { ok: false, error: String(result.error) };
}

function sessionAgentIdOrNull(sessionKey: string): string | null {
  try {
    return localSessionAgentId(sessionKey);
  } catch {
    return null;
  }
}

function localSessionAgentId(sessionKey: string): string {
  const normalized = String(sessionKey || '').trim();
  if (!normalized || normalized.length > 2048 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('OpenClaw session key is invalid');
  }
  const agentId = normalized.startsWith('agent:') ? normalized.split(':')[1] : 'portal';
  if (!agentId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentId)) {
    throw new Error('OpenClaw session agent identity is invalid');
  }
  return agentId;
}

export type LocalOpenClawSessionIdentity = {
  agentId: string;
  sessionKey: string;
  sessionId: string | null;
};


/**
 * Get the current session info including active model.
 */
export async function getSessionInfo(sessionKey: string): Promise<{ ok: boolean; data?: any; error?: string }> {
  localSessionAgentId(sessionKey);
  const describe = await gatewayRpcCall('sessions.describe', { key: sessionKey }, 8000);
  if (describe.ok) {
    const session = describe.data?.session;
    if (session) return { ok: true, data: session };
    return { ok: false, error: 'Session not found' };
  }

  return { ok: false, error: String(describe.error || 'sessions.describe failed') };
}

/**
 * Strict identity read for destructive privacy workflows. This uses only the
 * supported Gateway contract: private SQLite paths and table layouts are not a
 * Portal API and may change independently of sessions.describe.
 */
export async function readGatewaySessionIdentityStrict(
  sessionKey: string,
): Promise<LocalOpenClawSessionIdentity | null> {
  const normalized = String(sessionKey || '').trim();
  const agentId = localSessionAgentId(normalized);
  const described = await getSessionInfo(normalized);
  if (!described.ok) {
    if (/session not found|not found/i.test(String(described.error || ''))) return null;
    throw new Error(`OpenClaw session identity could not be read: ${described.error || 'unknown Gateway failure'}`);
  }
  const session = described.data;
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new Error('OpenClaw sessions.describe returned an invalid session identity');
  }
  if (session.key !== normalized) {
    throw new Error('OpenClaw sessions.describe returned a different session key');
  }
  if (session.agentId !== undefined && String(session.agentId).trim() !== agentId) {
    throw new Error('OpenClaw sessions.describe returned a different agent identity');
  }
  const sessionId = typeof session.sessionId === 'string' ? session.sessionId.trim() : '';
  if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(sessionId)) {
    throw new Error('OpenClaw sessions.describe returned an invalid transcript identity');
  }
  const updatedAt = session.updatedAt;
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error('OpenClaw sessions.describe returned an invalid update identity');
  }
  return Object.freeze({ agentId, sessionKey: normalized, sessionId });
}

export type OpenClawChatHistory = {
  sessionKey: string;
  sessionId: string | null;
  messages: any[];
  offset?: number;
  nextOffset?: number;
  hasMore?: boolean;
  totalMessages?: number;
  inFlightRun?: any;
};

export async function getSessionHistory(
  sessionKey: string,
  options: { limit?: number; offset?: number; maxChars?: number } = {},
): Promise<{ ok: boolean; data?: OpenClawChatHistory; error?: string }> {
  localSessionAgentId(sessionKey);
  const limit = options.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    return { ok: false, error: 'OpenClaw chat.history limit is invalid' };
  }
  if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) {
    return { ok: false, error: 'OpenClaw chat.history offset is invalid' };
  }
  if (options.maxChars !== undefined && (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1)) {
    return { ok: false, error: 'OpenClaw chat.history maxChars is invalid' };
  }

  const result = await gatewayRpcCall('chat.history', {
    sessionKey,
    limit,
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
    ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
  }, 15000);
  if (!result.ok) return { ok: false, error: String(result.error || 'chat.history failed') };
  const payload = result.data;
  if (!payload || !Array.isArray(payload.messages)) {
    return { ok: false, error: 'OpenClaw chat.history returned an invalid payload' };
  }
  if (typeof payload.sessionKey === 'string' && payload.sessionKey !== sessionKey) {
    return { ok: false, error: 'OpenClaw chat.history returned a different session identity' };
  }
  const sessionId = payload.sessionId === undefined || payload.sessionId === null
    ? null
    : String(payload.sessionId).trim();
  if (sessionId !== null && (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(sessionId))) {
    return { ok: false, error: 'OpenClaw chat.history returned an invalid transcript identity' };
  }
  for (const [field, value] of [
    ['offset', payload.offset],
    ['nextOffset', payload.nextOffset],
    ['totalMessages', payload.totalMessages],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      return { ok: false, error: `OpenClaw chat.history returned an invalid ${field}` };
    }
  }
  if (payload.hasMore !== undefined && typeof payload.hasMore !== 'boolean') {
    return { ok: false, error: 'OpenClaw chat.history returned an invalid hasMore flag' };
  }
  return {
    ok: true,
    data: {
      sessionKey,
      sessionId,
      messages: payload.messages,
      ...(payload.offset !== undefined ? { offset: payload.offset } : {}),
      ...(payload.nextOffset !== undefined ? { nextOffset: payload.nextOffset } : {}),
      ...(payload.hasMore !== undefined ? { hasMore: payload.hasMore } : {}),
      ...(payload.totalMessages !== undefined ? { totalMessages: payload.totalMessages } : {}),
      ...(payload.inFlightRun !== undefined ? { inFlightRun: payload.inFlightRun } : {}),
    },
  };
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
 * `sessions.delete` parameters that remove a transcript without leaving an
 * archive. Stock OpenClaw 9.9 through 10.9 has neither: its params schema is
 * closed, so sending one is an INVALID_REQUEST. `purgeTranscript` is the name
 * proposed upstream (not shipped); `deleteTranscriptWithoutArchive` belongs to
 * the retired Portal core patch. Only a positive probe of the running Gateway
 * may select one.
 */
export const OPENCLAW_SESSION_PURGE_PARAMETERS = Object.freeze([
  'purgeTranscript',
  'deleteTranscriptWithoutArchive',
] as const);

export type OpenClawSessionPurgeParameter = typeof OPENCLAW_SESSION_PURGE_PARAMETERS[number];

function isOpenClawSessionPurgeParameter(value: unknown): value is OpenClawSessionPurgeParameter {
  return OPENCLAW_SESSION_PURGE_PARAMETERS.includes(value as OpenClawSessionPurgeParameter);
}

export type OpenClawSessionPurgeProbe = Readonly<{
  result: 'accepted' | 'rejected' | 'unknown';
  detail: string;
}>;

const SESSION_PURGE_PROBE_KEY_PREFIX = 'bridgesllm-purge-probe-';

/**
 * OC-PURGE: learn whether the running Gateway accepts a purge parameter without
 * mutating anything. The key is a fresh random session key and the CAS guards
 * name a random transcript, so no session can match:
 * - a closed (stock) params schema rejects the parameter during validation,
 *   before any handler runs ("unexpected property '<name>'");
 * - a Gateway that accepts the parameter reaches the handler's first CAS
 *   check, which refuses a missing entry ("changed before deletion") before
 *   any lifecycle drain or store write.
 * Every other answer is "unknown"; callers must not infer either capability.
 */
export async function probeSessionPurgeParameter(
  parameter: OpenClawSessionPurgeParameter,
  rawAgentId: string,
): Promise<OpenClawSessionPurgeProbe> {
  if (!isOpenClawSessionPurgeParameter(parameter)) {
    return { result: 'unknown', detail: 'unrecognized purge parameter' };
  }
  const agentId = String(rawAgentId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentId)) {
    return { result: 'unknown', detail: 'invalid agent identity' };
  }
  const probeKey = `agent:${agentId}:${SESSION_PURGE_PROBE_KEY_PREFIX}${crypto.randomUUID()}`;
  const response = await gatewayRpcCall('sessions.delete', {
    key: probeKey,
    agentId,
    expectedSessionId: crypto.randomUUID(),
    expectedSessionUpdatedAt: 0,
    [parameter]: true,
  }, 10000);
  if (response.ok) {
    if (
      response.data?.ok === true
      && response.data?.deleted === false
      && Array.isArray(response.data?.archived)
      && response.data.archived.length === 0
    ) {
      return { result: 'accepted', detail: 'parameter accepted; probe key not found' };
    }
    return { result: 'unknown', detail: 'unexpected sessions.delete probe receipt' };
  }
  const code = String(response.errorCode || '');
  const message = String(response.errorMessage || response.error || '');
  if (
    code === 'INVALID_REQUEST'
    && message.includes('invalid sessions.delete params')
    && message.includes(`unexpected property '${parameter}'`)
  ) {
    return { result: 'rejected', detail: 'closed sessions.delete params schema' };
  }
  if (
    code === 'INVALID_REQUEST'
    && message.includes(`Session ${probeKey} changed before deletion`)
  ) {
    return { result: 'accepted', detail: 'parameter accepted; CAS refused the probe key' };
  }
  return {
    result: 'unknown',
    detail: `${code || 'NO_CODE'}: ${message}`.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200),
  };
}

/**
 * Delete/end an OpenClaw session.
 */
export type DeleteOpenClawSessionOptions = {
  agentId?: string;
  deleteTranscript?: boolean;
  /** Set only from an `accepted` probeSessionPurgeParameter() of this Gateway. */
  purgeParameter?: OpenClawSessionPurgeParameter;
  expectedSessionId?: string | null;
  archivedOnly?: boolean;
  emitLifecycleHooks?: boolean;
};

export type DeleteOpenClawSessionResult = {
  ok: boolean;
  key?: string;
  deleted?: boolean;
  archived?: string[];
  error?: string;
};

export async function deleteSession(
  sessionKey: string,
  options: DeleteOpenClawSessionOptions = {},
): Promise<DeleteOpenClawSessionResult> {
  console.log(`[Gateway RPC] Deleting session: key=${sessionKey}`);
  const inferredAgentId = localSessionAgentId(sessionKey);
  const agentId = options.agentId === undefined ? inferredAgentId : String(options.agentId).trim();
  if (agentId !== inferredAgentId) {
    return { ok: false, error: 'OpenClaw deletion agent identity does not match the session key' };
  }
  if (options.purgeParameter !== undefined) {
    if (!isOpenClawSessionPurgeParameter(options.purgeParameter)) {
      return { ok: false, error: 'OpenClaw transcript purge parameter is not recognized' };
    }
    // Both purge contracts refuse an archive request in the same mutation.
    if (options.deleteTranscript !== undefined || options.archivedOnly !== undefined) {
      return { ok: false, error: 'OpenClaw transcript purge cannot be combined with archive options' };
    }
  }
  const described = await getSessionInfo(sessionKey);
  if (!described.ok) {
    if (/session not found|not found/i.test(String(described.error || ''))) {
      return { ok: true, key: sessionKey, deleted: false, archived: [] };
    }
    return { ok: false, error: described.error || 'sessions.describe failed before deletion' };
  }
  const describedSessionId = typeof described.data?.sessionId === 'string'
    ? described.data.sessionId.trim()
    : '';
  if (!describedSessionId) {
    return { ok: false, error: 'OpenClaw session has no immutable transcript identity' };
  }
  if (
    options.expectedSessionId !== undefined
    && options.expectedSessionId !== null
    && options.expectedSessionId !== describedSessionId
  ) {
    return { ok: false, error: 'OpenClaw session identity changed before deletion' };
  }
  const updatedAt = described.data?.updatedAt;
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    return { ok: false, error: 'OpenClaw session has no valid update identity for deletion' };
  }

  const result = await gatewayRpcCall('sessions.delete', {
    key: sessionKey,
    agentId,
    expectedSessionId: describedSessionId,
    expectedSessionUpdatedAt: updatedAt,
    ...(options.deleteTranscript !== undefined ? { deleteTranscript: options.deleteTranscript } : {}),
    ...(options.purgeParameter !== undefined ? { [options.purgeParameter]: true } : {}),
    ...(options.archivedOnly !== undefined ? { archivedOnly: options.archivedOnly } : {}),
    ...(options.emitLifecycleHooks !== undefined ? { emitLifecycleHooks: options.emitLifecycleHooks } : {}),
  }, 20000);
  
  if (result.ok) {
    if (
      result.data?.ok !== true
      || typeof result.data?.deleted !== 'boolean'
      || !Array.isArray(result.data?.archived)
      || result.data.archived.some((entry: unknown) => typeof entry !== 'string')
    ) {
      return { ok: false, error: 'OpenClaw sessions.delete returned an invalid payload' };
    }
    console.log(`[Gateway RPC] Session deleted successfully: ${sessionKey}`);
    return {
      ok: true,
      key: typeof result.data.key === 'string' ? result.data.key : sessionKey,
      deleted: result.data.deleted,
      archived: result.data.archived,
    };
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
    // This helper knows no sender, so the text never runs OpenClaw chat
    // commands (services/openclawChatCommandAuthority.ts).
    ...OPENCLAW_PLAIN_TEXT_CHAT_PARAMS,
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
export async function listGatewayModels(agentId?: string): Promise<{ ok: boolean; models?: any[]; error?: string }> {
  const result = await gatewayRpcCall('models.list', agentId ? { agentId } : {});
  
  if (result.ok) {
    return { ok: true, models: result.data?.models || [] };
  }
  
  return { ok: false, error: String(result.error) };
}
