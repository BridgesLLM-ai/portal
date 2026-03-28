import { execFileSync } from 'child_process';
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
  saveNativeSession,
  type NativeSessionData,
} from './NativeSessionStore';

let idCounter = 0;
function nextId(): string {
  return `ollama-msg-${Date.now()}-${++idCounter}`;
}

function detectDefaultModel(): string {
  const envModel = process.env.OLLAMA_MODEL || process.env.OLLAMA_DEFAULT_MODEL;
  if (envModel) return envModel;
  try {
    const out = execFileSync('ollama', ['list'], { encoding: 'utf8', env: process.env, maxBuffer: 1024 * 1024 * 2 });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines.slice(1)) {
      const match = line.match(/^(\S+)/);
      if (match?.[1]) return match[1];
    }
  } catch {}
  return 'qwen2.5-coder:7b';
}

function requireSession(sessionId: AgentSessionId): NativeSessionData {
  const session = loadNativeSession('OLLAMA', sessionId);
  if (session) {
    if (!session.model) {
      session.model = detectDefaultModel();
      saveNativeSession(session);
    }
    return session;
  }
  throw new Error(`Ollama session not found: ${sessionId}`);
}

export class OllamaProvider implements AgentProvider {
  readonly displayName = 'Ollama';
  readonly providerName: AgentProviderName = 'OLLAMA';

  async startSession(userId: string, config?: AgentSessionConfig): Promise<AgentSessionId> {
    const session = createNativeSession('OLLAMA', userId, config);
    if (!session.model) {
      session.model = detectDefaultModel();
      saveNativeSession(session);
    }
    return session.sessionId;
  }

  async sendMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
  ): Promise<AgentSendResult> {
    const session = requireSession(sessionId);
    appendNativeMessage(session, { id: nextId(), role: 'user', content: message, timestamp: new Date().toISOString() });
    onStatus?.({ type: 'status', content: `Running Ollama (${session.model})...` });

    const prompt = buildTranscriptPrompt(session.messages.slice(0, -1), message);
    const baseUrl = process.env.OLLAMA_HOST || 'http://localhost:11434';

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: session.model || detectDefaultModel(),
        prompt,
        stream: true,
        think: false,
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (typeof parsed?.response === 'string' && parsed.response) {
          fullText += parsed.response;
          onChunk?.(parsed.response);
        }
      }
    }

    fullText = fullText.replace(/\s*\/think\s*$/i, '').trim();
    appendNativeMessage(session, { id: nextId(), role: 'assistant', content: fullText, timestamp: new Date().toISOString() });
    onStatus?.({ type: 'status', content: '' });

    return { fullText, metadata: { provider: 'ollama', model: session.model } };
  }

  async getHistory(sessionId: AgentSessionId): Promise<AgentMessage[]> {
    return requireSession(sessionId).messages;
  }

  async listSessions(userId: string): Promise<AgentSessionSummary[]> {
    return listNativeSessions('OLLAMA', userId);
  }

  async terminateSession(sessionId: AgentSessionId): Promise<void> {
    deleteNativeSession('OLLAMA', sessionId);
  }
}
