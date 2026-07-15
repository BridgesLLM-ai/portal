import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { prisma } from '../config/database';
import { config } from '../config/env';
import { readOpenClawConfig } from '../services/openclawConfigManager';
import type { AgentProviderName } from './AgentProvider.interface';
import { buildOpenClawCliEnv, normalizePortalModelId } from '../utils/openclawCli';
import { listGatewayModels } from '../utils/openclawGatewayRpc';
import { listAntigravityModelsFromCli } from './antigravityModels';

export interface ProviderModelDescriptor {
  id: string;
  alias?: string | null;
  provider: string;
  displayName: string;
  source: 'dynamic' | 'declared';
}

const GEMINI_DECLARED_FALLBACK = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
];

const OPENCLAW_VISIBLE_MODEL_IDS = [
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.5',
  'google-gemini-cli/gemini-3.1-pro-preview',
  'google-gemini-cli/gemini-3-flash-preview',
  'google-gemini-cli/gemini-3.1-flash-lite',
  'anthropic/claude-fable-5',
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-opus-4-8',
  'anthropic/claude-haiku-4-5',
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

export function isOpenClawSessionSelectableModelId(id: string): boolean {
  const normalizedId = normalizePortalModelId(id);
  return normalizedId.startsWith('openai/')
    || normalizedId.startsWith('codex/')
    || normalizedId.startsWith('anthropic/')
    || normalizedId.startsWith('google-gemini-cli/')
    || normalizedId.startsWith('google-antigravity/');
}

export function filterOpenClawSessionModelCatalog(models: ProviderModelDescriptor[]): ProviderModelDescriptor[] {
  return models.filter((model) => isOpenClawSessionSelectableModelId(model.id));
}

const DECLARED_MODELS: Partial<Record<AgentProviderName, ProviderModelDescriptor[]>> = {
  OPENCLAW: declaredModels(OPENCLAW_VISIBLE_MODEL_IDS, 'openclaw'),
  GEMINI: declaredModels(GEMINI_DECLARED_FALLBACK, 'gemini'),
};

const OPENCLAW_MODEL_CACHE_TTL_MS = 60_000;
let openClawModelCache: { at: number; models: ProviderModelDescriptor[] } | null = null;
let openClawModelRefresh: Promise<ProviderModelDescriptor[]> | null = null;

function aliasFromTags(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  const aliasTag = tags.map((tag) => String(tag || '')).find((tag) => tag.startsWith('alias:'));
  const alias = aliasTag?.slice('alias:'.length).trim();
  return alias || null;
}

export function parseOpenClawModelsListPayload(payload: any): ProviderModelDescriptor[] {
  const entries = Array.isArray(payload) ? payload : (Array.isArray(payload?.models) ? payload.models : []);
  const deduped = new Map<string, ProviderModelDescriptor>();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.missing === true || entry.available === false) continue;

    const rawId = String(entry.key || entry.id || entry.model || '').trim();
    const rawProvider = String(entry.provider || '').trim();
    const qualifiedId = rawId && !rawId.includes('/') && rawProvider ? `${rawProvider}/${rawId}` : rawId;
    const id = normalizePortalModelId(qualifiedId);
    if (!id || deduped.has(id)) continue;

    const alias = aliasFromTags(entry.tags) || (typeof entry.alias === 'string' && entry.alias.trim() ? entry.alias.trim() : null);
    const name = String(entry.name || '').trim();
    deduped.set(id, {
      id,
      alias,
      provider: id.split('/')[0] || String(entry.provider || 'other'),
      displayName: alias || name || id.split('/').slice(1).join('/') || id,
      source: 'dynamic',
    });
  }

  return Array.from(deduped.values());
}

async function listOpenClawModelsFromGateway(): Promise<ProviderModelDescriptor[]> {
  try {
    const result = await listGatewayModels();
    if (!result.ok) return [];
    return parseOpenClawModelsListPayload({ models: result.models || [] });
  } catch (error: any) {
    console.warn(`[providerModels] OpenClaw gateway model catalog unavailable: ${error?.message || error}`);
    return [];
  }
}

function listOpenClawModelsFromCli(): Promise<ProviderModelDescriptor[]> {
  return new Promise((resolve) => {
    execFile('openclaw', ['models', 'list', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
      env: buildOpenClawCliEnv(),
      maxBuffer: 1024 * 1024 * 8,
    }, (error, stdout) => {
      if (error) {
        console.warn(`[providerModels] OpenClaw CLI model catalog unavailable: ${(error as any)?.message || error}`);
        resolve([]);
        return;
      }
      try {
        resolve(parseOpenClawModelsListPayload(JSON.parse(String(stdout || ''))));
      } catch {
        resolve([]);
      }
    });
  });
}

