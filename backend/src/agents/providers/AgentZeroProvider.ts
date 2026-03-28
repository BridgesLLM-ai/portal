/**
 * Agent Zero Provider — Stub
 *
 * Placeholder for future Agent Zero integration.
 * All methods throw "not yet implemented" until wired up.
 */

import {
  AgentProvider,
  AgentProviderName,
  AgentSessionId,
  AgentSessionConfig,
  AgentMessage,
  AgentSendResult,
  AgentSessionSummary,
  OnChunkCallback,
  OnStatusCallback,
  OnExecApprovalCallback,
  SenderIdentity,
} from '../AgentProvider.interface';

const NOT_IMPLEMENTED = 'Agent Zero provider is not yet implemented';

export class AgentZeroProvider implements AgentProvider {
  readonly displayName = 'Agent Zero';
  readonly providerName: AgentProviderName = 'AGENT_ZERO';

  async startSession(_userId: string, _config?: AgentSessionConfig): Promise<AgentSessionId> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async sendMessage(
    _sessionId: AgentSessionId,
    _message: string,
    _onChunk?: OnChunkCallback,
    _onStatus?: OnStatusCallback,
    _onExecApproval?: OnExecApprovalCallback,
    _sender?: SenderIdentity,
  ): Promise<AgentSendResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getHistory(_sessionId: AgentSessionId): Promise<AgentMessage[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async listSessions(_userId: string): Promise<AgentSessionSummary[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async terminateSession(_sessionId: AgentSessionId): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
