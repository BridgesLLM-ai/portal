import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { AI_PROVIDER_MAP } from '../config/aiProviders';
import { readOpenClawConfig } from '../services/openclawConfigManager';
import {
  requestResolvedOllamaJson,
  resolveOllamaBackendAuthority,
  type OllamaBackendAuthority,
} from '../services/ollamaBackendAuthority';
import type { AgentProviderName } from './AgentProvider.interface';
import { buildOpenClawCliEnv, normalizePortalModelId } from '../utils/openclawCli';
import { listGatewayModels } from '../utils/openclawGatewayRpc';
import { listAntigravityModelsFromCli } from './antigravityModels';
import {
  loadSelectableAgentZeroOAuthModels,
  type AgentZeroSelectableOAuthModel,
} from './providers/agentZero/AgentZeroOAuthModelCatalog';

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

const GROK_DECLARED_FALLBACK = ['grok-build'];
export const GROK_BUILD_MODEL_ARGS = ['--no-auto-update', 'models'] as const;
const OLLAMA_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/u;
const OLLAMA_MAX_MODELS = 1_000;

function declaredCatalogProviderModels(
  catalogProviderId: string,
  runtimeProvider: string,
): ProviderModelDescriptor[] {
  return (AI_PROVIDER_MAP.get(catalogProviderId)?.defaultModels || []).map((model) => ({
    id: model.id,
    alias: null,
    provider: runtimeProvider,
    displayName: model.name,
    source: 'declared' as const,
  }));
}

const OPENCLAW_VISIBLE_MODEL_IDS = [
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.5',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3-flash-preview',
  'google/gemini-3.1-flash-lite',
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
  return id.startsWith('gemini-') || id.startsWith('grok-') ? toTitleCase(id) : id;
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
    || normalizedId.startsWith('google/')
    || normalizedId.startsWith('google-antigravity/')
    || normalizedId.startsWith('xai/');
}

export function filterOpenClawSessionModelCatalog(models: ProviderModelDescriptor[]): ProviderModelDescriptor[] {
  return models.filter((model) => isOpenClawSessionSelectableModelId(model.id));
}

const DECLARED_MODELS: Partial<Record<AgentProviderName, ProviderModelDescriptor[]>> = {
  OPENCLAW: declaredModels(OPENCLAW_VISIBLE_MODEL_IDS, 'openclaw'),
  CLAUDE_CODE: declaredCatalogProviderModels('anthropic', 'claude-code'),
  CODEX: declaredCatalogProviderModels('openai-codex', 'codex'),
  GEMINI: declaredModels(GEMINI_DECLARED_FALLBACK, 'gemini'),
  GROK: declaredModels(GROK_DECLARED_FALLBACK, 'grok'),
};

export function parseGrokModelsOutput(output: string): ProviderModelDescriptor[] {
  const ids = new Set<string>();
  for (const line of String(output || '').split(/\r?\n/)) {
    const defaultMatch = line.match(/^\s*Default model:\s*(\S+)\s*$/i);
    const availableMatch = line.match(/^\s*[*-]\s+(\S+)(?:\s+\(default\))?\s*$/i);
    const id = String(defaultMatch?.[1] || availableMatch?.[1] || '').trim();
    if (id && /^[A-Za-z0-9._:-]+$/.test(id)) ids.add(id);
  }
  return Array.from(ids).map((id) => ({
    id,
    alias: null,
    provider: 'grok',
    displayName: displayNameFromId(id),
    source: 'dynamic' as const,
  }));
}

export function mapAgentZeroOAuthModels(
  models: AgentZeroSelectableOAuthModel[],
): ProviderModelDescriptor[] {
  return models.map((model) => ({
    id: model.id,
    alias: null,
    provider: model.providerId,
    displayName: `${model.providerDisplayName} — ${model.displayName}`,
    source: 'dynamic' as const,
  }));
}

async function listAgentZeroModels(): Promise<ProviderModelDescriptor[]> {
  // Intentionally no declared/preset fallback: an unvalidated fallback would
  // recreate the silent OpenRouter/default-provider authentication failure.
  return mapAgentZeroOAuthModels(await loadSelectableAgentZeroOAuthModels());
}

let grokModelCache: { at: number; models: ProviderModelDescriptor[] } | null = null;

