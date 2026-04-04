import { spawn } from 'child_process';
import type {
  AgentMessage,
  AgentProvider,
  AgentProviderName,
  AgentSessionConfig,
  AgentSessionId,
  AgentSessionSummary,
  OnChunkCallback,
  OnExecApprovalCallback,
  OnStatusCallback,
  SenderIdentity,
  AgentSendResult,
} from '../../AgentProvider.interface';
import { AgentAbortError } from '../../AgentProvider.interface';
import {
  appendNativeMessage,
  createNativeSession,
  deleteNativeSession,
  listNativeSessions,
  loadNativeSession,
  rekeyNativeSession,
  updateNativeSessionMetadata,
  type NativeSessionData,
} from '../NativeSessionStore';
import type { NativeCliProviderAdapter, NativeCliTurnContext } from './types';
import { getProviderAvailability } from '../../providerAvailability';
import { getPortalApiKeysForEnv } from '../../../services/openclawConfigManager';
import { prisma } from '../../../config/database';
import type { NativeCliPermissionLevel } from './types';

export async function getNativeCliPermissionLevel(providerName: string): Promise<NativeCliPermissionLevel> {
  try {
    const row = await prisma.systemSetting.findUnique({
      where: { key: `agents.nativePermission.${providerName}` },
    });
    if (row?.value === 'elevated') return 'elevated';
    return 'sandboxed';
  } catch {
    return 'sandboxed';
  }
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007]*(\u0007|\u001B\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export abstract class NativeCliAdapterProvider implements AgentProvider {
  readonly displayName: string;
  readonly providerName: AgentProviderName;
  private readonly activeRuns = new Map<AgentSessionId, { child: ReturnType<typeof spawn>; aborted: boolean; killTimer: ReturnType<typeof setTimeout> | null }>();

  protected constructor(protected readonly adapter: NativeCliProviderAdapter) {
    this.displayName = adapter.displayName;
    this.providerName = adapter.providerName;
  }

  private idCounter = 0;

  protected nextId(): string {
    return `${this.adapter.messageIdPrefix}-${Date.now()}-${++this.idCounter}`;
  }

  protected requireSession(sessionId: AgentSessionId): NativeSessionData {
    const session = loadNativeSession(this.adapter.providerName, sessionId);
    if (session) return session;
    throw new Error(`${this.adapter.displayName} session not found: ${sessionId}`);
  }

  async startSession(userId: string, config?: AgentSessionConfig): Promise<AgentSessionId> {
    const resolvedConfig = this.adapter.configureSession
      ? await this.adapter.configureSession(userId, config)
      : config;
    return createNativeSession(this.adapter.providerName, userId, resolvedConfig).sessionId;
  }

  async sendMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
    _onExecApproval?: OnExecApprovalCallback,
    _sender?: SenderIdentity,
  ) {
    const providerAvailability = getProviderAvailability(this.adapter.providerName);
    if (!providerAvailability.usable) {
      throw new Error(providerAvailability.reason || `${this.adapter.displayName} is not ready on this server.`);
    }

    const session = this.requireSession(sessionId);
    appendNativeMessage(session, {
      id: this.nextId(),
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    });

    const ctx: NativeCliTurnContext = {
      session,
      originalSessionId: sessionId,
      message,
      onChunk,
      onStatus,
      fullText: '',
      lastAssistantMessage: '',
      stderr: '',
      exitCode: null,
      state: {},
      emitChunk: (chunk) => { if (chunk) onChunk?.(chunk); },
      emitStatus: (content, extra) => onStatus?.({ type: 'status', content, ...(extra || {}) }),
      setFullText: (text) => { ctx.fullText = text; },
      appendFullText: (text) => { if (text) ctx.fullText += text; },
      setLastAssistantMessage: (text) => { ctx.lastAssistantMessage = text; },
      appendStderr: (text) => { if (text) ctx.stderr += text; },
      updateSessionMetadata: (metadata) => {
        session.metadata = {
          ...(session.metadata || {}),
          ...metadata,
        };
        updateNativeSessionMetadata(this.adapter.providerName, session.sessionId, metadata);
      },
      rekeySession: (nextSessionId) => {
        const resolved = nextSessionId.trim();
        if (!resolved || resolved === session.sessionId) return;
        rekeyNativeSession(this.adapter.providerName, session.sessionId, resolved);
        session.sessionId = resolved;
      },
      stripAnsi,
    };

    const initialStatus = typeof this.adapter.initialStatus === 'function'
      ? this.adapter.initialStatus(ctx)
      : this.adapter.initialStatus;
    if (initialStatus) ctx.emitStatus(initialStatus);

    const invocation = await this.adapter.buildInvocation(ctx);

    return new Promise<AgentSendResult>((resolve, reject) => {
      let stdoutBuffer = '';

      // Inject portal-configured API keys so native CLIs can use them as fallback auth
      const portalApiKeys = getPortalApiKeysForEnv(this.adapter.providerName);
      const child = spawn(invocation.command, invocation.args, {
        cwd: session.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', ...portalApiKeys },
        ...(invocation.options || {}),
      });

      const activeRun = { child, aborted: false, killTimer: null as ReturnType<typeof setTimeout> | null };
      this.activeRuns.set(session.sessionId, activeRun);

      const clearActiveRun = () => {
        const current = this.activeRuns.get(session.sessionId);
        if (current?.killTimer) clearTimeout(current.killTimer);
        if (current === activeRun) {
          this.activeRuns.delete(session.sessionId);
        }
      };

      const flushLine = (line: string) => {
        const normalized = line.replace(/\r$/, '');
        if (!normalized.trim()) return;
        this.adapter.handleStdoutLine(normalized, ctx);
      };

      child.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        let idx;
        while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, idx);
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          flushLine(line);
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        ctx.appendStderr(text);
        this.adapter.handleStderrChunk?.(text, ctx);
      });

      child.on('close', async (code) => {
        const wasAborted = activeRun.aborted;
        clearActiveRun();
        try {
          if (stdoutBuffer.trim()) {
            if (this.adapter.handleStdoutRemainder) {
              this.adapter.handleStdoutRemainder(stdoutBuffer, ctx);
            } else {
              flushLine(stdoutBuffer);
            }
          }

          if (wasAborted) {
            ctx.emitStatus('');
            reject(new AgentAbortError());
            return;
          }

          ctx.exitCode = code ?? 0;
          await this.adapter.finalizeTurn?.(ctx);

          const result = this.adapter.transformResult
            ? await this.adapter.transformResult(ctx)
            : {
                fullText: stripAnsi((this.adapter.getResultText?.(ctx) || ctx.fullText || ctx.lastAssistantMessage)).trim(),
                metadata: this.adapter.getResultMetadata?.(ctx),
              };

          const text = stripAnsi(result.fullText || '').trim();

          if ((code ?? 0) !== 0 && !text) {
            const errMsg = stripAnsi(this.adapter.getErrorMessage?.(ctx) || ctx.stderr || `${this.adapter.displayName} CLI exited with code ${code}`).trim();
            appendNativeMessage(session, {
              id: this.nextId(),
              role: 'assistant',
              content: `Error: ${errMsg}`,
              timestamp: new Date().toISOString(),
            });
            reject(new Error(errMsg));
            return;
          }

          appendNativeMessage(session, {
            id: this.nextId(),
            role: 'assistant',
            content: text,
            timestamp: new Date().toISOString(),
          });
          ctx.emitStatus('');
          resolve({
            fullText: text,
            metadata: result.metadata,
          });
        } catch (err) {
          reject(err);
        }
      });

      child.on('error', (err) => {
        clearActiveRun();
        reject(new Error(`${this.adapter.spawnErrorPrefix || `Failed to spawn ${this.adapter.cliCommand} CLI`}: ${err.message}`));
      });
    });
  }

  async abortActiveRun(sessionId: AgentSessionId): Promise<boolean> {
    const activeRun = this.activeRuns.get(sessionId);
    if (!activeRun) return false;

    activeRun.aborted = true;
    try {
      activeRun.child.kill('SIGTERM');
    } catch {}

    activeRun.killTimer = setTimeout(() => {
      try {
        activeRun.child.kill('SIGKILL');
      } catch {}
    }, 3000);

    return true;
  }

  async getHistory(sessionId: AgentSessionId): Promise<AgentMessage[]> {
    return this.requireSession(sessionId).messages;
  }

  async listSessions(userId: string): Promise<AgentSessionSummary[]> {
    return listNativeSessions(this.adapter.providerName, userId);
  }

  async terminateSession(sessionId: AgentSessionId): Promise<void> {
    deleteNativeSession(this.adapter.providerName, sessionId);
  }
}
