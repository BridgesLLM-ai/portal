/**
 * Live Agent Work state for the open conversation.
 *
 * `/work` is the authority. Socket `work.changed` signals are hints that only cause a
 * re-read: duplicates, reordering and loss are harmless because every refresh replaces
 * the whole snapshot. Results that belong to another conversation or to a read that
 * started before a newer goal readback are discarded.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { gatewayAPI } from '../../../api/endpoints';
import type { WsManager } from '../../../contexts/ChatStateProvider';
import {
  classifyReadFailure,
  fetchAgentActivity,
  fetchSessionWork,
  isAbortError,
  isQualifiedSessionKey,
  type AgentActivity,
  type SessionGoal,
  type SessionWork,
} from './agentWorkApi';
import { isActiveRun } from './agentWorkModel';
import { nativeAgentChatSessionId } from '../../../utils/nativeAgentSession';

export interface CoalescedRefresher {
  request(immediate?: boolean): void;
  dispose(): void;
}

/**
 * Debounce signals (default 250 ms) with a maximum wait so a steady stream of signals
 * cannot starve the read, and never run two reads at once.
 */
export function createCoalescedRefresher(
  run: () => Promise<void>,
  options: { debounceMs?: number; maxWaitMs?: number } = {},
): CoalescedRefresher {
  const debounceMs = options.debounceMs ?? 250;
  const maxWaitMs = options.maxWaitMs ?? 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstRequestAt: number | null = null;
  let inFlight = false;
  let again = false;
  let disposed = false;
  const fire = () => {
    timer = null;
    firstRequestAt = null;
    if (disposed) return;
    if (inFlight) { again = true; return; }
    inFlight = true;
    void run().catch(() => undefined).finally(() => {
      inFlight = false;
      if (again && !disposed) { again = false; request(); }
    });
  };
  function request(immediate = false) {
    if (disposed) return;
    const now = Date.now();
    if (firstRequestAt === null) firstRequestAt = now;
    if (timer !== null) clearTimeout(timer);
    const wait = immediate ? 0 : Math.max(0, Math.min(debounceMs, firstRequestAt + maxWaitMs - now));
    timer = setTimeout(fire, wait);
  }
  return {
    request,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export type WorkStatus =
  | 'disabled'
  | 'resolving'
  | 'loading'
  | 'ready'
  | 'not-found'
  | 'unsupported'
  | 'forbidden'
  | 'unavailable';

interface WorkSnapshot {
  key: string | null;
  status: WorkStatus;
  work: SessionWork | null;
  loadedAt: number | null;
  /** The last refresh failed; `work` is the previous good snapshot. */
  stale: boolean;
  refreshing: boolean;
}

export interface AgentWorkState extends WorkSnapshot {
  /** Read now (explicit user action, reconnect). */
  refresh(): void;
  /** Coalesced read for signals and settled goal changes. */
  requestRefresh(): void;
  /** Show a goal readback for `key` and ignore reads that started before it. */
  applyGoalReadback(key: string, goal: SessionGoal | null): void;
}

type Resolution =
  | { status: 'disabled' | 'resolving' | 'missing' | 'error'; key: null }
  | { status: 'resolved'; key: string };

/**
 * `/api/agent-work` only accepts exact identities. For OpenClaw a Portal alias (`main`,
 * `new-…`) is resolved through the existing alias-aware session read, never guessed in the
 * browser. A native harness chat is addressed by its exact Portal session id; before its
 * first turn it has none, so there is nothing to read yet.
 */
function useWorkSessionKey(enabled: boolean, session: string, provider: string): Resolution & { retry(): void } {
  const trimmed = String(session || '').trim();
  const native = provider !== 'OPENCLAW';
  const qualified = native
    ? nativeAgentChatSessionId(provider, trimmed)
    : isQualifiedSessionKey(trimmed) ? trimmed : null;
  const [lookup, setLookup] = useState<{ session: string; key: string | null; status: 'resolved' | 'missing' | 'error' } | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled || qualified || !trimmed || native) return undefined;
    let cancelled = false;
    gatewayAPI.sessionInfo(trimmed, { silent: true }).then((data: any) => {
      if (cancelled) return;
      const key = data?.session?.key;
      setLookup(isQualifiedSessionKey(key)
        ? { session: trimmed, key, status: 'resolved' }
        : { session: trimmed, key: null, status: data?.missing === true || data?.session === null ? 'missing' : 'error' });
    }, () => {
      if (!cancelled) setLookup({ session: trimmed, key: null, status: 'error' });
    });
    return () => { cancelled = true; };
  }, [enabled, qualified, trimmed, native, nonce]);
  const retry = useCallback(() => setNonce((value) => value + 1), []);
  if (!enabled) return { status: 'disabled', key: null, retry };
  if (qualified) return { status: 'resolved', key: qualified, retry };
  if (!trimmed || native) return { status: 'missing', key: null, retry };
  if (!lookup || lookup.session !== trimmed) return { status: 'resolving', key: null, retry };
  return lookup.status === 'resolved' && lookup.key
    ? { status: 'resolved', key: lookup.key, retry }
    : { status: lookup.status === 'missing' ? 'missing' : 'error', key: null, retry };
}

