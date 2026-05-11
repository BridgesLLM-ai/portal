import express, { Request, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { z } from 'zod';
import { getAiProviderMeta } from '../config/aiProviders';
import { validateApiKey } from '../services/aiProviderValidator';
import { completeNativeCliFlow, completeOAuthFlow, getClaudeSetupToken, getOAuthFlowStatus, importClaudeCliAuthProfile, pasteCodeToClaudeSession, saveClaudeToken, startClaudeSetupTokenFlow, startDeviceCodeFlow, startNativeCliFlow, startOAuthFlow } from '../services/oauthFlowManager';
import {
  AUTH_PROFILES_PATH,
  CONFIG_PATH,
  MODELS_JSON_PATH,
  getDefaultModel,
  getFallbackModels,
  getProviderStatuses,
  pinProviderAuthProfile,
  readAuthProfiles,
  readOpenClawConfig,
  saveProviderApiKey,
} from '../services/openclawConfigManager';
import { listGatewayModels } from '../utils/openclawGatewayRpc';
import { getNativeCliAuthStatus } from '../agents/nativeCliAuth';
import {
  buildOpenClawCliEnv,
  canonicalizeProviderModelId,
  extractJsonFromCliOutput,
  normalizePortalModelId,
  repairClaudeSubscriptionConfig,
} from '../utils/openclawCli';

const providerIdSchema = z.string().min(1).refine((value) => Boolean(getAiProviderMeta(value)), 'Unknown provider');
const validateKeySchema = z.object({
  provider: providerIdSchema,
  apiKey: z.string().min(1).max(500),
});
const saveKeySchema = validateKeySchema.extend({
  setDefault: z.boolean().optional(),
  model: z.string().max(200).optional(),
}).superRefine((data, ctx) => {
  if (data.model && !data.model.includes('/')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'Model must include provider prefix' });
  }
  if (data.setDefault && !data.model) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'Model is required when setDefault is true' });
  }
  if (data.model && !matchesProviderModel(data.provider, data.model)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'Selected model must belong to the same provider being configured' });
  }
});
const setDefaultSchema = z.object({
  model: z.string().max(200).refine((value) => value.includes('/'), 'Model must include provider prefix'),
});
const saveSetupTokenSchema = z.object({
  provider: z.literal('anthropic'),
  token: z.string().min(1).max(5000),
  setDefault: z.boolean().optional(),
  model: z.string().max(200).optional(),
}).superRefine((data, ctx) => {
  if (data.setDefault && !data.model) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'Model is required when setDefault is true' });
  }
});
const setFallbacksSchema = z.object({
  fallbacks: z.array(z.string().max(200).refine((value) => value.includes('/'), 'Fallback model must include provider prefix')).max(10),
});
const oauthStartSchema = z.object({
  provider: z.enum(['openai-codex', 'google-gemini-cli', 'qwen-portal']),
  googleProjectId: z.string().min(1).optional(),
});
const oauthCallbackSchema = z.object({
  sessionId: z.string().min(1),
  callbackUrl: z.string().min(1, 'Callback URL is required').transform((value) => {
    const trimmed = value.trim();
    // Browsers often strip http:// from the address bar — add it back if missing
    if (trimmed.startsWith('localhost:') || trimmed.startsWith('localhost/')) {
      return `http://${trimmed}`;
    }
    if (trimmed.startsWith('127.0.0.1:') || trimmed.startsWith('127.0.0.1/')) {
      return `http://${trimmed}`;
    }
    return trimmed;
  }).refine((value) => value.startsWith('http://127.0.0.1:') || value.startsWith('http://localhost:') || value.startsWith('http://127.0.0.1/') || value.startsWith('http://localhost/'), 'Callback URL must be a localhost redirect URL'),
});

