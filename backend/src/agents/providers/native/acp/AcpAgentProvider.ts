import { withPortalGuideReference } from '../../../../services/portalOperatingGuide';
import type {
  AgentProviderName,
  AgentSendResult,
  AgentSessionId,
  AgentSessionModelResult,
  OnChunkCallback,
  OnExecApprovalCallback,
  OnStatusCallback,
  SenderIdentity,
} from '../../../AgentProvider.interface';
import { AgentAbortError } from '../../../AgentProvider.interface';
import { assertExecutionContextBinding } from '../../../executionScope';
import { requestNativeCliApproval } from '../../../nativeCliApprovals';
import { getNativeProviderReadiness } from '../../../nativeProviderReadiness';
import { getProviderAvailability } from '../../../providerAvailability';
import { isElevatedRole } from '../../../../utils/authz';
import {
  appendNativeMessage,
  updateNativeSessionMetadata,
  updateNativeSessionModel,
} from '../../NativeSessionStore';
import { NativeCliAdapterProvider } from '../NativeCliAdapterProvider';
import type { NativeCliProviderAdapter } from '../types';
import { buildAcpHarnessEnvironment } from './AcpHarnessEnvironment';
import type { AcpHarnessProfile, AcpPermissionRequest } from './AcpStdioBroker';
import { AcpStdioBroker } from './AcpStdioBroker';
import { recordAcpModelCatalog } from './AcpModelCatalog';

type PortalAcpProviderName = Extract<AgentProviderName, 'HERMES' | 'OPENCODE'>;

export interface AcpAgentProviderConfig {
  providerName: PortalAcpProviderName;
  adapter: NativeCliProviderAdapter;
  profile: AcpHarnessProfile;
  securityTag: string;
  /** Test seam for the complete provider/persistence contract. */
  brokerFactory?: (options: ConstructorParameters<typeof AcpStdioBroker>[0]) => AcpStdioBroker;
}

interface ActiveAcpRun {
  broker: AcpStdioBroker;
  approvalAbort: AbortController;
  completion: Promise<void>;
  resolveCompletion: () => void;
}

function renderPermissionCommand(request: AcpPermissionRequest): string {
  const raw = typeof request.rawInput === 'string'
    ? request.rawInput
    : (() => {
        try { return JSON.stringify(request.rawInput); } catch { return ''; }
      })();
  const detail = String(raw || '').trim();
  const command = detail ? `${request.title}\n${detail}` : request.title;
  return Buffer.byteLength(command, 'utf8') > 16_384
    ? `${Buffer.from(command, 'utf8').subarray(0, 16_381).toString('utf8').replace(/\uFFFD$/u, '')}…`
    : command;
}

/** Shared Portal session/persistence bridge for exact-pinned ACP harnesses. */
export abstract class AcpAgentProvider extends NativeCliAdapterProvider {
  private readonly activeBrokers = new Map<AgentSessionId, ActiveAcpRun>();
  private readonly reservations = new Set<AgentSessionId>();

  protected constructor(private readonly acp: AcpAgentProviderConfig) {
    super(acp.adapter);
    if (acp.adapter.providerName !== acp.providerName || acp.profile.id !== acp.providerName) {
      throw new Error('ACP provider identity configuration is inconsistent');
    }
  }

  private createBroker(
    sessionId: AgentSessionId,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
    onExecApproval?: OnExecApprovalCallback,
    sender?: SenderIdentity,
    requestedModel?: string | null,
  ): ActiveAcpRun {
    const session = this.requireSession(sessionId);
    const approvalAbort = new AbortController();
    const broker = (this.acp.brokerFactory || ((options) => new AcpStdioBroker(options)))({
      profile: this.acp.profile,
      cwd: session.cwd,
      environment: buildAcpHarnessEnvironment(this.acp.providerName),
      model: requestedModel === undefined ? session.model : requestedModel,
      nativeSessionId: typeof session.metadata?.nativeSessionId === 'string'
        ? session.metadata.nativeSessionId
        : null,
      onChunk,
      onStatus,
      onPermission: async (request) => {
        if (!sender?.role || !isElevatedRole(sender.role)) {
          onStatus?.({
            type: 'status',
            content: `${this.displayName} permission requests are restricted to portal admins. This request was denied.`,
            provider: this.acp.profile.providerTag,
          });
          return 'deny';
        }
        onStatus?.({
          type: 'status',
          content: `${this.displayName} is waiting for permission…`,
          provider: this.acp.profile.providerTag,
          toolCallId: request.toolCallId,
        });
        return requestNativeCliApproval({
          providerName: this.acp.providerName,
          sessionId: session.sessionId,
          command: renderPermissionCommand(request),
          cwd: session.cwd,
          security: this.acp.securityTag,
          ask: `${request.kind}: ${request.title}`,
          onRequest: onExecApproval,
          signal: approvalAbort.signal,
          timeoutMs: 10 * 60_000,
        });
      },
    });
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    return { broker, approvalAbort, completion, resolveCompletion };
  }

