import React, { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react';

/**
 * Explicit expand/collapse choices for tool activity groups and tool cards.
 *
 * Choices live outside React so they survive what remounts transcript rows:
 * a lone call joining a group, a live turn becoming persisted history, a
 * reconnect replacing message IDs, or a group being collapsed and reopened.
 * They are keyed by a conversation scope plus the original tool-call ID and
 * hold display preferences only; nothing is persisted beyond this tab.
 */

const MAX_REMEMBERED_CHOICES = 4000;
const choices = new Map<string, boolean>();
const listeners = new Set<() => void>();

function choiceKey(scope: string, key: string): string {
  return JSON.stringify([scope, key]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readToolActivityChoice(scope: string, key: string): boolean | undefined {
  return choices.get(choiceKey(scope, key));
}

export function rememberToolActivityChoice(scope: string, key: string, expanded: boolean): void {
  const id = choiceKey(scope, key);
  if (choices.get(id) === expanded) return;
  // Re-insert so the oldest untouched choices are evicted first.
  choices.delete(id);
  choices.set(id, expanded);
  while (choices.size > MAX_REMEMBERED_CHOICES) {
    const oldest = choices.keys().next().value;
    if (oldest === undefined) break;
    choices.delete(oldest);
  }
  listeners.forEach((listener) => listener());
}

/** Test helper: forget every remembered choice. */
export function resetToolActivityChoices(): void {
  choices.clear();
  listeners.forEach((listener) => listener());
}

interface ToolActivityScopeValue {
  scope: string;
  onDisclosureChange?: () => void;
}

const ToolActivityScopeContext = createContext<ToolActivityScopeValue | null>(null);

/**
 * Names the conversation whose transcript is rendered below. Choices are only
 * remembered inside a scope; components outside one keep local state.
 * `onDisclosureChange` lets the transcript re-check the reader's scroll
 * position after content grows or shrinks, so it never yanks a reader away.
 */
export function ToolActivityScope({
  scope,
  onDisclosureChange,
  children,
}: {
  scope: string;
  onDisclosureChange?: () => void;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({ scope, onDisclosureChange }), [onDisclosureChange, scope]);
  return <ToolActivityScopeContext.Provider value={value}>{children}</ToolActivityScopeContext.Provider>;
}

export function useToolActivityScope(): string | null {
  return useContext(ToolActivityScopeContext)?.scope ?? null;
}

/**
 * Expanded state for one disclosure. `key` null (or no enclosing scope) keeps
 * plain component state, which is what nested and standalone cards need.
 */
export function useToolActivityDisclosure(
  key: string | null,
  defaultExpanded: boolean,
): [boolean, (expanded: boolean) => void] {
  const context = useContext(ToolActivityScopeContext);
  const scope = context && key ? context.scope : null;
  const [local, setLocal] = useState<boolean | undefined>(undefined);
  const remembered = useSyncExternalStore(
    subscribe,
    () => (scope !== null && key ? readToolActivityChoice(scope, key) : undefined),
    () => undefined,
  );
  const expanded = (scope !== null ? remembered : local) ?? defaultExpanded;
  const notify = context?.onDisclosureChange;
  const setExpanded = useCallback((next: boolean) => {
    if (scope !== null && key) rememberToolActivityChoice(scope, key, next);
    else setLocal(next);
    notify?.();
  }, [key, notify, scope]);
  return [expanded, setExpanded];
}
