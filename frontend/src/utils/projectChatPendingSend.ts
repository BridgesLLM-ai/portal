import type { ProjectChatPersistedMessage, ProjectChatProviderName } from '../api/endpoints';
import { clientCryptographicRandomId } from './clientId';

const PROJECT_CHAT_PENDING_SEND_SCHEMA = 2;
const PROJECT_CHAT_PENDING_SEND_PREFIX = 'project-chat-pending-send:v2:';
const PROJECT_CHAT_CONFIRMED_SEND_SCHEMA = 1;
const PROJECT_CHAT_CONFIRMED_SEND_PREFIX = 'project-chat-confirmed-send:v1:';
const PROJECT_CHAT_SEND_CHANNEL = 'project-chat-send-coordination:v2';
const PROJECT_CHAT_LOCK_WAIT_MS = 5_000;

export const PROJECT_CHAT_PENDING_SEND_PROVIDERS: ProjectChatProviderName[] = [
  'OPENCLAW',
  'CLAUDE_CODE',
  'CODEX',
  'GROK',
  'AGENT_ZERO',
  'GEMINI',
  'OLLAMA',
];

export interface ProjectChatSendScope {
  actorUserId: string;
  projectId: string;
  provider: ProjectChatProviderName;
}

export interface PendingProjectChatSend {
  schema: typeof PROJECT_CHAT_PENDING_SEND_SCHEMA;
  actorUserId: string;
  projectId: string;
  provider: ProjectChatProviderName;
  messageId: string;
  draftFingerprint: string;
  payloadFingerprint: string;
  model: string;
  attemptStartedAt: number;
  createdAt: string;
}

interface ConfirmedProjectChatSend {
  schema: typeof PROJECT_CHAT_CONFIRMED_SEND_SCHEMA;
  actorUserId: string;
  projectId: string;
  provider: ProjectChatProviderName;
  messageId: string;
  draftFingerprint: string;
  payloadFingerprint: string;
  model: string;
  attemptStartedAt: number;
  confirmedAt: number;
}

export interface StagedProjectChatSend extends PendingProjectChatSend {
  /** Request-only data. These fields are never serialized to browser storage. */
  draftText: string;
  payloadText: string;
  reusedConfirmedAttempt: boolean;
}

export type ProjectChatPendingSendInspection =
  | { status: 'absent'; pending: null }
  | { status: 'valid'; pending: PendingProjectChatSend }
  | { status: 'corrupt'; pending: null; reason: string };

export type ProjectChatSendOutcome = 'confirmed' | 'never-admitted' | 'ambiguous';

export class ProjectChatPendingStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectChatPendingStateError';
  }
}

interface BrowserLockManager {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface ProjectChatCoordinatorOptions {
  lockManager?: BrowserLockManager;
  lockWaitMs?: number;
  attemptStartedAt?: number;
}

function requiredScopePart(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 512 || normalized.includes('\0')) {
    throw new Error(`Project Chat cannot coordinate a send without a verified ${label}.`);
  }
  return normalized;
}

function validateScope(scope: ProjectChatSendScope): ProjectChatSendScope {
  const provider = String(scope.provider || '').trim() as ProjectChatProviderName;
  if (!PROJECT_CHAT_PENDING_SEND_PROVIDERS.includes(provider)) {
    throw new Error('Project Chat cannot coordinate a send for an unknown provider.');
  }
  return {
    actorUserId: requiredScopePart(scope.actorUserId, 'user scope'),
    projectId: requiredScopePart(scope.projectId, 'project identity'),
    provider,
  };
}

function scopedStorageSuffix(scope: ProjectChatSendScope): string {
  const verified = validateScope(scope);
  return `${encodeURIComponent(verified.actorUserId)}:${encodeURIComponent(verified.projectId)}:${verified.provider}`;
}

function pendingStorageKey(scope: ProjectChatSendScope): string {
  return `${PROJECT_CHAT_PENDING_SEND_PREFIX}${scopedStorageSuffix(scope)}`;
}

function confirmedStorageKey(scope: ProjectChatSendScope): string {
  return `${PROJECT_CHAT_CONFIRMED_SEND_PREFIX}${scopedStorageSuffix(scope)}`;
}