/** Something can still change without a signal reaching us. */
export function workHasLiveState(work: SessionWork | null): boolean {
  if (!work) return false;
  return isActiveRun(work.session.status)
    || work.goal?.status === 'active'
    || work.children.some((child) => isActiveRun(child.status));
}

const EMPTY: WorkSnapshot = { key: null, status: 'disabled', work: null, loadedAt: null, stale: false, refreshing: false };
const FALLBACK_POLL_MS = 30_000;

export function useAgentWork({ enabled, session, wsManager, provider = 'OPENCLAW' }: {
  enabled: boolean;
  session: string;
  wsManager: WsManager | null;
  /** Agent Chat harness; native harnesses are addressed by their Portal session id. */
  provider?: string;
}): AgentWorkState {
  const resolution = useWorkSessionKey(enabled, session, String(provider || 'OPENCLAW').trim().toUpperCase());
  const key = resolution.key;
  const [snapshot, setSnapshot] = useState<WorkSnapshot>(EMPTY);
  const keyRef = useRef<string | null>(null);
  const refresherRef = useRef<CoalescedRefresher | null>(null);
  const seqRef = useRef(0);
  const minSeqRef = useRef(0);
  const workRef = useRef<SessionWork | null>(null);
  const retryResolutionRef = useRef(resolution.retry);
  retryResolutionRef.current = resolution.retry;
  const resolutionStatusRef = useRef(resolution.status);
  resolutionStatusRef.current = resolution.status;
  keyRef.current = key;

  useEffect(() => {
    workRef.current = null;
    if (!enabled || !key) {
      refresherRef.current = null;
      return undefined;
    }
    let alive = true;
    let controller: AbortController | null = null;
    const patch = (update: (current: WorkSnapshot) => WorkSnapshot) => {
      setSnapshot((current) => (current.key === key ? update(current) : current));
    };
    const load = async () => {
      const seq = ++seqRef.current;
      controller = new AbortController();
      patch((current) => ({ ...current, refreshing: true }));
      try {
        const work = await fetchSessionWork(key, controller.signal);
        if (!alive || seq < minSeqRef.current) return;
        workRef.current = work;
        patch(() => ({ key, status: 'ready', work, loadedAt: Date.now(), stale: false, refreshing: false }));
      } catch (error) {
        if (!alive || isAbortError(error) || seq < minSeqRef.current) return;
        const failure = classifyReadFailure(error);
        // An authorization change reloads the workspace; do not paint over it.
        if (failure.kind === 'stale-authorization') return;
        patch((current) => {
          if (failure.kind === 'unavailable' && current.work) return { ...current, stale: true, refreshing: false };
          workRef.current = null;
          return { key, status: failure.kind as WorkStatus, work: null, loadedAt: null, stale: false, refreshing: false };
        });
      } finally {
        if (alive) patch((current) => (current.refreshing ? { ...current, refreshing: false } : current));
      }
    };
    const refresher = createCoalescedRefresher(load);
    refresherRef.current = refresher;
    setSnapshot({ key, status: 'loading', work: null, loadedAt: null, stale: false, refreshing: true });
    refresher.request(true);

    const onVisible = () => {
      if (document.visibilityState === 'visible') refresher.request();
    };
    document.addEventListener('visibilitychange', onVisible);
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible' && workHasLiveState(workRef.current)) refresher.request();
    }, FALLBACK_POLL_MS);
    return () => {
      alive = false;
      refresher.dispose();
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(poll);
      if (refresherRef.current === refresher) refresherRef.current = null;
    };
  }, [enabled, key]);

  useEffect(() => {
    if (!enabled || !wsManager) return undefined;
    const handler = (data: any) => {
      if (!data || typeof data !== 'object' || typeof data.sessionKey !== 'string') return;
      if (data.sessionKey !== keyRef.current) return;
      if ((data.type === 'work.changed' && data.v === 1) || data.type === 'history_changed') {
        refresherRef.current?.request();
      }
    };
    wsManager.addHandler(handler);
    const offReconnect = wsManager.onReconnect(() => {
      if (resolutionStatusRef.current === 'error') retryResolutionRef.current();
      refresherRef.current?.request(true);
    });
    return () => {
      wsManager.removeHandler(handler);
      offReconnect();
    };
  }, [enabled, wsManager]);

  const refresh = useCallback(() => {
    if (resolutionStatusRef.current === 'error') retryResolutionRef.current();
    refresherRef.current?.request(true);
  }, []);
  const requestRefresh = useCallback(() => { refresherRef.current?.request(); }, []);
  const applyGoalReadback = useCallback((target: string, goal: SessionGoal | null) => {
    if (target !== keyRef.current) return;
    // Reads already under way were answered before this readback; drop them.
    minSeqRef.current = seqRef.current + 1;
    setSnapshot((current) => {
      if (current.key !== target || !current.work) return current;
      const work = { ...current.work, goal };
      workRef.current = work;
      return { ...current, work, stale: false };
    });
    refresherRef.current?.request(true);
  }, []);

  let view: WorkSnapshot;
  if (resolution.status === 'disabled') view = EMPTY;
  else if (resolution.status === 'resolving') view = { ...EMPTY, status: 'resolving' };
  else if (resolution.status === 'missing') view = { ...EMPTY, status: 'not-found' };
  else if (resolution.status === 'error') view = { ...EMPTY, status: 'unavailable' };
  else if (snapshot.key !== key) view = { ...EMPTY, key, status: 'loading', refreshing: true };
  else view = snapshot;
  return { ...view, refresh, requestRefresh, applyGoalReadback };
}