const OPENCLAW_BIN = 'openclaw';
const GATEWAY_HEALTH_URL = process.env.OPENCLAW_API_URL || 'http://127.0.0.1:18789';
const handledNativeCliDeviceCompletions = new Set<string>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonWithFallback<T>(targetPath: string, fallback: T): T {
  try {
    if (!fs.existsSync(targetPath)) return fallback;
    return JSON.parse(fs.readFileSync(targetPath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function atomicWriteJson(targetPath: string, data: unknown) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, targetPath);
}

function runOpenClaw(args: string[], timeout = 30000) {
  const raw = execFileSync(OPENCLAW_BIN, args, {
    timeout,
    encoding: 'utf8',
    env: buildOpenClawCliEnv(),
  });
  if (args.includes('--json')) {
    return extractJsonFromCliOutput(raw);
  }
  return raw;
}

const PROVIDER_MODEL_DISCOVERY_FALLBACKS: Record<string, string[]> = {
  anthropic: [
    'anthropic/claude-opus-4-6',
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-haiku-4-5',
  ],
  'openai-codex': [
    'openai-codex/gpt-5.5',
    'openai-codex/gpt-5.5-pro',
    'openai-codex/gpt-5.4',
    'openai-codex/gpt-5.4-pro',
    'openai-codex/gpt-5.4-mini',
    'openai-codex/gpt-5.3-codex',
    'openai-codex/gpt-5.2',
    'openai-codex/gpt-5.2-codex',
  ],
  'google-gemini-cli': [
    'google-gemini-cli/gemini-2.0-flash',
    'google-gemini-cli/gemini-2.5-flash',
    'google-gemini-cli/gemini-2.5-pro',
    'google-gemini-cli/gemini-3-flash-preview',
    'google-gemini-cli/gemini-3-pro-preview',
    'google-gemini-cli/gemini-3.1-flash-lite-preview',
    'google-gemini-cli/gemini-3.1-pro-preview',
  ],
};


const PROVIDER_MODEL_PREFIX_ALIASES: Record<string, string[]> = {
  'google-gemini-cli': ['google-gemini-cli', 'google'],
  google: ['google', 'google-gemini-cli'],
  'openai-codex': ['openai-codex', 'openai'],
  openai: ['openai', 'openai-codex'],
};

function getProviderModelPrefixes(provider: string): string[] {
  return Array.from(new Set([provider, ...(PROVIDER_MODEL_PREFIX_ALIASES[provider] || [])]));
}

function bareModelLooksLikeProviderFamily(provider: string | null | undefined, rawModel: string | null | undefined): boolean {
  const candidate = String(rawModel || '').trim().toLowerCase();
  if (!provider || !candidate || candidate.includes('/')) return true;

  switch (provider) {
    case 'google':
    case 'google-gemini-cli':
      return candidate.startsWith('gemini-');
    case 'openai':
    case 'openai-codex':
      return /^(gpt-|o\d|codex)/i.test(candidate);
    case 'anthropic':
      return /^(claude-|sonnet|opus|haiku)/i.test(candidate);
    default:
      return true;
  }
}

function providerBelongsToSameFamily(provider: string | null | undefined, otherProvider: string | null | undefined): boolean {
  const left = String(provider || '').trim();
  const right = String(otherProvider || '').trim();
  if (!left || !right) return false;
  return getProviderModelPrefixes(left).includes(right) || getProviderModelPrefixes(right).includes(left);
}

function resolveModelProviderHint(providerHint: string | null | undefined, rawModel: string | null | undefined, explicitProvider?: string | null): string | null {
  const raw = String(rawModel || '').trim();
  const selectedProvider = String(providerHint || '').trim();
  const modelProvider = String(explicitProvider || '').trim();

  if (selectedProvider && modelProvider) {
    return providerBelongsToSameFamily(selectedProvider, modelProvider) ? selectedProvider : modelProvider;
  }

  if (selectedProvider && raw.includes('/')) {
    const prefix = raw.split('/')[0] || '';
    if (providerBelongsToSameFamily(selectedProvider, prefix)) {
      return selectedProvider;
    }
    return null;
  }

  if (modelProvider) return modelProvider;
  if (!selectedProvider) return null;
  if (!bareModelLooksLikeProviderFamily(selectedProvider, raw)) return null;
  return selectedProvider;
}

function canonicalizeDiscoveredProviderModelId(provider: string, rawModel: string | null | undefined): string {
  const explicit = canonicalizeProviderModelId(null, rawModel);
  if (explicit && explicit.includes('/') && !getProviderModelPrefixes(provider).some((prefix) => explicit.startsWith(`${prefix}/`))) {
    return explicit;
  }

  return canonicalizeProviderModelId(provider, rawModel);
}

export function matchesProviderModel(provider: string, rawModel: string | null | undefined): boolean {
  const canonical = canonicalizeDiscoveredProviderModelId(provider, rawModel);
  if (!canonical) return false;

  for (const prefix of getProviderModelPrefixes(provider)) {
    const fullPrefix = `${prefix}/`;
    if (!canonical.startsWith(fullPrefix)) continue;
    const remainder = canonical.slice(fullPrefix.length);

    if ((provider === 'google' || provider === 'google-gemini-cli' || provider === 'openai' || provider === 'openai-codex' || provider === 'anthropic') && remainder.includes('/')) {
      return false;
    }

    return true;
  }

  return false;
}

function extractModelArray(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.models)) return payload.models;
  if (Array.isArray(payload?.entries)) return payload.entries;
  return [];
}

