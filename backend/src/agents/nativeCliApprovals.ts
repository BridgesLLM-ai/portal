import { randomUUID } from 'crypto';
import type { AgentProviderName } from './AgentProvider.interface';
import type { ExecApprovalRequest, ExecApprovalResolved } from './providers/PersistentGatewayWs';

export type NativeCliApprovalDecision = 'allow-once' | 'deny' | 'allow-always';

export interface NativeCliApprovalDraft {
  providerName: AgentProviderName;
  sessionId: string;
  command: string;
  cwd?: string;
  host?: string;
  security?: string;
  ask?: string;
  agentId?: string;
  resolvedPath?: string;
  timeoutMs?: number;
  onRequest?: ApprovalRequestCallback;
}

type ApprovalRequestCallback = (approval: ExecApprovalRequest) => void;
type ApprovalResolvedCallback = (resolved: ExecApprovalResolved) => void;

interface PendingNativeApproval {
  approval: ExecApprovalRequest;
  resolve: (decision: NativeCliApprovalDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingNativeApproval>();
const requestListeners = new Set<ApprovalRequestCallback>();
const resolvedListeners = new Set<ApprovalResolvedCallback>();

function emitRequest(approval: ExecApprovalRequest): void {
  for (const listener of requestListeners) {
    try { listener(approval); } catch (error: any) {
      console.error('[NativeCliApprovals] request listener error:', error?.message || error);
    }
  }
}

function emitResolved(resolved: ExecApprovalResolved): void {
  for (const listener of resolvedListeners) {
    try { listener(resolved); } catch (error: any) {
      console.error('[NativeCliApprovals] resolved listener error:', error?.message || error);
    }
  }
}

export function onNativeCliApprovalRequest(callback: ApprovalRequestCallback): () => void {
  requestListeners.add(callback);
  return () => requestListeners.delete(callback);
}

export function onNativeCliApprovalResolved(callback: ApprovalResolvedCallback): () => void {
  resolvedListeners.add(callback);
  return () => resolvedListeners.delete(callback);
}

export function requestNativeCliApproval(draft: NativeCliApprovalDraft): Promise<NativeCliApprovalDecision> {
  const createdAtMs = Date.now();
  const timeoutMs = Math.max(10_000, Math.min(draft.timeoutMs || 120_000, 10 * 60_000));
  const approval: ExecApprovalRequest = {
    id: `native-${draft.providerName.toLowerCase()}-${randomUUID()}`,
    request: {
      command: draft.command,
      cwd: draft.cwd,
      host: draft.host,
      security: draft.security || 'native-cli',
      ask: draft.ask,
      agentId: draft.agentId,
      sessionKey: draft.sessionId,
      resolvedPath: draft.resolvedPath,
    },
    createdAtMs,
    expiresAtMs: createdAtMs + timeoutMs,
  };

  return new Promise((resolve) => {
    const finish = (decision: NativeCliApprovalDecision) => {
      const current = pending.get(approval.id);
      if (!current) return;
      clearTimeout(current.timeout);
      pending.delete(approval.id);
      emitResolved({ id: approval.id, decision });
      resolve(decision);
    };

    const timeout = setTimeout(() => finish('deny'), timeoutMs);
    pending.set(approval.id, { approval, resolve: finish, timeout });
    if (draft.onRequest) {
      try { draft.onRequest(approval); } catch (error: any) {
        console.error('[NativeCliApprovals] direct request listener error:', error?.message || error);
      }
    }
    emitRequest(approval);
  });
}

export function resolveNativeCliApproval(
  approvalId: string,
  decision: NativeCliApprovalDecision,
): { ok: boolean; error?: string } {
  const current = pending.get(approvalId);
  if (!current) return { ok: false, error: 'not_found' };
  current.resolve(decision);
  return { ok: true };
}

export function getPendingNativeCliApproval(approvalId: string): ExecApprovalRequest | null {
  return pending.get(approvalId)?.approval || null;
}

/**
 * Snapshot of all currently-pending (non-expired) native CLI approvals.
 *
 * Used to replay in-flight approval requests to a client that connects (or
 * reconnects) after the original request was emitted. Without this, a reload /
 * chat switch / WS or SSE reconnect during a Claude Code turn that is parked
 * awaiting approval would never re-deliver the popup, and the request would sit
 * pending until it timed out and auto-denied.
 */
export function listPendingNativeCliApprovals(now = Date.now()): ExecApprovalRequest[] {
  const approvals: ExecApprovalRequest[] = [];
  for (const entry of pending.values()) {
    if (entry.approval.expiresAtMs > now) approvals.push(entry.approval);
  }
  return approvals.sort((a, b) => a.createdAtMs - b.createdAtMs);
}
