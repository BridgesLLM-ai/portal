import { randomUUID } from 'crypto';
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
  return `claude-msg-${Date.now()}-${++idCounter}`;
}

function requireSession(sessionId: AgentSessionId): NativeSessionData {
  const session = loadNativeSession('CLAUDE_CODE', sessionId);
  if (session) return session;
  throw new Error(`Claude session not found: ${sessionId}`);
}

export class ClaudeCodeProvider implements AgentProvider {
  readonly displayName = 'Claude';
  readonly providerName: AgentProviderName = 'CLAUDE_CODE';

  async startSession(userId: string, config?: AgentSessionConfig): Promise<AgentSessionId> {
    const nativeSessionId = randomUUID();
    return createNativeSession('CLAUDE_CODE', userId, {
      ...config,
      metadata: {
        ...(config?.metadata || {}),
        nativeSessionId,
      },
    }).sessionId;
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
    onStatus?.({ type: 'status', content: 'Claude is thinking…' });

    const nativeSessionId = typeof session.metadata?.nativeSessionId === 'string' && session.metadata.nativeSessionId.trim()
      ? String(session.metadata.nativeSessionId).trim()
      : session.sessionId;
    const isFirstTurn = session.messages.filter((entry) => entry.role === 'user').length <= 1;

    return new Promise<AgentSendResult>((resolve, reject) => {
      let stdoutBuffer = '';
      let stderr = '';
      let fullText = '';
      const permissionDenials: any[] = [];

      const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'];
      if (isFirstTurn) {
        args.push('--session-id', nativeSessionId);
      } else {
        args.push('--resume', nativeSessionId);
      }
      if (session.model) args.push('--model', session.model);
      args.push(message);

      const child = spawn('claude', args, {
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
          return;
        }

        if (parsed?.type === 'assistant' && Array.isArray(parsed?.message?.content)) {
          const textParts = parsed.message.content
            .filter((part: any) => part?.type === 'text' && typeof part?.text === 'string')
            .map((part: any) => part.text);
          const text = textParts.join('');
          if (text && text !== fullText) {
            const delta = text.startsWith(fullText) ? text.slice(fullText.length) : text;
            fullText = text;
            if (delta) onChunk?.(delta);
          }
          return;
        }

        if (parsed?.type === 'result') {
          if (typeof parsed?.session_id === 'string' && parsed.session_id.trim()) {
            updateNativeSessionMetadata('CLAUDE_CODE', session.sessionId, { nativeSessionId: parsed.session_id.trim() });
          }
          if (typeof parsed?.result === 'string' && parsed.result.trim()) {
            if (!fullText) {
              fullText = parsed.result.trim();
              onChunk?.(fullText);
            }
          }
          if (Array.isArray(parsed?.permission_denials)) {
            permissionDenials.push(...parsed.permission_denials);
          }
          return;
        }

        if (parsed?.type === 'system' && parsed?.subtype === 'init') {
          onStatus?.({ type: 'status', content: 'Claude session initialized' });
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
        const text = stripAnsi(fullText).trim();

        if (permissionDenials.length > 0) {
          onStatus?.({
            type: 'status',
            content: 'Claude hit permission limits. Interactive approval bridge still needs implementation for true in-browser approve/deny.',
            permissionDenials,
          });
        }

        if (code !== 0 && !text) {
          const errMsg = stripAnsi(stderr).trim() || `Claude CLI exited with code ${code}`;
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
        resolve({ fullText: text, metadata: { provider: 'claude-cli', exitCode: code, permissionDenials, model: session.model || null, resolvedSessionId: session.sessionId, nativeSessionId } });
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
      });
    });
  }

  async getHistory(sessionId: AgentSessionId): Promise<AgentMessage[]> {
    return requireSession(sessionId).messages;
  }

  async listSessions(userId: string): Promise<AgentSessionSummary[]> {
    return listNativeSessions('CLAUDE_CODE', userId);
  }

  async terminateSession(sessionId: AgentSessionId): Promise<void> {
    deleteNativeSession('CLAUDE_CODE', sessionId);
  }
}
