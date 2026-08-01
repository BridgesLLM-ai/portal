import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

export type RouteOperationOwner = Readonly<object>;

let activeOwner: RouteOperationOwner | null = null;
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return activeOwner;
}

/**
 * Claims the authenticated shell for one immutable operation token.
 * Re-entry is permitted only for the exact same token; a different token
 * always fails closed until the owner explicitly settles and releases.
 */
export function claimRouteOperation(owner: RouteOperationOwner): boolean {
  if (activeOwner && activeOwner !== owner) return false;
  if (activeOwner === owner) return true;
  activeOwner = owner;
  emitChange();
  return true;
}

export function releaseRouteOperation(owner: RouteOperationOwner): boolean {
  if (activeOwner !== owner) return false;
  activeOwner = null;
  emitChange();
  return true;
}

export function isRouteOperationOwned(): boolean {
  return activeOwner !== null;
}

export function isRouteOperationOwner(owner: RouteOperationOwner): boolean {
  return activeOwner === owner;
}

export function getRouteOperationOwner(): RouteOperationOwner | null {
  return activeOwner;
}

type RouteOperationCoordinator = Readonly<{
  claim: typeof claimRouteOperation;
  release: typeof releaseRouteOperation;
}>;

const coordinator: RouteOperationCoordinator = Object.freeze({
  claim: claimRouteOperation,
  release: releaseRouteOperation,
});

const RouteOperationContext = createContext<RouteOperationCoordinator>(coordinator);

export function RouteOperationProvider({ children }: { children: ReactNode }) {
  return (
    <RouteOperationContext.Provider value={coordinator}>
      {children}
    </RouteOperationContext.Provider>
  );
}

export function useRouteOperationGuard() {
  const value = useContext(RouteOperationContext);
  const owner = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => ({
    ...value,
    owner,
    active: owner !== null,
  }), [owner, value]);
}
