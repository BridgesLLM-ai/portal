import crypto from 'crypto';
import type { ChatBridgeTurnBinding } from './contract';

/**
 * Process-local registry of live bridge capabilities. A capability exists only
 * between turn start and settlement; a Portal restart therefore revokes every
 * outstanding token, which is the safe direction.
 */

export interface ChatBridgeWidgetRecord {
  readonly widgetId: string;
  readonly title: string;
  /** Harness tool-call id once the turn's own stream has bound it. */
  boundToolCallId: string | null;
}

export interface ChatBridgeTurnRecord {
  readonly binding: ChatBridgeTurnBinding;
  readonly tokenDigest: string;
  readonly createdAt: number;
  readonly widgets: Map<string, ChatBridgeWidgetRecord>;
  readonly questionIds: Set<string>;
  readonly abort: AbortController;
  revoked: boolean;
}

const MAX_LIVE_TURNS = 256;
const turnsByDigest = new Map<string, ChatBridgeTurnRecord>();

function digest(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function frozenBinding(binding: ChatBridgeTurnBinding): ChatBridgeTurnBinding {
  const authorizationVersion = Number(binding.authorizationVersion);
  if (
    !binding.provider
    || typeof binding.portalSessionId !== 'string' || !binding.portalSessionId.trim()
    || typeof binding.runId !== 'string' || !binding.runId.trim()
    || typeof binding.userId !== 'string' || !binding.userId.trim()
    || !Number.isSafeInteger(authorizationVersion) || authorizationVersion < 1
  ) {
    throw new Error('Chat bridge turn binding is incomplete');
  }
  return Object.freeze({
    provider: binding.provider,
    portalSessionId: binding.portalSessionId,
    runId: binding.runId,
    userId: binding.userId,
    authorizationVersion,
  });
}

export function mintChatBridgeTurn(binding: ChatBridgeTurnBinding): { token: string; record: ChatBridgeTurnRecord } {
  if (turnsByDigest.size >= MAX_LIVE_TURNS) {
    throw new Error('Too many live chat bridge turns');
  }
  for (const record of turnsByDigest.values()) {
    if (record.binding.runId === binding.runId && record.binding.portalSessionId === binding.portalSessionId) {
      throw new Error('This run already holds a chat bridge capability');
    }
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const record: ChatBridgeTurnRecord = {
    binding: frozenBinding(binding),
    tokenDigest: digest(token),
    createdAt: Date.now(),
    widgets: new Map(),
    questionIds: new Set(),
    abort: new AbortController(),
    revoked: false,
  };
  turnsByDigest.set(record.tokenDigest, record);
  return { token, record };
}

/** Lookup is by SHA-256 digest, so the presented secret is never compared byte-wise. */
export function resolveChatBridgeToken(token: unknown): ChatBridgeTurnRecord | null {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return null;
  }
  const record = turnsByDigest.get(digest(token));
  return record && !record.revoked ? record : null;
}

export function revokeChatBridgeTurn(record: ChatBridgeTurnRecord): void {
  if (record.revoked) return;
  record.revoked = true;
  record.abort.abort();
  turnsByDigest.delete(record.tokenDigest);
}

export function __resetChatBridgeRegistryForTests(): void {
  for (const record of turnsByDigest.values()) {
    record.revoked = true;
    record.abort.abort();
  }
  turnsByDigest.clear();
}