async function listGrokModels(): Promise<ProviderModelDescriptor[]> {
  if (grokModelCache && Date.now() - grokModelCache.at < 60_000) return grokModelCache.models;
  const dynamic = await new Promise<ProviderModelDescriptor[]>((resolve) => {
    execFile('grok', [...GROK_BUILD_MODEL_ARGS], {
      encoding: 'utf8',
      timeout: 8000,
      env: { ...process.env, NO_COLOR: '1', GROK_DISABLE_AUTOUPDATER: '1' },
      maxBuffer: 1024 * 1024 * 2,
    }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(parseGrokModelsOutput(String(stdout || '')));
    });
  });
  const deduped = new Map<string, ProviderModelDescriptor>();
  for (const model of [...dynamic, ...DECLARED_MODELS.GROK!]) {
    if (!deduped.has(model.id)) deduped.set(model.id, model);
  }
  const models = Array.from(deduped.values());
  grokModelCache = { at: Date.now(), models };
  return models;
}

const OPENCLAW_MODEL_CACHE_TTL_MS = 60_000;
const OPENCLAW_MODEL_DEGRADED_RETRY_MS = 15_000;

export interface OpenClawModelCatalogCacheEntry {
  at: number;
  models: ProviderModelDescriptor[];
  /** The cached models originate from live gateway/CLI discovery. */
  liveData: boolean;
  /** The most recent refresh attempt reached live discovery. */
  lastRefreshLive: boolean;
}

let openClawModelCache: OpenClawModelCatalogCacheEntry | null = null;
let openClawModelRefresh: Promise<ProviderModelDescriptor[]> | null = null;

/**
 * A degraded refresh (neither gateway RPC nor the CLI produced a catalog)
 * must never overwrite a previously live catalog: the CLI regularly missed
 * its old 5s budget on a loaded 2-core host, and every consumer then briefly
 * saw the static fallback. Preserved entries keep serving the last live data
 * while retrying on the shorter degraded cadence.
 */
export function reconcileOpenClawCatalogCache(
  previous: OpenClawModelCatalogCacheEntry | null,
  next: { at: number; models: ProviderModelDescriptor[]; live: boolean },
): OpenClawModelCatalogCacheEntry {
  if (next.live) {
    return { at: next.at, models: next.models, liveData: true, lastRefreshLive: true };
  }
  if (previous?.liveData) {
    return { at: next.at, models: previous.models, liveData: true, lastRefreshLive: false };
  }
  return { at: next.at, models: next.models, liveData: false, lastRefreshLive: false };
}

export function openClawCatalogCacheTtlMs(entry: OpenClawModelCatalogCacheEntry): number {
  return entry.lastRefreshLive ? OPENCLAW_MODEL_CACHE_TTL_MS : OPENCLAW_MODEL_DEGRADED_RETRY_MS;
}

function aliasFromTags(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  const aliasTag = tags.map((tag) => String(tag || '')).find((tag) => tag.startsWith('alias:'));
  const alias = aliasTag?.slice('alias:'.length).trim();
  return alias || null;
}

/**
 * Models the catalog knows about but cannot currently run, keyed by the most
 * recent parse. The picker reports the count so a model that "should be there"
 * is explained rather than simply absent.
 */
let lastOpenClawUnavailableModelIds: string[] = [];

export function readLastOpenClawUnavailableModelIds(): string[] {
  return [...lastOpenClawUnavailableModelIds];
}