function dedupeProviderModels(provider: string, models: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const raw of models) {
    const canonical = canonicalizeDiscoveredProviderModelId(provider, raw || '');
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    deduped.push(canonical);
  }
  return deduped;
}

function stripPortalUnsupportedModelMetadata(config: any): boolean {
  // Keep setup writes inside OpenClaw's stable public config schema. Runtime
  // harness selection is not a valid key under agents.defaults.models in
  // OpenClaw 2026.5.x; persisting it makes `openclaw gateway restart` abort.
  const models = config?.agents?.defaults?.models;
  if (!models || typeof models !== 'object') return false;

  let changed = false;
  for (const entry of Object.values(models) as any[]) {
    if (!entry || typeof entry !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(entry, 'agentRuntime')) {
      delete entry.agentRuntime;
      changed = true;
    }
  }
  return changed;
}

function parseDiscoveredProviderModels(provider: string, payload: any): string[] {
  const models = normalizeModelPayload(extractModelArray(payload), provider)
    .map((entry) => canonicalizeDiscoveredProviderModelId(provider, entry?.id || entry?.name || ''))
    .filter((modelId) => matchesProviderModel(provider, modelId));
  return dedupeProviderModels(provider, models);
}

function readDiscoveredProviderModelsFromCli(provider: string): string[] {
  const attempts: Array<() => string> = [
    () => runOpenClaw(['models', 'list', '--all', '--provider', provider, '--json'], 20000),
    () => runOpenClaw(['models', 'list', '--all', '--json'], 20000),
    () => runOpenClaw(['models', 'list', '--json'], 20000),
  ];

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt());
      const models = parseDiscoveredProviderModels(provider, parsed)
        .filter((modelId) => matchesProviderModel(provider, modelId));
      if (models.length) return models;
    } catch (err: any) {
      console.warn(`[AI-Setup] CLI model discovery failed for ${provider}: ${err.message}`);
    }
  }

  return [];
}

async function readDiscoveredProviderModelsFromGateway(provider: string): Promise<string[]> {
  try {
    const rpcResult = await listGatewayModels();
    if (!rpcResult.ok) return [];
    return parseDiscoveredProviderModels(provider, rpcResult.models || [])
      .filter((modelId) => matchesProviderModel(provider, modelId));
  } catch (err: any) {
    console.warn(`[AI-Setup] Gateway model discovery failed for ${provider}: ${err.message}`);
    return [];
  }
}

export function mergeDiscoveredProviderModelsIntoConfig(config: any, provider: string, discoveredModels: string[]) {
  const next = config && typeof config === 'object'
    ? JSON.parse(JSON.stringify(config))
    : {};

  next.agents = next.agents || {};
  next.agents.defaults = next.agents.defaults || {};
  next.agents.defaults.model = next.agents.defaults.model || {};
  next.agents.defaults.models = next.agents.defaults.models || {};

  const currentDefault = canonicalizeDiscoveredProviderModelId(provider, next.agents.defaults.model.primary || '');
  const existingFallbacks = Array.isArray(next.agents.defaults.model.fallbacks)
    ? dedupeProviderModels(provider, next.agents.defaults.model.fallbacks)
    : [];

  const fallbackSet = new Set(existingFallbacks);
  const addedAllowlist: string[] = [];
  const addedFallbacks: string[] = [];
  let changed = stripPortalUnsupportedModelMetadata(next);

  for (const modelId of dedupeProviderModels(provider, discoveredModels)) {
    if (!next.agents.defaults.models[modelId] || typeof next.agents.defaults.models[modelId] !== 'object') {
      next.agents.defaults.models[modelId] = next.agents.defaults.models[modelId] && typeof next.agents.defaults.models[modelId] === 'object'
        ? next.agents.defaults.models[modelId]
        : {};
      addedAllowlist.push(modelId);
      changed = true;
    }

    if (modelId !== currentDefault && !fallbackSet.has(modelId)) {
      existingFallbacks.push(modelId);
      fallbackSet.add(modelId);
      addedFallbacks.push(modelId);
      changed = true;
    }
  }

  if (changed) {
    next.agents.defaults.model.fallbacks = existingFallbacks;
  }

  return {
    config: next,
    changed,
    addedAllowlist,
    addedFallbacks,
  };
}

/**
 * After provider auth, discover all available models and persist them into
 * agents.defaults.models + agents.defaults.model.fallbacks so they are both
 * selectable and visibly configured across the portal.
 */
