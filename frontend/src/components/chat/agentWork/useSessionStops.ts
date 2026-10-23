/**
 * Stop chosen work from Agent Work through the existing session-scoped abort.
 *
 * Stopping takes two steps (ask, then confirm) because rows move as they refresh. One request
 * per conversation at a time, nothing is retried automatically, and only an answer confirming
 * this exact key counts as stopped. Outcomes are kept per key with the label the user saw.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { postSessionStop, type StopOutcome } from './agentWorkApi';

export type StopPhase = 'confirm' | 'stopping' | StopOutcome;

export interface StopEntry {
  key: string;
  label: string;
  phase: StopPhase;
  at: number;
}

export interface SessionStopsState {
  /** Newest first. */
  entries: StopEntry[];
  phaseOf(key: string): StopPhase | null;
  ask(key: string, label: string): void;
  cancel(key: string): void;
  confirm(key: string): void;
  dismiss(key: string): void;
}

export const isStopOutcome = (phase: StopPhase): phase is StopOutcome => phase !== 'confirm' && phase !== 'stopping';

/** Confirmations and "may have finished" answers fade; failures stay until dismissed. */
const FADE_MS: Partial<Record<StopPhase, number>> = { stopped: 20_000, 'not-confirmed': 20_000 };

export function useSessionStops(onSettled: (key: string) => void): SessionStopsState {
  const entriesRef = useRef(new Map<string, StopEntry>());
  const [entries, setEntries] = useState<StopEntry[]>([]);
  const inFlight = useRef(new Set<string>());
  const timers = useRef(new Map<string, number>());
  const mounted = useRef(true);
  const settled = useRef(onSettled);
  settled.current = onSettled;

  useEffect(() => {
    mounted.current = true;
    const pending = timers.current;
    return () => {
      mounted.current = false;
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const publish = useCallback(() => {
    if (mounted.current) setEntries([...entriesRef.current.values()].sort((a, b) => b.at - a.at));
  }, []);

  const put = useCallback((key: string, entry: StopEntry | null) => {
    const timer = timers.current.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(key);
    }
    if (entry) entriesRef.current.set(key, entry);
    else entriesRef.current.delete(key);
    const fade = entry ? FADE_MS[entry.phase] : undefined;
    if (entry && fade) {
      timers.current.set(key, window.setTimeout(() => {
        timers.current.delete(key);
        if (entriesRef.current.get(key) !== entry) return;
        entriesRef.current.delete(key);
        publish();
      }, fade));
    }
    publish();
  }, [publish]);

  const ask = useCallback((key: string, label: string) => {
    if (inFlight.current.has(key)) return;
    put(key, { key, label, phase: 'confirm', at: Date.now() });
  }, [put]);

  const cancel = useCallback((key: string) => {
    if (entriesRef.current.get(key)?.phase === 'confirm') put(key, null);
  }, [put]);

  const dismiss = useCallback((key: string) => {
    if (!inFlight.current.has(key)) put(key, null);
  }, [put]);

  const confirm = useCallback((key: string) => {
    const entry = entriesRef.current.get(key);
    // Only from the confirmation step, and never twice at once for one conversation.
    if (!entry || entry.phase !== 'confirm' || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    put(key, { ...entry, phase: 'stopping', at: Date.now() });
    void postSessionStop(key)
      .catch((): StopOutcome => 'unknown')
      .then((outcome) => {
        inFlight.current.delete(key);
        if (!mounted.current) return;
        put(key, { ...entry, phase: outcome, at: Date.now() });
        settled.current(key);
      });
  }, [put]);

  const byKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries]);
  const phaseOf = useCallback((key: string) => byKey.get(key)?.phase ?? null, [byKey]);

  return useMemo(
    () => ({ entries, phaseOf, ask, cancel, confirm, dismiss }),
    [entries, phaseOf, ask, cancel, confirm, dismiss],
  );
}
