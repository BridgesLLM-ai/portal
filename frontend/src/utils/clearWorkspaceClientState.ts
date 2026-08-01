import { WORKSPACE_NAVIGATION_STORAGE_KEY } from './workspaceNavigation';

const WORKSPACE_STORAGE_KEYS = new Set([
  'projects-last-selected',
  'palette-open-file',
]);

const WORKSPACE_STORAGE_PREFIXES = [
  'portal:project-rename-attempt:',
  'project-chat-pending-send:v2:',
  'project-chat-confirmed-send:v1:',
  'agent-active-',
  'agent-model-',
];

const TRANSIENT_WORKSPACE_STORAGE_KEYS = new Set([
  WORKSPACE_NAVIGATION_STORAGE_KEY,
  'portal:terminal-state:v1',
  'terminal-state',
  'mail-active-account',
  'bridgesllm.setup.session.v1',
  'cached_userAvatar',
  'cached_assistantAvatar',
  'palette-open-file',
]);

const TRANSIENT_WORKSPACE_STORAGE_PREFIXES = [
  'portal:workspace-navigation:',
];

type RemovableStorage = Pick<Storage, 'length' | 'key' | 'removeItem'>;

function removeMatchingStorage(
  storage: RemovableStorage | undefined,
  exactKeys: ReadonlySet<string>,
  prefixes: readonly string[],
): void {
  if (!storage) return;
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
  } catch {
    return;
  }
  for (const key of keys) {
    if (!exactKeys.has(key) && !prefixes.some((prefix) => key.startsWith(prefix))) continue;
    try {
      storage.removeItem(key);
    } catch {
      // Best-effort scrub; the DOM remains curtained or auth is removed.
    }
  }
}

export function clearWorkspaceClientState(
  persistentStorage?: RemovableStorage,
  transientStorage?: RemovableStorage,
): void {
  let persistent = persistentStorage;
  let transient = transientStorage;
  if (!persistent) {
    try {
      persistent = window.localStorage;
    } catch {
      // Storage access can throw before an operation is attempted.
    }
  }
  if (!transient) {
    try {
      transient = window.sessionStorage;
    } catch {
      // The hard authorization reload remains authoritative.
    }
  }

  removeMatchingStorage(persistent, WORKSPACE_STORAGE_KEYS, WORKSPACE_STORAGE_PREFIXES);
  removeMatchingStorage(
    transient,
    TRANSIENT_WORKSPACE_STORAGE_KEYS,
    TRANSIENT_WORKSPACE_STORAGE_PREFIXES,
  );
}
