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

      const child = spawn(invocation.command, invocation.args, {
        cwd: session.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
        ...(invocation.options || {}),
      });

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
        try {
          if (stdoutBuffer.trim()) {
            if (this.adapter.handleStdoutRemainder) {
              this.adapter.handleStdoutRemainder(stdoutBuffer, ctx);
            } else {
              flushLine(stdoutBuffer);
            }
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
        reject(new Error(`${this.adapter.spawnErrorPrefix || `Failed to spawn ${this.adapter.cliCommand} CLI`}: ${err.message}`));
      });
    });
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