export function parseOpenClawModelsListPayload(payload: any): ProviderModelDescriptor[] {
  const entries = Array.isArray(payload) ? payload : (Array.isArray(payload?.models) ? payload.models : []);
  const deduped = new Map<string, ProviderModelDescriptor>();
  const unavailable = new Set<string>();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    // `missing` means the model is not in the catalog at all. `available:false`
    // means it is known but its provider is not connected -- a state the
    // operator can fix, so it is counted and reported rather than silently
    // dropped.
    if (entry.missing === true) continue;
    if (entry.available === false) {
      const unavailableRaw = String(entry.key || entry.id || entry.model || '').trim();
      const unavailableProvider = String(entry.provider || '').trim();
      const unavailableQualified = unavailableRaw && !unavailableRaw.includes('/') && unavailableProvider
        ? `${unavailableProvider}/${unavailableRaw}`
        : unavailableRaw;
      const unavailableId = normalizePortalModelId(unavailableQualified);
      if (unavailableId) unavailable.add(unavailableId);
      continue;
    }

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

  if (unavailable.size > 0 || deduped.size > 0) {
    lastOpenClawUnavailableModelIds = Array.from(unavailable).sort();
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
    // `openclaw models list --json` measures ~4s on an idle 2-core appliance;
    // the old 5s budget flaked under ordinary load and silently degraded the
    // catalog. The cache absorbs the longer worst case.
    execFile('openclaw', ['models', 'list', '--json'], {
      encoding: 'utf8',
      timeout: 20_000,
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
  if (openClawModelCache && now - openClawModelCache.at < openClawCatalogCacheTtlMs(openClawModelCache)) {
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
  const liveDiscovery = cliModels.length > 0;
  if (!liveDiscovery) {
    for (const model of Array.from(deduped.values())) {
      if (!cliModels.some((entry) => entry.id === model.id)) cliModels.push(model);
    }
  }

  const catalog = cliModels.length ? cliModels : [...DECLARED_MODELS.OPENCLAW!];
  const curated = filterOpenClawSessionModelCatalog(catalog);
  const models = curated.length ? curated : [...DECLARED_MODELS.OPENCLAW!];
  openClawModelCache = reconcileOpenClawCatalogCache(openClawModelCache, {
    at: Date.now(),
    models,
    live: liveDiscovery,
  });
  return openClawModelCache.models;
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
      if (model.id.startsWith('google-antigravity/')) {
        add(model.id.slice('google-antigravity/'.length), model.alias || null);
      }
    }

    const openclawConfig = path.join(process.env.HOME || '/root', '.openclaw', 'openclaw.json');
    if (existsSync(openclawConfig)) {
      try {
        const raw = JSON.parse(readFileSync(openclawConfig, 'utf8'));
        const configured = raw?.agents?.defaults?.models || {};
        for (const [key, value] of Object.entries(configured)) {
          if (!key.startsWith('google-antigravity/')) continue;
          const id = key.slice('google-antigravity/'.length);
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

export async function getOllamaRuntimeCandidates(): Promise<Array<{
  authority: OllamaBackendAuthority;
  source: string;
}>> {
  try {
    const resolved = await resolveOllamaBackendAuthority();
    return [{
      authority: resolved.authority,
      source: resolved.authority.source,
    }];
  } catch {
    return [];
  }
}

async function listOllamaModels(): Promise<ProviderModelDescriptor[]> {
  try {
    const resolved = await resolveOllamaBackendAuthority();
    const { value: data } = await requestResolvedOllamaJson<any>(resolved, {
      path: '/api/tags',
      method: 'GET',
      timeoutMs: 5_000,
      maxResponseBytes: 2 * 1024 * 1024,
    });
    const models = Array.isArray(data?.models) ? data.models : [];
    const visibleModels = resolved.authority.kind === 'TAILNET'
      ? models.filter((model: any) => {
        if (
          !resolved.authority.selectedModel
          || !resolved.authority.selectedModelDigest
        ) {
          return false;
        }
        const id = String(model?.name || model?.model || '').trim();
        const digest = String(model?.digest || '').trim().toLowerCase();
        return id === resolved.authority.selectedModel
          && `sha256:${digest.replace(/^sha256:/u, '')}`
            === resolved.authority.selectedModelDigest;
      })
      : models;
    const ids = new Set<string>(visibleModels
      .slice(0, OLLAMA_MAX_MODELS)
      .flatMap((model: any) => {
        const id = String(model?.name || model?.model || '').trim();
        return OLLAMA_MODEL_ID_RE.test(id) ? [id] : [];
      }));
    return [...ids]
      .map((id: string) => ({
        id,
        alias: null,
        provider: 'ollama',
        displayName: id,
        source: 'dynamic' as const,
      }));
  } catch {
    return [];
  }
}

export async function listProviderModels(name: AgentProviderName): Promise<ProviderModelDescriptor[]> {
  switch (name) {
    case 'OPENCLAW':
      return listOpenClawModels();
    case 'GEMINI':
      return listGeminiDeclaredModels();
    case 'GROK':
      return listGrokModels();
    case 'AGENT_ZERO':
      return listAgentZeroModels();
    case 'OLLAMA':
      return listOllamaModels();
    default:
      return DECLARED_MODELS[name] ? [...DECLARED_MODELS[name]!] : [];
  }
}