async function registerProviderModels(provider: string) {
  const discoveredViaCli = readDiscoveredProviderModelsFromCli(provider);
  const discoveredViaGateway = discoveredViaCli.length ? [] : await readDiscoveredProviderModelsFromGateway(provider);
  const staticFallbacks = dedupeProviderModels(provider, [
    ...(PROVIDER_MODEL_DISCOVERY_FALLBACKS[provider] || []),
    ...((getAiProviderMeta(provider)?.defaultModels || []).map((model) => canonicalizeProviderModelId(provider, model.id))),
  ]);

  const discoveredModels = dedupeProviderModels(provider, [
    ...discoveredViaCli,
    ...discoveredViaGateway,
    ...staticFallbacks,
  ]).filter((modelId) => matchesProviderModel(provider, modelId));

  if (!discoveredModels.length) {
    console.log(`[AI-Setup] No models discovered for ${provider}`);
    return { changed: false, models: [] as string[], addedAllowlist: [] as string[], addedFallbacks: [] as string[] };
  }

  const openclawConfig = readOpenClawConfig();
  const merged = mergeDiscoveredProviderModelsIntoConfig(openclawConfig, provider, discoveredModels);
  if (merged.changed) {
    atomicWriteJson(CONFIG_PATH, merged.config);
    if (provider === 'anthropic') repairClaudeSubscriptionConfig();
  }

  console.log(`[AI-Setup] Registered ${discoveredModels.length} ${provider} models (${merged.addedAllowlist.length} allowlisted, ${merged.addedFallbacks.length} fallback additions)`);
  return {
    changed: merged.changed,
    models: discoveredModels,
    addedAllowlist: merged.addedAllowlist,
    addedFallbacks: merged.addedFallbacks,
  };
}

function restartGatewayBySignal() {
  const output = execFileSync('pgrep', ['-f', 'openclaw.*gateway|gateway.*openclaw|/openclaw/dist/.*gateway|openclaw-gateway'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  const pid = output.split(/\s+/).map((value) => value.trim()).find(Boolean);
  if (!pid) {
    throw new Error('No gateway PID found for signal fallback.');
  }
  process.kill(Number(pid), 'SIGUSR1');
}

async function restartGateway() {
  const systemdAvailable = fs.existsSync('/run/systemd/system') && fs.existsSync('/bin/systemctl');
  if (!systemdAvailable) {
    restartGatewayBySignal();
    await sleep(3000);
    return;
  }

  try {
    runOpenClaw(['gateway', 'restart'], 8000);
  } catch (cliError) {
    try {
      restartGatewayBySignal();
    } catch (signalError) {
      const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
      const signalMessage = signalError instanceof Error ? signalError.message : String(signalError);
      throw new Error(`Gateway restart failed via CLI (${cliMessage}) and SIGUSR1 fallback (${signalMessage}).`);
    }
  }
  await sleep(3000);
}

async function fetchGatewayHealth() {
  const url = `${GATEWAY_HEALTH_URL.replace(/\/$/, '')}/health`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return true;
    } catch {
      // retry once for transient gateway warm-up / restart races
    }

    if (attempt === 0) {
      await sleep(500);
    }
  }

  return false;
}

function getConfiguredProfileCount(): number {
  return getProviderStatuses().filter((provider) => provider.status === 'configured').length;
}

function getActiveProfiles(): string[] {
  return getProviderStatuses()
    .filter((provider) => provider.status === 'configured' && provider.profileId)
    .map((provider) => provider.profileId as string);
}

function buildSaveCommand(provider: string, apiKey: string): string[] {
  const meta = getAiProviderMeta(provider);
  if (!meta?.onboardAuthChoice) throw new Error(`Provider ${provider} does not support CLI onboarding`);

  const commonArgs = ['onboard', '--non-interactive', '--accept-risk', '--skip-channels', '--skip-skills', '--skip-health', '--skip-daemon', '--skip-search', '--skip-ui'];

  if (provider === 'groq') {
    return [...commonArgs, '--auth-choice', 'token', '--token-provider', 'groq', '--token', apiKey];
  }

  if (!meta.onboardKeyFlag) throw new Error(`Provider ${provider} is missing onboard key flag metadata`);
  return [...commonArgs, '--auth-choice', meta.onboardAuthChoice, `--${meta.onboardKeyFlag}`, apiKey];
}

