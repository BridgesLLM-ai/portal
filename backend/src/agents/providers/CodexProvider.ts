import { spawn } from 'child_process';
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
} from '../AgentProvider.interface';
import {
  appendNativeMessage,
  createNativeSession,
  deleteNativeSession,
  listNativeSessions,
  loadNativeSession,
  rekeyNativeSession,
  updateNativeSessionMetadata,
  type NativeSessionData,
} from './NativeSessionStore';

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007]*(\u0007|\u001B\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

let idCounter = 0;
function nextId(): string {
  return `codex-msg-${Date.now()}-${++idCounter}`;
}

function requireSession(sessionId: AgentSessionId): NativeSessionData {
  const session = loadNativeSession('CODEX', sessionId);
  if (session) return session;
  throw new Error(`Codex session not found: ${sessionId}`);
}

export class CodexProvider implements AgentProvider {
  readonly displayName = 'Codex';
  readonly providerName: AgentProviderName = 'CODEX';

  async startSession(userId: string, config?: AgentSessionConfig): Promise<AgentSessionId> {
    return createNativeSession('CODEX', userId, config).sessionId;
  }

  async sendMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
  ): Promise<AgentSendResult> {
    const session = requireSession(sessionId);
    appendNativeMessage(session, {
      id: nextId(),
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    });
    onStatus?.({ type: 'status', content: 'Codex is working…' });

    const nativeSessionId = typeof session.metadata?.nativeSessionId === 'string' && session.metadata.nativeSessionId.trim()
      ? String(session.metadata.nativeSessionId).trim()
      : null;

    return new Promise<AgentSendResult>((resolve, reject) => {
      let stdoutBuffer = '';
      let stderr = '';
      let fullText = '';
      let lastAgentMessage = '';

      const args = nativeSessionId
        ? ['exec', 'resume', nativeSessionId, '--skip-git-repo-check', '--json']
        : ['exec', '--skip-git-repo-check', '--color', 'never', '--json'];
      if (session.model) args.push('--model', session.model);
      args.push(message);

      const child = spawn('codex', args, {
        cwd: session.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
        env: { ...process.env, NO_COLOR: '1' },
      });

      const flushLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          const plain = stripAnsi(trimmed);
          if (plain) {
            fullText += (fullText ? '\n' : '') + plain;
            onChunk?.(plain + '\n');
          }
          return;
        }

        const type = parsed?.type;
        if (type === 'thread.started' && typeof parsed?.thread_id === 'string' && parsed.thread_id.trim()) {
          const resolvedThreadId = parsed.thread_id.trim();
          if (resolvedThreadId !== session.sessionId) {
            rekeyNativeSession('CODEX', session.sessionId, resolvedThreadId);
            session.sessionId = resolvedThreadId;
            onStatus?.({ type: 'session', sessionId: resolvedThreadId });
          }
          session.metadata = {
            ...(session.metadata || {}),
            nativeSessionId: resolvedThreadId,
          };
          updateNativeSessionMetadata('CODEX', session.sessionId, { nativeSessionId: resolvedThreadId });
          return;
        }

        if (type === 'item.completed' && parsed?.item?.type === 'agent_message' && parsed?.item?.text) {
          lastAgentMessage = String(parsed.item.text).trim();
          if (lastAgentMessage) {
            onChunk?.(lastAgentMessage);
            fullText = lastAgentMessage;
          }
          return;
        }

        if (type === 'item.completed' && parsed?.item?.type === 'reasoning' && parsed?.item?.text) {
          onStatus?.({ type: 'status', content: String(parsed.item.text) });
          return;
        }

        if (type === 'turn.completed') {
          return;
        }
      };

      child.stdout.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        let idx;
        while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, idx);
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          flushLine(line);
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (stdoutBuffer.trim()) flushLine(stdoutBuffer);
        const text = stripAnsi(fullText || lastAgentMessage).trim();

        if (code !== 0 && !text) {
          const errMsg = stripAnsi(stderr).trim() || `Codex CLI exited with code ${code}`;
          appendNativeMessage(session, {
            id: nextId(),
            role: 'assistant',
            content: `Error: ${errMsg}`,
            timestamp: new Date().toISOString(),
          });
          reject(new Error(errMsg));
          return;
        }

        appendNativeMessage(session, {
          id: nextId(),
          role: 'assistant',
          content: text,
          timestamp: new Date().toISOString(),
        });

        onStatus?.({ type: 'status', content: '' });
        resolve({ fullText: text, metadata: { provider: 'codex-cli', exitCode: code, model: session.model || null, resolvedSessionId: session.sessionId, nativeSessionId: session.metadata?.nativeSessionId || null } });
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn codex CLI: ${err.message}`));
      });
    });
  }

  async getHistory(sessionId: AgentSessionId): Promise<AgentMessage[]> {
    return requireSession(sessionId).messages;
  }

  async listSessions(userId: string): Promise<AgentSessionSummary[]> {
    return listNativeSessions('CODEX', userId);
  }

  async terminateSession(sessionId: AgentSessionId): Promise<void> {
    deleteNativeSession('CODEX', sessionId);
  }
}
