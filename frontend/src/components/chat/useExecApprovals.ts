/**
 * useExecApprovals — Hook to listen for exec approval events via SSE.
 * 
 * This connects to /api/gateway/approvals/stream and receives:
 * - exec_approval_requested: When the agent requests command approval
 * - exec_approval_resolved: When an approval is resolved (by any client)
 * 
 * This provides a global approval listener that works even when no chat
 * stream is active (e.g., the agent is running a background task).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import client from '../../api/client';
import {
  pruneExpiredExecApprovals,
  removeExecApproval,
  upsertExecApproval,
} from '../../utils/execApprovalQueue';

const DEBUG_EXEC_APPROVALS = import.meta.env.DEV;
const debugLog = (...args: unknown[]) => {
  if (DEBUG_EXEC_APPROVALS) console.debug(...args);
};

export interface ExecApprovalRequest {
  id: string;
  request: {
    command: string;
    cwd?: string;
    host?: string;
    security?: string;
    ask?: string;
    agentId?: string;
    sessionKey?: string;
    resolvedPath?: string;
  };
  createdAtMs: number;
  expiresAtMs: number;
}

export interface UseExecApprovalsReturn {
  pendingApproval: ExecApprovalRequest | null;
  pendingApprovals: ExecApprovalRequest[];
  pendingApprovalCount: number;
  resolveApproval: (approvalId: string, decision: 'allow-once' | 'deny' | 'allow-always') => Promise<void>;
  dismissApproval: (approvalId?: string) => void;
  isConnected: boolean;
}

export function useExecApprovals(options?: { enabled?: boolean }): UseExecApprovalsReturn {
  const enabled = options?.enabled !== false;
  const [pendingApprovals, setPendingApprovals] = useState<ExecApprovalRequest[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);

  // Resolve an approval
  const resolveApproval = useCallback(async (
    approvalId: string,
    decision: 'allow-once' | 'deny' | 'allow-always',
  ) => {
    try {
      const response = await client.post('/gateway/exec-approval/resolve', {
        approvalId,
        decision,
      });
      if (response.data?.ok) {
        debugLog('[useExecApprovals] Approval resolved:', decision);
        setPendingApprovals((prev) => removeExecApproval(prev, approvalId));
        return;
      }
      throw new Error('Approval did not complete');
    } catch (err) {
      console.error('[useExecApprovals] Failed to resolve approval:', err);
      // Keep the pending approval visible on failure so the user can retry or deny explicitly.
      throw err;
    }
  }, []);

  // Dismiss approval without resolving (e.g., expired or intentionally hidden)
  const dismissApproval = useCallback((approvalId?: string) => {
    setPendingApprovals((prev) => {
      if (!prev.length) return prev;
      return approvalId ? removeExecApproval(prev, approvalId) : prev.slice(1);
    });
  }, []);

  // Connect to SSE stream
  const connect = useCallback(() => {
    // Don't reconnect if we're already connected
    if (eventSourceRef.current && eventSourceRef.current.readyState === EventSource.OPEN) {
      return;
    }

    // Close existing connection if any
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const apiUrl = import.meta.env.VITE_API_URL || '';
        
    // EventSource doesn't support Authorization header, so we'll rely on
    // cookie-based auth (the authenticateToken middleware checks both).
    // For token-only auth, we'd need a polyfill like eventsource-polyfill.
    
    // Build URL with credentials
    const url = `${apiUrl}/gateway/approvals/stream`;
    
    debugLog('[useExecApprovals] Connecting to SSE stream:', url);
    
    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => {
      debugLog('[useExecApprovals] SSE stream connected');
      setIsConnected(true);
      reconnectAttemptsRef.current = 0;
    };

    es.onmessage = (event) => {
      if (!event.data || event.data.trim() === '') return;
      
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'connected') {
          debugLog('[useExecApprovals] SSE connected, persistent WS:', data.persistentWsConnected);
          return;
        }

        if (data.type === 'exec_approval_requested') {
          const approval = data.approval as ExecApprovalRequest;
          if (approval?.id) {
            debugLog('[useExecApprovals] Approval requested:', approval.id);
            setPendingApprovals((prev) => upsertExecApproval(prev, approval));
          }
          return;
        }

        if (data.type === 'exec_approval_resolved') {
          const resolved = data.resolved;
          if (resolved?.id) {
            debugLog('[useExecApprovals] Approval resolved:', resolved.id, resolved.decision);
            setPendingApprovals((prev) => removeExecApproval(prev, resolved.id));
          }
          return;
        }
      } catch (err) {
        // Ignore parse errors (might be keepalive comments)
      }
    };

    es.onerror = (err) => {
      console.error('[useExecApprovals] SSE error:', err);
      setIsConnected(false);
      
      // Close and schedule reconnect
      es.close();
      eventSourceRef.current = null;
      
      // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
      reconnectAttemptsRef.current++;
      
      debugLog(`[useExecApprovals] Scheduling reconnect in ${delay}ms`);
      reconnectTimerRef.current = setTimeout(connect, delay);
    };
  }, []);

  // Connect only when enabled. Agent Chats can defer this fallback SSE until the
  // critical initial history load is finished, so approval listening does not steal
  // startup bandwidth from the transcript itself.
  useEffect(() => {
    if (!enabled) {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setIsConnected(false);
      return;
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setIsConnected(false);
    };
  }, [connect, enabled]);

  // Auto-dismiss expired approvals
  useEffect(() => {
    if (!pendingApprovals.length) return;

    const pruneExpired = () => {
      setPendingApprovals((prev) => pruneExpiredExecApprovals(prev));
    };

    pruneExpired();
    const interval = setInterval(pruneExpired, 500);

    return () => clearInterval(interval);
  }, [pendingApprovals.length]);

  const pendingApproval = pendingApprovals[0] || null;

  return {
    pendingApproval,
    pendingApprovals,
    pendingApprovalCount: pendingApprovals.length,
    resolveApproval,
    dismissApproval,
    isConnected,
  };
}
