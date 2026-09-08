import client from './client';

export const AGENT_HARNESS_PREFERENCE_EVENT = 'bridgesllm:agent-harness-preference';
export const AGENT_HARNESS_SELECTION_EVENT = 'bridgesllm:agent-harness-selection';
export const AGENT_HARNESS_SELECTION_STORAGE_KEY = 'agent-chat-provider';
const AGENT_HARNESS_SELECTION_OWNER_KEY = 'agent-chat-provider-owner';

export interface AgentHarnessPreference {
  defaultHarness: string;
  revision: number;
}

export interface AppliedAgentHarnessPreference extends AgentHarnessPreference {
  selectedHarness: string;
  applied: boolean;
}

const inflightReads = new Map<string, Promise<AppliedAgentHarnessPreference>>();

function normalizeHarnessId(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

export function agentHarnessPreferenceStorageKey(userId: string): string {
  return `agent-chat-default-harness:${encodeURIComponent(userId)}`;
}

function validatedPreference(value: unknown): AgentHarnessPreference {
  const candidate = value && typeof value === 'object'
    ? value as Partial<AgentHarnessPreference>
    : {};
  const defaultHarness = normalizeHarnessId(candidate.defaultHarness);
  const revision = Number(candidate.revision);
  if (!defaultHarness || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Default harness preference response is invalid');
  }
  return { defaultHarness, revision };
}

function readAppliedMarker(userId: string): AgentHarnessPreference | null {
  try {
    const raw = localStorage.getItem(agentHarnessPreferenceStorageKey(userId));
    if (!raw) return null;
    return validatedPreference(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeAppliedMarker(userId: string, preference: AgentHarnessPreference): void {
  localStorage.setItem(agentHarnessPreferenceStorageKey(userId), JSON.stringify(preference));
  window.dispatchEvent(new CustomEvent(AGENT_HARNESS_PREFERENCE_EVENT, {
    detail: { userId, ...preference },
  }));
}

export function readSelectedAgentHarness(): string {
  return normalizeHarnessId(localStorage.getItem(AGENT_HARNESS_SELECTION_STORAGE_KEY)) || 'OPENCLAW';
}

export function persistSelectedAgentHarness(harnessId: string): string {
  const normalized = normalizeHarnessId(harnessId) || 'OPENCLAW';
  localStorage.setItem(AGENT_HARNESS_SELECTION_STORAGE_KEY, normalized);
  window.dispatchEvent(new CustomEvent(AGENT_HARNESS_SELECTION_EVENT, {
    detail: { harnessId: normalized },
  }));
  return normalized;
}

function applyFetchedPreference(
  userId: string,
  preference: AgentHarnessPreference,
  force: boolean,
): AppliedAgentHarnessPreference {
  const current = readSelectedAgentHarness();
  const marker = readAppliedMarker(userId);
  const selectionOwner = localStorage.getItem(AGENT_HARNESS_SELECTION_OWNER_KEY);
  // Revision zero is the migration baseline. Preserve an existing browser
  // selection during upgrade, while every explicit PATCH increments revision
  // and therefore applies exactly once per account/browser.
  const serverPreferenceChanged = preference.revision > 0 && (
    marker?.revision !== preference.revision
    || marker?.defaultHarness !== preference.defaultHarness
  );
  const applied = force
    || !localStorage.getItem(AGENT_HARNESS_SELECTION_STORAGE_KEY)
    || Boolean(selectionOwner && selectionOwner !== userId)
    || serverPreferenceChanged;
  const selectedHarness = applied
    ? persistSelectedAgentHarness(preference.defaultHarness)
    : current;
  writeAppliedMarker(userId, preference);
  localStorage.setItem(AGENT_HARNESS_SELECTION_OWNER_KEY, userId);
  return { ...preference, selectedHarness, applied };
}

export function loadAndApplyDefaultAgentHarness(
  userId: string,
): Promise<AppliedAgentHarnessPreference> {
  const actor = String(userId || '').trim();
  if (!actor) return Promise.reject(new Error('Authenticated user id is required'));
  const existing = inflightReads.get(actor);
  if (existing) return existing;

  let request!: Promise<AppliedAgentHarnessPreference>;
  request = client.get('/users/me/agent-harness-preference', {
    _silent: true,
  } as any).then(({ data }) => applyFetchedPreference(actor, validatedPreference(data), false))
    .finally(() => {
      if (inflightReads.get(actor) === request) inflightReads.delete(actor);
    });
  inflightReads.set(actor, request);
  return request;
}

// Global Assistant Status reads the saved preference, never the temporary
// chat selection. This read must not apply or change that chat selection.
export async function loadDefaultAgentHarness(userId: string): Promise<AgentHarnessPreference> {
  if (!String(userId || '').trim()) throw new Error('Authenticated user id is required');
  const { data } = await client.get('/users/me/agent-harness-preference', {
    _silent: true,
  } as any);
  return validatedPreference(data);
}

export async function saveAndApplyDefaultAgentHarness(
  userId: string,
  harnessId: string,
): Promise<AppliedAgentHarnessPreference> {
  const actor = String(userId || '').trim();
  if (!actor) throw new Error('Authenticated user id is required');
  const normalized = normalizeHarnessId(harnessId);
  if (!normalized) throw new Error('Harness id is required');
  const { data } = await client.patch('/users/me/agent-harness-preference', {
    harnessId: normalized,
  });
  return applyFetchedPreference(actor, validatedPreference(data), true);
}
