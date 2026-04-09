import { execFileSync } from 'child_process';
import { prisma } from '../../config/database';
import { config as envConfig } from '../../config/env';
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

const DEFAULT_OLLAMA_MODEL_CANDIDATES = [
  'qwen3:4b',
  'qwen3:8b',
  'qwen3:1.7b',
  'gemma4:e4b',
  'gemma4:e2b',
  'deepseek-r1:8b',
  'deepseek-r1:1.5b',
];

function listInstalledModels(): string[] {
  try {
    const out = execFileSync('ollama', ['list'], { encoding: 'utf8', env: process.env, maxBuffer: 1024 * 1024 * 2 });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.slice(1)
      .map((line) => line.match(/^(\S+)/)?.[1] || '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function resolveDefaultModel(): Promise<string> {
  const envModel = (process.env.OLLAMA_MODEL || process.env.OLLAMA_DEFAULT_MODEL || '').trim();
  if (envModel) return envModel;

  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'ollama.defaultModel' } });
    if (setting?.value?.trim()) return setting.value.trim();
  } catch {}

  const installedModels = listInstalledModels();
  const preferredInstalled = DEFAULT_OLLAMA_MODEL_CANDIDATES.find((candidate) => installedModels.includes(candidate));
  if (preferredInstalled) return preferredInstalled;
  if (installedModels[0]) return installedModels[0];

  return envConfig.ollamaModel;
}

function requireSession(sessionId: AgentSessionId): NativeSessionData {
  const session = loadNativeSession('OLLAMA', sessionId);
  if (session) {
    if (!session.model) {
      session.model = envConfig.ollamaModel;
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
      session.model = await resolveDefaultModel();
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
    if (!session.model) {
      session.model = await resolveDefaultModel();
      saveNativeSession(session);
    }

    appendNativeMessage(session, { id: nextId(), role: 'user', content: message, timestamp: new Date().toISOString() });
    onStatus?.({ type: 'status', content: `Running Ollama (${session.model})...` });

    const prompt = buildTranscriptPrompt(session.messages.slice(0, -1), message);
    const baseUrl = (process.env.OLLAMA_HOST || envConfig.ollamaApiUrl || 'http://localhost:11434').replace(/\/$/, '');

    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: session.model,
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
