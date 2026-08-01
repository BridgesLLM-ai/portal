import { useCallback, useEffect, useRef, useState } from 'react';
import {
  refreshPublicSettings,
  type PortalFeatureAvailability,
  usePublicSettings,
} from './usePublicSettings';

const CAPABILITY_CHECK_TIMEOUT_MS = 4_000;

export function usePasswordRecoveryCapability() {
  const publicSettings = usePublicSettings();
  const liveCapability = publicSettings?.mail;
  const [observedCapability, setObservedCapability] = useState<PortalFeatureAvailability>();
  const [checkState, setCheckState] = useState<'checking' | 'resolved' | 'failed'>(
    liveCapability ? 'resolved' : 'checking',
  );
  const [retrying, setRetrying] = useState(false);
  const retryInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (liveCapability) {
      setObservedCapability(undefined);
      setCheckState('resolved');
      return;
    }

    setObservedCapability(undefined);
    setCheckState('checking');
    const timeoutId = window.setTimeout(() => {
      setCheckState('failed');
    }, CAPABILITY_CHECK_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [liveCapability]);

  const retry = useCallback(async () => {
    if (retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    setRetrying(true);
    setCheckState('checking');

    let timeoutId: number | undefined;
    try {
      const settings = await Promise.race([
        refreshPublicSettings(),
        new Promise<null>((resolve) => {
          timeoutId = window.setTimeout(() => resolve(null), CAPABILITY_CHECK_TIMEOUT_MS);
        }),
      ]);
      if (!mountedRef.current) return;
      if (settings?.mail) {
        setObservedCapability(settings.mail);
        setCheckState('resolved');
      } else {
        setObservedCapability(undefined);
        setCheckState('failed');
      }
    } catch {
      if (!mountedRef.current) return;
      setObservedCapability(undefined);
      setCheckState('failed');
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      retryInFlightRef.current = false;
      if (mountedRef.current) setRetrying(false);
    }
  }, []);

  return {
    capability: liveCapability ?? observedCapability,
    checkState,
    retry,
    retrying,
  };
}