export type ActivityStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'forbidden' | 'unavailable';

export interface AgentActivityState {
  status: ActivityStatus;
  activity: AgentActivity | null;
  stale: boolean;
  loadedAt: number | null;
  refresh(): void;
}

const ACTIVITY_POLL_MS = 15_000;

/** Other conversations' activity, read only while the panel is open. */
export function useAgentActivity({ enabled, wsManager }: { enabled: boolean; wsManager: WsManager | null }): AgentActivityState {
  const [state, setState] = useState<Omit<AgentActivityState, 'refresh'>>({ status: 'idle', activity: null, stale: false, loadedAt: null });
  const refresherRef = useRef<CoalescedRefresher | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let controller: AbortController | null = null;
    const load = async () => {
      controller = new AbortController();
      setState((current) => (current.activity ? current : { ...current, status: 'loading' }));
      try {
        const activity = await fetchAgentActivity(controller.signal);
        if (alive) setState({ status: 'ready', activity, stale: false, loadedAt: Date.now() });
      } catch (error) {
        if (!alive || isAbortError(error)) return;
        const failure = classifyReadFailure(error);
        if (failure.kind === 'stale-authorization') return;
        const status: ActivityStatus = failure.kind === 'forbidden' ? 'forbidden'
          : failure.kind === 'unavailable' ? 'unavailable' : 'unsupported';
        setState((current) => (status === 'unavailable' && current.activity
          ? { ...current, stale: true }
          : { status, activity: null, stale: false, loadedAt: null }));
      }
    };
    const refresher = createCoalescedRefresher(load, { debounceMs: 1000, maxWaitMs: 3000 });
    refresherRef.current = refresher;
    refresher.request(true);
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresher.request();
    }, ACTIVITY_POLL_MS);
    return () => {
      alive = false;
      refresher.dispose();
      controller?.abort();
      window.clearInterval(poll);
      if (refresherRef.current === refresher) refresherRef.current = null;
    };
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !wsManager) return undefined;
    const handler = (data: any) => {
      if (data?.type === 'work.changed' && data.v === 1) refresherRef.current?.request();
    };
    wsManager.addHandler(handler);
    const offReconnect = wsManager.onReconnect(() => refresherRef.current?.request(true));
    return () => {
      wsManager.removeHandler(handler);
      offReconnect();
    };
  }, [enabled, wsManager]);
  const refresh = useCallback(() => refresherRef.current?.request(true), []);
  return { ...state, refresh };
}
