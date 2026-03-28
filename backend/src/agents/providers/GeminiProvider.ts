import { execFile, spawn } from 'child_process';
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
  buildTranscriptPrompt,
  createNativeSession,
  deleteNativeSession,
  listNativeSessions,
  loadNativeSession,
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
  return `gemini-msg-${Date.now()}-${++idCounter}`;
}

function requireSession(sessionId: AgentSessionId): NativeSessionData {
  const session = loadNativeSession('GEMINI', sessionId);
  if (session) return session;
  throw new Error(`Gemini session not found: ${sessionId}`);
}

async function runGeminiText(prompt: string, cwd: string, model?: string): Promise<string> {
  const args = ['-p', prompt, '--output-format', 'text'];
  if (model) args.push('--model', model);
  return new Promise((resolve, reject) => {
    execFile('gemini', args, { cwd, env: process.env, maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stripAnsi(stderr || err.message).trim() || 'Gemini text fallback failed'));
      resolve(stripAnsi(stdout || '').trim());
    });
  });
}

export class GeminiProvider implements AgentProvider {
  readonly displayName = 'Gemini CLI';
  readonly providerName: AgentProviderName = 'GEMINI';

  async startSession(userId: string, config?: AgentSessionConfig): Promise<AgentSessionId> {
    return createNativeSession('GEMINI', userId, config).sessionId;
  }

  async sendMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
  ): Promise<AgentSendResult> {
    const session = requireSession(sessionId);
    appendNativeMessage(session, { id: nextId(), role: 'user', content: message, timestamp: new Date().toISOString() });
    onStatus?.({ type: 'status', content: 'Running Gemini CLI...' });

    const prompt = buildTranscriptPrompt(session.messages.slice(0, -1), message);
    const args = ['-p', prompt, '--output-format', 'stream-json'];
    if (session.model) args.push('--model', session.model);

    const streamedText = await new Promise<string>((resolve, reject) => {
      let stdoutBuffer = '';
      let stderr = '';
      let fullText = '';

      const proc = spawn('gemini', args, {
        cwd: session.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
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

        if (parsed?.type === 'message' && parsed?.role === 'assistant' && typeof parsed?.content === 'string') {
          if (parsed?.delta) {
            fullText += parsed.content;
            onChunk?.(parsed.content);
          } else if (!fullText) {
            fullText = parsed.content;
            onChunk?.(parsed.content);
          }
          return;
        }

        if (parsed?.type === 'thought' && typeof parsed?.subject === 'string') {
          onStatus?.({ type: 'status', content: parsed.subject });
          return;
        }

        if (parsed?.type === 'error') {
          stderr += `${parsed?.message || 'Gemini error'}\n`;
        }
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        let idx;
        while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, idx);
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          flushLine(line);
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        if (stdoutBuffer.trim()) flushLine(stdoutBuffer);
        const result = stripAnsi(fullText).trim();
        if (code !== 0 && !result) return reject(new Error(stripAnsi(stderr).trim() || `Gemini CLI exited with code ${code}`));
        resolve(result);
      });
      proc.on('error', reject);
    });

    const fullText = streamedText || await runGeminiText(prompt, session.cwd, session.model);

    appendNativeMessage(session, { id: nextId(), role: 'assistant', content: fullText, timestamp: new Date().toISOString() });
    onStatus?.({ type: 'status', content: '' });
    return { fullText, metadata: { provider: 'gemini-cli', model: session.model || null } };
  }

  async getHistory(sessionId: AgentSessionId): Promise<AgentMessage[]> {
    return requireSession(sessionId).messages;
  }

  async listSessions(userId: string): Promise<AgentSessionSummary[]> {
    return listNativeSessions('GEMINI', userId);
  }

  async terminateSession(sessionId: AgentSessionId): Promise<void> {
    deleteNativeSession('GEMINI', sessionId);
  }
}
