import crypto from 'crypto';
import type {
  AgentMessage,
  AgentProvider,
  AgentProviderName,
  AgentSendResult,
  AgentSessionConfig,
  AgentSessionId,
  AgentSessionSummary,
  AttestedProjectRuntimeCleanup,
  OnChunkCallback,
  OnExecApprovalCallback,
  OnStatusCallback,
  SenderIdentity,
  ProjectSandboxExecutionContext,
} from '../../AgentProvider.interface';
import { AgentAbortError } from '../../AgentProvider.interface';
import { assertExecutionContextBinding } from '../../executionScope';
import {
  appendNativeMessage,
  clearNativeSessionHistory,
  createNativeSession,
  deleteNativeSession,
  listNativeSessions,
  loadNativeSession,
  readAllNativeSessionHistory,
  saveNativeSession,
  updateNativeSessionMetadata,
  type NativeSessionData,
} from '../NativeSessionStore';
import type { AgentZeroConnectorEvent } from './AgentZeroConnectorStream';
import {
  AGENT_ZERO_PROJECT_ROOT,
  AGENT_ZERO_PROJECT_RUNTIME,
  applyAgentZeroProjectModelPreset,
  hardAbortAgentZeroProjectRuntime,
  openQualifiedAgentZeroProjectRuntime,
  type AgentZeroProjectRuntimeHandle,
} from './AgentZeroProjectSandbox';
import {
  AGENT_ZERO_PROJECT_OAUTH_PROVIDER_IDS,
  normalizeAgentZeroProjectModelSelection,
  type AgentZeroProjectModelSelection,
  type AgentZeroProjectOAuthProviderId,
} from './AgentZeroProjectModelBridgeCredential';

const MAX_MESSAGE_LENGTH = 200_000;
const MAX_RESPONSE_LENGTH = 4 * 1024 * 1024;
const DEFAULT_ABORT_SETTLEMENT_TIMEOUT_MS = 15_000;
const CONTEXT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RUN_ID_RE = /^[^\u0000-\u001f\u007f]{1,512}$/;

type RuntimeResolver = (
  context: ProjectSandboxExecutionContext,
  selection: AgentZeroProjectModelSelection,
) => Promise<AgentZeroProjectRuntimeHandle>;

export interface AgentZeroProjectProviderOptions {
  runtimeResolver?: RuntimeResolver;
  hardAbort?: (context: ProjectSandboxExecutionContext) => boolean | Promise<boolean>;
  abortSettlementTimeoutMs?: number;
  idFactory?: () => string;
}

interface ActiveProjectRun {
  readonly sessionId: string;
  readonly runId: string;
  readonly context: ProjectSandboxExecutionContext;
  readonly projectKey: string;
  readonly controller: AbortController;
  readonly settlement: Promise<void>;
  readonly resolveSettlement: () => void;
  abortPromise: Promise<boolean> | null;
  sendSettled: boolean;
  quarantined: boolean;
}

function validateContextId(value: unknown): string {
  const id = String(value || '').trim();
  if (!CONTEXT_ID_RE.test(id)) throw new Error('Agent Zero returned an invalid project context identifier.');
  return id;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function cleanText(value: unknown, maximum = MAX_RESPONSE_LENGTH): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.replace(/\u0000/g, '').slice(0, maximum);
}

function responseText(value: unknown): string {
  const body = record(value);
  const candidates = [body.response, body.message, body.text, body.output, record(body.data).response];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return cleanText(candidate);
  }
  return '';
}

function eventText(event: AgentZeroConnectorEvent): string {
  return cleanText(event.data.text || event.data.heading || '', 256_000);
}

function eventToolCallId(event: AgentZeroConnectorEvent, sessionId: string): string {
  const metadata = event.data.meta || {};
  for (const key of ['tool_call_id', 'call_id', 'tool_id', 'id']) {
    const candidate = String(metadata[key] || '').trim();
    if (CONTEXT_ID_RE.test(candidate)) return candidate;
  }
  return `a0:${sessionId}:${event.sequence}`;
}

