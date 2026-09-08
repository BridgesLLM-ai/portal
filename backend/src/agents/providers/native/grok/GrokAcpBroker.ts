import type { OnStatusCallback } from '../../../AgentProvider.interface';
import { buildAcpHarnessEnvironment } from '../acp/AcpHarnessEnvironment';
import { GROK_ACP_PROFILE } from '../acp/AcpHarnessProfiles';
import {
  ACP_MAX_LINE_BYTES,
  ACP_MAX_TEXT_BYTES,
  AcpStdioBroker,
  type AcpPermissionDecision,
  type AcpPermissionOption,
  type AcpPermissionRequest,
  type SpawnImplementation,
} from '../acp/AcpStdioBroker';

export const GROK_ACP_AGENT_VERSION = GROK_ACP_PROFILE.expectedAgentVersion;
export const GROK_ACP_PROTOCOL_VERSION = GROK_ACP_PROFILE.protocolVersion;
export const GROK_ACP_MAX_LINE_BYTES = ACP_MAX_LINE_BYTES;
export const GROK_ACP_MAX_TEXT_BYTES = ACP_MAX_TEXT_BYTES;

export type GrokAcpPermissionDecision = AcpPermissionDecision;
export type GrokAcpPermissionOption = AcpPermissionOption;
export type GrokAcpPermissionRequest = AcpPermissionRequest;
export { type SpawnImplementation };

export interface GrokAcpTurnResult {
  fullText: string;
  nativeSessionId: string;
  stopReason: string;
  usage?: Record<string, unknown>;
  agentVersion: string;
  protocolVersion: number;
}

export interface GrokAcpBrokerOptions {
  cwd: string;
  model?: string | null;
  nativeSessionId?: string | null;
  onChunk?: (chunk: string) => void;
  onStatus?: OnStatusCallback;
  onPermission: (request: GrokAcpPermissionRequest) => Promise<GrokAcpPermissionDecision>;
  spawnImpl?: SpawnImplementation;
  controlTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancelGraceMs?: number;
}

/** Compatibility facade over the shared bounded ACP stdio transport. */
export class GrokAcpBroker {
  private readonly broker: AcpStdioBroker;

  constructor(options: GrokAcpBrokerOptions) {
    this.broker = new AcpStdioBroker({
      profile: GROK_ACP_PROFILE,
      cwd: options.cwd,
      environment: buildAcpHarnessEnvironment('GROK'),
      model: options.model,
      nativeSessionId: options.nativeSessionId,
      onChunk: options.onChunk,
      onStatus: options.onStatus,
      onPermission: options.onPermission,
      spawnImpl: options.spawnImpl,
      controlTimeoutMs: options.controlTimeoutMs,
      promptTimeoutMs: options.promptTimeoutMs,
      cancelGraceMs: options.cancelGraceMs,
    });
  }

  get sessionId(): string | null {
    return this.broker.sessionId;
  }

  get wasAborted(): boolean {
    return this.broker.wasAborted;
  }

  async start(): Promise<string> {
    return (await this.broker.start()).nativeSessionId;
  }

  async prompt(message: string): Promise<GrokAcpTurnResult> {
    const result = await this.broker.prompt(message);
    return {
      fullText: result.fullText,
      nativeSessionId: result.nativeSessionId,
      stopReason: result.stopReason,
      usage: result.usage,
      agentVersion: result.agentVersion,
      protocolVersion: result.protocolVersion,
    };
  }

  abort(): boolean {
    return this.broker.abort();
  }

  close(): void {
    void this.broker.dispose();
  }
}
