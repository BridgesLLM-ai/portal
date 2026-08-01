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
import { getProviderAvailability } from '../providerAvailability';
import { requestNativeCliApproval } from '../nativeCliApprovals';
import { isElevatedRole } from '../../utils/authz';
import {
  appendNativeMessage,
  updateNativeSessionMetadata,
} from './NativeSessionStore';

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

  constructor() {
    super(grokAdapter);
  }

  override async sendMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
    onExecApproval?: OnExecApprovalCallback,
    sender?: SenderIdentity,
  ): Promise<AgentSendResult> {
    const availability = getProviderAvailability('GROK');
    if (!availability.usable) {
      throw new Error(availability.reason || 'Grok Build is not ready on this server.');
    }
    if (this.activeBrokers.has(sessionId)) {
      throw new Error('A Grok Build turn is already active for this session.');
    }

    const session = this.requireSession(sessionId);
    assertExecutionContextBinding(session.executionContext, session.userId, 'HOST_OPERATOR');
    appendNativeMessage(session, {
      id: this.nextId(),
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    });

    const broker = new GrokAcpBroker({
      cwd: session.cwd,
      model: session.model,
      nativeSessionId: typeof session.metadata?.nativeSessionId === 'string'
        ? session.metadata.nativeSessionId
        : null,
      onChunk,
      onStatus,
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
      const result = await broker.prompt(message);
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
      });
      throw error;
    } finally {
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