function requireProjectSession(
  sessionId: string,
  options: { allowQuarantined?: boolean } = {},
): NativeSessionData {
  const id = validateContextId(sessionId);
  const session = loadNativeSession('AGENT_ZERO', id);
  if (!session) throw new Error(`Agent Zero project session not found: ${id}`);
  assertExecutionContextBinding(session.executionContext, session.userId, 'PROJECT_SANDBOX');
  if (session.metadata?.projectRuntime !== AGENT_ZERO_PROJECT_RUNTIME) {
    throw new Error('Agent Zero session is not bound to the Project Sandbox adapter.');
  }
  if (session.metadata?.agentZeroRuntimeQuarantined === true && !options.allowQuarantined) {
    throw new Error(
      'Agent Zero Project runtime is quarantined because its last cleanup boundary could not be verified.',
    );
  }
  return session;
}

function projectContext(session: NativeSessionData): ProjectSandboxExecutionContext {
  assertExecutionContextBinding(session.executionContext, session.userId, 'PROJECT_SANDBOX');
  return session.executionContext as ProjectSandboxExecutionContext;
}

function remoteContextIdForSession(session: NativeSessionData): string {
  // Portal session identity is immutable. Legacy sessions may still use the
  // upstream context as their local key, so retain that read-only fallback.
  return validateContextId(
    session.metadata?.agentZeroRemoteContextId || session.sessionId,
  );
}

function remoteContextAlreadyBound(
  userId: string,
  remoteContextId: string,
  excludeSessionId?: string,
): boolean {
  return listNativeSessions('AGENT_ZERO', userId).some((summary) => {
    if (summary.sessionId === excludeSessionId) return false;
    const existing = loadNativeSession('AGENT_ZERO', summary.sessionId);
    if (!existing) return false;
    try {
      return remoteContextIdForSession(existing) === remoteContextId;
    } catch {
      return false;
    }
  });
}

function modelSelectionFromConfig(config: AgentSessionConfig): AgentZeroProjectModelSelection {
  let providerId = String(config.metadata?.agentZeroOAuthProviderId || '').trim();
  let model = String(config.model || '').trim();
  if (!providerId) {
    const prefix = AGENT_ZERO_PROJECT_OAUTH_PROVIDER_IDS.find((candidate) => (
      model.startsWith(`${candidate}/`)
    ));
    if (prefix) {
      providerId = prefix;
      model = model.slice(prefix.length + 1);
    }
  }
  return normalizeAgentZeroProjectModelSelection({
    providerId: providerId as AgentZeroProjectOAuthProviderId,
    model,
  });
}

function modelSelectionFromSession(session: NativeSessionData): AgentZeroProjectModelSelection {
  return normalizeAgentZeroProjectModelSelection({
    providerId: String(session.metadata?.agentZeroOAuthProviderId || '') as AgentZeroProjectOAuthProviderId,
    model: String(session.metadata?.agentZeroModel || session.model || ''),
  });
}

function assertRuntimeModelBinding(
  runtime: AgentZeroProjectRuntimeHandle,
  selection: AgentZeroProjectModelSelection,
): void {
  const expected = normalizeAgentZeroProjectModelSelection(selection);
  if (runtime.modelSelection.providerId !== expected.providerId
    || runtime.modelSelection.model !== expected.model
    || !runtime.modelPresetName) {
    throw new Error('Agent Zero Project runtime model binding does not match the selected OAuth provider.');
  }
}

function runIdFromSender(sender: SenderIdentity | undefined, idFactory: () => string): string {
  const requested = typeof sender?.requestId === 'string' ? sender.requestId.trim() : '';
  if (!requested) return idFactory();
  if (!RUN_ID_RE.test(requested)) throw new Error('Agent Zero Project run identity is invalid.');
  return requested;
}

function boundedAbortTimeout(value: unknown): number {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 120_000) {
    return DEFAULT_ABORT_SETTLEMENT_TIMEOUT_MS;
  }
  return timeout;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Dedicated Agent Zero Project Chat adapter.
 *
 * This intentionally does not subclass or call AgentZeroProvider: that class
 * proves and exposes the unrestricted A0 Launcher host bridge for Main Agent
 * Chat. This adapter can open only a currently-qualified per-project runtime.
 */
export class AgentZeroProjectProvider implements AgentProvider {
  readonly displayName = 'Agent Zero (Project Sandbox)';
  readonly providerName: AgentProviderName = 'AGENT_ZERO';

  private readonly runtimeResolver: RuntimeResolver;
  private readonly hardAbortRuntime: (
    context: ProjectSandboxExecutionContext,
  ) => boolean | Promise<boolean>;
  private readonly abortSettlementTimeoutMs: number;
  private readonly idFactory: () => string;
  private readonly activeRuns = new Map<string, ActiveProjectRun>();
  private readonly activeProjects = new Map<string, string>();
  private readonly quarantinedProjects = new Map<string, string>();