function lockName(scope: ProjectChatSendScope): string {
  return `project-chat-send:${scopedStorageSuffix(scope)}`;
}

function isProvider(value: unknown): value is ProjectChatProviderName {
  return PROJECT_CHAT_PENDING_SEND_PROVIDERS.includes(String(value) as ProjectChatProviderName);
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^project-chat-[a-f0-9]{32}$/i.test(value);
}

function parsePendingProjectChatSend(raw: string, scope: ProjectChatSendScope): PendingProjectChatSend | null {
  try {
    const value = JSON.parse(raw) as Partial<PendingProjectChatSend>;
    if (
      value.schema !== PROJECT_CHAT_PENDING_SEND_SCHEMA
      || value.actorUserId !== scope.actorUserId
      || value.projectId !== scope.projectId
      || value.provider !== scope.provider
      || !isProvider(value.provider)
      || !isMessageId(value.messageId)
      || !isFingerprint(value.draftFingerprint)
      || !isFingerprint(value.payloadFingerprint)
      || typeof value.model !== 'string'
      || value.model.length > 1_024
      || !Number.isSafeInteger(value.attemptStartedAt)
      || Number(value.attemptStartedAt) < 0
      || typeof value.createdAt !== 'string'
      || Date.parse(value.createdAt) !== value.attemptStartedAt
    ) return null;
    return value as PendingProjectChatSend;
  } catch {
    return null;
  }
}

function parseConfirmedProjectChatSend(
  raw: string,
  scope: ProjectChatSendScope,
): ConfirmedProjectChatSend | null {
  try {
    const value = JSON.parse(raw) as Partial<ConfirmedProjectChatSend>;
    if (
      value.schema !== PROJECT_CHAT_CONFIRMED_SEND_SCHEMA
      || value.actorUserId !== scope.actorUserId
      || value.projectId !== scope.projectId
      || value.provider !== scope.provider
      || !isProvider(value.provider)
      || !isMessageId(value.messageId)
      || !isFingerprint(value.draftFingerprint)
      || !isFingerprint(value.payloadFingerprint)
      || typeof value.model !== 'string'
      || value.model.length > 1_024
      || !Number.isSafeInteger(value.attemptStartedAt)
      || !Number.isSafeInteger(value.confirmedAt)
      || Number(value.confirmedAt) < Number(value.attemptStartedAt)
    ) return null;
    return value as ConfirmedProjectChatSend;
  } catch {
    return null;
  }
}

function inspectPendingOnly(scopeInput: ProjectChatSendScope): ProjectChatPendingSendInspection {
  const scope = validateScope(scopeInput);
  const key = pendingStorageKey(scope);
  const raw = localStorage.getItem(key);

  if (raw !== null) {
    const pending = parsePendingProjectChatSend(raw, scope);
    if (!pending) {
      return { status: 'corrupt', pending: null, reason: 'The preserved Project Chat delivery record is malformed.' };
    }
    return { status: 'valid', pending };
  }
  return { status: 'absent', pending: null };
}

function inspectConfirmedOnly(scopeInput: ProjectChatSendScope):
  | { status: 'absent'; confirmed: null }
  | { status: 'valid'; confirmed: ConfirmedProjectChatSend }
  | { status: 'corrupt'; confirmed: null; reason: string } {
  const scope = validateScope(scopeInput);
  const raw = localStorage.getItem(confirmedStorageKey(scope));
  if (raw === null) return { status: 'absent', confirmed: null };
  const confirmed = parseConfirmedProjectChatSend(raw, scope);
  if (!confirmed) {
    return { status: 'corrupt', confirmed: null, reason: 'The Project Chat delivery confirmation record is malformed.' };
  }
  return { status: 'valid', confirmed };
}

