import { NativeCliAdapterProvider } from './native/NativeCliAdapterProvider';
import { grokAdapter } from './native/adapters/grok';
import {
  GrokAcpBroker,
  type GrokAcpPermissionRequest,
} from './native/grok/GrokAcpBroker';
import type {
  AgentSendResult,
  AgentSessionId,
  OnChunkCallback,
  OnExecApprovalCallback,
  OnStatusCallback,
  SenderIdentity,
} from '../AgentProvider.interface';
import { AgentAbortError } from '../AgentProvider.interface';
import { assertExecutionContextBinding } from '../executionScope';
import { getProviderAvailabilityAsync } from '../providerAvailability';
import { requestNativeCliApproval } from '../nativeCliApprovals';
import { withPortalGuideReference } from '../../services/portalOperatingGuide';
import { isElevatedRole } from '../../utils/authz';
import {
  appendNativeMessage,
  updateNativeSessionMetadata,
} from './NativeSessionStore';
import { randomUUID } from 'crypto';
import { ChatImageError } from '../../services/chatImages/chatImageModelPolicy';
import { stripChatImageReferences } from '../../services/chatImages/directChatImages';
import { NativeChatTurnTools } from './native/NativeChatTurnTools';
import { acpBridgeMcpServers, acpBridgeToolResolver } from './native/acp/AcpChatBridge';

const GROK_PROMPT_IMAGE_ATTESTATION_TTL_MS = 10 * 60_000;

function renderPermissionCommand(request: GrokAcpPermissionRequest): string {
  const raw = typeof request.rawInput === 'string'
    ? request.rawInput
    : (() => {
        try { return JSON.stringify(request.rawInput); } catch { return ''; }
      })();
  const detail = String(raw || '').trim();
  const command = detail ? `${request.title}\n${detail}` : request.title;
  return command.length > 16_384 ? `${command.slice(0, 16_384)}…` : command;
}

/** Native xAI Grok Build CLI provider for privileged Agent Chat sessions. */
export class GrokProvider extends NativeCliAdapterProvider {
  private readonly activeBrokers = new Map<AgentSessionId, GrokAcpBroker>();
  /** Held from the guard until settlement, across the bridge-open await. */
  private readonly reservations = new Set<AgentSessionId>();
  private promptImageAttestation: { at: number; images: boolean; identity: string } | null = null;

  constructor() {
    super(grokAdapter);
  }

  /** Photos are offered; Grok's own ACP initialize answer decides. */
  override get supportsNativeChatImages(): boolean {
    return true;
  }

  /** Admission from `agentCapabilities.promptCapabilities.image` (never a model-name guess). */
  override async assertChatImageModel(sessionId: AgentSessionId): Promise<string> {
    const session = this.requireSession(sessionId);
    assertExecutionContextBinding(session.executionContext, session.userId, 'HOST_OPERATOR');
    const cached = this.promptImageAttestation;
    let attestation = cached && Date.now() - cached.at < GROK_PROMPT_IMAGE_ATTESTATION_TTL_MS ? cached : null;
    if (!attestation) {
      const broker = new GrokAcpBroker({ cwd: session.cwd });
      try {
        const attested = await broker.attest();
        attestation = { at: Date.now(), images: attested.promptImages, identity: `${attested.agentName}@${attested.agentVersion}` };
        this.promptImageAttestation = attestation;
      } catch {
        throw new ChatImageError('IMAGE_MODEL_UNAVAILABLE', 503);
      } finally {
        await broker.dispose();
      }
    }
    if (!attestation.images) throw new ChatImageError('IMAGE_MODEL_UNSUPPORTED');
    return `${attestation.identity}:${session.model || 'default'}`;
  }