  constructor(options: AgentZeroProjectProviderOptions = {}) {
    this.runtimeResolver = options.runtimeResolver
      || ((context, selection) => openQualifiedAgentZeroProjectRuntime(context, { modelSelection: selection }));
    this.hardAbortRuntime = options.hardAbort || ((context) => hardAbortAgentZeroProjectRuntime(context));
    this.abortSettlementTimeoutMs = boundedAbortTimeout(options.abortSettlementTimeoutMs);
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
  }

  private projectRunKey(context: ProjectSandboxExecutionContext): string {
    return crypto.createHash('sha256').update(JSON.stringify({
      actorUserId: context.userId,
      projectIdentityId: context.projectId,
    })).digest('hex');
  }

  private durableQuarantineForProject(
    userId: string,
    context: ProjectSandboxExecutionContext,
  ): NativeSessionData | null {
    const projectKey = this.projectRunKey(context);
    for (const summary of listNativeSessions('AGENT_ZERO', userId)) {
      const candidate = loadNativeSession('AGENT_ZERO', summary.sessionId);
      if (!candidate
        || (
          candidate.metadata?.agentZeroRuntimeQuarantined !== true
          && !String(candidate.metadata?.agentZeroActiveRunId || '').trim()
        )
        || !candidate.executionContext) continue;
      try {
        if (this.projectRunKey(projectContext(candidate)) === projectKey) return candidate;
      } catch {
        // A malformed or foreign session cannot establish this project's
        // quarantine identity; requireProjectSession will reject it directly.
      }
    }
    return null;
  }

  private assertProjectAvailable(
    userId: string,
    context: ProjectSandboxExecutionContext,
  ): string {
    const projectKey = this.projectRunKey(context);
    if (this.activeProjects.has(projectKey)) {
      throw new Error('This project already has an active Agent Zero Sandbox operation.');
    }
    if (this.quarantinedProjects.has(projectKey)
      || this.durableQuarantineForProject(userId, context)) {
      throw new Error(
        'This project has a quarantined Agent Zero runtime and requires verified cleanup before another operation.',
      );
    }
    return projectKey;
  }

  private markQuarantined(
    session: NativeSessionData,
    reason: string,
    runId?: string,
  ): void {
    const context = projectContext(session);
    const projectKey = this.projectRunKey(context);
    this.quarantinedProjects.set(projectKey, session.sessionId);
    updateNativeSessionMetadata('AGENT_ZERO', session.sessionId, {
      agentZeroRuntimeQuarantined: true,
      agentZeroQuarantineReason: reason,
      agentZeroQuarantinedAt: new Date().toISOString(),
      ...(runId ? { agentZeroQuarantinedRunId: runId } : {}),
    });
  }

  private clearQuarantine(session: NativeSessionData): boolean {
    const context = projectContext(session);
    const projectKey = this.projectRunKey(context);
    let updated: NativeSessionData | null = null;
    try {
      updated = updateNativeSessionMetadata('AGENT_ZERO', session.sessionId, {
        agentZeroRuntimeQuarantined: false,
        agentZeroQuarantineReason: null,
        agentZeroQuarantinedAt: null,
        agentZeroQuarantinedRunId: null,
        agentZeroActiveRunId: null,
        agentZeroActiveRunStartedAt: null,
      });
    } catch {
      return false;
    }
    if (!updated) return false;
    if (this.quarantinedProjects.get(projectKey) === session.sessionId) {
      this.quarantinedProjects.delete(projectKey);
    }
    return true;
  }

  private releaseRun(active: ActiveProjectRun): void {
    if (this.activeRuns.get(active.sessionId) === active) {
      this.activeRuns.delete(active.sessionId);
    }
    if (this.activeProjects.get(active.projectKey) === active.sessionId) {
      this.activeProjects.delete(active.projectKey);
    }
  }