async function listOpenClawModels(): Promise<ProviderModelDescriptor[]> {
  const now = Date.now();
  if (openClawModelCache && now - openClawModelCache.at < OPENCLAW_MODEL_CACHE_TTL_MS) {
    return openClawModelCache.models;
  }
  if (openClawModelRefresh) return openClawModelRefresh;

  openClawModelRefresh = resolveOpenClawModels();
  try {
    return await openClawModelRefresh;
  } finally {
    openClawModelRefresh = null;
  }
}

async function resolveOpenClawModels(): Promise<ProviderModelDescriptor[]> {
  const openclawConfig = readOpenClawConfig();
  const deduped = new Map<string, ProviderModelDescriptor>();

  const addModel = (id: unknown, alias?: unknown) => {
    const normalizedId = normalizePortalModelId(typeof id === 'string' ? id : '');
    if (!normalizedId || deduped.has(normalizedId)) return;
    const cleanAlias = typeof alias === 'string' && alias.trim() ? alias.trim() : null;
    deduped.set(normalizedId, {
      id: normalizedId,
      alias: cleanAlias,
      provider: normalizedId.split('/')[0] || 'other',
      displayName: cleanAlias || normalizedId.split('/').slice(1).join('/') || normalizedId,
      source: 'dynamic' as const,
    });
  };

  const modelRegistry = openclawConfig?.agents?.defaults?.models;
  if (modelRegistry && typeof modelRegistry === 'object' && !Array.isArray(modelRegistry)) {
    for (const [id, cfg] of Object.entries(modelRegistry)) {
      const alias = cfg && typeof cfg === 'object' && 'alias' in cfg ? (cfg as any).alias : null;
      addModel(id, alias);
    }
  }

  const runtimeProviders = openclawConfig?.models?.providers;
  if (runtimeProviders && typeof runtimeProviders === 'object' && !Array.isArray(runtimeProviders)) {
    for (const [provider, providerConfig] of Object.entries<any>(runtimeProviders)) {
      const models = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
      for (const entry of models) {
        const rawId = typeof entry === 'string' ? entry : String(entry?.id || entry?.key || entry?.model || '').trim();
        const alias = typeof entry === 'object' && entry ? (entry.alias || entry.name) : null;
        addModel(rawId.includes('/') ? rawId : `${provider}/${rawId}`, alias);
      }
    }
  }

  addModel(openclawConfig?.agents?.defaults?.model?.primary);

  const fallbacks = openclawConfig?.agents?.defaults?.model?.fallbacks;
  if (Array.isArray(fallbacks)) {
    for (const id of fallbacks) addModel(id);
  }

  let cliModels = await listOpenClawModelsFromGateway();
  if (cliModels.length === 0) cliModels = await listOpenClawModelsFromCli();
  for (const model of Array.from(deduped.values())) {
    if (!cliModels.some((entry) => entry.id === model.id)) cliModels.push(model);
  }

  const catalog = cliModels.length ? cliModels : [...DECLARED_MODELS.OPENCLAW!];
  const curated = filterOpenClawSessionModelCatalog(catalog);
  const models = curated.length ? curated : [...DECLARED_MODELS.OPENCLAW!];
  openClawModelCache = { at: Date.now(), models };
  return models;
}

async function listGeminiDeclaredModels(): Promise<ProviderModelDescriptor[]> {
  const ids = new Map<string, ProviderModelDescriptor>();
  const add = (id: string, alias?: string | null, source: 'dynamic' | 'declared' = 'declared') => {
    const clean = String(id || '').trim();
    if (!clean) return;
    if (!ids.has(clean)) {
      ids.set(clean, {
        id: clean,
        alias: alias || null,
        provider: 'gemini',
        displayName: displayNameFromId(clean),
        source,
      });
    } else if (alias && !ids.get(clean)?.alias) {
      ids.get(clean)!.alias = alias;
    }
  };

  const liveAntigravityModels = listAntigravityModelsFromCli();
  for (const model of liveAntigravityModels) {
    add(model.id, model.displayName, 'dynamic');
  }

  for (const model of GEMINI_DECLARED_FALLBACK) add(model);

  if (liveAntigravityModels.length === 0) {
    for (const model of await listOpenClawModels()) {
      if (model.id.startsWith('google-antigravity/') || model.id.startsWith('google-gemini-cli/')) {
        add(model.id.replace(/^google-(?:antigravity|gemini-cli)\//, ''), model.alias || null);
      }
    }

    const openclawConfig = path.join(process.env.HOME || '/root', '.openclaw', 'openclaw.json');
    if (existsSync(openclawConfig)) {
      try {
        const raw = JSON.parse(readFileSync(openclawConfig, 'utf8'));
        const configured = raw?.agents?.defaults?.models || {};
        for (const [key, value] of Object.entries(configured)) {
          if (!key.startsWith('google-antigravity/') && !key.startsWith('google-gemini-cli/')) continue;
          const id = key.replace(/^google-(?:antigravity|gemini-cli)\//, '');
          const alias = value && typeof value === 'object' && 'alias' in value ? String((value as any).alias || '') : '';
          add(id, alias || null);
        }
      } catch {
        // Ignore malformed config; fallback models still apply.
      }
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