export function inspectProjectChatPendingSend(
  scopeInput: ProjectChatSendScope,
): ProjectChatPendingSendInspection {
  const scope = validateScope(scopeInput);
  const pending = inspectPendingOnly(scope);
  const confirmed = inspectConfirmedOnly(scope);
  if (confirmed.status === 'corrupt') {
    return { status: 'corrupt', pending: null, reason: confirmed.reason };
  }
  if (
    pending.status === 'valid'
    && confirmed.status === 'valid'
    && confirmed.confirmed.messageId === pending.pending.messageId
    && (
      confirmed.confirmed.draftFingerprint !== pending.pending.draftFingerprint
      || confirmed.confirmed.payloadFingerprint !== pending.pending.payloadFingerprint
      || confirmed.confirmed.model !== pending.pending.model
      || confirmed.confirmed.attemptStartedAt !== pending.pending.attemptStartedAt
    )
  ) {
    return {
      status: 'corrupt',
      pending: null,
      reason: 'Conflicting Project Chat delivery confirmation records were found.',
    };
  }
  if (pending.status !== 'absent') return pending;
  return pending;
}

export function loadPendingProjectChatSend(scope: ProjectChatSendScope): PendingProjectChatSend | null {
  const inspected = inspectProjectChatPendingSend(scope);
  if (inspected.status === 'corrupt') throw new Error(inspected.reason);
  return inspected.pending;
}