  override async sendMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
    onExecApproval?: OnExecApprovalCallback,
    sender?: SenderIdentity,
  ): Promise<AgentSendResult> {
    const availability = await getProviderAvailabilityAsync('GROK');
    if (!availability.usable) {
      throw new Error(availability.reason || 'Grok Build is not ready on this server.');
    }
    if (this.activeBrokers.has(sessionId) || this.reservations.has(sessionId)) {
      throw new Error('A Grok Build turn is already active for this session.');
    }
    this.reservations.add(sessionId);
    try {
      return await this.sendReservedMessage(sessionId, message, onChunk, onStatus, onExecApproval, sender);
    } finally {
      this.reservations.delete(sessionId);
    }
  }

  private async sendReservedMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
    onExecApproval?: OnExecApprovalCallback,
    sender?: SenderIdentity,
  ): Promise<AgentSendResult> {

    const session = this.requireSession(sessionId);
    assertExecutionContextBinding(session.executionContext, session.userId, 'HOST_OPERATOR');
    if (sender?.userId && sender.userId !== session.userId) {
      throw new Error('Grok Build sender does not own this host session');
    }
    const runId = typeof sender?.requestId === 'string' && sender.requestId.trim()
      ? sender.requestId.trim()
      : randomUUID();
    const chatImages = Array.isArray(sender?.chatImages) ? sender!.chatImages! : [];
    const promptMessage = chatImages.length > 0
      ? stripChatImageReferences(message) || 'Describe the attached photo.'
      : message;
    appendNativeMessage(session, {
      id: this.nextId(),
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    });

    const chatTools = await NativeChatTurnTools.open({
      provider: 'GROK',
      portalSessionId: sessionId,
      runId,
      sender,
      bridge: true,
    });
    const projectStatus: OnStatusCallback = (event) => onStatus?.(chatTools.project(event));
    let broker: GrokAcpBroker;
    try {
      broker = new GrokAcpBroker({
        cwd: session.cwd,
        model: session.model,
        nativeSessionId: typeof session.metadata?.nativeSessionId === 'string'
          ? session.metadata.nativeSessionId
          : null,
        mcpServers: acpBridgeMcpServers(chatTools),
        resolveToolName: acpBridgeToolResolver(chatTools),
        onChunk,
        onStatus: projectStatus,
        onPermission: async (request) => {
          if (sender?.role && !isElevatedRole(sender.role)) {
            onStatus?.({
              type: 'status',
              content: 'Grok Build permission requests are restricted to portal admins. This request was denied.',
              provider: 'grok-build',
            });
            return 'deny';
          }
          onStatus?.({
            type: 'status',
            content: 'Grok Build is waiting for permission…',
            provider: 'grok-build',
            toolCallId: request.toolCallId,
          });
          return requestNativeCliApproval({
            providerName: 'GROK',
            sessionId: session.sessionId,
            command: renderPermissionCommand(request),
            cwd: session.cwd,
            security: 'grok-acp-host-operator',
            ask: `${request.kind}: ${request.title}`,
            onRequest: onExecApproval,
            timeoutMs: 10 * 60_000,
          });
        },
      });
    } catch (error) {
      chatTools.revoke();
      throw error;
    }
    this.activeBrokers.set(sessionId, broker);
    onStatus?.({
      type: 'status',
      content: 'Grok Build is working…',
      provider: 'grok-build',
      executionScope: 'HOST_OPERATOR',
    });

    try {
      // Persist the native id before the side-effecting prompt begins. If the
      // ACP process is lost mid-turn, the next request can safely load the
      // same Grok session without silently replaying the prior prompt.
      const establishedSessionId = await broker.start();
      session.metadata = {
        ...(session.metadata || {}),
        nativeSessionId: establishedSessionId,
      };
      updateNativeSessionMetadata('GROK', session.sessionId, session.metadata);
      if (chatImages.length > 0) {
        if (!broker.supportsPromptImages) throw new ChatImageError('IMAGE_MODEL_UNSUPPORTED');
        if (typeof sender?.revalidateChatImages !== 'function') throw new ChatImageError('IMAGE_REVALIDATION_REQUIRED', 503);
        await sender.revalidateChatImages();
      }
      const result = await broker.prompt(
        withPortalGuideReference(promptMessage, session.messages.length === 1),
        chatImages,
      );
      session.metadata = {
        ...(session.metadata || {}),
        nativeSessionId: result.nativeSessionId,
        grokAcpAgentVersion: result.agentVersion,
        grokAcpProtocolVersion: result.protocolVersion,
      };
      updateNativeSessionMetadata('GROK', session.sessionId, session.metadata);
      appendNativeMessage(session, {
        id: this.nextId(),
        role: 'assistant',
        content: result.fullText,
        timestamp: new Date().toISOString(),
        toolCalls: chatTools.toolCalls(),
      });
      onStatus?.({ type: 'status', content: '', provider: 'grok-build' });
      return {
        fullText: result.fullText,
        metadata: {
          provider: 'grok-build-cli',
          transport: 'acp-stdio',
          nativeToolEvents: true,
          nativePermissions: true,
          hardAbort: true,
          reconnect: 'persisted-session-load-between-turns',
          midTurnReplay: false,
          agentVersion: result.agentVersion,
          protocolVersion: result.protocolVersion,
          nativeSessionId: result.nativeSessionId,
          stopReason: result.stopReason,
          usage: result.usage,
          model: session.model || null,
          executionScope: session.executionContext.scope,
        },
      };
    } catch (error: any) {
      if (error instanceof AgentAbortError) {
        onStatus?.({ type: 'status', content: '', provider: 'grok-build' });
        throw error;
      }
      const messageText = error instanceof Error ? error.message : String(error);
      appendNativeMessage(session, {
        id: this.nextId(),
        role: 'assistant',
        content: `Error: ${messageText}`,
        timestamp: new Date().toISOString(),
        toolCalls: chatTools.toolCalls(),
      });
      throw error;
    } finally {
      // Every settlement path (success, error, abort) ends the capability.
      chatTools.revoke();
      if (this.activeBrokers.get(sessionId) === broker) this.activeBrokers.delete(sessionId);
      broker.close();
    }
  }

  override async abortActiveRun(sessionId: AgentSessionId): Promise<boolean> {
    return this.activeBrokers.get(sessionId)?.abort() || false;
  }

  override async terminateSession(sessionId: AgentSessionId): Promise<void> {
    this.activeBrokers.get(sessionId)?.abort();
    await super.terminateSession(sessionId);
  }
}