export function normalizeModelPayload(models: any[], providerHint?: string | null): any[] {
  return models.map((model) => {
    if (typeof model === 'string') {
      const rawId = String(model || '').trim();
      const provider = resolveModelProviderHint(providerHint || null, rawId);
      const canonicalId = canonicalizeProviderModelId(provider, rawId);
      return canonicalId ? {
        id: canonicalId,
        name: canonicalId,
        provider: canonicalId.includes('/') ? canonicalId.split('/')[0] : undefined,
      } : null;
    }

    const rawId = model?.key || model?.id || model?.model || model?.name || '';
    const explicitProvider = typeof model?.provider === 'string'
      ? model.provider
      : (typeof model?.modelProvider === 'string' ? model.modelProvider : null);
    const provider = resolveModelProviderHint(providerHint || null, rawId, explicitProvider);
    const canonicalId = canonicalizeProviderModelId(provider, rawId);
    return canonicalId ? {
      id: canonicalId,
      name: model?.name || model?.id || model?.model || model?.key || canonicalId,
      provider: provider || (canonicalId.includes('/') ? canonicalId.split('/')[0] : undefined),
      raw: model,
    } : null;
  }).filter(Boolean);
}

export function createAiSetupRouter(): Router {
  const router = express.Router();

  router.post('/oauth/start', async (req: Request, res: Response) => {
    const parsed = oauthStartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i: any) => i.message).join("; ") || "Invalid request" });
      return;
    }

    try {
      if (parsed.data.provider === 'qwen-portal') {
        runOpenClaw(['plugins', 'enable', 'qwen-portal-auth'], 15000);
      }
      const result = await startOAuthFlow(parsed.data.provider, {
        googleProjectId: parsed.data.googleProjectId,
      });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to start OAuth flow' });
    }
  });

  router.post('/oauth/device/start', async (_req: Request, res: Response) => {
    try {
      const result = await startDeviceCodeFlow('github-copilot');
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to start device-code flow' });
    }
  });

  router.post('/oauth/callback', async (req: Request, res: Response) => {
    const parsed = oauthCallbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i: any) => i.message).join("; ") || "Invalid request" });
      return;
    }

    try {
      const result = await completeOAuthFlow(parsed.data.sessionId, parsed.data.callbackUrl);
      if (!result.success) {
        res.status(500).json(result);
        return;
      }
      const sessionStatus = getOAuthFlowStatus(parsed.data.sessionId);
      if (sessionStatus?.provider && sessionStatus.createdProfileId) {
        pinProviderAuthProfile(sessionStatus.provider, sessionStatus.createdProfileId, 'oauth');
      }
      if (sessionStatus?.provider) {
        await registerProviderModels(sessionStatus.provider);
      }
      await restartGateway();
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to complete OAuth flow' });
    }
  });

  router.get('/oauth/status/:sessionId', async (req: Request, res: Response) => {
    const status = getOAuthFlowStatus(req.params.sessionId);
    if (!status) {
      res.status(404).json({ error: 'OAuth session not found' });
      return;
    }
    res.json(status);
  });

  router.get('/status', async (_req: Request, res: Response) => {
    let openclawInstalled = false;
    let openclawVersion: string | null = null;

    try {
      execSync(`command -v ${OPENCLAW_BIN}`, { timeout: 2000, stdio: 'ignore' });
      openclawInstalled = true;
      openclawVersion = runOpenClaw(['--version'], 5000).trim() || null;
    } catch {
      openclawInstalled = false;
    }

    const gatewayRunning = await fetchGatewayHealth();
    const providers = getProviderStatuses();

    res.json({
      openclawInstalled,
      openclawVersion,
      gatewayRunning,
      providers,
      defaultModel: getDefaultModel(),
      fallbackModels: getFallbackModels(),
      configuredProfileCount: getConfiguredProfileCount(),
      activeProfiles: getActiveProfiles(),
    });
  });

  router.post('/validate-key', async (req: Request, res: Response) => {
    const parsed = validateKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i: any) => i.message).join("; ") || "Invalid request" });
      return;
    }

    const { provider, apiKey } = parsed.data;
    const meta = getAiProviderMeta(provider)!;
    if (meta.keyPrefix && !apiKey.startsWith(meta.keyPrefix)) {
      res.status(400).json({ valid: false, error: `Key should start with ${meta.keyPrefix}` });
      return;
    }

    res.json(await validateApiKey(provider, apiKey));
  });

  router.post('/save-key', async (req: Request, res: Response) => {
    const parsed = saveKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i: any) => i.message).join("; ") || "Invalid request" });
      return;
    }

    const { provider, apiKey, setDefault, model } = parsed.data;
    const normalizedModel = canonicalizeProviderModelId(provider, model || '');
    const validation = await validateApiKey(provider, apiKey);
    if (!validation.valid) {
      res.status(400).json(validation);
      return;
    }

    try {
      // Write API key directly to auth-profiles.json, openclaw.json, and models.json.
      // The 'openclaw onboard' CLI doesn't reliably persist API keys for non-OAuth providers,
      // so we bypass it entirely and write to the same files OpenClaw reads at runtime.
      const { profileId: savedProfileId } = saveProviderApiKey(provider, apiKey);

      if (setDefault && normalizedModel) {
        try { runOpenClaw(['models', 'set', normalizedModel], 10000); } catch {
          const config = readOpenClawConfig();
          if (!config.agents) config.agents = {};
          if (!config.agents.defaults) config.agents.defaults = {};
          if (!config.agents.defaults.model) config.agents.defaults.model = {};
          config.agents.defaults.model.primary = normalizedModel;
          const fs = require('fs');
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        }
      }

      await registerProviderModels(provider);
      await restartGateway();

      res.json({ success: true, profileId: savedProfileId, model: normalizedModel || null });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to save API key' });
    }
  });

  // ── Claude setup-token flow (automated) ──────────────────────────
  router.post('/claude/start', async (_req: Request, res: Response) => {
    try {
      const nativeClaude = getNativeCliAuthStatus('CLAUDE_CODE');
      if (nativeClaude.status === 'authenticated') {
        try {
          const imported = await importClaudeCliAuthProfile(30000);
          if (imported.profileId) pinProviderAuthProfile('anthropic', imported.profileId, 'oauth');
          await registerProviderModels('anthropic');
          await restartGateway();
          res.json({ success: true, instantComplete: true, method: 'cli-reuse' });
          return;
        } catch (cliReuseError: any) {
          console.warn('[Claude] Claude CLI reuse path failed, falling back to setup-token:', cliReuseError?.message || cliReuseError);
        }
      }

      const result = await startClaudeSetupTokenFlow();
      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error('[Claude] start error:', error.message);
      res.status(500).json({ success: false, error: error?.message || 'Failed to start Claude setup' });
    }
  });

  router.post('/claude/paste-code', async (req: Request, res: Response) => {
    const { sessionId, code } = req.body;
    if (!sessionId || !code) { res.status(400).json({ error: 'sessionId and code required' }); return; }

    try {
      const result = await pasteCodeToClaudeSession(sessionId, code);
      res.json(result);
    } catch (error: any) {
      console.error('[Claude] paste-code error:', error.message);
      res.status(500).json({ success: false, error: error?.message || 'Failed to paste code' });
    }
  });

  router.post('/claude/complete', async (req: Request, res: Response) => {
    const { sessionId } = req.body;
    if (!sessionId) { res.status(400).json({ error: 'sessionId required' }); return; }

    try {
      const result = await getClaudeSetupToken(sessionId);
      if (!result.success) {
        res.json(result);
        return;
      }

      if (result.token) {
        const saveResult = await saveClaudeToken(result.token);
        if (!saveResult.success) {
          res.json(saveResult);
          return;
        }
      } else if (!result.usedCliImport) {
        res.json({ success: false, error: 'Claude authentication completed, but no reusable token or CLI auth import was found.' });
        return;
      }

      if (result.usedCliImport) {
        pinProviderAuthProfile('anthropic', 'anthropic:claude-cli', 'oauth');
      }

      await registerProviderModels('anthropic');
      // Restart gateway after the allowlist/fallback updates are persisted.
      await restartGateway();
      res.json({ success: true });
    } catch (error: any) {
      console.error('[Claude] complete error:', error.message);
      res.status(500).json({ success: false, error: error?.message || 'Failed to complete Claude setup' });
    }
  });

  router.post('/save-setup-token', async (req: Request, res: Response) => {
    const parsed = saveSetupTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i: any) => i.message).join("; ") || "Invalid request" });
      return;
    }

    const { provider, token, setDefault, model } = parsed.data;

    try {
      const beforeAuthProfiles = readAuthProfiles();
      const beforeProfileIds = new Set(Object.keys(beforeAuthProfiles.profiles || {}).filter((profileId) => beforeAuthProfiles.profiles?.[profileId]?.provider === provider));

      runOpenClaw(['models', 'auth', 'paste-token', '--provider', provider, '--token', token], 30000);

      const normalizedModel = canonicalizeProviderModelId(provider, model || '');
      if (setDefault && normalizedModel) {
        runOpenClaw(['models', 'set', normalizedModel], 10000);
        repairClaudeSubscriptionConfig(normalizedModel);
      }

      await registerProviderModels(provider);
      await restartGateway();

      const authProfiles = readAuthProfiles();
      const providerProfileIds = Object.keys(authProfiles.profiles || {}).filter((profileId) => authProfiles.profiles[profileId]?.provider === provider);
      const savedProfileId = providerProfileIds.find((profileId) => !beforeProfileIds.has(profileId))
        || providerProfileIds.find((profileId) => profileId.includes('setup-token'))
        || providerProfileIds[0];
      if (!savedProfileId) throw new Error('Provider profile was not found after saving setup-token');

      res.json({ success: true, profileId: savedProfileId, model: normalizePortalModelId(model || '') || null });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to save setup-token' });
    }
  });

  router.post('/set-default-model', async (req: Request, res: Response) => {
    const parsed = setDefaultSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i: any) => i.message).join("; ") || "Invalid request" });
      return;
    }

    try {
      const normalizedModel = normalizePortalModelId(parsed.data.model);
      runOpenClaw(['models', 'set', normalizedModel], 10000);
      repairClaudeSubscriptionConfig(normalizedModel);
      // Also register all models for this provider (handles auto-completion case)
      const provider = normalizedModel.split('/')[0];
      if (provider) await registerProviderModels(provider);
      await restartGateway();
      res.json({ success: true, model: normalizedModel });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to set default model' });
    }
  });

  router.post('/set-fallbacks', async (req: Request, res: Response) => {
    const parsed = setFallbacksSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i: any) => i.message).join("; ") || "Invalid request" });
      return;
    }

    try {
      const normalizedFallbacks = parsed.data.fallbacks.map((model) => normalizePortalModelId(model)).filter(Boolean);
      runOpenClaw(['models', 'fallbacks', 'set', ...normalizedFallbacks], 15000);
      repairClaudeSubscriptionConfig();
      await restartGateway();
      res.json({ success: true, fallbacks: normalizedFallbacks });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to set fallback models' });
    }
  });

  router.get('/models', async (req: Request, res: Response) => {
    const providerFilter = typeof req.query.provider === 'string' ? req.query.provider : null;

    try {
      const rpcResult = await listGatewayModels();
      if (rpcResult.ok) {
        let models = normalizeModelPayload(rpcResult.models || [], providerFilter);
        if (providerFilter) models = models.filter((model) => matchesProviderModel(providerFilter, model.id || model.name || ''));
        res.json({ models });
        return;
      }

      const cliModels = JSON.parse(runOpenClaw(['models', 'list', '--json'], 60000));
      let models = normalizeModelPayload(Array.isArray(cliModels) ? cliModels : cliModels.models || [], providerFilter);
      if (providerFilter) models = models.filter((model) => matchesProviderModel(providerFilter, model.id || model.name || ''));
      res.json({ models });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to list models' });
    }
  });

  router.delete('/provider/:id', async (req: Request, res: Response) => {
    const providerId = req.params.id;
    const providerMeta = getAiProviderMeta(providerId);
    if (!providerMeta) {
      res.status(404).json({ error: 'Unknown provider' });
      return;
    }
    if (!providerMeta.onboardAuthChoice && providerId === 'ollama') {
      res.status(400).json({ success: false, error: 'Ollama is managed by the local models flow and cannot be removed through AI provider auth removal.' });
      return;
    }

    try {
      const authProfiles = readJsonWithFallback<any>(AUTH_PROFILES_PATH, { version: 2, profiles: {} });
      const openclawConfig = readJsonWithFallback<any>(CONFIG_PATH, {});
      const modelsJson = readJsonWithFallback<any>(MODELS_JSON_PATH, { providers: {} });
      const profileIds = Object.keys(authProfiles.profiles || {}).filter((profileId) => authProfiles.profiles[profileId]?.provider === providerId);

      for (const profileId of profileIds) {
        delete authProfiles.profiles[profileId];
        if (authProfiles.usageStats) delete authProfiles.usageStats[profileId];
      }

      const configProfiles = openclawConfig?.auth?.profiles || {};
      for (const [profileId, profile] of Object.entries<any>(configProfiles)) {
        if (profile?.provider === providerId) delete configProfiles[profileId];
      }
      if (openclawConfig?.auth) {
        openclawConfig.auth.profiles = configProfiles;
        if (openclawConfig.auth.order && typeof openclawConfig.auth.order === 'object') {
          delete openclawConfig.auth.order[providerId];
        }
      }

      const defaultModel = openclawConfig?.agents?.defaults?.model?.primary;
      const removeClaudeCliRefs = providerId === 'anthropic';
      if (typeof defaultModel === 'string' && (defaultModel.startsWith(`${providerId}/`) || (removeClaudeCliRefs && defaultModel.startsWith('claude-cli/')))) {
        if (openclawConfig?.agents?.defaults?.model) {
          delete openclawConfig.agents.defaults.model.primary;
        }
      }

      const fallbacks = openclawConfig?.agents?.defaults?.model?.fallbacks;
      if (Array.isArray(fallbacks)) {
        openclawConfig.agents.defaults.model.fallbacks = fallbacks.filter((model: unknown) => {
          if (typeof model !== 'string') return true;
          if (model.startsWith(`${providerId}/`)) return false;
          if (removeClaudeCliRefs && model.startsWith('claude-cli/')) return false;
          return true;
        });
      }

      const modelRegistry = openclawConfig?.agents?.defaults?.models;
      if (modelRegistry && typeof modelRegistry === 'object' && !Array.isArray(modelRegistry)) {
        for (const modelId of Object.keys(modelRegistry)) {
          if (modelId.startsWith(`${providerId}/`) || (removeClaudeCliRefs && modelId.startsWith('claude-cli/'))) {
            delete modelRegistry[modelId];
          }
        }
      }

      if (modelsJson?.providers && typeof modelsJson.providers === 'object') {
        delete modelsJson.providers[providerId];
      }
      if (openclawConfig?.models?.providers && typeof openclawConfig.models.providers === 'object') {
        delete openclawConfig.models.providers[providerId];
      }

      if (typeof authProfiles.version !== 'number') {
        authProfiles.version = 1;
      }
      atomicWriteJson(AUTH_PROFILES_PATH, authProfiles);
      atomicWriteJson(CONFIG_PATH, openclawConfig);
      atomicWriteJson(MODELS_JSON_PATH, modelsJson);
      await restartGateway();
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to remove provider configuration' });
    }
  });

  router.post('/restart-gateway', async (_req: Request, res: Response) => {
    try {
      await restartGateway();
      const gatewayRunning = await fetchGatewayHealth();
      res.json({ success: gatewayRunning, message: gatewayRunning ? 'Gateway restarted' : 'Gateway may still be starting' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to restart gateway' });
    }
  });

  // ── Native CLI OAuth flows ──────────────────────────────────────────
  router.post('/native-cli/start', async (req: Request, res: Response) => {
    const { provider } = req.body;
    if (!['claude-code', 'codex', 'gemini'].includes(provider)) {
      res.status(400).json({ error: 'Invalid native CLI provider' });
      return;
    }

    try {
      const result = await startNativeCliFlow(provider);
      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error(`[NativeCLI] start error for ${provider}:`, error.message);
      res.status(500).json({ success: false, error: error?.message || 'Failed to start native CLI flow' });
    }
  });

  router.get('/native-cli/status/:sessionId', async (req: Request, res: Response) => {
    const status = getOAuthFlowStatus(req.params.sessionId);
    if (!status) {
      res.status(404).json({ error: 'Native CLI session not found' });
      return;
    }

    if (status.mode === 'device_code' && status.status === 'complete' && !handledNativeCliDeviceCompletions.has(status.id)) {
      handledNativeCliDeviceCompletions.add(status.id);
      try {
        await restartGateway();
      } catch (error: any) {
        handledNativeCliDeviceCompletions.delete(status.id);
        console.error(`[NativeCLI] gateway restart failed after ${status.provider} login:`, error?.message || error);
        res.status(500).json({
          ...status,
          success: false,
          error: `Native CLI auth completed, but gateway restart failed: ${error?.message || 'unknown error'}`,
        });
        return;
      }
    }

    res.json(status);
  });

  router.post('/native-cli/callback', async (req: Request, res: Response) => {
    const { sessionId, callbackUrl } = req.body;
    if (!sessionId || !callbackUrl) {
      res.status(400).json({ error: 'sessionId and callbackUrl required' });
      return;
    }

    try {
      const result = await completeNativeCliFlow(sessionId, callbackUrl);
      if (result?.success) {
        try {
          await restartGateway();
        } catch (error: any) {
          console.error('[NativeCLI] gateway restart failed after callback login:', error?.message || error);
          res.status(500).json({
            ...result,
            success: false,
            error: `Native CLI auth completed, but gateway restart failed: ${error?.message || 'unknown error'}`,
          });
          return;
        }
      }
      res.json(result);
    } catch (error: any) {
      console.error('[NativeCLI] callback error:', error.message);
      res.status(500).json({ success: false, error: error?.message || 'Failed to complete native CLI flow' });
    }
  });

  return router;
}

export default createAiSetupRouter;
