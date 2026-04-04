import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { prisma } from '../config/database';
import { config } from '../config/env';
import type { AgentProviderName } from './AgentProvider.interface';

export interface ProviderModelDescriptor {
  id: string;
  alias?: string | null;
  provider: string;
  displayName: string;
  source: 'dynamic' | 'declared';
}

const GEMINI_DECLARED_FALLBACK = [
  'gemini-3.1-pro-preview',
  'gemini-3-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
];

function toTitleCase(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
    .replace(/\bPro\b/g, 'Pro')
    .replace(/\bFlash\b/g, 'Flash');
}

function displayNameFromId(id: string): string {
  return id.startsWith('gemini-') ? toTitleCase(id) : id;
}

function declaredModels(ids: string[], provider: string): ProviderModelDescriptor[] {
  return ids.map((id) => ({
    id,
    alias: null,
    provider,
    displayName: displayNameFromId(id),
    source: 'declared' as const,
  }));
}

const DECLARED_MODELS: Partial<Record<AgentProviderName, ProviderModelDescriptor[]>> = {
  GEMINI: declaredModels(GEMINI_DECLARED_FALLBACK, 'gemini'),
};

function safeExecFile(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      timeout: 8000,
      maxBuffer: 1024 * 1024 * 8,
    }).trim();
  } catch {
    return null;
  }
}

function listOpenClawModels(): ProviderModelDescriptor[] {
  try {
    const output = execSync('openclaw config get agents.defaults.models 2>/dev/null', {
      timeout: 8000,
      encoding: 'utf-8',
    });
    const raw: Record<string, { alias?: string }> = JSON.parse(output.trim());
    return Object.entries(raw).map(([id, cfg]) => ({
      id,
      alias: cfg.alias || null,
      provider: id.split('/')[0] || 'other',
      displayName: cfg.alias || id.split('/').slice(1).join('/') || id,
      source: 'dynamic' as const,
    }));
  } catch {
    return [];
  }
}

function listGeminiDeclaredModels(): ProviderModelDescriptor[] {
  const ids = new Map<string, ProviderModelDescriptor>();
  const add = (id: string, alias?: string | null) => {
    const clean = String(id || '').trim();
    if (!clean) return;
    if (!ids.has(clean)) {
      ids.set(clean, {
        id: clean,
        alias: alias || null,
        provider: 'gemini',
        displayName: displayNameFromId(clean),
        source: 'declared',
      });
    } else if (alias && !ids.get(clean)?.alias) {
      ids.get(clean)!.alias = alias;
    }
  };

  for (const model of GEMINI_DECLARED_FALLBACK) add(model);

  for (const model of listOpenClawModels()) {
    if (model.id.startsWith('google-gemini-cli/')) {
      add(model.id.replace(/^google-gemini-cli\//, ''), model.alias || null);
    }
  }

  const openclawConfig = path.join(process.env.HOME || '/root', '.openclaw', 'openclaw.json');
  if (existsSync(openclawConfig)) {
    try {
      const raw = JSON.parse(readFileSync(openclawConfig, 'utf8'));
      const configured = raw?.agents?.defaults?.models || {};
      for (const [key, value] of Object.entries(configured)) {
        if (!key.startsWith('google-gemini-cli/')) continue;
        const id = key.replace(/^google-gemini-cli\//, '');
        const alias = value && typeof value === 'object' && 'alias' in value ? String((value as any).alias || '') : '';
        add(id, alias || null);
      }
    } catch {
      // Ignore malformed config; fallback models still apply.
    }
  }

  return Array.from(ids.values());
}

function normalizeBaseUrl(input?: string | null): string {
  const raw = String(input || '').trim();
  if (!raw) return 'http://127.0.0.1:11434';
  return raw.replace(/\/+$/, '');
}

async function getOllamaRuntimeCandidates(): Promise<Array<{ url: string; source: string }>> {
  const candidates: Array<{ url: string; source: string }> = [];
  const push = (url: string | null | undefined, source: string) => {
    const normalized = normalizeBaseUrl(url);
    if (!normalized) return;
    if (!candidates.some((entry) => entry.url === normalized)) {
      candidates.push({ url: normalized, source });
    }
  };

  push(process.env.OLLAMA_HOST, 'env:OLLAMA_HOST');
  push(process.env.OLLAMA_API_URL, 'env:OLLAMA_API_URL');
  push(config.ollamaApiUrl, 'config.ollamaApiUrl');

  try {
    const settings = await prisma.systemSetting.findMany({
      where: { key: { in: ['ollama.host', 'ollama.remoteHost', 'ollama.localEnabled'] } },
    });
    const map = settings.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    const localEnabled = map['ollama.localEnabled'] !== 'false';
    const remoteHost = String(map['ollama.remoteHost'] || '').trim();
    const localHost = String(map['ollama.host'] || '').trim();
    if (remoteHost) push(remoteHost, 'setting:ollama.remoteHost');
    if (localEnabled) push(localHost || 'http://127.0.0.1:11434', 'setting:ollama.host');
  } catch {
    // DB settings are optional here; env/config fallbacks still work.
  }

  if (!candidates.length) push('http://127.0.0.1:11434', 'default');
  return candidates;
}

async function listOllamaModels(): Promise<ProviderModelDescriptor[]> {
  const candidates = await getOllamaRuntimeCandidates();
  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate.url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) continue;
      const data = await response.json() as any;
      const models = Array.isArray(data?.models) ? data.models : [];
      return models
        .map((model: any) => String(model?.name || '').trim())
        .filter(Boolean)
        .map((id: string) => ({
          id,
          alias: null,
          provider: 'ollama',
          displayName: id,
          source: 'dynamic' as const,
        }));
    } catch {
      continue;
    }
  }
  return [];
}

export async function listProviderModels(name: AgentProviderName): Promise<ProviderModelDescriptor[]> {
  switch (name) {
    case 'OPENCLAW':
      return listOpenClawModels();
    case 'GEMINI':
      return listGeminiDeclaredModels();
    case 'OLLAMA':
      return listOllamaModels();
    default:
      return DECLARED_MODELS[name] ? [...DECLARED_MODELS[name]!] : [];
  }
}