async function sha256Fingerprint(content: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('This browser cannot securely fingerprint a pending Project Chat message.');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getBrowserLockManager(override?: BrowserLockManager): BrowserLockManager {
  if (override) return override;
  const manager = (globalThis.navigator as Navigator & { locks?: BrowserLockManager } | undefined)?.locks;
  if (!manager?.request) {
    throw new Error('This browser cannot safely coordinate Project Chat sends across tabs.');
  }
  return manager;
}

async function withProjectChatSendLock<T>(
  scope: ProjectChatSendScope,
  callback: () => Promise<T>,
  options: ProjectChatCoordinatorOptions = {},
): Promise<T> {
  const manager = getBrowserLockManager(options.lockManager);
  const abortController = new AbortController();
  let acquired = false;
  const timeout = setTimeout(() => {
    if (!acquired) abortController.abort();
  }, options.lockWaitMs ?? PROJECT_CHAT_LOCK_WAIT_MS);
  try {
    return await manager.request(
      lockName(scope),
      { mode: 'exclusive', signal: abortController.signal },
      async () => {
        acquired = true;
        clearTimeout(timeout);
        return callback();
      },
    );
  } catch (error) {
    if (!acquired && abortController.signal.aborted) {
      throw new Error('Another tab is still confirming this Project Chat send. Try again after it finishes.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function broadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel !== 'function') return null;
  try {
    return new BroadcastChannel(PROJECT_CHAT_SEND_CHANNEL);
  } catch {
    return null;
  }
}

function notifyProjectChatSendState(scope: ProjectChatSendScope): void {
  const channel = broadcastChannel();
  if (!channel) return;
  try {
    channel.postMessage({ schema: 1, scope: scopedStorageSuffix(scope) });
  } finally {
    channel.close();
  }
}

function persistPending(scope: ProjectChatSendScope, pending: PendingProjectChatSend): void {
  // Never serialize a structurally compatible StagedProjectChatSend: it also
  // carries request-only plaintext fields for the dispatch callback.
  const serializedPending: PendingProjectChatSend = {
    schema: pending.schema,
    actorUserId: pending.actorUserId,
    projectId: pending.projectId,
    provider: pending.provider,
    messageId: pending.messageId,
    draftFingerprint: pending.draftFingerprint,
    payloadFingerprint: pending.payloadFingerprint,
    model: pending.model,
    attemptStartedAt: pending.attemptStartedAt,
    createdAt: pending.createdAt,
  };
  localStorage.setItem(pendingStorageKey(scope), JSON.stringify(serializedPending));
  const verified = inspectPendingOnly(scope);
  if (verified.status !== 'valid' || verified.pending.messageId !== pending.messageId) {
    throw new Error('Project Chat could not preserve its delivery ID before sending.');
  }
  notifyProjectChatSendState(scope);
}

function applyOutcome(
  scope: ProjectChatSendScope,
  pending: PendingProjectChatSend,
  outcome: ProjectChatSendOutcome,
  now: number,
): void {
  const pendingKey = pendingStorageKey(scope);
  const confirmedKey = confirmedStorageKey(scope);
  if (outcome === 'confirmed') {
    const confirmed: ConfirmedProjectChatSend = {
      schema: PROJECT_CHAT_CONFIRMED_SEND_SCHEMA,
      actorUserId: scope.actorUserId,
      projectId: scope.projectId,
      provider: scope.provider,
      messageId: pending.messageId,
      draftFingerprint: pending.draftFingerprint,
      payloadFingerprint: pending.payloadFingerprint,
      model: pending.model,
      attemptStartedAt: pending.attemptStartedAt,
      confirmedAt: now,
    };
    // Write the tombstone before removing pending state. Failure therefore
    // leaves the stable pending identity intact and cannot mint a duplicate.
    localStorage.setItem(confirmedKey, JSON.stringify(confirmed));
    localStorage.removeItem(pendingKey);
  } else if (outcome === 'never-admitted') {
    localStorage.removeItem(pendingKey);
    const confirmed = inspectConfirmedOnly(scope);
    if (confirmed.status === 'corrupt') {
      throw new ProjectChatPendingStateError(confirmed.reason);
    }
    if (confirmed.status === 'valid' && confirmed.confirmed.messageId === pending.messageId) {
      localStorage.removeItem(confirmedKey);
    }
  } else {
    persistPending(scope, pending);
    return;
  }
  notifyProjectChatSendState(scope);
}

async function stagePendingProjectChatSendUnlocked(input: {
  scope: ProjectChatSendScope;
  draftText: string;
  payloadText: string;
  model: string;
  attemptStartedAt: number;
  confirmedMessageIdAtAttemptStart: string | null;
}): Promise<StagedProjectChatSend> {
  const scope = validateScope(input.scope);
  const [draftFingerprint, payloadFingerprint] = await Promise.all([
    sha256Fingerprint(input.draftText),
    sha256Fingerprint(input.payloadText),
  ]);
  const inspected = inspectPendingOnly(scope);
  if (inspected.status === 'corrupt') throw new Error(inspected.reason);
  if (inspected.status === 'valid') {
    const existing = inspected.pending;
    if (
      existing.draftFingerprint !== draftFingerprint
      || existing.payloadFingerprint !== payloadFingerprint
      || existing.model !== input.model
    ) {
      throw new Error('A previous Project Chat send still needs confirmation. Retry the exact original message and model before sending another.');
    }
    const confirmedInspection = inspectConfirmedOnly(scope);
    if (confirmedInspection.status === 'corrupt') throw new Error(confirmedInspection.reason);
    if (
      confirmedInspection.status === 'valid'
      && confirmedInspection.confirmed.messageId === existing.messageId
    ) {
      const confirmed = confirmedInspection.confirmed;
      if (
        confirmed.draftFingerprint !== existing.draftFingerprint
        || confirmed.payloadFingerprint !== existing.payloadFingerprint
        || confirmed.model !== existing.model
        || confirmed.attemptStartedAt !== existing.attemptStartedAt
      ) {
        throw new ProjectChatPendingStateError('Conflicting Project Chat delivery confirmation records were found.');
      }
      persistPending(scope, existing);
      return {
        ...existing,
        draftText: input.draftText,
        payloadText: input.payloadText,
        reusedConfirmedAttempt: true,
      };
    }
    persistPending(scope, existing);
    return {
      ...existing,
      draftText: input.draftText,
      payloadText: input.payloadText,
      reusedConfirmedAttempt: false,
    };
  }

  const confirmedInspection = inspectConfirmedOnly(scope);
  if (confirmedInspection.status === 'corrupt') throw new Error(confirmedInspection.reason);
  if (confirmedInspection.status === 'valid') {
    const confirmed = confirmedInspection.confirmed;
    if (
      confirmed.messageId !== input.confirmedMessageIdAtAttemptStart
      && confirmed.draftFingerprint === draftFingerprint
      && confirmed.payloadFingerprint === payloadFingerprint
      && confirmed.model === input.model
    ) {
      const pending: PendingProjectChatSend = {
        schema: PROJECT_CHAT_PENDING_SEND_SCHEMA,
        actorUserId: scope.actorUserId,
        projectId: scope.projectId,
        provider: scope.provider,
        messageId: confirmed.messageId,
        draftFingerprint,
        payloadFingerprint,
        model: confirmed.model,
        attemptStartedAt: confirmed.attemptStartedAt,
        createdAt: new Date(confirmed.attemptStartedAt).toISOString(),
      };
      persistPending(scope, pending);
      return {
        ...pending,
        draftText: input.draftText,
        payloadText: input.payloadText,
        reusedConfirmedAttempt: true,
      };
    }
  }

  const pending: PendingProjectChatSend = {
    schema: PROJECT_CHAT_PENDING_SEND_SCHEMA,
    actorUserId: scope.actorUserId,
    projectId: scope.projectId,
    provider: scope.provider,
    messageId: clientCryptographicRandomId('project-chat-'),
    draftFingerprint,
    payloadFingerprint,
    model: input.model,
    attemptStartedAt: input.attemptStartedAt,
    createdAt: new Date(input.attemptStartedAt).toISOString(),
  };
  persistPending(scope, pending);
  return {
    ...pending,
    draftText: input.draftText,
    payloadText: input.payloadText,
    reusedConfirmedAttempt: false,
  };
}

export async function runCoordinatedProjectChatSend<T>(input: {
  scope: ProjectChatSendScope;
  draftText: string;
  payloadText: string;
  model: string;
  dispatch: (staged: StagedProjectChatSend) => Promise<T>;
  classifyError: (error: unknown) => Exclude<ProjectChatSendOutcome, 'confirmed'>;
  onStaged?: (staged: StagedProjectChatSend) => void;
  options?: ProjectChatCoordinatorOptions;
}): Promise<
  | { staged: StagedProjectChatSend; confirmedBeforeDispatch: true; value: null }
  | { staged: StagedProjectChatSend; confirmedBeforeDispatch: false; value: T }
> {
  const scope = validateScope(input.scope);
  const attemptStartedAt = input.options?.attemptStartedAt ?? Date.now();
  const confirmationAtAttemptStart = inspectConfirmedOnly(scope);
  if (confirmationAtAttemptStart.status === 'corrupt') {
    throw new ProjectChatPendingStateError(confirmationAtAttemptStart.reason);
  }
  const confirmedMessageIdAtAttemptStart = confirmationAtAttemptStart.status === 'valid'
    ? confirmationAtAttemptStart.confirmed.messageId
    : null;
  return withProjectChatSendLock(scope, async () => {
    const staged = await stagePendingProjectChatSendUnlocked({
      scope,
      draftText: input.draftText,
      payloadText: input.payloadText,
      model: input.model,
      attemptStartedAt,
      confirmedMessageIdAtAttemptStart,
    });
    input.onStaged?.(staged);
    if (staged.reusedConfirmedAttempt) {
      // A queued tab observed the tombstone written by the tab that actually
      // dispatched this attempt. Replaying the HTTP request would be harmless
      // server-side, but it is unnecessary and creates avoidable ambiguity if
      // the second response is lost. The original durable identity has already
      // been confirmed, so converge local state without dispatching again.
      applyOutcome(scope, staged, 'confirmed', Date.now());
      return { staged, confirmedBeforeDispatch: true, value: null };
    }
    try {
      // Do not race the dispatch against a timer: aborting the browser request
      // cannot prove the server stopped committing it. The Web Lock therefore
      // remains held until the real dispatch promise settles or the document is
      // destroyed; a replacement document must reconcile the same persisted ID.
      const value = await input.dispatch(staged);
      applyOutcome(scope, staged, 'confirmed', Date.now());
      return { staged, confirmedBeforeDispatch: false, value };
    } catch (error) {
      applyOutcome(scope, staged, input.classifyError(error), Date.now());
      throw error;
    }
  }, input.options);
}

export async function reconcilePendingProjectChatSend(input: {
  scope: ProjectChatSendScope;
  resolve: (pending: PendingProjectChatSend) => Promise<ProjectChatSendOutcome>;
  options?: ProjectChatCoordinatorOptions;
}): Promise<ProjectChatPendingSendInspection> {
  const scope = validateScope(input.scope);
  return withProjectChatSendLock(scope, async () => {
    const inspected = inspectPendingOnly(scope);
    if (inspected.status !== 'valid') return inspected;
    const outcome = await input.resolve(inspected.pending);
    applyOutcome(scope, inspected.pending, outcome, Date.now());
    return inspectProjectChatPendingSend(scope);
  }, input.options);
}

function clearAllPendingProjectChatSendsUnlocked(input: {
  actorUserId: string;
  projectId: string;
}): boolean {
  const base = {
    actorUserId: requiredScopePart(input.actorUserId, 'user scope'),
    projectId: requiredScopePart(input.projectId, 'project identity'),
  };
  const keys: string[] = [];
  for (const provider of PROJECT_CHAT_PENDING_SEND_PROVIDERS) {
    const scope = validateScope({ ...base, provider });
    keys.push(pendingStorageKey(scope), confirmedStorageKey(scope));
  }
  for (const key of keys) localStorage.removeItem(key);
  for (const provider of PROJECT_CHAT_PENDING_SEND_PROVIDERS) {
    notifyProjectChatSendState(validateScope({ ...base, provider }));
  }
  return keys.every((key) => localStorage.getItem(key) === null);
}

/**
 * Serialize a destructive project-wide reset behind every provider send lock.
 * Locks are acquired in one fixed order, so concurrent resets cannot deadlock
 * and no provider can stage or settle a delivery identity while the server
 * reset and matching browser cleanup are in progress.
 */
export async function runCoordinatedProjectChatReset<T>(input: {
  actorUserId: string;
  projectId: string;
  reset: () => Promise<T>;
  options?: ProjectChatCoordinatorOptions;
}): Promise<T> {
  const base = {
    actorUserId: requiredScopePart(input.actorUserId, 'user scope'),
    projectId: requiredScopePart(input.projectId, 'project identity'),
  };
  const acquire = async (index: number): Promise<T> => {
    if (index >= PROJECT_CHAT_PENDING_SEND_PROVIDERS.length) {
      const value = await input.reset();
      try {
        if (!clearAllPendingProjectChatSendsUnlocked(base)) {
          throw new Error('delivery records remained after cleanup');
        }
      } catch {
        throw new ProjectChatPendingStateError(
          'Project Chat reset completed, but this browser could not clear its pending delivery IDs.',
        );
      }
      return value;
    }
    const scope = validateScope({
      ...base,
      provider: PROJECT_CHAT_PENDING_SEND_PROVIDERS[index],
    });
    return withProjectChatSendLock(scope, () => acquire(index + 1), input.options);
  };
  return acquire(0);
}

export function subscribeProjectChatSendState(
  scopeInput: ProjectChatSendScope,
  listener: () => void,
): () => void {
  const scope = validateScope(scopeInput);
  const relevantKeys = new Set([
    pendingStorageKey(scope),
    confirmedStorageKey(scope),
  ]);
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === localStorage && event.key && relevantKeys.has(event.key)) listener();
  };
  const channel = broadcastChannel();
  const onBroadcast = (event: MessageEvent) => {
    if (event.data?.schema === 1 && event.data?.scope === scopedStorageSuffix(scope)) listener();
  };
  window.addEventListener('storage', onStorage);
  channel?.addEventListener('message', onBroadcast);
  return () => {
    window.removeEventListener('storage', onStorage);
    channel?.removeEventListener('message', onBroadcast);
    channel?.close();
  };
}

export async function historyConfirmsPendingProjectChatSend(
  pending: PendingProjectChatSend,
  messages: ProjectChatPersistedMessage[],
): Promise<boolean> {
  const candidate = messages.find((message) => (
    message.role === 'user' && message.messageId === pending.messageId
  ));
  if (!candidate) return false;
  return (await sha256Fingerprint(String(candidate.content || ''))) === pending.payloadFingerprint;
}

export function projectChatPendingSendStorageKey(
  actorUserId: string,
  projectId: string,
  provider: ProjectChatProviderName,
): string {
  return pendingStorageKey({ actorUserId, projectId, provider });
}

export function projectChatConfirmedSendStorageKey(
  actorUserId: string,
  projectId: string,
  provider: ProjectChatProviderName,
): string {
  return confirmedStorageKey({ actorUserId, projectId, provider });
}
