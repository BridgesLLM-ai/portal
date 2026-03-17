import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import path from 'path';
import type {
  AgentMessage,
  AgentProviderName,
  AgentSessionConfig,
  AgentSessionId,
  AgentSessionSummary,
} from '../AgentProvider.interface';

export interface NativeSessionData {
  sessionId: AgentSessionId;
  provider: AgentProviderName;
  userId: string;
  createdAt: string;
  lastActivityAt: string;
  cwd: string;
  model?: string;
  messages: AgentMessage[];
  metadata?: Record<string, unknown>;
}

const BASE_DIR = process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR
  ? path.resolve(process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR)
  : path.join(process.env.HOME || '/root', '.openclaw', 'portal-native-agent-sessions');

function providerDir(provider: AgentProviderName): string {
  return path.join(BASE_DIR, provider.toLowerCase());
}

function sessionPath(provider: AgentProviderName, sessionId: string): string {
  return path.join(providerDir(provider), `${sessionId}.json`);
}

function ensureProviderDir(provider: AgentProviderName): void {
  mkdirSync(providerDir(provider), { recursive: true });
}

export function createNativeSession(provider: AgentProviderName, userId: string, config?: AgentSessionConfig): NativeSessionData {
  ensureProviderDir(provider);
  const now = new Date().toISOString();
  const sessionId = `${provider.toLowerCase()}-${userId}-${Date.now()}`;
  const data: NativeSessionData = {
    sessionId,
    provider,
    userId,
    createdAt: now,
    lastActivityAt: now,
    cwd: String(
      config?.metadata?.cwd
      || process.env.OPENCLAW_WORKSPACE
      || path.join(process.env.HOME || '/root', '.openclaw', 'workspace-main'),
    ),
    model: typeof config?.model === 'string'
      ? config.model
      : typeof config?.metadata?.model === 'string'
        ? String(config?.metadata?.model)
        : undefined,
    metadata: config?.metadata,
    messages: [],
  };
  saveNativeSession(data);
  return data;
}

export function loadNativeSession(provider: AgentProviderName, sessionId: string): NativeSessionData | null {
  const file = sessionPath(provider, sessionId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as NativeSessionData;
  } catch {
    return null;
  }
}

export function saveNativeSession(data: NativeSessionData): void {
  ensureProviderDir(data.provider);
  writeFileSync(sessionPath(data.provider, data.sessionId), JSON.stringify(data, null, 2));
}

export function updateNativeSessionModel(provider: AgentProviderName, sessionId: string, model: string): NativeSessionData | null {
  const session = loadNativeSession(provider, sessionId);
  if (!session) return null;
  session.model = model;
  session.lastActivityAt = new Date().toISOString();
  saveNativeSession(session);
  return session;
}

export function updateNativeSessionMetadata(
  provider: AgentProviderName,
  sessionId: string,
  metadata: Record<string, unknown>,
): NativeSessionData | null {
  const session = loadNativeSession(provider, sessionId);
  if (!session) return null;
  session.metadata = {
    ...(session.metadata || {}),
    ...metadata,
  };
  session.lastActivityAt = new Date().toISOString();
  saveNativeSession(session);
  return session;
}

export function rekeyNativeSession(
  provider: AgentProviderName,
  fromSessionId: string,
  toSessionId: string,
): NativeSessionData | null {
  const session = loadNativeSession(provider, fromSessionId);
  if (!session) return null;
  if (fromSessionId === toSessionId) return session;

  ensureProviderDir(provider);
  const fromFile = sessionPath(provider, fromSessionId);
  const toFile = sessionPath(provider, toSessionId);
  session.sessionId = toSessionId;
  session.lastActivityAt = new Date().toISOString();
  writeFileSync(toFile, JSON.stringify(session, null, 2));
  if (existsSync(fromFile)) unlinkSync(fromFile);
  return session;
}

export function appendNativeMessage(data: NativeSessionData, message: AgentMessage): NativeSessionData {
  data.messages.push(message);
  data.lastActivityAt = new Date().toISOString();
  saveNativeSession(data);
  return data;
}

function summarizeText(text: string, max = 96): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function deriveNativeSessionTitle(data: NativeSessionData): string {
  const explicitTitle = typeof data.metadata?.title === 'string' ? summarizeText(String(data.metadata.title), 72) : '';
  if (explicitTitle) return explicitTitle;

  const firstUserMessage = data.messages.find((msg) => msg.role === 'user' && msg.content.trim());
  if (firstUserMessage) return summarizeText(firstUserMessage.content, 72);

  const cwdBase = path.basename(data.cwd || '').trim();
  if (cwdBase && cwdBase !== '/' && cwdBase !== '.') return cwdBase;

  return `${providerLabel(data.provider)} session`;
}

function deriveNativeSessionPreview(data: NativeSessionData): string {
  const lastAssistant = [...data.messages].reverse().find((msg) => msg.role === 'assistant' && msg.content.trim());
  if (lastAssistant) return summarizeText(lastAssistant.content, 120);

  const lastUser = [...data.messages].reverse().find((msg) => msg.role === 'user' && msg.content.trim());
  if (lastUser) return summarizeText(lastUser.content, 120);

  return '';
}

function providerLabel(provider: AgentProviderName): string {
  switch (provider) {
    case 'CLAUDE_CODE': return 'Claude';
    case 'CODEX': return 'Codex';
    case 'AGENT_ZERO': return 'Agent Zero';
    case 'GEMINI': return 'Gemini';
    case 'OLLAMA': return 'Ollama';
    default: return 'Agent';
  }
}

export function listNativeSessions(provider: AgentProviderName, userId: string): AgentSessionSummary[] {
  ensureProviderDir(provider);
  return readdirSync(providerDir(provider))
    .filter((name) => name.endsWith('.json'))
    .map((name) => loadNativeSession(provider, name.replace(/\.json$/, '')))
    .filter((data): data is NativeSessionData => Boolean(data && data.userId === userId))
    .map((data) => ({
      sessionId: data.sessionId,
      status: 'active' as const,
      createdAt: data.createdAt,
      lastActivityAt: data.lastActivityAt,
      title: deriveNativeSessionTitle(data),
      preview: deriveNativeSessionPreview(data),
      metadata: {
        provider,
        model: data.model || null,
        cwd: data.cwd,
      },
    }))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

export function deleteNativeSession(provider: AgentProviderName, sessionId: string): void {
  const file = sessionPath(provider, sessionId);
  if (existsSync(file)) unlinkSync(file);
}

export function buildTranscriptPrompt(messages: AgentMessage[], nextUserMessage: string): string {
  const history = messages.slice(-20).map((msg) => {
    const role = msg.role === 'assistant' ? 'Assistant' : msg.role === 'system' ? 'System' : 'User';
    return `${role}: ${msg.content}`;
  }).join('\n\n');

  return [
    'Continue this conversation faithfully. Use the prior transcript as context.',
    'Do not restate the transcript unless needed. Respond only to the latest user message.',
    history ? `\nTranscript:\n${history}` : '',
    `\nLatest user message:\n${nextUserMessage}`,
  ].filter(Boolean).join('\n');
}
