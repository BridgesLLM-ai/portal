import express, { Request, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { z } from 'zod';
import { getAiProviderMeta } from '../config/aiProviders';
import { validateApiKey } from '../services/aiProviderValidator';
import { completeOAuthFlow, getClaudeSetupToken, getOAuthFlowStatus, pasteCodeToClaudeSession, saveClaudeToken, startClaudeSetupTokenFlow, startDeviceCodeFlow, startOAuthFlow } from '../services/oauthFlowManager';
import {
  AUTH_PROFILES_PATH,
  CONFIG_PATH,
  getDefaultModel,
  getFallbackModels,
  getProviderStatuses,
  readAuthProfiles,
  readOpenClawConfig,
} from '../services/openclawConfigManager';
import { listGatewayModels } from '../utils/openclawGatewayRpc';

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
  if (data.model) {
    const providerPrefix = data.model.split('/')[0];
    if (providerPrefix !== data.provider) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'Selected model must belong to the same provider being configured' });
    }
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

function shellEscapeSingleQuotes(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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
  return execFileSync(OPENCLAW_BIN, args, { timeout, encoding: 'utf8' });
}

/**
 * After provider auth, discover all available models and add them as fallbacks
 * so they show up as "configured" in the model switcher.
 */
function registerProviderModels(provider: string) {
  try {
    const output = runOpenClaw(['models', 'list', '--all', '--provider', provider, '--json'], 15000);
    const data = JSON.parse(output);
    const models: string[] = (data.models || []).map((m: any) => m.key || m.id).filter(Boolean);
    if (!models.length) {
      console.log(`[AI-Setup] No models discovered for ${provider}`);
      return;
    }

    // Get currently configured fallbacks to avoid duplicates
    const currentFallbacksRaw = runOpenClaw(['models', 'fallbacks', 'list', '--json'], 10000);
    let currentFallbacks: string[] = [];
    try {
      const parsed = JSON.parse(currentFallbacksRaw);
      currentFallbacks = (parsed.fallbacks || parsed || []).map((f: any) => typeof f === 'string' ? f : f.model || f.id || '').filter(Boolean);
    } catch { /* ignore parse errors */ }

    // Also check what's already default
    const currentDefault = getDefaultModel();

    const toAdd = models.filter((m) => m !== currentDefault && !currentFallbacks.includes(m));
    if (!toAdd.length) {
      console.log(`[AI-Setup] All ${provider} models already configured`);
      return;
    }

    for (const model of toAdd) {
      try {
        runOpenClaw(['models', 'fallbacks', 'add', model], 10000);
        console.log(`[AI-Setup] Added fallback: ${model}`);
      } catch (err: any) {
        console.warn(`[AI-Setup] Failed to add fallback ${model}: ${err.message}`);
      }
    }
    console.log(`[AI-Setup] Registered ${toAdd.length} models for ${provider}`);
  } catch (err: any) {
    console.warn(`[AI-Setup] registerProviderModels(${provider}) failed: ${err.message}`);
  }
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
  try {
    const response = await fetch(`${GATEWAY_HEALTH_URL.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
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

  if (provider === 'anthropic') {
    return [...commonArgs, '--auth-choice', 'token', '--token-provider', 'anthropic', '--token', apiKey];
  }

  if (provider === 'groq') {
    return [...commonArgs, '--auth-choice', 'token', '--token-provider', 'groq', '--token', apiKey];
  }

  if (!meta.onboardKeyFlag) throw new Error(`Provider ${provider} is missing onboard key flag metadata`);
  return [...commonArgs, '--auth-choice', meta.onboardAuthChoice, `--${meta.onboardKeyFlag}`, apiKey];
}

function normalizeModelPayload(models: any[]): any[] {
  return models.map((model) => {
    if (typeof model === 'string') return { id: model, name: model };
    const canonicalId = model.key || model.id || model.model || model.name || '';
    return {
      id: canonicalId,
      name: model.name || model.id || model.model || model.key || '',
      provider: model.provider || model.modelProvider || (typeof canonicalId === 'string' && canonicalId.includes('/') ? canonicalId.split('/')[0] : undefined),
      raw: model,
    };
  }).filter((model) => model.id);
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
      await restartGateway();
      // Register all available models for this provider
      const sessionStatus = getOAuthFlowStatus(parsed.data.sessionId);
      if (sessionStatus?.provider) {
        registerProviderModels(sessionStatus.provider);
      }
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
    const validation = await validateApiKey(provider, apiKey);
    if (!validation.valid) {
      res.status(400).json(validation);
      return;
    }

    try {
      const beforeAuthProfiles = readAuthProfiles();
      const beforeProfileIds = new Set(Object.keys(beforeAuthProfiles.profiles || {}).filter((profileId) => beforeAuthProfiles.profiles?.[profileId]?.provider === provider));

      // shell-escape helper kept per roadmap; execFileSync is used for actual execution.
      shellEscapeSingleQuotes(apiKey);
      runOpenClaw(buildSaveCommand(provider, apiKey), 30000);

      if (setDefault && model) {
        runOpenClaw(['models', 'set', model], 10000);
      }

      await restartGateway();
      registerProviderModels(provider);

      const authProfiles = readAuthProfiles();
      const providerProfileIds = Object.keys(authProfiles.profiles || {}).filter((profileId) => authProfiles.profiles[profileId]?.provider === provider);
      const savedProfileId = providerProfileIds.find((profileId) => !beforeProfileIds.has(profileId))
        || providerProfileIds.find((profileId) => profileId.endsWith(':manual'))
        || providerProfileIds[0];
      if (!savedProfileId) throw new Error('Provider profile was not found after saving credentials');

      res.json({ success: true, profileId: savedProfileId, model: model || null });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to save API key' });
    }
  });

  // ── Claude setup-token flow (automated) ──────────────────────────
  router.post('/claude/start', async (_req: Request, res: Response) => {
    try {
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
      if (result.success) {
        await restartGateway();
        registerProviderModels('anthropic');
      }
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
      if (!result.success || !result.token) {
        res.json(result);
        return;
      }

      // Save the token
      const saveResult = await saveClaudeToken(result.token);
      if (!saveResult.success) {
        res.json(saveResult);
        return;
      }

      // Restart gateway to pick up the new profile
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

      if (setDefault && model) {
        runOpenClaw(['models', 'set', model], 10000);
      }

      await restartGateway();
      registerProviderModels(provider);

      const authProfiles = readAuthProfiles();
      const providerProfileIds = Object.keys(authProfiles.profiles || {}).filter((profileId) => authProfiles.profiles[profileId]?.provider === provider);
      const savedProfileId = providerProfileIds.find((profileId) => !beforeProfileIds.has(profileId))
        || providerProfileIds.find((profileId) => profileId.includes('setup-token'))
        || providerProfileIds[0];
      if (!savedProfileId) throw new Error('Provider profile was not found after saving setup-token');

      res.json({ success: true, profileId: savedProfileId, model: model || null });
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
      runOpenClaw(['models', 'set', parsed.data.model], 10000);
      await restartGateway();
      // Also register all models for this provider (handles auto-completion case)
      const provider = parsed.data.model.split('/')[0];
      if (provider) registerProviderModels(provider);
      res.json({ success: true, model: parsed.data.model });
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
      runOpenClaw(['models', 'fallbacks', 'set', ...parsed.data.fallbacks], 15000);
      await restartGateway();
      res.json({ success: true, fallbacks: parsed.data.fallbacks });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to set fallback models' });
    }
  });

  router.get('/models', async (req: Request, res: Response) => {
    const providerFilter = typeof req.query.provider === 'string' ? req.query.provider : null;

    try {
      const rpcResult = await listGatewayModels();
      if (rpcResult.ok) {
        let models = normalizeModelPayload(rpcResult.models || []);
        if (providerFilter) models = models.filter((model) => model.id.startsWith(`${providerFilter}/`) || model.provider === providerFilter);
        res.json({ models });
        return;
      }

      const cliModels = JSON.parse(runOpenClaw(['models', 'list', '--json'], 15000));
      let models = normalizeModelPayload(Array.isArray(cliModels) ? cliModels : cliModels.models || []);
      if (providerFilter) models = models.filter((model) => model.id.startsWith(`${providerFilter}/`) || model.provider === providerFilter);
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
      const profileIds = Object.keys(authProfiles.profiles || {}).filter((profileId) => authProfiles.profiles[profileId]?.provider === providerId);

      for (const profileId of profileIds) {
        delete authProfiles.profiles[profileId];
        if (authProfiles.usageStats) delete authProfiles.usageStats[profileId];
      }

      const configProfiles = openclawConfig?.auth?.profiles || {};
      for (const [profileId, profile] of Object.entries<any>(configProfiles)) {
        if (profile?.provider === providerId) delete configProfiles[profileId];
      }
      if (openclawConfig?.auth) openclawConfig.auth.profiles = configProfiles;

      const defaultModel = openclawConfig?.agents?.defaults?.model?.primary;
      if (typeof defaultModel === 'string' && defaultModel.startsWith(`${providerId}/`)) {
        if (openclawConfig?.agents?.defaults?.model) {
          delete openclawConfig.agents.defaults.model.primary;
        }
      }

      const fallbacks = openclawConfig?.agents?.defaults?.model?.fallbacks;
      if (Array.isArray(fallbacks)) {
        openclawConfig.agents.defaults.model.fallbacks = fallbacks.filter((model: unknown) => typeof model !== 'string' || !model.startsWith(`${providerId}/`));
      }

      if (typeof authProfiles.version !== 'number') {
        authProfiles.version = 1;
      }
      atomicWriteJson(AUTH_PROFILES_PATH, authProfiles);
      atomicWriteJson(CONFIG_PATH, openclawConfig);
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

  return router;
}

export default createAiSetupRouter;