  private async assertReady(): Promise<void> {
    const availability = getProviderAvailability(this.acp.providerName);
    if (!availability.usable) {
      throw new Error(availability.reason || `${this.displayName} is not ready on this server.`);
    }
    const readiness = await getNativeProviderReadiness(this.acp.providerName);
    if (!readiness.usable) throw new Error(readiness.message);
  }

  override async sendMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
    onExecApproval?: OnExecApprovalCallback,
    sender?: SenderIdentity,
  ): Promise<AgentSendResult> {
    if (!String(message || '').trim()) throw new Error(`${this.displayName} message cannot be empty.`);
    if (this.reservations.has(sessionId)) {
      throw new Error(`A ${this.displayName} turn is already active for this session.`);
    }
    this.reservations.add(sessionId);
    try {
      await this.assertReady();
      const session = this.requireSession(sessionId);
      assertExecutionContextBinding(session.executionContext, session.userId, 'HOST_OPERATOR');
      if (sender?.userId && sender.userId !== session.userId) {
        throw new Error(`${this.displayName} sender does not own this host session`);
      }
      appendNativeMessage(session, {
        id: this.nextId(),
        role: 'user',
        content: message,
        timestamp: new Date().toISOString(),
      });

      const active = this.createBroker(sessionId, onChunk, onStatus, onExecApproval, sender);
      this.activeBrokers.set(sessionId, active);
      onStatus?.({
        type: 'status',
        content: `${this.displayName} is working…`,
        provider: this.acp.profile.providerTag,
        executionScope: 'HOST_OPERATOR',
      });

      try {
        // Persist the upstream id before prompting. If the process disappears
        // during a side-effecting prompt, the next request loads this exact
        // native session and never replays the prior message automatically.
        const established = await active.broker.start();
        recordAcpModelCatalog(this.acp.providerName, established.modelState);
        const metadata: Record<string, unknown> = {
          ...(session.metadata || {}),
          nativeSessionId: established.nativeSessionId,
          acpAgentName: established.agentName,
          acpAgentVersion: established.agentVersion,
          acpProtocolVersion: established.protocolVersion,
          acpCurrentModelId: established.modelState.currentModelId,
          acpAvailableModels: established.modelState.availableModels,
        };
        if (!metadata.nativeDefaultModelId && established.initialModelId) {
          metadata.nativeDefaultModelId = established.initialModelId;
        }
        session.metadata = metadata;
        updateNativeSessionMetadata(this.acp.providerName, session.sessionId, metadata);

        const result = await active.broker.prompt(withPortalGuideReference(message, session.messages.length === 1));
        recordAcpModelCatalog(this.acp.providerName, result.modelState);
        session.metadata = {
          ...(session.metadata || {}),
          nativeSessionId: result.nativeSessionId,
          acpAgentName: result.agentName,
          acpAgentVersion: result.agentVersion,
          acpProtocolVersion: result.protocolVersion,
          acpCurrentModelId: result.modelState.currentModelId,
          acpAvailableModels: result.modelState.availableModels,
        };
        updateNativeSessionMetadata(this.acp.providerName, session.sessionId, session.metadata);
        appendNativeMessage(session, {
          id: this.nextId(),
          role: 'assistant',
          content: result.fullText,
          timestamp: new Date().toISOString(),
        });
        onStatus?.({ type: 'status', content: '', provider: this.acp.profile.providerTag });
        return {
          fullText: result.fullText,
          metadata: {
            provider: this.acp.profile.providerTag,
            transport: 'acp-stdio',
            nativeToolEvents: true,
            nativePermissions: true,
            hardAbort: true,
            reconnect: 'persisted-session-load-between-turns',
            midTurnReplay: false,
            agentName: result.agentName,
            agentVersion: result.agentVersion,
            protocolVersion: result.protocolVersion,
            nativeSessionId: result.nativeSessionId,
            stopReason: result.stopReason,
            usage: result.usage,
            model: result.modelState.currentModelId,
            sessionModelState: result.modelState,
            executionScope: session.executionContext.scope,
          },
        };
      } catch (error: any) {
        if (error instanceof AgentAbortError) {
          onStatus?.({ type: 'status', content: '', provider: this.acp.profile.providerTag });
          throw error;
        }
        const errorText = error instanceof Error ? error.message : String(error);
        appendNativeMessage(session, {
          id: this.nextId(),
          role: 'assistant',
          content: `Error: ${errorText}`,
          timestamp: new Date().toISOString(),
        });
        throw error;
      } finally {
        active.approvalAbort.abort();
        try {
          await active.broker.dispose();
        } finally {
          if (this.activeBrokers.get(sessionId) === active) this.activeBrokers.delete(sessionId);
          active.resolveCompletion();
        }
      }
    } finally {
      this.reservations.delete(sessionId);
    }
  }

  async setSessionModel(
    sessionId: AgentSessionId,
    model: string | null,
  ): Promise<AgentSessionModelResult> {
    if (this.reservations.has(sessionId)) {
      throw new Error(`Cannot change the ${this.displayName} model during an active operation.`);
    }
    this.reservations.add(sessionId);
    try {
      await this.assertReady();
      const session = this.requireSession(sessionId);
      assertExecutionContextBinding(session.executionContext, session.userId, 'HOST_OPERATOR');
      const active = this.createBroker(sessionId, undefined, undefined, undefined, undefined, null);
      this.activeBrokers.set(sessionId, active);
      try {
        const established = await active.broker.start();
        recordAcpModelCatalog(this.acp.providerName, established.modelState);
        const defaultModelId = typeof session.metadata?.nativeDefaultModelId === 'string'
          ? session.metadata.nativeDefaultModelId
          : established.initialModelId;
        const target = model || defaultModelId || established.modelState.currentModelId;
        if (!target) throw new Error(`${this.displayName} did not report a model that can be selected.`);
        const state = await active.broker.setModel(target);
        if (state.currentModelId !== target) {
          throw new Error(`${this.displayName} model readback did not match the requested model.`);
        }
        recordAcpModelCatalog(this.acp.providerName, state);
        const metadata: Record<string, unknown> = {
          ...(session.metadata || {}),
          nativeSessionId: established.nativeSessionId,
          nativeDefaultModelId: defaultModelId || target,
          acpCurrentModelId: state.currentModelId,
          acpAvailableModels: state.availableModels,
          acpAgentName: established.agentName,
          acpAgentVersion: established.agentVersion,
          acpProtocolVersion: established.protocolVersion,
        };
        updateNativeSessionMetadata(this.acp.providerName, sessionId, metadata);
        const updated = updateNativeSessionModel(this.acp.providerName, sessionId, model);
        if (!updated) throw new Error(`${this.displayName} session disappeared while changing its model.`);
        return {
          model,
          metadata: {
            effectiveModel: state.currentModelId,
            availableModels: state.availableModels,
            sessionModelState: state,
            nativeSessionId: established.nativeSessionId,
          },
        };
      } finally {
        active.approvalAbort.abort();
        try {
          await active.broker.dispose();
        } finally {
          if (this.activeBrokers.get(sessionId) === active) this.activeBrokers.delete(sessionId);
          active.resolveCompletion();
        }
      }
    } finally {
      this.reservations.delete(sessionId);
    }
  }

  override async abortActiveRun(sessionId: AgentSessionId): Promise<boolean> {
    const active = this.activeBrokers.get(sessionId);
    if (!active) return false;
    active.approvalAbort.abort();
    return active.broker.abort();
  }

  override async terminateSession(sessionId: AgentSessionId): Promise<void> {
    const active = this.activeBrokers.get(sessionId);
    if (!active && this.reservations.has(sessionId)) {
      throw new Error(`${this.displayName} has an operation in progress for this session.`);
    }
    if (active) {
      active.approvalAbort.abort();
      active.broker.abort();
      await active.broker.dispose();
      await active.completion;
    } else if (this.acp.profile.supportsSessionClose) {
      await this.assertReady();
      this.requireSession(sessionId);
      const closing = this.createBroker(sessionId, undefined, undefined, undefined, undefined, null);
      try {
        await closing.broker.closeSession();
      } finally {
        await closing.broker.dispose();
      }
    }
    await super.terminateSession(sessionId);
  }
}
