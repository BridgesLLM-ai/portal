import { useCallback, useEffect, useRef, useState } from 'react';
import {
  rememberedPortalUpdateCheckpoint,
  rememberedPortalUpdateOperation,
} from '../utils/portalUpdateSession';

export const PORTAL_UPDATE_SESSION_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

type PortalUpdateSessionRecoveryOptions = {
  enabled: boolean;
  restoreSession: () => Promise<boolean>;
};

export function usePortalUpdateSessionRecovery({
  enabled,
  restoreSession,
}: PortalUpdateSessionRecoveryOptions) {
  const rememberedOperationId = enabled ? rememberedPortalUpdateOperation() : null;
  const rememberedCheckpoint = rememberedOperationId
    ? rememberedPortalUpdateCheckpoint(rememberedOperationId)
    : null;
  // A terminal browser checkpoint is not evidence of a restart still in
  // progress. Ignore it so an unrelated later outage uses the ordinary
  // fail-closed session screen instead of stale updater copy.
  const checkpointIsTerminal = rememberedCheckpoint
    ? !['starting', 'running', 'recovering'].includes(rememberedCheckpoint.status)
    : false;
  const operationId = checkpointIsTerminal ? null : rememberedOperationId;
  const checkpoint = operationId ? rememberedCheckpoint : null;
  const [attemptCount, setAttemptCount] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setAttemptCount(0);
  }, [operationId]);

  const retryNow = useCallback(async (): Promise<boolean> => {
    if (!operationId || inFlightRef.current) return false;
    inFlightRef.current = true;
    if (mountedRef.current) setIsRetrying(true);
    try {
      return await restoreSession();
    } catch {
      return false;
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setIsRetrying(false);
        setAttemptCount((count) => count + 1);
      }
    }
  }, [operationId, restoreSession]);

  useEffect(() => {
    if (!enabled || !operationId || isRetrying) return undefined;
    const delayIndex = Math.min(attemptCount, PORTAL_UPDATE_SESSION_RETRY_DELAYS_MS.length - 1);
    const timer = window.setTimeout(() => {
      void retryNow();
    }, PORTAL_UPDATE_SESSION_RETRY_DELAYS_MS[delayIndex]);
    return () => window.clearTimeout(timer);
  }, [attemptCount, enabled, isRetrying, operationId, retryNow]);

  return {
    operationId,
    checkpoint,
    attemptCount,
    isRetrying,
    retryNow,
  };
}