  private async hardAbortWithDeadline(
    context: ProjectSandboxExecutionContext,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => this.hardAbortRuntime(context))
          .then((value) => value === true, () => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.abortSettlementTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async deleteRemoteContext(
    runtime: AgentZeroProjectRuntimeHandle,
    remoteContextId: string,
  ): Promise<boolean> {
    try {
      const result = record(await runtime.client.call('chat_delete', {
        context_id: remoteContextId,
      }));
      return result.ok !== false;
    } catch (error: any) {
      return error?.status === 404;
    }
  }

  async convergeAttestedProjectCleanup(input: AttestedProjectRuntimeCleanup): Promise<void> {
    const sessionIds = new Set(input.sessionIds.map((sessionId) => validateContextId(sessionId)));
    const projectKey = this.projectRunKey({
      scope: 'PROJECT_SANDBOX',
      source: 'PORTAL_SERVER',
      userId: input.userId,
      projectId: input.projectId,
      workspaceOwnerId: '',
      projectName: '',
      canonicalRoot: input.canonicalRoot,
      rootDevice: input.rootDevice,
      rootInode: input.rootInode,
      rootBirthtimeNs: input.rootBirthtimeNs,
      runtimePolicyVersion: '',
      egressPolicyVersion: '',
      runtimeImageDigest: '',
      policyFingerprint: '',
    });
    for (const [sessionId, active] of this.activeRuns) {
      if (active.projectKey !== projectKey) continue;
      if (
        !sessionIds.has(sessionId)
        || active.context.userId !== input.userId
        || active.context.projectId !== input.projectId
        || active.context.canonicalRoot !== input.canonicalRoot
        || active.context.rootDevice !== input.rootDevice
        || active.context.rootInode !== input.rootInode
        || active.context.rootBirthtimeNs !== input.rootBirthtimeNs
      ) {
        throw new Error('Agent Zero Project cleanup encountered a newer or differently-bound active run');
      }
      active.quarantined = true;
      active.controller.abort();
      active.resolveSettlement();
      this.activeRuns.delete(sessionId);
    }
    for (const reservations of [this.activeProjects, this.quarantinedProjects]) {
      const sessionId = reservations.get(projectKey);
      if (!sessionId) continue;
      if (!sessionIds.has(sessionId)) {
        throw new Error('Agent Zero Project cleanup encountered a newer in-memory reservation');
      }
      reservations.delete(projectKey);
    }
  }

  async startSession(userId: string, config: AgentSessionConfig): Promise<AgentSessionId> {
    assertExecutionContextBinding(config.executionContext, userId, 'PROJECT_SANDBOX');
    const context = config.executionContext as ProjectSandboxExecutionContext;
    const selection = modelSelectionFromConfig(config);
    const projectKey = this.assertProjectAvailable(userId, context);
    const reservationId = `starting:${this.idFactory()}`;
    this.activeProjects.set(projectKey, reservationId);
    let runtime: AgentZeroProjectRuntimeHandle | null = null;
    let remoteContextId: string | null = null;
    let remoteContextMayBeDeleted = true;
    let chatCreateAttempted = false;
    let localSession: NativeSessionData | null = null;
    try {
      // Persist a local identity before provisioning. If remote cleanup later
      // cannot be proved, this becomes the durable project quarantine marker
      // instead of losing the only record of the uncertain runtime.
      localSession = createNativeSession('AGENT_ZERO', userId, {
        executionContext: context,
        model: selection.model,
        metadata: {
          ...(config.metadata || {}),
          cwd: AGENT_ZERO_PROJECT_ROOT,
          projectRuntime: AGENT_ZERO_PROJECT_RUNTIME,
          connectorProtocol: 'a0-connector.v1',
          agentZeroOAuthProviderId: selection.providerId,
          agentZeroModel: selection.model,
          agentZeroLastSequence: 0,
          agentZeroRuntimeQuarantined: false,
        },
      });
      runtime = await this.runtimeResolver(context, selection);
      assertRuntimeModelBinding(runtime, selection);
      const capabilities = await runtime.client.getCapabilities(true);
      for (const feature of ['chat_create', 'chat_delete', 'chat_reset', 'message_send', 'model_presets', 'model_switcher']) {
        if (!capabilities.features.includes(feature)) {
          throw new Error(`Agent Zero Project Sandbox connector lacks ${feature}.`);
        }
      }
      chatCreateAttempted = true;
      const created = record(await runtime.client.call('chat_create', {
        project_name: 'portal',
      }));
      remoteContextId = validateContextId(created.context_id);
      if (remoteContextAlreadyBound(userId, remoteContextId, localSession.sessionId)) {
        remoteContextMayBeDeleted = false;
        throw new Error('Agent Zero returned a context already bound in Portal.');
      }
      if (!updateNativeSessionMetadata('AGENT_ZERO', localSession.sessionId, {
        agentZeroRemoteContextId: remoteContextId,
        projectRuntimeKey: runtime.descriptor.key,
        agentZeroModelPreset: runtime.modelPresetName,
      })) {
        throw new Error('Portal could not persist the pending Agent Zero project context binding.');
      }
      await applyAgentZeroProjectModelPreset(
        runtime.client,
        remoteContextId,
        runtime.modelPresetName,
        selection,
      );
      return localSession.sessionId;
    } catch (error) {
      let cleanupConfirmed = false;
      if (runtime && remoteContextId && remoteContextMayBeDeleted) {
        cleanupConfirmed = await this.deleteRemoteContext(runtime, remoteContextId);
      } else if (runtime && remoteContextId) {
        cleanupConfirmed = true;
      } else if (runtime && !chatCreateAttempted) {
        // The qualified runtime was opened, but no remote chat creation was
        // attempted, so this start did not allocate a remote logical context.
        cleanupConfirmed = true;
      } else if (!runtime) {
        // The resolver may have provisioned before throwing. Only an exact
        // runtime restart/reattest can close that uncertainty.
        cleanupConfirmed = await this.hardAbortWithDeadline(context);
      }

      if (cleanupConfirmed) {
        if (localSession) deleteNativeSession('AGENT_ZERO', localSession.sessionId);
        throw error;
      }

      if (localSession) {
        this.markQuarantined(
          localSession,
          remoteContextId
            ? 'SESSION_START_REMOTE_DELETE_UNCONFIRMED'
            : 'SESSION_START_REMOTE_CONTEXT_UNCERTAIN',
        );
      }
      const quarantineError = new Error(
        'Agent Zero Project session start failed and remote cleanup could not be verified; the project is quarantined.',
      );
      (quarantineError as Error & { cause?: unknown }).cause = error;
      throw quarantineError;
    } finally {
      if (this.activeProjects.get(projectKey) === reservationId) {
        this.activeProjects.delete(projectKey);
      }
    }
  }

  /**
   * Rebind an idle Portal session to a newly qualified OAuth model without
   * replacing either its Portal identity or its transcript sidecar.
   */
  async rebindSessionModel(
    sessionId: AgentSessionId,
    requestedSelection: AgentZeroProjectModelSelection,
  ): Promise<void> {
    const session = requireProjectSession(sessionId);
    const selection = normalizeAgentZeroProjectModelSelection(requestedSelection);
    const current = modelSelectionFromSession(session);
    if (current.providerId === selection.providerId && current.model === selection.model) return;
    if (this.activeRuns.has(sessionId)) {
      throw new Error('Agent Zero cannot change models while a Project Sandbox turn is active.');
    }

    const context = projectContext(session);
    const projectKey = this.assertProjectAvailable(session.userId, context);
    const reservationId = `model:${this.idFactory()}`;
    this.activeProjects.set(projectKey, reservationId);
    try {
      const runtime = await this.runtimeResolver(context, selection);
      assertRuntimeModelBinding(runtime, selection);
      await applyAgentZeroProjectModelPreset(
        runtime.client,
        remoteContextIdForSession(session),
        runtime.modelPresetName,
        selection,
      );

      // Persist the model and all resume metadata in one atomic session-file
      // replacement after the remote context confirms the exact preset.
      session.model = selection.model;
      session.metadata = {
        ...(session.metadata || {}),
        projectRuntimeKey: runtime.descriptor.key,
        agentZeroOAuthProviderId: selection.providerId,
        agentZeroModel: selection.model,
        agentZeroModelPreset: runtime.modelPresetName,
        agentZeroRuntimeQuarantined: false,
      };
      session.lastActivityAt = new Date().toISOString();
      saveNativeSession(session);
    } catch (error) {
      try {
        this.markQuarantined(session, 'MODEL_REBIND_PERSISTENCE_OR_RUNTIME_UNCONFIRMED');
      } catch {
        this.quarantinedProjects.set(projectKey, sessionId);
      }
      const failure = new Error(
        'Agent Zero Project model change could not prove one consistent remote and persisted binding; the project is quarantined.',
      );
      (failure as Error & { cause?: unknown }).cause = error;
      throw failure;
    } finally {
      if (this.activeProjects.get(projectKey) === reservationId) {
        this.activeProjects.delete(projectKey);
      }
    }
  }

  async sendMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
    _onExecApproval?: OnExecApprovalCallback,
    sender?: SenderIdentity,
  ): Promise<AgentSendResult> {
    const session = requireProjectSession(sessionId);
    if (sender && sender.userId !== session.userId) {
      throw new Error('Agent Zero project session does not belong to the authenticated sender.');
    }
    const content = String(message || '').trim();
    if (!content) throw new Error('Agent Zero project message cannot be empty.');
    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Agent Zero project message exceeds ${MAX_MESSAGE_LENGTH} characters.`);
    }
    if (this.activeRuns.has(sessionId)) {
      throw new Error('Agent Zero already has an active Project Sandbox turn for this session.');
    }

    const context = projectContext(session);
    const remoteContextId = remoteContextIdForSession(session);
    const projectKey = this.assertProjectAvailable(session.userId, context);
    const selection = modelSelectionFromSession(session);
    const runId = runIdFromSender(sender, this.idFactory);
    const controller = new AbortController();
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => { resolveSettlement = resolve; });
    const active: ActiveProjectRun = {
      sessionId,
      runId,
      context,
      projectKey,
      controller,
      settlement,
      resolveSettlement,
      abortPromise: null,
      sendSettled: false,
      quarantined: false,
    };
    // This reservation occurs before runtime resolution, model switching, or
    // history append. A concurrent same-session or same-project request can
    // therefore never cross the first asynchronous boundary.
    this.activeRuns.set(sessionId, active);
    this.activeProjects.set(projectKey, sessionId);
    try {
      if (!updateNativeSessionMetadata('AGENT_ZERO', sessionId, {
        agentZeroActiveRunId: runId,
        agentZeroActiveRunStartedAt: new Date().toISOString(),
      })) {
        throw new Error('Agent Zero Project run reservation could not be persisted.');
      }
    } catch (error) {
      this.releaseRun(active);
      throw error;
    }
    let aggregate = '';
    let emitted = '';
    let activeTool: { id: string; name: string } | null = null;
    const finishActiveTool = (content = '') => {
      if (!activeTool) return;
      onStatus?.({
        type: 'tool_end',
        content,
        toolName: activeTool.name,
        toolCallId: activeTool.id,
        completed: true,
      });
      activeTool = null;
    };
    try {
      const runtime = await this.runtimeResolver(context, selection);
      if (controller.signal.aborted) throw new AgentAbortError();
      assertRuntimeModelBinding(runtime, selection);
      await applyAgentZeroProjectModelPreset(
        runtime.client,
        remoteContextId,
        runtime.modelPresetName,
        selection,
      );
      if (controller.signal.aborted) throw new AgentAbortError();
      const lastSequence = Number(session.metadata?.agentZeroLastSequence || 0);
      appendNativeMessage(session, {
        id: this.idFactory(),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      });
      const result = await runtime.client.streamMessage({
        contextId: remoteContextId,
        message: content,
        fromSequence: Number.isSafeInteger(lastSequence) && lastSequence > 0 ? lastSequence : 0,
        signal: controller.signal,
        onTransportStatus: (status) => {
          onStatus?.({
            type: 'status',
            content: status === 'reconnecting'
              ? 'Reconnecting to the isolated Agent Zero project runtime…'
              : status === 'replayed'
                ? 'Replaying missed Agent Zero project events…'
                : 'Agent Zero Project Sandbox connected.',
          });
        },
        onEvent: (event) => {
          const text = eventText(event);
          if (event.event === 'assistant_delta') {
            finishActiveTool();
            aggregate = cleanText(`${aggregate}${text}`);
            if (text) {
              emitted = cleanText(`${emitted}${text}`);
              onChunk?.(text);
            }
            return;
          }
          if (event.event === 'assistant_message') {
            finishActiveTool();
            aggregate = text || aggregate;
            if (aggregate && aggregate !== emitted) {
              if (aggregate.startsWith(emitted)) onChunk?.(aggregate.slice(emitted.length));
              else onStatus?.({ type: 'text', content: aggregate, replace: true });
              emitted = aggregate;
            }
            return;
          }
          if (event.event === 'tool_start' || event.event === 'code_start') {
            finishActiveTool();
            activeTool = {
              id: eventToolCallId(event, sessionId),
              name: event.data.heading || (event.event === 'code_start' ? 'Agent Zero code' : 'Agent Zero tool'),
            };
            onStatus?.({
              type: 'tool_start',
              content: text,
              toolName: activeTool.name,
              toolCallId: activeTool.id,
            });
          } else if (event.event === 'tool_output' || event.event === 'code_output') {
            if (!activeTool) {
              activeTool = {
                id: eventToolCallId(event, sessionId),
                name: event.data.heading || (event.event === 'code_output' ? 'Agent Zero code' : 'Agent Zero tool'),
              };
              onStatus?.({
                type: 'tool_start',
                content: '',
                toolName: activeTool.name,
                toolCallId: activeTool.id,
              });
            }
            onStatus?.({
              type: 'tool_update',
              content: text,
              toolName: activeTool.name,
              toolCallId: activeTool.id,
            });
          } else if (event.event === 'tool_end') {
            if (!activeTool) {
              activeTool = {
                id: eventToolCallId(event, sessionId),
                name: event.data.heading || 'Agent Zero tool',
              };
            }
            finishActiveTool(text);
          } else if (event.event === 'util_message') {
            onStatus?.({ type: 'thinking', content: text });
          } else if (event.event === 'error') {
            finishActiveTool();
            onStatus?.({ type: 'error', content: text });
          } else {
            if (event.event === 'message_complete') finishActiveTool();
            onStatus?.({ type: 'status', content: text });
          }
        },
      });
      finishActiveTool();
      if (controller.signal.aborted) throw new AgentAbortError();
      if (result.status !== 'completed') {
        throw new Error('Agent Zero Project turn did not report a completed settlement.');
      }
      const completed = responseText(result.response) || aggregate;
      if (completed && completed !== emitted) {
        if (completed.startsWith(emitted)) onChunk?.(completed.slice(emitted.length));
        else onStatus?.({ type: 'text', content: completed, replace: true });
      }
      appendNativeMessage(session, {
        id: this.idFactory(),
        role: 'assistant',
        content: completed,
        timestamp: new Date().toISOString(),
      });
      updateNativeSessionMetadata('AGENT_ZERO', sessionId, {
        agentZeroLastSequence: result.lastSequence,
        projectRuntimeKey: runtime.descriptor.key,
        agentZeroOAuthProviderId: selection.providerId,
        agentZeroModel: selection.model,
        agentZeroModelPreset: runtime.modelPresetName,
      });
      return {
        fullText: completed,
        metadata: {
          provider: 'agent-zero',
          executionScope: 'PROJECT_SANDBOX',
          projectRuntime: AGENT_ZERO_PROJECT_RUNTIME,
          contextId: sessionId,
          lastSequence: result.lastSequence,
          reconnects: result.reconnects,
          eventsProcessed: result.eventsProcessed,
          supportsAbort: true,
          runId,
          model: selection.model,
          oauthProviderId: selection.providerId,
        },
      };
    } catch (error) {
      finishActiveTool();
      if (controller.signal.aborted || error instanceof AgentAbortError) throw new AgentAbortError();
      throw error;
    } finally {
      active.sendSettled = true;
      active.resolveSettlement();
      if (!active.quarantined) {
        let cleared = false;
        try {
          cleared = Boolean(updateNativeSessionMetadata('AGENT_ZERO', sessionId, {
            agentZeroActiveRunId: null,
            agentZeroActiveRunStartedAt: null,
          }));
        } catch {
          cleared = false;
        }
        if (cleared) {
          this.releaseRun(active);
        } else {
          active.quarantined = true;
          try {
            this.markQuarantined(session, 'ACTIVE_RUN_SETTLEMENT_PERSISTENCE_UNCONFIRMED', runId);
          } catch {
            this.quarantinedProjects.set(projectKey, sessionId);
          }
        }
      }
      onStatus?.({ type: 'status', content: '' });
    }
  }

  async getHistory(sessionId: AgentSessionId): Promise<AgentMessage[]> {
    requireProjectSession(sessionId, { allowQuarantined: true });
    return readAllNativeSessionHistory('AGENT_ZERO', sessionId);
  }

  async listSessions(userId: string): Promise<AgentSessionSummary[]> {
    return listNativeSessions('AGENT_ZERO', userId).filter((summary) => {
      try {
        requireProjectSession(summary.sessionId, { allowQuarantined: true });
        return true;
      } catch {
        return false;
      }
    });
  }

  async terminateSession(sessionId: AgentSessionId): Promise<void> {
    const session = requireProjectSession(sessionId, { allowQuarantined: true });
    const active = this.activeRuns.get(sessionId);
    if (active) {
      const aborted = await this.abortActiveRun(sessionId, active.runId);
      if (!aborted) {
        throw new Error(
          'Agent Zero Project session termination is blocked because active runtime cleanup was not verified.',
        );
      }
    }
    const selection = modelSelectionFromSession(session);
    const context = projectContext(session);
    const projectKey = this.projectRunKey(context);
    const remoteContextId = remoteContextIdForSession(session);
    // A failed chat_create can leave no trustworthy remote id. Preserve its
    // durable quarantine until project-level runtime cleanup removes the
    // entire exact container/volume boundary.
    if (!CONTEXT_ID_RE.test(remoteContextId)) {
      this.markQuarantined(session, 'SESSION_TERMINATION_REMOTE_CONTEXT_UNKNOWN');
      throw new Error('Agent Zero Project remote context identity is unavailable for verified deletion.');
    }
    if (session.metadata?.agentZeroRuntimeQuarantined === true) {
      const stopped = await this.hardAbortWithDeadline(context);
      if (!stopped) {
        this.markQuarantined(session, 'SESSION_TERMINATION_HARD_ABORT_UNCONFIRMED');
        throw new Error('Agent Zero Project session termination could not verify runtime stop.');
      }
    }
    let runtime: AgentZeroProjectRuntimeHandle;
    try {
      runtime = await this.runtimeResolver(context, selection);
      assertRuntimeModelBinding(runtime, selection);
    } catch (error) {
      this.markQuarantined(session, 'SESSION_TERMINATION_RUNTIME_UNVERIFIED');
      throw error;
    }
    const deleted = await this.deleteRemoteContext(runtime, remoteContextId);
    if (!deleted) {
      this.markQuarantined(session, 'SESSION_TERMINATION_REMOTE_DELETE_UNCONFIRMED');
      throw new Error('Agent Zero Project remote context deletion could not be verified.');
    }
    if (active) this.releaseRun(active);
    if (this.quarantinedProjects.get(projectKey) === sessionId) {
      this.quarantinedProjects.delete(projectKey);
    }
    if (this.activeProjects.get(projectKey) === sessionId) {
      this.activeProjects.delete(projectKey);
    }
    deleteNativeSession('AGENT_ZERO', sessionId);
  }

  async abortActiveRun(sessionId: AgentSessionId, runId?: string): Promise<boolean> {
    const session = requireProjectSession(sessionId, { allowQuarantined: true });
    const active = this.activeRuns.get(sessionId);
    if (!active) return false;
    if (runId && active.runId !== runId) return false;
    if (active.abortPromise) return active.abortPromise;

    // Quarantine before touching the stream. The stream's finally block may
    // run immediately after AbortController fires and must not release the
    // actor/project reservation until both boundaries are proved.
    active.quarantined = true;
    try {
      this.markQuarantined(session, 'ACTIVE_RUN_ABORT_PENDING', active.runId);
    } catch {
      this.quarantinedProjects.set(active.projectKey, sessionId);
    }
    active.controller.abort();
    const attempt = (async () => {
      const hardStopped = await this.hardAbortWithDeadline(active.context);
      if (!hardStopped) return false;
      const settled = active.sendSettled
        || await settlesWithin(active.settlement, this.abortSettlementTimeoutMs);
      if (!settled) return false;
      const current = loadNativeSession('AGENT_ZERO', sessionId);
      if (!current || !this.clearQuarantine(current)) return false;
      active.quarantined = false;
      this.releaseRun(active);
      return true;
    })();
    active.abortPromise = attempt;
    return attempt;
  }

  /** Reset only the remote context; the per-project runtime and other projects remain untouched. */
  async resetSession(sessionId: AgentSessionId): Promise<void> {
    const session = requireProjectSession(sessionId);
    if (this.activeRuns.has(sessionId)) throw new Error('Abort the active Agent Zero project turn before reset.');
    const selection = modelSelectionFromSession(session);
    const runtime = await this.runtimeResolver(projectContext(session), selection);
    assertRuntimeModelBinding(runtime, selection);
    const remoteContextId = remoteContextIdForSession(session);
    await runtime.client.call('chat_reset', { context_id: remoteContextId });
    await applyAgentZeroProjectModelPreset(
      runtime.client,
      remoteContextId,
      runtime.modelPresetName,
      selection,
    );
    clearNativeSessionHistory(session);
  }
}
