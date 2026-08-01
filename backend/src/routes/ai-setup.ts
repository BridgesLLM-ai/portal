import express, { Request, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { createHash } from 'crypto';
import { z } from 'zod';
import {
  getAiProviderMeta,
  getPublicAiProviderCatalog,
  isGuidedSetupAuthTypeAvailable,
} from '../config/aiProviders';
import { validateApiKey } from '../services/aiProviderValidator';
import {
  cancelOAuthFlow,
  beginClaudeSetupTokenFinalization,
  commitClaudeSetupTokenCredential,
  completeNativeCliFlow,
  completeOAuthFlow,
  getClaudeSetupToken,
  getCredentialLifecycleNamespaceForOpenClawProvider,
  getOAuthFlowStatus,
  isClaudeSetupTokenLeaseReleasable,
  finishClaudeSetupTokenFinalization,
  markOAuthFlowFinalized,
  markOAuthFlowFinalizationError,
  markOAuthFlowFinalizationPending,
  markOAuthFlowFinalizationWarning,
  pasteCodeToClaudeSession,
  startClaudeSetupTokenFlow,
  startDeviceCodeFlow,
  startNativeCliFlow,
  startOAuthFlow,
} from '../services/oauthFlowManager';
import {
  AUTH_PROFILES_PATH,
  CONFIG_PATH,
  MODELS_JSON_PATH,
  clearProviderAuthOrder,
  getDefaultModel,
  getFallbackModels,
  getProviderStatusesAsync,
  pinCodexExternalCliAuthProfile,
  pinProviderAuthProfile,
  readAuthProfiles,
  readOpenClawAuthStoreProfilesAsync,
  readOpenClawConfig,
  registerProviderRuntimeModels,
  saveProviderApiKey,
  invalidateOpenClawAuthStoreProfilesCache,
  ProviderApiKeySaveError,
} from '../services/openclawConfigManager';
import { gatewayRpcCall, listGatewayModels } from '../utils/openclawGatewayRpc';
import {
  ensureOpenClawProviderPluginEnabled,
  rollbackOpenClawProviderPluginLease,
  type OpenClawPluginLease,
} from '../services/openclawPluginManager';
import { probeOpenClawAuthProfile } from '../services/openclawAuthProbe';
import { invalidateNativeCliAuthStatus } from '../agents/nativeCliAuth';
import { invalidateAntigravityModelCache, listAntigravityModelsFromCli } from '../agents/antigravityModels';
import { getNativeProviderReadiness, invalidateNativeProviderReadiness } from '../agents/nativeProviderReadiness';
import {
  buildOpenClawCliEnv,
  canonicalizeProviderModelId,
  extractJsonFromCliOutput,
  normalizePortalModelId,
  repairClaudeSubscriptionConfig,
  usesClaudeCliAuthProfile,
} from '../utils/openclawCli';
import {
  claimProviderCredentialRemovalOperationLifecycle,
  claimProviderCredentialWriteLifecycle,
  completeProviderCredentialWriteLifecycle,
  DurableCredentialOperationEnvelopeMismatchError,
  DurableCredentialLifecycleRecoveryRequiredError,
  getProviderCredentialLifecycleRecord,
  parkProviderCredentialRemovalLifecycle,
  releaseProviderCredentialLifecycle,
  resetStuckProviderCredentialLifecycle,
  setProviderCredentialWriteAdmissionBaseline,
  verifyAndReleaseProviderCredentialRemovalLifecycle,
  verifyProviderCredentialWriteCompletionReceipt,
  type ClaimedProviderCredentialLifecycle,
} from '../services/providerCredentialLifecycleLedger';
import { assertOpenClawGatewayAuthorizationFenceReleased } from '../services/openClawGatewayAuthorizationFence';

const providerIdSchema = z.string().min(1).refine((value) => Boolean(getAiProviderMeta(value)), 'Unknown provider');
const guidedApiKeyProviderIdSchema = providerIdSchema.refine(
  (value) => isGuidedSetupAuthTypeAvailable(value, 'api_key'),
  'Portal guided API-key setup is not available for this provider',
);
const validateKeySchema = z.object({
  provider: guidedApiKeyProviderIdSchema,
  apiKey: z.string().min(1).max(500),
});
const saveKeySchema = validateKeySchema.extend({
  setDefault: z.boolean().optional(),
  model: z.string().max(200).optional(),
  operationId: z.string().uuid(),
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
  provider: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/).optional(),
  profileId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).optional(),
});
const saveSetupTokenSchema = z.object({
  provider: z.literal('anthropic'),
  token: z.string().min(1).max(5000),
  setDefault: z.boolean().optional(),
  model: z.string().max(200).optional(),
  operationId: z.string().uuid(),
}).superRefine((data, ctx) => {
  if (data.setDefault && !data.model) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'Model is required when setDefault is true' });
  }
});
const setFallbacksSchema = z.object({
  fallbacks: z.array(z.string().max(200).refine((value) => value.includes('/'), 'Fallback model must include provider prefix')).max(10),
});
const smokeProviderSchema = z.enum(['google-gemini-cli']);
const oauthStartSchema = z.object({
  provider: z.enum(['openai-codex', 'google-gemini-cli', 'qwen-portal', 'xai']),
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
const oauthCancelSchema = z.object({ sessionId: z.string().min(1) });
const removeProviderSchema = z.object({
  operationId: z.string().uuid(),
  confirmationProvider: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
});

const OPENCLAW_BIN = 'openclaw';
const GATEWAY_HEALTH_URL = process.env.OPENCLAW_API_URL || 'http://127.0.0.1:18789';
const PORTAL_OWNED_REMOVABLE_API_KEY_PROVIDERS = new Set([
  'openrouter',
  'mistral',
  'groq',
  'together',
  'deepseek',
]);
const handledNativeCliCompletions = new Set<string>();
const nativeCliCompletionFinalizers = new Map<string, Promise<void>>();
const handledOAuthCompletions = new Set<string>();
const oauthCompletionFinalizers = new Map<string, Promise<void>>();
// Sessions whose finalization has been kicked off in the background from a
// status poll, so repeated polls do not spawn duplicate finalizers.
const oauthFinalizationKickoffs = new Set<string>();

/**
 * Start OAuth finalization (model registration, gateway restart, live probe)
 * in the background and return immediately. Finalization can take tens of
 * seconds; running it inside a status poll made the browser's short request
 * timeout abort with a misleading "server unreachable" error before the real
 * result was ever recorded. Errors are persisted on the session for every
 * provider so the next poll surfaces an honest outcome.
 */
function ensureOAuthFinalizationStarted(status: any): void {
  if (!status?.id || status.status !== 'complete' || !status.createdProfileId) return;
  if (handledOAuthCompletions.has(status.id) || oauthFinalizationKickoffs.has(status.id)) return;
  oauthFinalizationKickoffs.add(status.id);
  markOAuthFlowFinalizationPending(status.id, true);
  void finalizeOAuthCompletion(status)
    .catch((error: any) => {
      // finalizeOAuthCompletion records xAI errors itself; record here for
      // every other provider so a failed finalization is never silent.
      markOAuthFlowFinalizationError(status.id, error?.message || String(error));
      console.error('[AI-Setup] background OAuth finalization failed:', error?.message || error);
    })
    .finally(() => {
      oauthFinalizationKickoffs.delete(status.id);
      markOAuthFlowFinalizationPending(status.id, false);
    });
}
let activeClaudeSetupStart: {
  ownerId: string;
  promise: Promise<{ sessionId: string }>;
  sessionId: string | null;
  releasable: (sessionId: string, ownerId: string) => boolean;
} | null = null;
let activeClaudeSetupCompletion: { sessionId: string; promise: Promise<unknown> } | null = null;
const completedClaudeSetupResults = new Map<string, unknown>();
const OAUTH_FINALIZATION_RETENTION_MS = 15 * 60 * 1000;

interface ActiveXaiSetup {
  token: string;
  kind: 'oauth' | 'api-key';
  lease: OpenClawPluginLease;
  sessionId: string | null;
  ownerId: string | null;
  monitor: NodeJS.Timeout | null;
  finalizing: boolean;
}

let activeXaiSetup: ActiveXaiSetup | null = null;

export class ProviderSetupInProgressError extends Error {
  readonly statusCode = 409;
}

export class ExclusiveProviderOperationGate {
  private active: { token: string; kind: string } | null = null;

  acquire(kind: string): string {
    if (this.active) {
      throw new ProviderSetupInProgressError(
        `Another xAI operation (${this.active.kind}) is already running. Finish it before starting ${kind}.`,
      );
    }
    const token = `${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    this.active = { token, kind };
    return token;
  }

  release(token: string | null | undefined): void {
    if (token && this.active?.token === token) this.active = null;
  }
}

const xaiOperationGate = new ExclusiveProviderOperationGate();

function beginXaiSetup(kind: ActiveXaiSetup['kind'], ownerId?: string): ActiveXaiSetup {
  const token = xaiOperationGate.acquire(kind);
  try {
    const setup: ActiveXaiSetup = {
      token,
      kind,
      lease: ensureOpenClawProviderPluginEnabled('xai', 'xai'),
      sessionId: null,
      ownerId: ownerId || null,
      monitor: null,
      finalizing: false,
    };
    activeXaiSetup = setup;
    return setup;
  } catch (error) {
    xaiOperationGate.release(token);
    throw error;
  }
}

// Explicit operator recovery: drop any in-process xAI setup gate and its
// monitor so a stuck lifecycle reset is not blocked by stale in-memory state.
// The xAI plugin stays enabled so the operator's retry can proceed.
function forceReleaseActiveXaiSetup(): void {
  const setup = activeXaiSetup;
  if (!setup) return;
  if (setup.monitor) {
    clearInterval(setup.monitor);
    setup.monitor = null;
  }
  xaiOperationGate.release(setup.token);
  if (activeXaiSetup?.token === setup.token) activeXaiSetup = null;
}

function bindXaiOAuthSession(setup: ActiveXaiSetup, sessionId: string): void {
  if (activeXaiSetup?.token !== setup.token) {
    throw new Error('xAI setup ownership changed before the OAuth session was created.');
  }
  setup.sessionId = sessionId;
  setup.monitor = setInterval(() => {
    if (activeXaiSetup?.token !== setup.token) {
      if (setup.monitor) clearInterval(setup.monitor);
      setup.monitor = null;
      return;
    }
    try {
      const status = getOAuthFlowStatus(sessionId, setup.ownerId || undefined);
      if (status?.createdProfileId && status.status === 'complete') {
        if (!setup.finalizing) {
          setup.finalizing = true;
          void finalizeOAuthCompletion(status).catch((error: any) => {
            console.error('[AI-Setup] background xAI finalization failed:', error?.message || error);
          }).finally(() => {
            if (activeXaiSetup?.token === setup.token) setup.finalizing = false;
          });
        }
      } else if (status?.createdProfileId && status.status === 'error') {
        commitXaiSetup(setup);
      } else if (!status || (['cancelled', 'expired', 'error'].includes(status.status) && !status.cleanupPending)) {
        rollbackXaiSetup(setup);
      }
    } catch (error: any) {
      console.error('[AI-Setup] xAI setup lifecycle reconciliation failed:', error?.message || error);
    }
  }, 2_000);
  setup.monitor.unref?.();
}

function commitXaiSetup(setup: ActiveXaiSetup | null | undefined): void {
  if (setup?.monitor) clearInterval(setup.monitor);
  if (setup) setup.monitor = null;
  if (setup && activeXaiSetup?.token === setup.token) activeXaiSetup = null;
  if (setup) xaiOperationGate.release(setup.token);
}

function commitXaiOAuthSession(sessionId: string): void {
  if (activeXaiSetup?.kind === 'oauth' && activeXaiSetup.sessionId === sessionId) {
    commitXaiSetup(activeXaiSetup);
  }
}

function rollbackXaiSetup(setup: ActiveXaiSetup | null | undefined): void {
  if (!setup || activeXaiSetup?.token !== setup.token) return;
  try {
    if (setup.monitor) clearInterval(setup.monitor);
    setup.monitor = null;
    rollbackOpenClawProviderPluginLease(setup.lease);
  } finally {
    activeXaiSetup = null;
    xaiOperationGate.release(setup.token);
  }
}

function rollbackXaiOAuthSession(sessionId: string): void {
  if (activeXaiSetup?.kind === 'oauth' && activeXaiSetup.sessionId === sessionId) {
    rollbackXaiSetup(activeXaiSetup);
  }
}

export function getOAuthRequestOwnerId(req: Pick<Request, 'user'>): string {
  return req.user?.userId ? `user:${req.user.userId}` : 'setup:pending';
}

function oauthStartFailurePayload(error: any, fallback: string): Record<string, unknown> {
  const sessionId = error?.oauthSessionId || error?.sessionId;
  return {
    success: false,
    error: error?.message || fallback,
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(sessionId ? { sessionId: String(sessionId) } : {}),
    ...(error?.cleanupPending ? { cleanupPending: true } : {}),
    ...(error?.credentialState ? { credentialState: error.credentialState } : {}),
  };
}

function providerSetupErrorStatus(error: any): number {
  const status = Number(error?.statusCode);
  return status === 400 || status === 409 || status === 503 ? status : 500;
}

function credentialOperationWasNotAdmitted(error: unknown, options: {
  claim: ClaimedProviderCredentialLifecycle | null;
  disposition: 'admitted' | 'recovered' | 'completed' | null;
  mutationStarted: boolean;
}): boolean {
  return error instanceof DurableCredentialOperationEnvelopeMismatchError
    && options.claim === null && options.disposition === null && !options.mutationStarted;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readJsonStrictIfPresent(targetPath: string): Record<string, any> {
  try {
    const raw = fs.readFileSync(targetPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root value is not an object');
    }
    return parsed as Record<string, any>;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Credential inventory ${path.basename(targetPath)} is unreadable: ${error?.message || error}`);
  }
}

export function providerCredentialAliases(providerId: string, authProviderId: string): Set<string> {
  const aliases = new Set([providerId, authProviderId]
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean));
  if (aliases.has('anthropic') || aliases.has('claude-cli')) {
    aliases.add('anthropic');
    aliases.add('claude-cli');
  }
  if (aliases.has('openai') || aliases.has('openai-codex') || aliases.has('codex') || aliases.has('codex-cli')) {
    aliases.add('openai');
    aliases.add('openai-codex');
    aliases.add('codex');
    aliases.add('codex-cli');
  }
  if (aliases.has('google') || aliases.has('google-gemini-cli') || aliases.has('gemini')) {
    aliases.add('google');
    aliases.add('google-gemini-cli');
    aliases.add('gemini');
  }
  return aliases;
}

export interface ProviderRemovalCapability {
  supported: boolean;
  code: 'PORTAL_OWNED_API_KEY' | 'UNSUPPORTED_CREDENTIAL_SURFACE';
  reason: string;
  requiresExactConfirmation: true;
}

export function getProviderRemovalCapability(providerId: string): ProviderRemovalCapability {
  const normalizedProvider = String(providerId || '').trim().toLowerCase();
  if (PORTAL_OWNED_REMOVABLE_API_KEY_PROVIDERS.has(normalizedProvider)) {
    return {
      supported: true,
      code: 'PORTAL_OWNED_API_KEY',
      reason: 'Portal can disconnect this exact Portal-owned API-key profile after a live credential and routing preflight.',
      requiresExactConfirmation: true,
    };
  }
  return {
    supported: false,
    code: 'UNSUPPORTED_CREDENTIAL_SURFACE',
    reason: 'Disconnect is unavailable because this provider may use OAuth, native CLI, environment, shared-alias, plugin, local-service, or externally managed credentials that OpenClaw 2026.7.1 cannot remove with an exact-provider transaction.',
    requiresExactConfirmation: true,
  };
}

export function removeProviderCredentialRoutingReferences(
  openclawConfig: Record<string, any>,
  aliases: Set<string>,
): void {
  const belongsToAlias = (modelId: unknown): boolean => typeof modelId === 'string'
    && [...aliases].some((alias) => modelId.trim().toLowerCase().startsWith(`${alias}/`));
  const authOrder = openclawConfig?.auth?.order;
  if (authOrder && typeof authOrder === 'object' && !Array.isArray(authOrder)) {
    for (const provider of Object.keys(authOrder)) {
      if (aliases.has(provider.trim().toLowerCase())) delete authOrder[provider];
    }
  }
  const modelDefaults = openclawConfig?.agents?.defaults?.model;
  if (typeof modelDefaults === 'string' && belongsToAlias(modelDefaults)) {
    delete openclawConfig.agents.defaults.model;
  } else if (modelDefaults && belongsToAlias(modelDefaults.primary)) {
    delete modelDefaults.primary;
  }
  if (modelDefaults && typeof modelDefaults === 'object' && Array.isArray(modelDefaults.fallbacks)) {
    modelDefaults.fallbacks = modelDefaults.fallbacks.filter((model: unknown) => !belongsToAlias(model));
  }
  const modelRegistry = openclawConfig?.agents?.defaults?.models;
  if (modelRegistry && typeof modelRegistry === 'object' && !Array.isArray(modelRegistry)) {
    for (const modelId of Object.keys(modelRegistry)) {
      if (belongsToAlias(modelId)) delete modelRegistry[modelId];
    }
  }
  const compaction = openclawConfig?.agents?.defaults?.compaction;
  if (compaction && belongsToAlias(compaction.model)) delete compaction.model;
  if (compaction && providerBelongsToCredentialAliases(compaction.provider, aliases)) {
    delete compaction.provider;
  }
  if (compaction?.memoryFlush && belongsToAlias(compaction.memoryFlush.model)) {
    delete compaction.memoryFlush.model;
  }
  const heartbeat = openclawConfig?.agents?.defaults?.heartbeat;
  if (heartbeat && belongsToAlias(heartbeat.model)) delete heartbeat.model;
}

function providerEntryContainsCredential(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const candidate = entry as Record<string, unknown>;
  return ['apiKey', 'key', 'token', 'access', 'refresh'].some((field) => (
    canonicalCredentialMaterial(candidate[field]) !== null
  ));
}

type CanonicalCredentialMaterial =
  | { kind: 'inline'; digest: string }
  | { kind: 'secret-ref'; source: 'env' | 'file' | 'exec'; provider: string; id: string }
  | { kind: 'opaque-present'; shape: string };

function canonicalCredentialMaterial(value: unknown): CanonicalCredentialMaterial | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    return { kind: 'inline', digest: createHash('sha256').update(value).digest('hex') };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if ((candidate.source === 'env' || candidate.source === 'file' || candidate.source === 'exec')
      && typeof candidate.provider === 'string' && candidate.provider.trim()
      && typeof candidate.id === 'string' && candidate.id.trim()) {
      return {
        kind: 'secret-ref',
        source: candidate.source,
        provider: candidate.provider.trim(),
        id: candidate.id.trim(),
      };
    }
    // Credential fields are security-sensitive discriminated unions. An
    // unrecognized non-null value is still credential presence; treating it
    // as absent could authorize destructive removal of a future SecretRef
    // representation this Portal version does not understand.
    return { kind: 'opaque-present', shape: 'object' };
  }
  return { kind: 'opaque-present', shape: Array.isArray(value) ? 'array' : typeof value };
}

export function credentialEntryProofSummary(entry: unknown): {
  present: boolean;
  externallyManaged: boolean;
  unknownShape: boolean;
  fingerprint: string;
} {
  const candidate = entry && typeof entry === 'object' && !Array.isArray(entry)
    ? entry as Record<string, unknown>
    : {};
  const material = ['apiKey', 'key', 'token', 'access', 'refresh']
    .map((field) => [field, canonicalCredentialMaterial(candidate[field])] as const);
  const values = material.map(([, value]) => value).filter((value): value is CanonicalCredentialMaterial => value !== null);
  return {
    present: values.length > 0,
    externallyManaged: values.some((value) => value.kind === 'secret-ref'),
    unknownShape: values.some((value) => value.kind === 'opaque-present'),
    fingerprint: createHash('sha256').update(JSON.stringify({
      provider: typeof candidate.provider === 'string' ? candidate.provider : null,
      type: typeof candidate.type === 'string' ? candidate.type : null,
      material,
      expires: typeof candidate.expires === 'number' ? candidate.expires : null,
      accountId: typeof candidate.accountId === 'string' ? candidate.accountId : null,
      email: typeof candidate.email === 'string' ? candidate.email : null,
      managedBy: typeof candidate.managedBy === 'string' ? candidate.managedBy : null,
    })).digest('hex'),
  };
}

function credentialMaterialFingerprint(entry: unknown): string {
  return credentialEntryProofSummary(entry).fingerprint;
}

export function providerCredentialEnvironmentVariables(providerId: string, authProviderId: string): string[] {
  const aliases = providerCredentialAliases(providerId, authProviderId);
  const names = new Set<string>();
  if (aliases.has('anthropic') || aliases.has('claude-cli')) {
    names.add('ANTHROPIC_API_KEY');
    names.add('ANTHROPIC_OAUTH_TOKEN');
    names.add('CLAUDE_CODE_OAUTH_TOKEN');
  }
  if (aliases.has('openai') || aliases.has('openai-codex') || aliases.has('codex') || aliases.has('codex-cli')) {
    names.add('CODEX_API_KEY');
    names.add('OPENAI_API_KEY');
  }
  if (aliases.has('google') || aliases.has('google-gemini-cli') || aliases.has('gemini')) {
    names.add('GEMINI_API_KEY');
    names.add('GOOGLE_API_KEY');
  }
  if (aliases.has('xai')) names.add('XAI_API_KEY');
  if (aliases.has('openrouter')) names.add('OPENROUTER_API_KEY');
  if (aliases.has('mistral')) names.add('MISTRAL_API_KEY');
  if (aliases.has('groq')) names.add('GROQ_API_KEY');
  if (aliases.has('together')) names.add('TOGETHER_API_KEY');
  if (aliases.has('deepseek')) names.add('DEEPSEEK_API_KEY');
  if (aliases.has('opencode')) {
    names.add('OPENCODE_API_KEY');
    names.add('OPENCODE_ZEN_API_KEY');
  }
  if (aliases.has('amazon-bedrock')) {
    names.add('AWS_ACCESS_KEY_ID');
    names.add('AWS_BEARER_TOKEN_BEDROCK');
    names.add('AWS_CONTAINER_CREDENTIALS_FULL_URI');
    names.add('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI');
    names.add('AWS_PROFILE');
    names.add('AWS_SECRET_ACCESS_KEY');
    names.add('AWS_SESSION_TOKEN');
    names.add('AWS_SHARED_CREDENTIALS_FILE');
    names.add('AWS_WEB_IDENTITY_TOKEN_FILE');
  }
  return [...names].sort();
}

export function presentProviderCredentialEnvironmentVariables(
  providerId: string,
  authProviderId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  return providerCredentialEnvironmentVariables(providerId, authProviderId)
    .filter((name) => typeof environment[name] === 'string' && Boolean(environment[name]!.trim()));
}

function readProcessStartTicks(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = raw.lastIndexOf(')');
    const fields = commandEnd >= 0 ? raw.slice(commandEnd + 1).trim().split(/\s+/) : [];
    return /^\d+$/.test(fields[19] || '') ? fields[19] : null;
  } catch {
    return null;
  }
}

function readSystemdGatewayMainPid(): number | null {
  if (!fs.existsSync('/run/systemd/system') || !fs.existsSync('/usr/bin/systemctl')) return null;
  try {
    const output = execFileSync(
      '/usr/bin/systemctl',
      ['show', 'openclaw-gateway.service', '--property=MainPID', '--value'],
      {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    const pid = Number.parseInt(output, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Environment credentials outlive JSON deletion and can be inherited by a
 * restarted gateway. Read only matching variable names—never their values—
 * from the exact systemd-owned gateway process, with PID-reuse attestation.
 */
function presentGatewayProviderCredentialEnvironmentVariables(
  providerId: string,
  authProviderId: string,
): string[] {
  const names = providerCredentialEnvironmentVariables(providerId, authProviderId);
  const present = new Set(presentProviderCredentialEnvironmentVariables(providerId, authProviderId));
  const pid = readSystemdGatewayMainPid();
  if (!pid) {
    throw new ProviderRemovalPreflightBlockedError(
      'Portal could not attest the OpenClaw gateway process environment.',
    );
  }
  const beforeTicks = readProcessStartTicks(pid);
  if (!beforeTicks) {
    throw new ProviderRemovalPreflightBlockedError(
      'Portal could not attest the OpenClaw gateway process identity.',
    );
  }
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    if (!/openclaw/i.test(command) || !/\bgateway\b/i.test(command)) {
      throw new Error('systemd MainPID is not the OpenClaw gateway');
    }
    const environment = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    for (const name of names) {
      if (environment.some((entry) => entry.startsWith(`${name}=`) && entry.length > name.length + 1)) {
        present.add(name);
      }
    }
  } catch {
    throw new ProviderRemovalPreflightBlockedError(
      'Portal could not attest the OpenClaw gateway process environment.',
    );
  }
  if (readProcessStartTicks(pid) !== beforeTicks) {
    throw new ProviderRemovalPreflightBlockedError(
      'The OpenClaw gateway changed while Portal was attesting its environment.',
    );
  }
  return [...present].sort();
}

type ProviderRemovalBlockerCode =
  | 'unsupported-provider'
  | 'authoritative-profile'
  | 'unexpected-profile'
  | 'credential-mismatch'
  | 'authoritative-oauth'
  | 'authoritative-non-oauth'
  | 'authoritative-unknown'
  | 'legacy-profile'
  | 'config-credential'
  | 'models-credential'
  | 'environment-credential'
  | 'unsupported-routing-reference'
  | 'malformed-inventory';

export interface RcSafeProviderRemovalInventory {
  aliases: Set<string>;
  authoritativeProfiles: Record<string, any>;
  legacyAuthProfiles: Record<string, any>;
  config: Record<string, any>;
  models: Record<string, any>;
  environmentCredentials: string[];
}

export interface RcSafeProviderRemovalPreflight {
  allowed: boolean;
  blockers: ProviderRemovalBlockerCode[];
  authStoreProviders: string[];
}

export interface ProviderRemovalConfigPatchPlan {
  patch: Record<string, any>;
  replacePaths: string[];
  changed: boolean;
}

interface GatewayConfigSnapshot {
  config: Record<string, any>;
  hash: string;
}

export class ProviderRemovalPreflightBlockedError extends Error {
  readonly statusCode = 409;
  readonly code = 'PROVIDER_REMOVAL_PREFLIGHT_BLOCKED';
}

class ProviderRemovalControlPlaneUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'PROVIDER_REMOVAL_CONTROL_PLANE_UNAVAILABLE';
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBlockedProviderRemovalObjectKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function modelBelongsToCredentialAliases(modelId: unknown, aliases: Set<string>): boolean {
  return typeof modelId === 'string'
    && [...aliases].some((alias) => modelId.trim().toLowerCase().startsWith(`${alias}/`));
}

function providerBelongsToCredentialAliases(providerId: unknown, aliases: Set<string>): boolean {
  return typeof providerId === 'string' && aliases.has(providerId.trim().toLowerCase());
}

function isRcCleanableProviderRoutingPath(pathParts: Array<string | number>): boolean {
  const path = pathParts.join('.');
  return path === 'agents.defaults.model'
    || path === 'agents.defaults.model.primary'
    || /^agents\.defaults\.model\.fallbacks\.\d+$/.test(path)
    || path === 'agents.defaults.compaction.model'
    || path === 'agents.defaults.compaction.memoryFlush.model'
    || path === 'agents.defaults.heartbeat.model';
}

function unsupportedProviderRoutingReferences(
  config: Record<string, any>,
  aliases: Set<string>,
): string[] {
  const references = new Set<string>();
  const visit = (value: unknown, pathParts: Array<string | number>): void => {
    if (typeof value === 'string') {
      if (modelBelongsToCredentialAliases(value, aliases) && !isRcCleanableProviderRoutingPath(pathParts)) {
        references.add(pathParts.join('.'));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...pathParts, index]));
      return;
    }
    if (!isPlainRecord(value)) return;
    const recordPath = pathParts.join('.');
    if (providerBelongsToCredentialAliases(value.provider, aliases)
      && recordPath !== 'agents.defaults.compaction') {
      references.add(`${recordPath || '<root>'}.provider`);
    }
    for (const [key, entry] of Object.entries(value)) {
      const keyPath = [...pathParts, key];
      const parentPath = pathParts.join('.');
      if ((parentPath === 'models.providers' || parentPath === 'auth.order')
        && providerBelongsToCredentialAliases(key, aliases)) {
        continue;
      }
      if (parentPath === 'auth.profiles'
        && isPlainRecord(entry) && providerBelongsToCredentialAliases(entry.provider, aliases)) {
        continue;
      }
      if (parentPath === 'agents.defaults.models' && modelBelongsToCredentialAliases(key, aliases)) {
        continue;
      }
      if (providerBelongsToCredentialAliases(key, aliases)) {
        references.add(`${keyPath.join('.')}#provider-key`);
      }
      if (modelBelongsToCredentialAliases(key, aliases)
        && parentPath !== 'agents.defaults.models') {
        references.add(`${keyPath.join('.')}#key`);
      }
      visit(entry, keyPath);
    }
  };
  visit(config, []);
  return [...references].sort();
}

function providerAuthOrderProfileReferences(
  order: Record<string, any>,
  targetProfileIds: Set<string>,
  aliases: Set<string>,
): string[] {
  const references = new Set<string>();
  for (const [orderProvider, profileIds] of Object.entries(order)) {
    if (!Array.isArray(profileIds)) continue;
    for (const profileId of profileIds) {
      if (typeof profileId !== 'string') continue;
      const normalizedProfileId = profileId.trim().toLowerCase();
      const belongsToAlias = [...aliases].some((alias) => normalizedProfileId.startsWith(`${alias}:`));
      if (!providerBelongsToCredentialAliases(orderProvider, aliases)
        && (targetProfileIds.has(profileId) || belongsToAlias)) {
        references.add(`${orderProvider}:${profileId}`);
      }
    }
  }
  return [...references].sort();
}

function isSafeProviderOAuthMarker(value: unknown, aliases: Set<string>): boolean {
  if (typeof value !== 'string') return false;
  const match = /^oauth:([a-z0-9-]+)$/i.exec(value.trim());
  return Boolean(match && aliases.has(match[1].toLowerCase()));
}

function providerRemovalEntryBlockers(
  entry: unknown,
  aliases: Set<string>,
): { credential: boolean; unknown: boolean } {
  if (!isPlainRecord(entry)) return { credential: entry !== undefined, unknown: entry !== undefined };
  let credential = false;
  let unknown = false;
  const includeCredentialMaterial = (value: unknown): void => {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return;
    const material = canonicalCredentialMaterial(value);
    credential = credential || material !== null;
    unknown = unknown || material?.kind === 'opaque-present';
  };
  const includeHeaderMap = (headers: unknown): void => {
    if (headers === null || headers === undefined) return;
    if (!isPlainRecord(headers)) {
      credential = true;
      unknown = true;
      return;
    }
    for (const value of Object.values(headers)) includeCredentialMaterial(value);
  };
  for (const field of ['apiKey', 'key', 'token', 'access', 'refresh']) {
    const value = entry[field];
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) continue;
    if (field === 'apiKey' && isSafeProviderOAuthMarker(value, aliases)) continue;
    includeCredentialMaterial(value);
  }
  includeHeaderMap(entry.headers);

  if (entry.baseUrl !== null && entry.baseUrl !== undefined) {
    if (typeof entry.baseUrl !== 'string') {
      credential = true;
      unknown = true;
    } else {
      try {
        const url = new URL(entry.baseUrl);
        if (url.username || url.password) credential = true;
      } catch {
        credential = true;
        unknown = true;
      }
    }
  }
  if (entry.auth !== null && entry.auth !== undefined
    && (typeof entry.auth !== 'string' || entry.auth === 'aws-sdk')) {
    credential = true;
    unknown = true;
  }

  if (entry.localService !== null && entry.localService !== undefined) {
    // Commands, arguments, and environment values are arbitrary. Portal
    // cannot prove that a plugin-specific local-service field is credential-free.
    credential = true;
    unknown = true;
  }

  if (entry.params !== null && entry.params !== undefined
    && (!isPlainRecord(entry.params) || Object.keys(entry.params).length > 0)) {
    credential = true;
    unknown = true;
  }

  if (entry.request !== null && entry.request !== undefined) {
    if (!isPlainRecord(entry.request)) {
      credential = true;
      unknown = true;
    } else {
      includeHeaderMap(entry.request.headers);
      const knownRequestFields = new Set(['allowPrivateNetwork', 'headers', 'auth', 'proxy', 'tls']);
      if (Object.entries(entry.request).some(([field, value]) => (
        !knownRequestFields.has(field) && value !== null && value !== undefined
      ))) {
        credential = true;
        unknown = true;
      }
      const requestAuth = entry.request.auth;
      if (requestAuth !== null && requestAuth !== undefined) {
        if (!isPlainRecord(requestAuth) || typeof requestAuth.mode !== 'string') {
          credential = true;
          unknown = true;
        } else if (requestAuth.mode === 'provider-default') {
          const unexpectedFields = Object.keys(requestAuth).filter((field) => field !== 'mode');
          if (unexpectedFields.length > 0) {
            credential = true;
            unknown = true;
          }
        } else if (requestAuth.mode === 'authorization-bearer') {
          includeCredentialMaterial(requestAuth.token);
          if (requestAuth.token === null || requestAuth.token === undefined) unknown = true;
        } else if (requestAuth.mode === 'header') {
          includeCredentialMaterial(requestAuth.value);
          if (requestAuth.value === null || requestAuth.value === undefined) unknown = true;
        } else {
          credential = true;
          unknown = true;
        }
      }
      // Proxy/TLS configuration may carry URL userinfo, private keys,
      // passphrases, or SecretRefs. Treat the entire optional lane as
      // credential-bearing until Portal has an exact schema-bound proof.
      if (entry.request.proxy !== null && entry.request.proxy !== undefined) credential = true;
      if (entry.request.tls !== null && entry.request.tls !== undefined) credential = true;
    }
  }

  const knownEntryFields = new Set([
    'provider', 'type', 'mode', 'authType', 'email', 'displayName', 'expires', 'expiresAt', 'expiry',
    'accountId', 'managedBy', 'apiKey', 'key', 'token', 'access', 'refresh',
    'baseUrl', 'auth', 'api', 'contextWindow', 'contextTokens', 'maxTokens', 'timeoutSeconds',
    'region', 'injectNumCtxForOpenAICompat', 'params', 'agentRuntime', 'localService', 'headers',
    'authHeader', 'request', 'models',
  ]);
  if (Object.entries(entry).some(([field, value]) => (
    !knownEntryFields.has(field) && value !== null && value !== undefined
  ))) {
    credential = true;
    unknown = true;
  }
  return { credential, unknown };
}

function readObjectMap(
  parent: Record<string, any>,
  key: string,
  blockers: Set<ProviderRemovalBlockerCode>,
): Record<string, any> {
  const value = parent[key];
  if (value === undefined || value === null) return {};
  if (!isPlainRecord(value)) {
    blockers.add('malformed-inventory');
    return {};
  }
  if (Object.keys(value).some(isBlockedProviderRemovalObjectKey)) {
    blockers.add('malformed-inventory');
    return {};
  }
  return value;
}

function validateRemovalConfigShape(
  config: Record<string, any>,
  blockers: Set<ProviderRemovalBlockerCode>,
): void {
  const auth = readObjectMap(config, 'auth', blockers);
  readObjectMap(auth, 'profiles', blockers);
  const order = readObjectMap(auth, 'order', blockers);
  if (Object.values(order).some((profileIds) => !Array.isArray(profileIds)
    || profileIds.some((profileId: unknown) => typeof profileId !== 'string'))) {
    blockers.add('malformed-inventory');
  }
  const models = readObjectMap(config, 'models', blockers);
  readObjectMap(models, 'providers', blockers);
  const agents = readObjectMap(config, 'agents', blockers);
  const defaults = readObjectMap(agents, 'defaults', blockers);
  const modelValue = defaults.model;
  const model = typeof modelValue === 'string' ? {} : readObjectMap(defaults, 'model', blockers);
  if (model.primary !== undefined && model.primary !== null && typeof model.primary !== 'string') {
    blockers.add('malformed-inventory');
  }
  if (model.fallbacks !== undefined && (!Array.isArray(model.fallbacks)
    || model.fallbacks.some((entry: unknown) => typeof entry !== 'string'))) {
    blockers.add('malformed-inventory');
  }
  readObjectMap(defaults, 'models', blockers);
  const compaction = readObjectMap(defaults, 'compaction', blockers);
  if (compaction.provider !== undefined && compaction.provider !== null
    && typeof compaction.provider !== 'string') {
    blockers.add('malformed-inventory');
  }
  if (compaction.model !== undefined && compaction.model !== null && typeof compaction.model !== 'string') {
    blockers.add('malformed-inventory');
  }
  const memoryFlush = readObjectMap(compaction, 'memoryFlush', blockers);
  if (memoryFlush.model !== undefined && memoryFlush.model !== null && typeof memoryFlush.model !== 'string') {
    blockers.add('malformed-inventory');
  }
  const heartbeat = readObjectMap(defaults, 'heartbeat', blockers);
  if (heartbeat.model !== undefined && heartbeat.model !== null && typeof heartbeat.model !== 'string') {
    blockers.add('malformed-inventory');
  }
}

export function classifyRcSafeProviderRemoval(
  inventory: RcSafeProviderRemovalInventory,
): RcSafeProviderRemovalPreflight {
  const blockers = new Set<ProviderRemovalBlockerCode>();
  const authStoreProviders = new Set<string>();
  const { aliases } = inventory;

  if (!isPlainRecord(inventory.authoritativeProfiles)
    || !isPlainRecord(inventory.legacyAuthProfiles)
    || !isPlainRecord(inventory.config)
    || !isPlainRecord(inventory.models)) {
    blockers.add('malformed-inventory');
  }

  for (const profile of Object.values(inventory.authoritativeProfiles || {})) {
    if (!isPlainRecord(profile) || typeof profile.provider !== 'string') {
      blockers.add('malformed-inventory');
      continue;
    }
    if (!providerBelongsToCredentialAliases(profile.provider, aliases)) continue;
    if (profile.type !== 'oauth') {
      blockers.add('authoritative-non-oauth');
      continue;
    }
    if (profile.managedBy !== 'openclaw-auth-store') {
      blockers.add('authoritative-unknown');
      continue;
    }
    const summary = credentialEntryProofSummary(profile);
    if (summary.externallyManaged || summary.unknownShape) {
      blockers.add('authoritative-unknown');
      continue;
    }
    authStoreProviders.add(profile.provider);
    // OpenClaw 2026.7.1 exposes only provider-wide logout. Without an
    // exact-profile compare-and-swap primitive, even a well-formed OAuth row
    // cannot be removed safely in the presence of an external writer.
    blockers.add('authoritative-oauth');
  }

  const legacyProfilesValue = inventory.legacyAuthProfiles?.profiles;
  if (legacyProfilesValue === undefined) {
    if (Object.keys(inventory.legacyAuthProfiles || {}).some((key) => key !== 'version')) {
      blockers.add('malformed-inventory');
    }
  } else if (!isPlainRecord(legacyProfilesValue)) {
    blockers.add('malformed-inventory');
  } else {
    for (const profile of Object.values(legacyProfilesValue)) {
      if (!isPlainRecord(profile) || typeof profile.provider !== 'string') {
        blockers.add('malformed-inventory');
        continue;
      }
      if (providerBelongsToCredentialAliases(profile.provider, aliases)) blockers.add('legacy-profile');
    }
  }

  validateRemovalConfigShape(inventory.config, blockers);
  const configAuth = isPlainRecord(inventory.config.auth) ? inventory.config.auth : {};
  const configProfiles = isPlainRecord(configAuth.profiles) ? configAuth.profiles : {};
  const targetConfigProfileIds = new Set<string>();
  for (const [profileId, profile] of Object.entries(configProfiles)) {
    if (!isPlainRecord(profile) || typeof profile.provider !== 'string') {
      blockers.add('malformed-inventory');
      continue;
    }
    if (!providerBelongsToCredentialAliases(profile.provider, aliases)) continue;
    targetConfigProfileIds.add(profileId);
    const summary = providerRemovalEntryBlockers(profile, aliases);
    if (summary.credential) blockers.add('config-credential');
    if (summary.unknown) blockers.add('malformed-inventory');
  }
  const configOrder = isPlainRecord(configAuth.order) ? configAuth.order : {};
  if (providerAuthOrderProfileReferences(configOrder, targetConfigProfileIds, aliases).length > 0) {
    blockers.add('unsupported-routing-reference');
  }
  if (unsupportedProviderRoutingReferences(inventory.config, aliases).length > 0) {
    blockers.add('unsupported-routing-reference');
  }
  const configModels = isPlainRecord(inventory.config.models) ? inventory.config.models : {};
  const configProviders = isPlainRecord(configModels.providers) ? configModels.providers : {};
  for (const [provider, entry] of Object.entries(configProviders)) {
    if (!isPlainRecord(entry)) {
      blockers.add('malformed-inventory');
      continue;
    }
    if (!providerBelongsToCredentialAliases(provider, aliases)) continue;
    const summary = providerRemovalEntryBlockers(entry, aliases);
    if (summary.credential) blockers.add('config-credential');
    if (summary.unknown) blockers.add('malformed-inventory');
  }

  const modelProvidersValue = inventory.models?.providers;
  if (modelProvidersValue === undefined) {
    if (Object.keys(inventory.models || {}).length > 0) blockers.add('malformed-inventory');
  } else if (!isPlainRecord(modelProvidersValue)) {
    blockers.add('malformed-inventory');
  } else {
    for (const [provider, entry] of Object.entries(modelProvidersValue)) {
      if (!isPlainRecord(entry)) {
        blockers.add('malformed-inventory');
        continue;
      }
      if (!providerBelongsToCredentialAliases(provider, aliases)) continue;
      const summary = providerRemovalEntryBlockers(entry, aliases);
      if (summary.credential) blockers.add('models-credential');
      if (summary.unknown) blockers.add('malformed-inventory');
    }
  }

  if (inventory.environmentCredentials.length > 0) blockers.add('environment-credential');
  return {
    allowed: blockers.size === 0,
    blockers: [...blockers].sort(),
    authStoreProviders: [...authStoreProviders].sort(),
  };
}

export interface PortalOwnedApiKeyRemovalPreflight extends RcSafeProviderRemovalPreflight {
  portalCredentialPresent: boolean;
}

function inlineCredentialDigest(value: unknown): string | null {
  const material = canonicalCredentialMaterial(value);
  return material?.kind === 'inline' ? material.digest : null;
}

function containsNestedCredentialMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsNestedCredentialMaterial);
  if (!isPlainRecord(value)) return false;
  const credentialFields = new Set([
    'apikey', 'key', 'token', 'access', 'refresh', 'secret', 'password',
    'authorization', 'credential', 'credentials', 'clientsecret', 'privatekey', 'headers',
  ]);
  return Object.entries(value).some(([field, entry]) => {
    const normalizedField = field.replace(/[-_]/g, '').toLowerCase();
    if (credentialFields.has(normalizedField)
      && entry !== null && entry !== undefined
      && !(typeof entry === 'string' && !entry.trim())
      && !(isPlainRecord(entry) && Object.keys(entry).length === 0)) {
      return true;
    }
    return containsNestedCredentialMaterial(entry);
  });
}

function exactPortalApiKeyProfileDigest(
  profileId: string,
  profile: unknown,
  providerId: string,
): string | null {
  if (profileId !== `${providerId}:default` || !isPlainRecord(profile)) return null;
  if (profile.provider !== providerId || profile.type !== 'api_key') return null;
  if (Object.keys(profile).some((field) => !['type', 'provider', 'key'].includes(field))) return null;
  return inlineCredentialDigest(profile.key);
}

/**
 * Removal support is intentionally narrower than setup support. These providers
 * are written by Portal to fixed JSON targets with a single, provider-unique
 * namespace. Shared OpenAI/Google/Anthropic aliases, xAI's locked store, OAuth,
 * native CLI, Agent Zero, AWS, and manual/plugin surfaces remain fail-closed.
 */
export function classifyPortalOwnedApiKeyRemoval(
  providerId: string,
  inventory: RcSafeProviderRemovalInventory,
): PortalOwnedApiKeyRemovalPreflight {
  const provider = String(providerId || '').trim().toLowerCase();
  const blockers = new Set<ProviderRemovalBlockerCode>();
  const authStoreProviders = new Set<string>();
  let authProfileDigest: string | null = null;
  let modelsProviderDigest: string | null = null;

  if (!PORTAL_OWNED_REMOVABLE_API_KEY_PROVIDERS.has(provider)
    || inventory.aliases.size !== 1 || !inventory.aliases.has(provider)) {
    blockers.add('unsupported-provider');
  }
  if (!isPlainRecord(inventory.authoritativeProfiles)
    || !isPlainRecord(inventory.legacyAuthProfiles)
    || !isPlainRecord(inventory.config)
    || !isPlainRecord(inventory.models)) {
    blockers.add('malformed-inventory');
  }

  for (const profile of Object.values(inventory.authoritativeProfiles || {})) {
    if (!isPlainRecord(profile) || typeof profile.provider !== 'string') {
      blockers.add('malformed-inventory');
      continue;
    }
    if (profile.provider.trim().toLowerCase() !== provider) continue;
    authStoreProviders.add(provider);
    blockers.add('authoritative-profile');
  }

  const legacyProfiles = inventory.legacyAuthProfiles?.profiles;
  if (legacyProfiles !== undefined && !isPlainRecord(legacyProfiles)) {
    blockers.add('malformed-inventory');
  } else {
    for (const [profileId, profile] of Object.entries(legacyProfiles || {})) {
      if (!isPlainRecord(profile) || typeof profile.provider !== 'string') {
        blockers.add('malformed-inventory');
        continue;
      }
      if (profile.provider.trim().toLowerCase() !== provider) continue;
      const digest = exactPortalApiKeyProfileDigest(profileId, profile, provider);
      if (!digest) {
        blockers.add('unexpected-profile');
      } else {
        authProfileDigest = digest;
      }
    }
  }

  validateRemovalConfigShape(inventory.config, blockers);
  const configAuth = isPlainRecord(inventory.config.auth) ? inventory.config.auth : {};
  const configProfiles = isPlainRecord(configAuth.profiles) ? configAuth.profiles : {};
  const targetConfigProfileIds = new Set<string>();
  for (const [profileId, profile] of Object.entries(configProfiles)) {
    if (!isPlainRecord(profile) || typeof profile.provider !== 'string') {
      blockers.add('malformed-inventory');
      continue;
    }
    if (profile.provider.trim().toLowerCase() !== provider) continue;
    targetConfigProfileIds.add(profileId);
    const authModes = [profile.mode, profile.type].filter((value) => value !== undefined);
    const exactProfile = profileId === `${provider}:default`
      && profile.provider === provider
      && authModes.length > 0
      && authModes.every((value) => value === 'api_key')
      && Object.keys(profile).every((field) => ['provider', 'mode', 'type'].includes(field));
    if (!exactProfile || providerEntryContainsCredential(profile)) blockers.add('unexpected-profile');
  }
  const configOrder = isPlainRecord(configAuth.order) ? configAuth.order : {};
  if (providerAuthOrderProfileReferences(configOrder, targetConfigProfileIds, inventory.aliases).length > 0) {
    blockers.add('unsupported-routing-reference');
  }
  if (unsupportedProviderRoutingReferences(inventory.config, inventory.aliases).length > 0) {
    blockers.add('unsupported-routing-reference');
  }

  const configModels = isPlainRecord(inventory.config.models) ? inventory.config.models : {};
  const configProviders = isPlainRecord(configModels.providers) ? configModels.providers : {};
  for (const [providerKey, configProviderEntry] of Object.entries(configProviders)) {
    if (providerKey.trim().toLowerCase() !== provider) continue;
    if (providerKey !== provider) blockers.add('unexpected-profile');
    if (!isPlainRecord(configProviderEntry)) {
      blockers.add('malformed-inventory');
    } else {
      const summary = providerRemovalEntryBlockers(configProviderEntry, inventory.aliases);
      if (summary.credential || summary.unknown || providerEntryContainsCredential(configProviderEntry)
        || containsNestedCredentialMaterial(configProviderEntry)) {
        blockers.add('config-credential');
      }
    }
  }

  const modelProviders = inventory.models?.providers;
  if (modelProviders !== undefined && !isPlainRecord(modelProviders)) {
    blockers.add('malformed-inventory');
  } else {
    for (const [providerKey, modelEntry] of Object.entries(modelProviders || {})) {
      if (providerKey.trim().toLowerCase() !== provider) continue;
      if (providerKey !== provider) blockers.add('unexpected-profile');
      if (!isPlainRecord(modelEntry)) {
        blockers.add('malformed-inventory');
      } else {
        const apiKeyDigest = inlineCredentialDigest(modelEntry.apiKey);
        if (modelEntry.apiKey !== undefined && !apiKeyDigest) blockers.add('models-credential');
        const credentialFreeEntry = { ...modelEntry };
        delete credentialFreeEntry.apiKey;
        const summary = providerRemovalEntryBlockers(credentialFreeEntry, inventory.aliases);
        if (summary.credential || summary.unknown || containsNestedCredentialMaterial(credentialFreeEntry)) {
          blockers.add('models-credential');
        }
        modelsProviderDigest = apiKeyDigest;
      }
    }
  }

  if (authProfileDigest && modelsProviderDigest && authProfileDigest !== modelsProviderDigest) {
    blockers.add('credential-mismatch');
  }
  if (inventory.environmentCredentials.length > 0) blockers.add('environment-credential');

  return {
    allowed: blockers.size === 0,
    blockers: [...blockers].sort(),
    authStoreProviders: [...authStoreProviders].sort(),
    portalCredentialPresent: Boolean(authProfileDigest || modelsProviderDigest),
  };
}

export function buildProviderRemovalConfigPatch(
  config: Record<string, any>,
  aliases: Set<string>,
): ProviderRemovalConfigPatchPlan {
  const shapeBlockers = new Set<ProviderRemovalBlockerCode>();
  validateRemovalConfigShape(config, shapeBlockers);
  if (shapeBlockers.size > 0) {
    throw new ProviderRemovalPreflightBlockedError(
      'OpenClaw returned a malformed configuration inventory. Portal refused provider removal.',
    );
  }

  const patch: Record<string, any> = {};
  const replacePaths: string[] = [];
  const authPatch: Record<string, any> = {};
  const configAuth = isPlainRecord(config.auth) ? config.auth : {};
  const configProfiles = isPlainRecord(configAuth.profiles) ? configAuth.profiles : {};
  const profilePatch: Record<string, null> = {};
  for (const [profileId, profile] of Object.entries(configProfiles)) {
    if (isPlainRecord(profile) && providerBelongsToCredentialAliases(profile.provider, aliases)) {
      profilePatch[profileId] = null;
    }
  }
  if (Object.keys(profilePatch).length > 0) authPatch.profiles = profilePatch;
  const order = isPlainRecord(configAuth.order) ? configAuth.order : {};
  const orderPatch: Record<string, null> = {};
  for (const provider of Object.keys(order)) {
    if (providerBelongsToCredentialAliases(provider, aliases)) orderPatch[provider] = null;
  }
  if (Object.keys(orderPatch).length > 0) authPatch.order = orderPatch;
  if (Object.keys(authPatch).length > 0) patch.auth = authPatch;

  const configModels = isPlainRecord(config.models) ? config.models : {};
  const providers = isPlainRecord(configModels.providers) ? configModels.providers : {};
  const providerPatch: Record<string, null> = {};
  for (const provider of Object.keys(providers)) {
    if (providerBelongsToCredentialAliases(provider, aliases)) providerPatch[provider] = null;
  }
  if (Object.keys(providerPatch).length > 0) patch.models = { providers: providerPatch };

  const agents = isPlainRecord(config.agents) ? config.agents : {};
  const defaults = isPlainRecord(agents.defaults) ? agents.defaults : {};
  const defaultsPatch: Record<string, any> = {};
  if (typeof defaults.model === 'string') {
    if (modelBelongsToCredentialAliases(defaults.model, aliases)) defaultsPatch.model = null;
  } else {
    const model = isPlainRecord(defaults.model) ? defaults.model : {};
    const modelPatch: Record<string, any> = {};
    if (modelBelongsToCredentialAliases(model.primary, aliases)) modelPatch.primary = null;
    if (Array.isArray(model.fallbacks)) {
      const filtered = model.fallbacks.filter((entry: unknown) => !modelBelongsToCredentialAliases(entry, aliases));
      if (filtered.length !== model.fallbacks.length) {
        modelPatch.fallbacks = filtered;
        replacePaths.push('agents.defaults.model.fallbacks');
      }
    }
    if (Object.keys(modelPatch).length > 0) defaultsPatch.model = modelPatch;
  }
  const modelRegistry = isPlainRecord(defaults.models) ? defaults.models : {};
  const modelRegistryPatch: Record<string, null> = {};
  for (const modelId of Object.keys(modelRegistry)) {
    if (modelBelongsToCredentialAliases(modelId, aliases)) modelRegistryPatch[modelId] = null;
  }
  if (Object.keys(modelRegistryPatch).length > 0) defaultsPatch.models = modelRegistryPatch;
  const compaction = isPlainRecord(defaults.compaction) ? defaults.compaction : {};
  const compactionPatch: Record<string, any> = {};
  if (modelBelongsToCredentialAliases(compaction.model, aliases)) compactionPatch.model = null;
  if (providerBelongsToCredentialAliases(compaction.provider, aliases)) compactionPatch.provider = null;
  const memoryFlush = isPlainRecord(compaction.memoryFlush) ? compaction.memoryFlush : {};
  if (modelBelongsToCredentialAliases(memoryFlush.model, aliases)) {
    compactionPatch.memoryFlush = { model: null };
  }
  if (Object.keys(compactionPatch).length > 0) defaultsPatch.compaction = compactionPatch;
  const heartbeat = isPlainRecord(defaults.heartbeat) ? defaults.heartbeat : {};
  if (modelBelongsToCredentialAliases(heartbeat.model, aliases)) {
    defaultsPatch.heartbeat = { model: null };
  }
  if (Object.keys(defaultsPatch).length > 0) patch.agents = { defaults: defaultsPatch };

  return { patch, replacePaths, changed: Object.keys(patch).length > 0 };
}

async function readGatewayConfigSnapshot(
  rpc: typeof gatewayRpcCall = gatewayRpcCall,
): Promise<GatewayConfigSnapshot> {
  const response = await rpc('config.get', {}, 15_000);
  if (!response.ok) {
    throw new ProviderRemovalControlPlaneUnavailableError(
      `OpenClaw config.get failed: ${String(response.error || 'gateway control plane unavailable')}`,
    );
  }
  const config = response.data?.config ?? response.data?.parsed;
  const hash = String(response.data?.hash || '').trim();
  if (!isPlainRecord(config) || !hash) {
    throw new ProviderRemovalPreflightBlockedError(
      'OpenClaw returned an incomplete configuration snapshot. Portal refused provider removal.',
    );
  }
  return { config, hash };
}

export function providerRemovalUsesUnverifiableCredentialSurface(authTypes: readonly string[]): boolean {
  return authTypes.some((authType) => authType === 'native_cli' || authType === 'aws_sdk');
}

export function shouldParkProviderRemovalFailure(
  claim: ClaimedProviderCredentialLifecycle,
  mutationStarted: boolean,
): boolean {
  return mutationStarted || claim.resumed === true;
}

function isConfigBaseHashConflict(error: unknown): boolean {
  return /config changed since last load|base hash/i.test(String(error || ''));
}

export async function applyProviderRemovalConfigPatch(options: {
  aliases: Set<string>;
  initialSnapshot: GatewayConfigSnapshot;
  assertLease: () => void;
  revalidate: (snapshot: GatewayConfigSnapshot) => Promise<void>;
  rpc?: typeof gatewayRpcCall;
  maxAttempts?: number;
}): Promise<{ patched: boolean; responseData?: any }> {
  const rpc = options.rpc || gatewayRpcCall;
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? 3));
  let snapshot = options.initialSnapshot;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    options.assertLease();
    await options.revalidate(snapshot);
    const plan = buildProviderRemovalConfigPatch(snapshot.config, options.aliases);
    if (!plan.changed) return { patched: false };
    const response = await rpc('config.patch', {
      raw: JSON.stringify(plan.patch),
      baseHash: snapshot.hash,
      ...(plan.replacePaths.length > 0 ? { replacePaths: plan.replacePaths } : {}),
    }, 20_000);
    if (response.ok) return { patched: true, responseData: response.data };
    if (!isConfigBaseHashConflict(response.error) || attempt + 1 >= maxAttempts) {
      throw new ProviderRemovalControlPlaneUnavailableError(
        `OpenClaw config.patch failed: ${String(response.error || 'gateway control plane unavailable')}`,
      );
    }
    snapshot = await readGatewayConfigSnapshot(rpc);
  }
  throw new ProviderRemovalControlPlaneUnavailableError('OpenClaw config.patch retry budget was exhausted.');
}

async function readOpenClawAndPortalCredentialProof(
  providerId: string,
  authProviderId: string,
): Promise<{
  fingerprint: string;
  absent: boolean;
  externallyManaged: boolean;
  unknownCredentialShape: boolean;
}> {
  invalidateOpenClawAuthStoreProfilesCache();
  const aliases = providerCredentialAliases(providerId, authProviderId);
  const allOpenClawProfiles = await readOpenClawAuthStoreProfilesAsync(undefined, { strict: true });
  const openClawProfiles = Object.fromEntries(
    Object.entries(allOpenClawProfiles)
      .filter(([, profile]) => providerBelongsToCredentialAliases(profile?.provider, aliases)),
  );
  const authProfiles = readJsonStrictIfPresent(AUTH_PROFILES_PATH);
  const config = readJsonStrictIfPresent(CONFIG_PATH);
  const models = readJsonStrictIfPresent(MODELS_JSON_PATH);
  const portalAuthProfiles = Object.entries<any>(authProfiles.profiles || {})
    .filter(([, profile]) => providerBelongsToCredentialAliases(profile?.provider, aliases))
    .map(([profileId, profile]) => [profileId, credentialMaterialFingerprint(profile)])
    .sort(([left], [right]) => left.localeCompare(right));
  const configAuthProfiles = Object.entries<any>(config?.auth?.profiles || {})
    .filter(([, profile]) => providerBelongsToCredentialAliases(profile?.provider, aliases))
    .map(([profileId, profile]) => [profileId, credentialMaterialFingerprint(profile)])
    .sort(([left], [right]) => left.localeCompare(right));
  const configCredentialProviders = [...aliases]
    .filter((alias) => providerEntryContainsCredential(config?.models?.providers?.[alias]))
    .sort()
    .map((alias) => [alias, credentialMaterialFingerprint(config.models.providers[alias])]);
  const modelCredentialProviders = [...aliases]
    .filter((alias) => providerEntryContainsCredential(models?.providers?.[alias]))
    .sort()
    .map((alias) => [alias, credentialMaterialFingerprint(models.providers[alias])]);
  const proofEntries = [
    ...Object.values(openClawProfiles),
    ...Object.values<any>(authProfiles.profiles || {})
      .filter((profile) => providerBelongsToCredentialAliases(profile?.provider, aliases)),
    ...Object.values<any>(config?.auth?.profiles || {})
      .filter((profile) => providerBelongsToCredentialAliases(profile?.provider, aliases)),
    ...[...aliases].map((alias) => config?.models?.providers?.[alias]).filter((entry) => entry !== undefined),
    ...[...aliases].map((alias) => models?.providers?.[alias]).filter((entry) => entry !== undefined),
  ];
  const proofEntrySummaries = proofEntries.map(credentialEntryProofSummary);
  const environmentCredentials = presentProviderCredentialEnvironmentVariables(providerId, authProviderId);
  const state = {
    openClawProfiles: Object.entries(openClawProfiles)
      .map(([profileId, profile]) => [profileId, credentialMaterialFingerprint(profile)])
      .sort(([left], [right]) => left.localeCompare(right)),
    portalAuthProfiles,
    configAuthProfiles,
    configCredentialProviders,
    modelCredentialProviders,
    environmentCredentials,
  };
  return {
    fingerprint: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
    absent: Object.values(state).every((entries) => entries.length === 0),
    externallyManaged: environmentCredentials.length > 0
      || proofEntrySummaries.some((summary) => summary.externallyManaged),
    unknownCredentialShape: proofEntrySummaries.some((summary) => summary.unknownShape),
  };
}

async function readPortalOwnedApiKeyRemovalInventory(
  providerId: string,
  gatewaySnapshot: GatewayConfigSnapshot,
): Promise<RcSafeProviderRemovalInventory> {
  invalidateOpenClawAuthStoreProfilesCache();
  return {
    aliases: new Set([providerId]),
    authoritativeProfiles: await readOpenClawAuthStoreProfilesAsync(undefined, { strict: true }),
    legacyAuthProfiles: readJsonStrictIfPresent(AUTH_PROFILES_PATH),
    config: gatewaySnapshot.config,
    models: readJsonStrictIfPresent(MODELS_JSON_PATH),
    environmentCredentials: presentGatewayProviderCredentialEnvironmentVariables(providerId, providerId),
  };
}

function parseSnapshotJson(snapshot: FileSnapshot): Record<string, any> {
  if (!snapshot.existed) return {};
  try {
    const parsed = JSON.parse((snapshot.contents || Buffer.alloc(0)).toString('utf8'));
    if (!isPlainRecord(parsed)) throw new Error('root value is not an object');
    return parsed;
  } catch (error: any) {
    throw new ProviderRemovalPreflightBlockedError(
      `Portal-owned ${path.basename(snapshot.targetPath)} is malformed: ${error?.message || 'invalid JSON'}`,
    );
  }
}

export function buildPortalOwnedProviderFileRemoval(
  providerId: string,
  authProfilesDocument: Record<string, any>,
  modelsDocument: Record<string, any>,
): {
  authProfiles: Record<string, any>;
  models: Record<string, any>;
  changedAuthProfiles: boolean;
  changedModels: boolean;
} {
  const provider = String(providerId || '').trim().toLowerCase();
  if (!PORTAL_OWNED_REMOVABLE_API_KEY_PROVIDERS.has(provider)) {
    throw new ProviderRemovalPreflightBlockedError('This provider does not use Portal-owned removable API-key files.');
  }
  const authProfiles = JSON.parse(JSON.stringify(authProfilesDocument || {}));
  const models = JSON.parse(JSON.stringify(modelsDocument || {}));
  const profileId = `${provider}:default`;
  let changedAuthProfiles = false;
  let changedModels = false;

  if (authProfiles.profiles !== undefined && !isPlainRecord(authProfiles.profiles)) {
    throw new ProviderRemovalPreflightBlockedError('Portal auth profile inventory is malformed.');
  }
  if (authProfiles.profiles?.[profileId] !== undefined) {
    delete authProfiles.profiles[profileId];
    changedAuthProfiles = true;
  }
  if (authProfiles.usageStats !== undefined && !isPlainRecord(authProfiles.usageStats)) {
    throw new ProviderRemovalPreflightBlockedError('Portal auth usage inventory is malformed.');
  }
  if (authProfiles.usageStats?.[profileId] !== undefined) {
    delete authProfiles.usageStats[profileId];
    changedAuthProfiles = true;
  }
  if (authProfiles.lastGood !== undefined && !isPlainRecord(authProfiles.lastGood)) {
    throw new ProviderRemovalPreflightBlockedError('Portal last-good credential inventory is malformed.');
  }
  for (const [lastGoodProvider, lastGoodProfileId] of Object.entries(authProfiles.lastGood || {})) {
    if (lastGoodProvider === provider || lastGoodProfileId === profileId) {
      delete authProfiles.lastGood[lastGoodProvider];
      changedAuthProfiles = true;
    }
  }

  if (models.providers !== undefined && !isPlainRecord(models.providers)) {
    throw new ProviderRemovalPreflightBlockedError('Portal model-provider inventory is malformed.');
  }
  if (models.providers?.[provider] !== undefined) {
    delete models.providers[provider];
    changedModels = true;
  }

  return { authProfiles, models, changedAuthProfiles, changedModels };
}

function expectedJsonFileSnapshot(
  targetPath: string,
  data: Record<string, any>,
): FileSnapshot {
  return {
    targetPath,
    existed: true,
    contents: Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8'),
    mode: 0o600,
  };
}

export function applyPortalOwnedProviderFileRemoval(
  providerId: string,
  options: {
    authProfilesPath?: string;
    modelsPath?: string;
    writer?: (targetPath: string, data: Record<string, any>) => void;
  } = {},
): {
  changed: boolean;
  before: FileSnapshot[];
  after: FileSnapshot[];
} {
  const authProfilesPath = options.authProfilesPath || AUTH_PROFILES_PATH;
  const modelsPath = options.modelsPath || MODELS_JSON_PATH;
  const writer = options.writer || atomicWriteJson;
  const before = [
    captureFileSnapshot(authProfilesPath),
    captureFileSnapshot(modelsPath),
  ];
  if (!before.every(fileSnapshotMatchesCurrent)) {
    throw new DurableCredentialLifecycleRecoveryRequiredError(
      'Portal-owned provider files changed before the removal transaction could begin.',
    );
  }
  const plan = buildPortalOwnedProviderFileRemoval(
    providerId,
    parseSnapshotJson(before[0]),
    parseSnapshotJson(before[1]),
  );
  const after = [...before];
  const writtenBefore: FileSnapshot[] = [];
  const writtenExpected: FileSnapshot[] = [];

  try {
    if (plan.changedAuthProfiles) {
      if (!fileSnapshotMatchesCurrent(before[0])) {
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'Portal auth profiles changed during provider removal.',
        );
      }
      const expected = expectedJsonFileSnapshot(authProfilesPath, plan.authProfiles);
      writer(authProfilesPath, plan.authProfiles);
      writtenBefore.push(before[0]);
      writtenExpected.push(expected);
      after[0] = expected;
      if (!fileSnapshotMatchesCurrent(expected)) {
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'Portal could not verify the exact auth-profile removal write.',
        );
      }
    }
    if (plan.changedModels) {
      if (!fileSnapshotMatchesCurrent(before[1])) {
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'Portal model providers changed during provider removal.',
        );
      }
      const expected = expectedJsonFileSnapshot(modelsPath, plan.models);
      writer(modelsPath, plan.models);
      writtenBefore.push(before[1]);
      writtenExpected.push(expected);
      after[1] = expected;
      if (!fileSnapshotMatchesCurrent(expected)) {
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'Portal could not verify the exact model-provider removal write.',
        );
      }
    }
  } catch (error) {
    if (writtenBefore.length > 0) {
      restoreSnapshotsWithCompareAndSwap(writtenBefore, writtenExpected);
    }
    throw error;
  }

  return {
    changed: plan.changedAuthProfiles || plan.changedModels,
    before,
    after,
  };
}

async function readPortalOwnedProviderRemovalProof(providerId: string): Promise<{
  fingerprint: string;
  absent: boolean;
}> {
  invalidateOpenClawAuthStoreProfilesCache();
  const aliases = new Set([providerId]);
  const authoritativeProfiles = await readOpenClawAuthStoreProfilesAsync(undefined, { strict: true });
  const authProfiles = readJsonStrictIfPresent(AUTH_PROFILES_PATH);
  const models = readJsonStrictIfPresent(MODELS_JSON_PATH);
  const gatewaySnapshot = await readGatewayConfigSnapshot();
  const config = gatewaySnapshot.config;
  const targetProfileIds = new Set<string>();
  const targetAuthoritativeProfiles = Object.entries(authoritativeProfiles)
    .filter(([, profile]) => profileBelongsToCredentialAliases(profile?.provider, aliases));
  const targetPortalProfiles = Object.entries<any>(authProfiles.profiles || {})
    .filter(([profileId, profile]) => {
      const matches = providerBelongsToCredentialAliases(profile?.provider, aliases);
      if (matches) targetProfileIds.add(profileId);
      return matches;
    });
  const targetConfigProfiles = Object.entries<any>(config?.auth?.profiles || {})
    .filter(([profileId, profile]) => {
      const matches = providerBelongsToCredentialAliases(profile?.provider, aliases);
      if (matches) targetProfileIds.add(profileId);
      return matches;
    });
  const configOrderReferences = Object.entries<any>(config?.auth?.order || {})
    .filter(([orderProvider, profileIds]) => (
      providerBelongsToCredentialAliases(orderProvider, aliases)
      || (Array.isArray(profileIds) && profileIds.some((profileId) => targetProfileIds.has(profileId)))
    ));
  const configProviderEntries = Object.entries<any>(config?.models?.providers || {})
    .filter(([provider]) => providerBelongsToCredentialAliases(provider, aliases));
  const modelProviderEntries = Object.entries<any>(models?.providers || {})
    .filter(([provider]) => providerBelongsToCredentialAliases(provider, aliases));
  const routingPatch = buildProviderRemovalConfigPatch(config, aliases);
  const unsupportedRouting = unsupportedProviderRoutingReferences(config, aliases);
  const environmentCredentials = presentGatewayProviderCredentialEnvironmentVariables(providerId, providerId);
  const state = {
    targetAuthoritativeProfiles,
    targetPortalProfiles,
    targetConfigProfiles,
    configOrderReferences,
    configProviderEntries,
    modelProviderEntries,
    routingPatch: routingPatch.patch,
    unsupportedRouting,
    environmentCredentials,
  };
  return {
    fingerprint: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
    absent: targetAuthoritativeProfiles.length === 0
      && targetPortalProfiles.length === 0
      && targetConfigProfiles.length === 0
      && configOrderReferences.length === 0
      && configProviderEntries.length === 0
      && modelProviderEntries.length === 0
      && !routingPatch.changed
      && unsupportedRouting.length === 0
      && environmentCredentials.length === 0,
  };
}

function profileBelongsToCredentialAliases(providerId: unknown, aliases: Set<string>): boolean {
  return providerBelongsToCredentialAliases(providerId, aliases);
}

function assertProviderRemovalLease(claim: ClaimedProviderCredentialLifecycle): void {
  const record = getProviderCredentialLifecycleRecord(claim.namespace);
  if (!record || record.leaseId !== claim.leaseId || record.state !== 'active') {
    throw new DurableCredentialLifecycleRecoveryRequiredError(
      'Provider removal ownership changed. The credential domain remains locked for recovery.',
    );
  }
}

export function credentialWriteRequestFingerprint(input: {
  provider: string;
  secret: string;
  setDefault: boolean;
  model: string | null;
}): string {
  return createHash('sha256').update(JSON.stringify({
    provider: input.provider,
    secretDigest: createHash('sha256').update(input.secret).digest('hex'),
    setDefault: input.setDefault,
    model: input.model,
  })).digest('hex');
}

function credentialWriteResultFingerprint(
  result: Record<string, unknown>,
  credentialFingerprint: string,
): string {
  return createHash('sha256').update(JSON.stringify({ result, credentialFingerprint })).digest('hex');
}

export async function readStableCredentialWriteProof<T extends { fingerprint: string; absent: boolean }>(
  reader: () => Promise<T>,
  options: { stableReads?: number; delay?: (milliseconds: number) => Promise<unknown>; intervalMs?: number } = {},
): Promise<T> {
  const stableReads = Math.max(2, options.stableReads ?? 3);
  const delay = options.delay || sleep;
  const intervalMs = Math.max(1, options.intervalMs ?? 100);
  let previous: T | null = null;
  for (let index = 0; index < stableReads; index += 1) {
    const current = await reader();
    if (!current.fingerprint || (previous && (
      previous.fingerprint !== current.fingerprint || previous.absent !== current.absent
    ))) {
      throw new DurableCredentialLifecycleRecoveryRequiredError(
        'The provider credential inventory was unstable during credential-write readback.',
      );
    }
    previous = current;
    if (index + 1 < stableReads) await delay(intervalMs);
  }
  return previous!;
}

async function expectedProviderCredentialPresent(
  providerId: string,
  authProviderId: string,
  profileId: string,
): Promise<boolean> {
  const aliases = providerCredentialAliases(providerId, authProviderId);
  if (providerId === 'xai') {
    invalidateOpenClawAuthStoreProfilesCache();
    const profiles = await readOpenClawAuthStoreProfilesAsync(undefined, { strict: true });
    const profile = profiles[profileId];
    return Boolean(profile && providerBelongsToCredentialAliases(profile.provider, aliases));
  }
  const authProfiles = readJsonStrictIfPresent(AUTH_PROFILES_PATH);
  const profile = authProfiles?.profiles?.[profileId];
  return Boolean(profile
    && providerBelongsToCredentialAliases(profile.provider, aliases)
    && providerEntryContainsCredential(profile));
}

export function portalCredentialProfileContainsSubmittedSecret(
  profile: unknown,
  providerId: string,
  submittedSecret: string,
): boolean {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;
  const candidate = profile as Record<string, unknown>;
  if (candidate.provider !== providerId) return false;
  if (candidate.type === 'api_key') {
    return candidate.key === submittedSecret || candidate.apiKey === submittedSecret;
  }
  if (candidate.type === 'token') return candidate.token === submittedSecret;
  return false;
}

function portalCredentialTargetContainsSubmittedSecret(
  providerId: string,
  profileId: string,
  submittedSecret: string,
): boolean {
  const authProfiles = readJsonStrictIfPresent(AUTH_PROFILES_PATH);
  return portalCredentialProfileContainsSubmittedSecret(
    authProfiles?.profiles?.[profileId],
    providerId,
    submittedSecret,
  );
}

function atomicWriteJson(targetPath: string, data: unknown) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, targetPath);
}

export interface FileSnapshot {
  targetPath: string;
  existed: boolean;
  contents: Buffer | null;
  mode: number;
}

export function captureFileSnapshot(targetPath: string): FileSnapshot {
  if (!fs.existsSync(targetPath)) {
    return { targetPath, existed: false, contents: null, mode: 0o600 };
  }
  const stat = fs.statSync(targetPath);
  return {
    targetPath,
    existed: true,
    contents: fs.readFileSync(targetPath),
    mode: stat.mode & 0o777,
  };
}

function restoreFileSnapshot(snapshot: FileSnapshot): void {
  if (!snapshot.existed) {
    if (fs.existsSync(snapshot.targetPath)) fs.unlinkSync(snapshot.targetPath);
    return;
  }
  const dir = path.dirname(snapshot.targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(snapshot.targetPath)}.${process.pid}.${Date.now()}.rollback.tmp`);
  fs.writeFileSync(tempPath, snapshot.contents || Buffer.alloc(0), { mode: snapshot.mode });
  fs.renameSync(tempPath, snapshot.targetPath);
}

function fileSnapshotMatchesCurrent(snapshot: FileSnapshot): boolean {
  const exists = fs.existsSync(snapshot.targetPath);
  if (exists !== snapshot.existed) return false;
  if (!exists) return true;
  const current = fs.readFileSync(snapshot.targetPath);
  return Boolean(snapshot.contents && current.equals(snapshot.contents));
}

export function restoreSnapshotsWithCompareAndSwap(before: FileSnapshot[], expectedCurrent: FileSnapshot[]): void {
  if (before.length !== expectedCurrent.length || !expectedCurrent.every(fileSnapshotMatchesCurrent)) {
    throw new Error('OpenClaw configuration changed concurrently; Portal refused to overwrite the newer configuration during rollback.');
  }
  for (const snapshot of before) restoreFileSnapshot(snapshot);
}

export function getExpectedXaiProbeModel(provider: string, setDefault: boolean | undefined, model: string): string | undefined {
  return provider === 'xai' && setDefault && model ? model : undefined;
}

/**
 * The live model probe is advisory everywhere a credential is already
 * committed: the probe executes a real turn through OpenClaw's default-agent
 * routing, which can fail for environmental reasons (a project sandbox owning
 * default routing, docker hiccups) while the credential itself works — proven
 * by direct main-agent turns. A probe failure therefore yields a user-facing
 * warning, never a rollback of an otherwise valid configuration.
 */
function runAdvisoryAuthProbe(
  provider: string,
  profileId: string,
  probeTimeoutMs: number,
  expectedModel?: string,
): string | null {
  try {
    probeOpenClawAuthProfile(provider, profileId, probeTimeoutMs, expectedModel);
    return null;
  } catch (probeError: any) {
    const message = probeError?.message || 'The live model probe was inconclusive.';
    console.warn(`[AI-Setup] advisory ${provider} model probe failed:`, message);
    return `${message} The configuration was saved anyway; if the model does not respond in chat, review the provider account.`;
  }
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

export function runOpenClawWithSecretInput(args: string[], secret: string, timeout = 30000): void {
  try {
    execFileSync(OPENCLAW_BIN, args, {
      timeout,
      env: buildOpenClawCliEnv(),
      input: `${secret}\n`,
      stdio: ['pipe', 'ignore', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
  } catch {
    // Never forward child output here: an interactive CLI may echo stdin on a
    // failure path, and the setup-token must not escape into logs or errors.
    throw new Error('OpenClaw did not accept the setup-token. The credential domain remains locked for safe retry.');
  }
}

const PROVIDER_MODEL_DISCOVERY_FALLBACKS: Record<string, string[]> = {
  anthropic: [
    'anthropic/claude-fable-5',
    'anthropic/claude-opus-5',
    'anthropic/claude-opus-4-8',
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-haiku-4-5',
  ],
  'openai-codex': [
    'openai/gpt-5.6-sol',
    'openai/gpt-5.6-terra',
    'openai/gpt-5.6-luna',
    'openai/gpt-5.5',
  ],
  'google-gemini-cli': [
    'google/gemini-3.1-pro-preview',
    'google/gemini-3-flash-preview',
    'google/gemini-3.1-flash-lite',
  ],
  'google-antigravity': [
    'google-antigravity/gemini-3.5-flash',
    'google-antigravity/gemini-3.5-flash-high',
    'google-antigravity/gemini-3.5-flash-low',
    'google-antigravity/gemini-3.1-pro-high',
    'google-antigravity/gemini-3.1-pro-low',
  ],
  xai: [
    'xai/grok-4.5',
    'xai/grok-build-0.1',
    'xai/grok-4.3',
    'xai/grok-4.20-beta-latest-reasoning',
    'xai/grok-4.20-beta-latest-non-reasoning',
  ],
};

const DEFAULT_ONLY_MODEL_DISCOVERY_PROVIDERS = new Set([
  'anthropic',
  'openai-codex',
  'codex',
  'google-gemini-cli',
]);


const PROVIDER_MODEL_PREFIX_ALIASES: Record<string, string[]> = {
  'google-gemini-cli': ['google-gemini-cli', 'google'],
  'google-antigravity': ['google-antigravity', 'google'],
  google: ['google', 'google-gemini-cli'],
  'openai-codex': ['openai-codex', 'codex', 'openai'],
  codex: ['codex', 'openai-codex', 'openai'],
  openai: ['openai', 'openai-codex', 'codex'],
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
    case 'google-antigravity':
      return candidate.startsWith('gemini-');
    case 'openai':
    case 'openai-codex':
    case 'codex':
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

    if ((provider === 'google' || provider === 'google-gemini-cli' || provider === 'google-antigravity' || provider === 'openai' || provider === 'openai-codex' || provider === 'codex' || provider === 'anthropic') && remainder.includes('/')) {
      return false;
    }

    return true;
  }

  return false;
}

export function resolveModelRegistrationProvider(
  normalizedModel: string,
  requestedProvider: string | null | undefined,
  configuredModels: Record<string, any> | null | undefined,
): string {
  const explicitProvider = String(requestedProvider || '').trim();
  if (explicitProvider) return explicitProvider;

  const configuredEntry = configuredModels && typeof configuredModels === 'object'
    ? (configuredModels[normalizedModel]
      || Object.entries<any>(configuredModels).find(([modelId]) => normalizePortalModelId(modelId) === normalizedModel)?.[1])
    : null;

  return String(configuredEntry?.agentRuntime?.id || '').trim() === 'google-gemini-cli'
    ? 'google-gemini-cli'
    : normalizedModel.split('/')[0];
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

function repairProviderModelRuntimeMetadata(config: any, provider: string, authProfilesForRuntime = readAuthProfiles()): boolean {
  const models = config?.agents?.defaults?.models;
  if (!models || typeof models !== 'object') return false;

  let changed = false;
  if (provider !== 'openai-codex'
    && provider !== 'codex'
    && provider !== 'anthropic'
    && provider !== 'google-gemini-cli'
    && provider !== 'google') return changed;

  for (const [modelId, rawEntry] of Object.entries(models) as Array<[string, any]>) {
    let entry = rawEntry;
    let effectiveModelId = modelId;

    // OpenClaw 2026.7.1 makes openai/* the canonical Codex-runtime route. Move
    // legacy provider keys onto canonical declarations while preserving GPT-5.5
    // as the compatibility choice for workspaces without GPT-5.6 access.
    if ((provider === 'openai-codex' || provider === 'codex')
      && (modelId.startsWith('openai/') || modelId.startsWith('openai-codex/') || modelId.startsWith('codex/'))) {
      effectiveModelId = canonicalizeDiscoveredProviderModelId(provider, modelId);
    }
    if (provider === 'google-gemini-cli'
      && (modelId.startsWith('google/') || modelId.startsWith('google-gemini-cli/'))) {
      effectiveModelId = canonicalizeDiscoveredProviderModelId(provider, modelId);
    }
    if (effectiveModelId && effectiveModelId !== modelId) {
      models[effectiveModelId] = {
        ...(models[effectiveModelId] && typeof models[effectiveModelId] === 'object' ? models[effectiveModelId] : {}),
        ...(entry && typeof entry === 'object' ? entry : {}),
      };
      delete models[modelId];
      entry = models[effectiveModelId];
      changed = true;
    }

    if (!entry || typeof entry !== 'object') continue;

    if (provider === 'anthropic') {
      if (effectiveModelId.startsWith('anthropic/') && usesClaudeCliAuthProfile(config, authProfilesForRuntime)) {
        const runtimeId = String(entry.agentRuntime?.id || '').trim();
        if (runtimeId !== 'claude-cli') {
          entry.agentRuntime = { ...(entry.agentRuntime && typeof entry.agentRuntime === 'object' ? entry.agentRuntime : {}), id: 'claude-cli' };
          changed = true;
        }
      } else if (effectiveModelId.startsWith('anthropic/') && String(entry.agentRuntime?.id || '').trim() === 'claude-cli') {
        delete entry.agentRuntime;
        changed = true;
      }
      continue;
    }

    if (provider === 'google-gemini-cli') {
      if (effectiveModelId.startsWith('google/')) {
        const runtimeId = String(entry.agentRuntime?.id || '').trim();
        if (runtimeId !== 'google-gemini-cli') {
          entry.agentRuntime = {
            ...(entry.agentRuntime && typeof entry.agentRuntime === 'object' ? entry.agentRuntime : {}),
            id: 'google-gemini-cli',
          };
          changed = true;
        }
      }
      continue;
    }

    if (provider === 'google') {
      if (effectiveModelId.startsWith('google/') && String(entry.agentRuntime?.id || '').trim() === 'google-gemini-cli') {
        delete entry.agentRuntime;
        changed = true;
      }
      continue;
    }

    // openai/* agent turns route through the bundled Codex app-server runtime
    // by default on OpenClaw 2026.7.1, so explicit codex runtime pins are
    // legacy metadata and should be removed.
    if (effectiveModelId.startsWith('openai/') && String(entry.agentRuntime?.id || '').trim() === 'codex') {
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

export function getProviderDefaultModelPayload(provider: string | null): any[] {
  if (!provider) return [];
  const meta = getAiProviderMeta(provider);
  if (!meta) return [];
  return normalizeModelPayload(
    meta.defaultModels.map((model) => ({
      id: model.id,
      name: model.name,
      description: model.description,
    })),
    provider,
  ).filter((model) => matchesProviderModel(provider, model.id || model.name || ''));
}

function readDiscoveredProviderModelsFromCli(provider: string): string[] {
  if (provider === 'google-antigravity') {
    const antigravityModels = listAntigravityModelsFromCli()
      .map((model) => canonicalizeProviderModelId(provider, model.id))
      .filter((modelId) => matchesProviderModel(provider, modelId));
    if (antigravityModels.length) return dedupeProviderModels(provider, antigravityModels);
  }

  if (DEFAULT_ONLY_MODEL_DISCOVERY_PROVIDERS.has(provider)) {
    return [];
  }

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
  if (DEFAULT_ONLY_MODEL_DISCOVERY_PROVIDERS.has(provider) || provider === 'google-antigravity') {
    return [];
  }

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

export function mergeDiscoveredProviderModelsIntoConfig(
  config: any,
  provider: string,
  discoveredModels: string[],
  authProfilesForRuntime: any = readAuthProfiles(),
  options?: { addFallbacks?: boolean },
) {
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
      .filter((modelId) => !currentDefault || modelId !== currentDefault)
    : [];

  const fallbackSet = new Set(existingFallbacks);
  const addedAllowlist: string[] = [];
  const addedFallbacks: string[] = [];
  const shouldPinAnthropicCliRuntime = provider === 'anthropic' && usesClaudeCliAuthProfile(next, authProfilesForRuntime);
  const shouldPinGoogleGeminiCliRuntime = provider === 'google-gemini-cli';
  let changed = repairProviderModelRuntimeMetadata(next, provider, authProfilesForRuntime);

  for (const modelId of dedupeProviderModels(provider, discoveredModels)) {
    if (!next.agents.defaults.models[modelId] || typeof next.agents.defaults.models[modelId] !== 'object') {
      next.agents.defaults.models[modelId] = next.agents.defaults.models[modelId] && typeof next.agents.defaults.models[modelId] === 'object'
        ? next.agents.defaults.models[modelId]
        : {};
      addedAllowlist.push(modelId);
      changed = true;
    }

    if ((provider === 'openai-codex' || provider === 'codex') && modelId.startsWith('openai/')) {
      const entry = next.agents.defaults.models[modelId];
      if (String(entry.agentRuntime?.id || '').trim() === 'codex') {
        // Canonical openai/* ids use the Codex app-server runtime by default
        // on OpenClaw 2026.7.1; explicit pins are legacy metadata.
        delete entry.agentRuntime;
        changed = true;
      }
    }

    if (shouldPinAnthropicCliRuntime && modelId.startsWith('anthropic/')) {
      const entry = next.agents.defaults.models[modelId];
      const runtimeId = String(entry.agentRuntime?.id || '').trim();
      if (runtimeId !== 'claude-cli') {
        entry.agentRuntime = { ...(entry.agentRuntime && typeof entry.agentRuntime === 'object' ? entry.agentRuntime : {}), id: 'claude-cli' };
        changed = true;
      }
    }

    if (shouldPinGoogleGeminiCliRuntime && modelId.startsWith('google/')) {
      const entry = next.agents.defaults.models[modelId];
      const runtimeId = String(entry.agentRuntime?.id || '').trim();
      if (runtimeId !== 'google-gemini-cli') {
        entry.agentRuntime = {
          ...(entry.agentRuntime && typeof entry.agentRuntime === 'object' ? entry.agentRuntime : {}),
          id: 'google-gemini-cli',
        };
        changed = true;
      }
    }

    if (options?.addFallbacks !== false && modelId !== currentDefault && !fallbackSet.has(modelId)) {
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
export function buildProviderRegistrationSeedModels(
  provider: string,
  validatedModels: string[] | undefined,
  selectedModel: string | null | undefined,
  safeChatCatalog?: string[],
): string[] {
  if (provider !== 'xai') return [];
  return filterXaiChatModels(dedupeProviderModels(provider, [
    ...(validatedModels || []),
    selectedModel || '',
  ]), safeChatCatalog?.length ? safeChatCatalog : getSafeXaiChatModelCatalog([]));
}

export function getSafeXaiChatModelCatalog(discoveredModels?: string[]): string[] {
  const staticChatModels = (getAiProviderMeta('xai')?.defaultModels || [])
    .map((model) => canonicalizeProviderModelId('xai', model.id));
  const discovered = discoveredModels === undefined
    ? readDiscoveredProviderModelsFromCli('xai')
    : discoveredModels;
  // Union, not prefer-discovered: the bundled OpenClaw xai catalog lags xAI
  // releases, but the transport passes registered model ids straight through
  // (live-proven with grok-4.5 on OpenClaw 2026.7.1). Portal-curated models
  // stay selectable and the live probe at selection reports the truth.
  return dedupeProviderModels('xai', [...discovered, ...staticChatModels])
    .filter((modelId) => matchesProviderModel('xai', modelId));
}

export function filterXaiChatModels(models: string[] | undefined, catalog: string[]): string[] {
  const allowed = new Set(dedupeProviderModels('xai', catalog));
  return dedupeProviderModels('xai', models || []).filter((modelId) => allowed.has(modelId));
}

async function registerProviderModels(provider: string, options?: { preserveProviderTransport?: boolean; seedModels?: string[] }) {
  const discoveredViaCli = readDiscoveredProviderModelsFromCli(provider);
  const discoveredViaGateway = discoveredViaCli.length ? [] : await readDiscoveredProviderModelsFromGateway(provider);
  const seedModels = dedupeProviderModels(provider, options?.seedModels || [])
    .filter((modelId) => matchesProviderModel(provider, modelId));
  const discoveredRuntimeModels = [...seedModels, ...discoveredViaCli, ...discoveredViaGateway];
  const shouldUseStaticFallbacks = provider !== 'xai' || discoveredRuntimeModels.length === 0;
  const staticFallbacks = shouldUseStaticFallbacks
    ? dedupeProviderModels(provider, [
      ...(PROVIDER_MODEL_DISCOVERY_FALLBACKS[provider] || []),
      ...((getAiProviderMeta(provider)?.defaultModels || []).map((model) => canonicalizeProviderModelId(provider, model.id))),
    ])
    : [];

  const discoveredModels = dedupeProviderModels(provider, [
    ...discoveredRuntimeModels,
    ...staticFallbacks,
  ]).filter((modelId) => matchesProviderModel(provider, modelId));

  if (!discoveredModels.length) {
    console.log(`[AI-Setup] No models discovered for ${provider}`);
    return { changed: false, models: [] as string[], addedAllowlist: [] as string[], addedFallbacks: [] as string[] };
  }

  if (provider === 'google-antigravity') {
    console.log(`[AI-Setup] Discovered ${discoveredModels.length} ${provider} native models; not registering them into OpenClaw because Antigravity is handled by Portal's native GEMINI adapter.`);
    return {
      changed: false,
      models: discoveredModels,
      addedAllowlist: [] as string[],
      addedFallbacks: [] as string[],
    };
  }

  const openclawConfig = readOpenClawConfig();
  const merged = mergeDiscoveredProviderModelsIntoConfig(openclawConfig, provider, discoveredModels, readAuthProfiles(), {
    addFallbacks: provider !== 'xai',
  });
  const runtimeModels = registerProviderRuntimeModels(provider, discoveredModels, {
    preserveProviderTransport: options?.preserveProviderTransport,
  });
  if (merged.changed) {
    atomicWriteJson(CONFIG_PATH, merged.config);
    if (provider === 'anthropic') repairClaudeSubscriptionConfig();
  }

  console.log(`[AI-Setup] Registered ${discoveredModels.length} ${provider} models (${merged.addedAllowlist.length} allowlisted, ${merged.addedFallbacks.length} fallback additions, ${runtimeModels.addedModels.length} runtime additions)`);
  return {
    changed: merged.changed || runtimeModels.changed,
    models: discoveredModels,
    addedAllowlist: merged.addedAllowlist,
    addedFallbacks: merged.addedFallbacks,
  };
}

async function waitForGatewayHealth(timeoutMs = 60000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetchGatewayHealth()) return true;
    await sleep(1000);
  }
  return false;
}

async function restartGateway() {
  await assertOpenClawGatewayAuthorizationFenceReleased();
  if (!fs.existsSync('/run/systemd/system') || !fs.existsSync('/usr/bin/systemctl')) {
    throw new Error('OpenClaw gateway restart requires the installed systemd system service.');
  }

  try {
    execFileSync('/usr/bin/systemctl', ['restart', 'openclaw-gateway.service'], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenClaw gateway system service restart failed: ${message}`);
  }
  if (!(await waitForGatewayHealth(60000))) {
    throw new Error('OpenClaw gateway did not become healthy after systemd restart.');
  }
}

async function finalizeNativeCliCompletion(status: any) {
  if (!status?.id || status.status !== 'complete') return;
  await runNativeCliCompletionFinalizerOnce(status.id, async () => {
    const nativeProvider = status.provider === 'claude-code'
      ? 'CLAUDE_CODE'
      : status.provider === 'codex'
        ? 'CODEX'
        : status.provider === 'grok'
          ? 'GROK'
          : status.provider === 'gemini'
            ? 'GEMINI'
            : null;
    if (nativeProvider) {
      // A completed native login is the explicit credential-generation
      // transition that may release an earlier provider rejection. Refresh
      // both turn admission and the independently cached Agent Chat catalog.
      invalidateNativeCliAuthStatus(nativeProvider);
      invalidateNativeProviderReadiness(nativeProvider);
    }
    if (status.provider === 'gemini') {
      // Antigravity belongs to Portal's native GEMINI adapter, not OpenClaw's
      // provider/default-model configuration. Force the next readiness/catalog
      // read to attest the just-completed native credential state.
      invalidateAntigravityModelCache();
      return;
    }
    if (status.provider === 'google-gemini-cli') {
      await registerProviderModels('google-gemini-cli');
      return;
    }
    if (status.provider === 'codex') {
      pinCodexExternalCliAuthProfile();
      await registerProviderModels('openai-codex');
      await restartGateway();
      return;
    }
    if (status.provider === 'grok') {
      // Native Grok Build auth belongs to ~/.grok and is independent from the
      // OpenClaw xAI SQLite store. No gateway restart or credential copy.
      return;
    }
    await restartGateway();
  });
  markOAuthFlowFinalized(status.id);
}

export async function runNativeCliCompletionFinalizerOnce(
  sessionId: string,
  finalizer: () => Promise<void>,
): Promise<void> {
  if (handledNativeCliCompletions.has(sessionId)) return;

  const inFlight = nativeCliCompletionFinalizers.get(sessionId);
  if (inFlight) {
    await inFlight;
    return;
  }

  const run = (async () => {
    await finalizer();
    handledNativeCliCompletions.add(sessionId);
    const retentionTimer = setTimeout(
      () => handledNativeCliCompletions.delete(sessionId),
      OAUTH_FINALIZATION_RETENTION_MS,
    );
    retentionTimer.unref?.();
  })();
  nativeCliCompletionFinalizers.set(sessionId, run);

  try {
    await run;
  } finally {
    if (nativeCliCompletionFinalizers.get(sessionId) === run) {
      nativeCliCompletionFinalizers.delete(sessionId);
    }
  }
}

export async function runOAuthCompletionFinalizerOnce(sessionId: string, finalizer: () => Promise<void>): Promise<void> {
  if (handledOAuthCompletions.has(sessionId)) return;

  const inFlight = oauthCompletionFinalizers.get(sessionId);
  if (inFlight) {
    await inFlight;
    return;
  }

  const run = (async () => {
    await finalizer();
    handledOAuthCompletions.add(sessionId);
    const retentionTimer = setTimeout(() => handledOAuthCompletions.delete(sessionId), OAUTH_FINALIZATION_RETENTION_MS);
    retentionTimer.unref?.();
  })();
  oauthCompletionFinalizers.set(sessionId, run);

  try {
    await run;
  } finally {
    if (oauthCompletionFinalizers.get(sessionId) === run) oauthCompletionFinalizers.delete(sessionId);
  }
}

export function __resetClaudeSetupStartLeaseForTests(): void {
  activeClaudeSetupStart = null;
}

export async function runClaudeSetupStartOnce<T extends { sessionId: string }>(
  ownerId: string,
  starter: () => Promise<T>,
  releasable: (sessionId: string, ownerId: string) => boolean = isClaudeSetupTokenLeaseReleasable,
): Promise<T> {
  if (activeClaudeSetupStart?.sessionId
    && activeClaudeSetupStart.releasable(activeClaudeSetupStart.sessionId, activeClaudeSetupStart.ownerId)) {
    activeClaudeSetupStart = null;
  }

  if (activeClaudeSetupStart) {
    if (activeClaudeSetupStart.ownerId === ownerId) {
      return activeClaudeSetupStart.promise as Promise<T>;
    }
    throw new ProviderSetupInProgressError('Claude setup is already running for another owner session.');
  }

  const attempt = Promise.resolve().then(starter);
  activeClaudeSetupStart = { ownerId, promise: attempt, sessionId: null, releasable };
  try {
    const result = await attempt;
    if (activeClaudeSetupStart?.promise === attempt) {
      activeClaudeSetupStart.sessionId = result.sessionId;
    }
    return result;
  } catch (error: any) {
    if (activeClaudeSetupStart?.promise === attempt) {
      const retainedSessionId = String(error?.oauthSessionId || error?.sessionId || '').trim();
      if (retainedSessionId) {
        activeClaudeSetupStart.sessionId = retainedSessionId;
        if (releasable(retainedSessionId, ownerId)) activeClaudeSetupStart = null;
      } else {
        activeClaudeSetupStart = null;
      }
    }
    throw error;
  }
}

export async function runClaudeSetupCompletionOnce<T>(
  sessionId: string,
  finalizer: () => Promise<T>,
): Promise<T> {
  if (completedClaudeSetupResults.has(sessionId)) {
    return completedClaudeSetupResults.get(sessionId) as T;
  }
  if (activeClaudeSetupCompletion) {
    if (activeClaudeSetupCompletion.sessionId === sessionId) {
      return activeClaudeSetupCompletion.promise as Promise<T>;
    }
    throw new ProviderSetupInProgressError('Another Claude setup completion is already running.');
  }

  const attempt = Promise.resolve().then(finalizer);
  activeClaudeSetupCompletion = { sessionId, promise: attempt };
  try {
    const result = await attempt;
    if (result && typeof result === 'object' && (result as any).success === true) {
      completedClaudeSetupResults.set(sessionId, result);
      const retentionTimer = setTimeout(
        () => completedClaudeSetupResults.delete(sessionId),
        OAUTH_FINALIZATION_RETENTION_MS,
      );
      retentionTimer.unref?.();
    }
    return result;
  } finally {
    if (activeClaudeSetupCompletion?.promise === attempt) activeClaudeSetupCompletion = null;
  }
}

async function finalizeOAuthCompletion(status: any): Promise<void> {
  if (!status?.id || status.status !== 'complete') return;
  await runOAuthCompletionFinalizerOnce(status.id, async () => {
    if (!status.provider || !status.createdProfileId) {
      throw new Error('Provider sign-in completed, but its OpenClaw auth profile could not be resolved yet. Retry status in a moment.');
    }

    if (status.provider === 'openai-codex') {
      pinCodexExternalCliAuthProfile(status.createdProfileId);
    } else if (status.provider !== 'xai') {
      pinProviderAuthProfile(status.authProvider || status.provider, status.createdProfileId, 'oauth');
    }

    const rollbackSnapshots = status.provider === 'xai'
      ? [captureFileSnapshot(CONFIG_PATH), captureFileSnapshot(MODELS_JSON_PATH)]
      : [];
    let expectedRollbackState: FileSnapshot[] = [];

    try {
      if (status.provider === 'xai') {
        clearProviderAuthOrder('xai');
      }
      await registerProviderModels(status.provider, {
        // xAI is a bundled provider. OpenClaw owns both its subscription and
        // API-key transports; Portal may extend the model allowlist but must
        // never author or delete models.providers.xai transport configuration.
        preserveProviderTransport: status.provider === 'xai',
      });
      if (rollbackSnapshots.length) {
        expectedRollbackState = [captureFileSnapshot(CONFIG_PATH), captureFileSnapshot(MODELS_JSON_PATH)];
      }
      await restartGateway();
      if (status.provider === 'xai') {
        // The credential is already committed to OpenClaw's auth store and its
        // models are registered. The live model probe is advisory: xAI OAuth is
        // subscription/entitlement-gated, so a probe can be inconclusive
        // ("unknown") or fail for an account that Portal cannot verify yet even
        // when the credential is valid. A probe failure must NOT strand a valid
        // setup — record a non-fatal warning and let the operator pick a
        // default model. A genuine problem surfaces at first use with an
        // actionable message.
        try {
          probeOpenClawAuthProfile('xai', status.createdProfileId, 20_000);
          markOAuthFlowFinalizationWarning(status.id, null);
        } catch (probeError: any) {
          console.warn('[AI-Setup] xAI live model probe was inconclusive; completing setup with a warning:', probeError?.message || probeError);
          markOAuthFlowFinalizationWarning(
            status.id,
            `${probeError?.message || 'Portal could not confirm a live xAI model response.'} Setup completed and you can select a default model; if a model does not respond, your xAI plan may not include API access.`,
          );
        }
        commitXaiOAuthSession(status.id);
      }
    } catch (error: any) {
      if (rollbackSnapshots.length) {
        try {
          if (expectedRollbackState.length) {
            restoreSnapshotsWithCompareAndSwap(rollbackSnapshots, expectedRollbackState);
          } else if (!rollbackSnapshots.every(fileSnapshotMatchesCurrent)) {
            throw new Error('OpenClaw configuration changed before Portal established a safe OAuth rollback checkpoint.');
          }
          clearProviderAuthOrder('xai');
          await restartGateway();
        } catch (rollbackError: any) {
          throw new Error(`Provider authentication was saved, final setup failed, and the restored gateway configuration did not recover: ${rollbackError?.message || rollbackError}`);
        }
      }
      if (status.provider === 'xai') {
        markOAuthFlowFinalizationError(status.id, error?.message || String(error));
        commitXaiOAuthSession(status.id);
      }
      throw error;
    }
  });
  markOAuthFlowFinalized(status.id);
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

export function classifyProviderRuntimeFailure(output: string): string {
  const normalized = output.replace(/\s+/g, ' ').trim();
  if (/manual authorization is required|non-interactive|run the Gemini CLI in an interactive terminal/i.test(normalized)) {
    return 'Gemini CLI is installed, but server-side auth is not usable headlessly. Re-run Gemini CLI sign-in from Portal or provide GEMINI_API_KEY/Application Default Credentials.';
  }
  if (/IneligibleTierError|UNSUPPORTED_CLIENT|not eligible|unsupported client/i.test(normalized)) {
    return 'Google rejected this Gemini CLI account/client. Use a different Google account or the API-key Gemini provider instead.';
  }
  if (/command not found|ENOENT|not recognized/i.test(normalized)) {
    return 'Gemini CLI is not installed or is not on PATH for the Portal service.';
  }
  if (/quota|rate limit|resource exhausted/i.test(normalized)) {
    return 'Gemini CLI auth worked, but Google rejected the request for quota or rate-limit reasons.';
  }
  return normalized.slice(0, 600) || 'Provider runtime smoke test failed.';
}

function runGoogleGeminiCliSmoke() {
  try {
    const output = execFileSync('gemini', [
      '-p',
      'Reply with exactly GEMINI_OK.',
      '--model',
      'gemini-3-flash-preview',
      '--output-format',
      'json',
    ], {
      timeout: 75000,
      encoding: 'utf8',
      env: buildOpenClawCliEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 4,
    });

    return {
      ok: /GEMINI_OK/i.test(output),
      provider: 'google-gemini-cli',
      model: 'google/gemini-3-flash-preview',
      error: /GEMINI_OK/i.test(output) ? null : 'Gemini CLI returned without the expected smoke-test response.',
    };
  } catch (error: any) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : error?.stdout?.toString?.('utf8') || '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr : error?.stderr?.toString?.('utf8') || '';
    const combined = `${stdout}\n${stderr}`.trim() || error?.message || 'Gemini CLI smoke test failed.';
    return {
      ok: false,
      provider: 'google-gemini-cli',
      model: 'google/gemini-3-flash-preview',
      error: classifyProviderRuntimeFailure(combined),
    };
  }
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

  router.get('/catalog', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ providers: getPublicAiProviderCatalog(), source: 'backend' });
  });

  router.post('/oauth/start', async (req: Request, res: Response) => {
    const parsed = oauthStartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i: any) => i.message).join("; ") || "Invalid request" });
      return;
    }

    let xaiSetup: ActiveXaiSetup | null = null;
    try {
      if (parsed.data.provider === 'qwen-portal') {
        runOpenClaw(['plugins', 'enable', 'qwen-portal-auth'], 15000);
      }
      if (parsed.data.provider === 'xai') {
        xaiSetup = beginXaiSetup('oauth', getOAuthRequestOwnerId(req));
      }
      const result = await startOAuthFlow(parsed.data.provider, {
        googleProjectId: parsed.data.googleProjectId,
        ownerId: getOAuthRequestOwnerId(req),
      });
      if (xaiSetup) bindXaiOAuthSession(xaiSetup, result.sessionId);
      res.json(result);
    } catch (error: any) {
      let detail = error?.message || 'Failed to start OAuth flow';
      if (xaiSetup) {
        try {
          if (error?.credentialCommitted) {
            commitXaiSetup(xaiSetup);
          } else if (error?.cleanupPending && error?.oauthSessionId) {
            bindXaiOAuthSession(xaiSetup, String(error.oauthSessionId));
          } else if (!error?.oauthSessionId || error?.credentialState === 'absent') {
            rollbackXaiSetup(xaiSetup);
          } else {
            // A durable session exists but did not produce authoritative
            // credential absence. Retain the xAI lease and exact session
            // binding so status/cancel can finish reconciliation safely.
            bindXaiOAuthSession(xaiSetup, String(error.oauthSessionId));
          }
        } catch (rollbackError: any) {
          detail = `${detail} Plugin policy rollback also failed: ${rollbackError?.message || rollbackError}`;
        }
      }
      res.status(providerSetupErrorStatus(error)).json({
        ...oauthStartFailurePayload(error, 'Failed to start OAuth flow'),
        error: detail,
      });
    }
  });

  // Owner-initiated recovery from a stuck credential lifecycle. A failed
  // sign-in can leave a terminal record that makes every retry throw
  // PROVIDER_CREDENTIAL_LIFECYCLE_CONFLICT. This clears that bookkeeping (and
  // any parked removal fence) so a fresh sign-in can start; it never touches
  // the credential store — the operator's next sign-in overwrites it.
  router.post('/oauth/reset-lifecycle', async (req: Request, res: Response) => {
    const parsed = oauthStartSchema.pick({ provider: true }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A valid provider is required.' });
      return;
    }
    const provider = parsed.data.provider;
    const ownerId = getOAuthRequestOwnerId(req);
    try {
      // Release any in-process xAI operation lease so the reset is not itself
      // blocked by a stale in-memory gate.
      if (provider === 'xai') {
        try { forceReleaseActiveXaiSetup(); } catch { /* best effort */ }
      }
      const namespace = getCredentialLifecycleNamespaceForOpenClawProvider(provider);
      const result = resetStuckProviderCredentialLifecycle(namespace, ownerId);
      if (result.reason === 'owner_mismatch') {
        res.status(409).json({ success: false, code: 'PROVIDER_LIFECYCLE_OWNER_MISMATCH', error: 'This provider authorization belongs to another account.' });
        return;
      }
      if (result.reason === 'process_alive') {
        res.status(409).json({ success: false, code: 'PROVIDER_LIFECYCLE_BUSY', error: 'A provider sign-in is still running. Cancel it, then reset.' });
        return;
      }
      res.json({
        success: true,
        cleared: result.cleared,
        message: result.cleared
          ? 'Cleared the stuck provider authorization. You can start the sign-in again.'
          : 'No stuck provider authorization was found; you can start the sign-in.',
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Could not reset the provider authorization lifecycle.' });
    }
  });

  router.post('/oauth/device/start', async (req: Request, res: Response) => {
    try {
      const result = await startDeviceCodeFlow('github-copilot', getOAuthRequestOwnerId(req));
      res.json(result);
    } catch (error: any) {
      res.status(providerSetupErrorStatus(error))
        .json(oauthStartFailurePayload(error, 'Failed to start device-code flow'));
    }
  });

  router.post('/oauth/callback', async (req: Request, res: Response) => {
    const parsed = oauthCallbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i: any) => i.message).join("; ") || "Invalid request" });
      return;
    }

    try {
      const ownerId = getOAuthRequestOwnerId(req);
      const result = await completeOAuthFlow(parsed.data.sessionId, parsed.data.callbackUrl, ownerId);
      if (!result.success) {
        res.status(500).json(result);
        return;
      }
      const sessionStatus = getOAuthFlowStatus(parsed.data.sessionId, ownerId);
      await finalizeOAuthCompletion(sessionStatus);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to complete OAuth flow' });
    }
  });

  router.post('/oauth/cancel', async (req: Request, res: Response) => {
    const parsed = oauthCancelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const ownerId = getOAuthRequestOwnerId(req);
    const result = await cancelOAuthFlow(parsed.data.sessionId, ownerId);
    if (!result) {
      res.status(404).json({ error: 'OAuth session not found' });
      return;
    }
    const reconciled = getOAuthFlowStatus(parsed.data.sessionId, ownerId);
    if (reconciled?.provider === 'xai') {
      try {
        if (reconciled.createdProfileId) commitXaiOAuthSession(parsed.data.sessionId);
        else if (reconciled.credentialState === 'absent' && !reconciled.cleanupPending) {
          rollbackXaiOAuthSession(parsed.data.sessionId);
        }
      } catch (rollbackError: any) {
        res.status(500).json({
          success: false,
          status: reconciled.status,
          error: `Authorization stopped, but xAI plugin policy rollback failed: ${rollbackError?.message || rollbackError}`,
        });
        return;
      }
    }
    res.status(result.success ? 200 : 409).json({
      ...result,
      ...(reconciled?.cleanupPending ? { cleanupPending: true } : {}),
      ...(reconciled?.credentialState ? { credentialState: reconciled.credentialState } : {}),
    });
  });

  router.get('/oauth/status/:sessionId', async (req: Request, res: Response) => {
    const status = getOAuthFlowStatus(req.params.sessionId, getOAuthRequestOwnerId(req));
    if (!status) {
      res.status(404).json({ error: 'OAuth session not found' });
      return;
    }

    if (status.provider === 'xai' && status.createdProfileId && status.status === 'error') {
      commitXaiOAuthSession(status.id);
    } else if (status.provider === 'xai' && status.credentialState === 'absent' && !status.cleanupPending) {
      try {
        rollbackXaiOAuthSession(status.id);
      } catch (rollbackError: any) {
        res.status(500).json({
          ...status,
          finalized: false,
          error: `xAI sign-in ended, but plugin policy rollback failed: ${rollbackError?.message || rollbackError}`,
        });
        return;
      }
    }

    if (status.status === 'complete' && !status.createdProfileId) {
      // OpenClaw can emit its completion marker just before the SQLite-backed
      // auth profile commit becomes visible. Keep this a non-fatal pending state
      // so the browser polls the same completed session instead of re-authing.
      res.status(202).json({ ...status, finalized: false });
      return;
    }

    if (status.status === 'complete' && !handledOAuthCompletions.has(status.id)) {
      // Finalization (gateway restart + live credential probe) can take tens of
      // seconds. Kick it off in the background and answer this poll immediately;
      // blocking here made the browser abort with a false "server unreachable".
      ensureOAuthFinalizationStarted(status);
      const latest = getOAuthFlowStatus(status.id, getOAuthRequestOwnerId(req)) || status;
      if (latest.status === 'error') {
        res.status(200).json({ ...latest, finalized: false });
        return;
      }
      res.status(202).json({ ...latest, finalized: false, finalizing: true });
      return;
    }

    res.json({ ...status, finalized: handledOAuthCompletions.has(status.id) });
  });

  router.get('/status', async (req: Request, res: Response) => {
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
    const providers = await getProviderStatusesAsync({
      forceProviderReadiness: req.query.refreshProviderReadiness === '1',
    });
    const configuredProviders = providers.filter((provider) => provider.status === 'configured');
    const providersWithRemovalCapabilities = providers.map((provider) => ({
      ...provider,
      removal: getProviderRemovalCapability(provider.id),
    }));

    res.json({
      openclawInstalled,
      openclawVersion,
      gatewayRunning,
      providers: providersWithRemovalCapabilities,
      defaultModel: getDefaultModel(),
      fallbackModels: getFallbackModels(),
      configuredProfileCount: configuredProviders.length,
      activeProfiles: configuredProviders
        .map((provider) => provider.profileId)
        .filter((profileId): profileId is string => Boolean(profileId)),
    });
  });

  router.post('/provider/:id/smoke', async (req: Request, res: Response) => {
    const parsed = smokeProviderSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Runtime smoke test is not available for this provider yet.' });
      return;
    }

    if (parsed.data === 'google-gemini-cli') {
      const result = runGoogleGeminiCliSmoke();
      res.status(result.ok ? 200 : 502).json(result);
      return;
    }

    res.status(400).json({ ok: false, error: 'Runtime smoke test is not available for this provider yet.' });
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

    const validation = await validateApiKey(provider, apiKey);
    if (provider === 'xai' && validation.valid) {
      validation.models = filterXaiChatModels(validation.models, getSafeXaiChatModelCatalog([]));
    }
    res.json(validation);
  });

  router.post('/save-key', async (req: Request, res: Response) => {
    const parsed = saveKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i: any) => i.message).join("; ") || "Invalid request",
        operationDisposition: 'not_admitted',
      });
      return;
    }

    const { provider, apiKey, setDefault, model, operationId } = parsed.data;
    const normalizedModel = canonicalizeProviderModelId(provider, model || '');
    const authProviderId = provider === 'openai-codex' ? 'openai' : provider;
    const lifecycleNamespace = getCredentialLifecycleNamespaceForOpenClawProvider(authProviderId);
    const ownerId = getOAuthRequestOwnerId(req);
    const savedProfileId = provider === 'xai' ? 'xai:portal-api-key' : `${provider}:default`;
    const responsePayload = { success: true, profileId: savedProfileId, model: normalizedModel || null };
    const requestFingerprint = credentialWriteRequestFingerprint({
      provider,
      secret: apiKey,
      setDefault: Boolean(setDefault && normalizedModel),
      model: normalizedModel || null,
    });
    const xaiChatCatalog = provider === 'xai' ? getSafeXaiChatModelCatalog() : [];
    if (provider === 'xai' && normalizedModel && !xaiChatCatalog.includes(normalizedModel)) {
      res.status(400).json({
        success: false,
        error: 'The selected xAI model is not an OpenClaw chat model and cannot be used as the agent default.',
        operationDisposition: 'not_admitted',
      });
      return;
    }

    let rollbackSnapshots: FileSnapshot[] = [];
    let expectedRollbackState: FileSnapshot[] = [];
    let credentialSaved = false;
    let credentialCommitIndeterminate = false;
    let xaiSetup: ActiveXaiSetup | null = null;
    let writeClaim: ClaimedProviderCredentialLifecycle | null = null;
    let writeDisposition: 'admitted' | 'recovered' | 'completed' | null = null;
    let mutationStarted = false;
    let validatedChatModels: string[] = [];
    const settleFailedWriteClaim = (safeToRelease = false) => {
      if (!writeClaim) return;
      if (safeToRelease) releaseProviderCredentialLifecycle(writeClaim);
      else parkProviderCredentialRemovalLifecycle(writeClaim);
      writeClaim = null;
    };
    try {
      const admission = claimProviderCredentialWriteLifecycle(
        lifecycleNamespace,
        ownerId,
        operationId,
        requestFingerprint,
        'openclaw-and-portal',
      );
      writeClaim = admission.claim;
      writeDisposition = admission.disposition;

      if (admission.disposition === 'admitted') {
        const admissionProof = await readStableCredentialWriteProof(
          () => readOpenClawAndPortalCredentialProof(provider, authProviderId),
        );
        setProviderCredentialWriteAdmissionBaseline(admission.claim, admissionProof.fingerprint);
      }

      if (admission.disposition === 'completed') {
        const proof = await readStableCredentialWriteProof(
          () => readOpenClawAndPortalCredentialProof(provider, authProviderId),
        );
        const credentialPresent = await expectedProviderCredentialPresent(provider, authProviderId, savedProfileId);
        if (proof.absent || !credentialPresent || !verifyProviderCredentialWriteCompletionReceipt(
          lifecycleNamespace,
          ownerId,
          operationId,
          requestFingerprint,
          credentialWriteResultFingerprint(responsePayload, proof.fingerprint),
        )) {
          throw new DurableCredentialLifecycleRecoveryRequiredError(
            'Portal could not re-attest the completed credential write. The domain remains locked for review.',
          );
        }
        releaseProviderCredentialLifecycle(writeClaim);
        writeClaim = null;
        res.json(responsePayload);
        return;
      }

      if (admission.disposition === 'recovered') {
        // A fixed profile containing the submitted secret proves only that the
        // first Portal JSON write may have landed. It does not prove that the
        // later auth declaration/order, model routing, default selection, and
        // gateway settlement all completed. Never replay the secret and never
        // certify that partial state as a completed operation without a durable
        // receipt covering the final proof.
        credentialCommitIndeterminate = true;
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'Portal cannot prove that the interrupted request completed its full credential and routing transaction. The secret will not be written again; the operation remains parked for server review.',
        );
      } else {
        const validation = await validateApiKey(provider, apiKey);
        if (!validation.valid) {
          settleFailedWriteClaim(true);
          res.status(400).json({ ...validation, operationDisposition: 'not_admitted' });
          return;
        }
        validatedChatModels = provider === 'xai'
          ? filterXaiChatModels(validation.models, xaiChatCatalog)
          : (validation.models || []);
      }

      if (provider === 'xai') {
        mutationStarted = true;
        xaiSetup = beginXaiSetup('api-key', ownerId);
      }
      if (provider === 'xai') {
        // Preserve the plugin-policy change selected by the user if the
        // credential becomes durable and a later setup step fails.
        rollbackSnapshots = [captureFileSnapshot(CONFIG_PATH), captureFileSnapshot(MODELS_JSON_PATH)];
      }
      if (admission.disposition === 'admitted') {
        // Bundled providers such as xAI are committed through OpenClaw's locked
        // auth-store control plane; legacy API providers use Portal-managed files.
        mutationStarted = true;
        const saved = saveProviderApiKey(provider, apiKey);
        if (saved.profileId !== savedProfileId) {
          throw new DurableCredentialLifecycleRecoveryRequiredError(
            'The provider saved an unexpected credential profile. The domain remains locked for review.',
          );
        }
        credentialSaved = true;
      }
      if (provider === 'xai') {
        expectedRollbackState = [captureFileSnapshot(CONFIG_PATH), captureFileSnapshot(MODELS_JSON_PATH)];
      }

      if (setDefault && normalizedModel) {
        try { runOpenClaw(['models', 'set', normalizedModel], 10000); } catch (setModelError) {
          if (provider === 'xai') throw setModelError;
          const config = readOpenClawConfig();
          if (!config.agents) config.agents = {};
          if (!config.agents.defaults) config.agents.defaults = {};
          if (!config.agents.defaults.model) config.agents.defaults.model = {};
          config.agents.defaults.model.primary = normalizedModel;
          const fs = require('fs');
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        }
      }
      if (provider === 'xai') {
        expectedRollbackState = [captureFileSnapshot(CONFIG_PATH), captureFileSnapshot(MODELS_JSON_PATH)];
      }

      await registerProviderModels(provider, {
        seedModels: buildProviderRegistrationSeedModels(provider, validatedChatModels, normalizedModel, xaiChatCatalog),
      });
      if (provider === 'xai') {
        expectedRollbackState = [captureFileSnapshot(CONFIG_PATH), captureFileSnapshot(MODELS_JSON_PATH)];
      }
      await restartGateway();
      if (provider === 'xai') {
        const probeWarning = runAdvisoryAuthProbe(
          'xai',
          savedProfileId,
          20_000,
          getExpectedXaiProbeModel(provider, setDefault, normalizedModel),
        );
        if (probeWarning) (responsePayload as any).warning = probeWarning;
      }
      const finalProof = await readStableCredentialWriteProof(
        () => readOpenClawAndPortalCredentialProof(provider, authProviderId),
      );
      const exactPortalTargetPresent = provider === 'xai'
        ? await expectedProviderCredentialPresent(provider, authProviderId, savedProfileId)
        : portalCredentialTargetContainsSubmittedSecret(provider, savedProfileId, apiKey);
      if (finalProof.absent || !exactPortalTargetPresent) {
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'Provider setup finished without authoritative credential readback. The credential domain remains locked for review.',
        );
      }

      completeProviderCredentialWriteLifecycle(
        writeClaim,
        ownerId,
        operationId,
        requestFingerprint,
        credentialWriteResultFingerprint(responsePayload, finalProof.fingerprint),
      );
      writeClaim = null;
      if (xaiSetup) commitXaiSetup(xaiSetup);
      res.json(responsePayload);
    } catch (error: any) {
      if (provider === 'xai' && !credentialSaved && error instanceof ProviderApiKeySaveError) {
        credentialSaved = error.credentialState === 'committed';
        credentialCommitIndeterminate = error.credentialState === 'indeterminate';
      }
      let pluginRollbackError: string | null = null;
      if (rollbackSnapshots.length) {
        try {
          if (!expectedRollbackState.length && error instanceof ProviderApiKeySaveError) {
            // The supported save helper is synchronous. Capture the post-error
            // bytes now so the immediate CAS rollback cannot erase a later
            // request's unrelated config update.
            expectedRollbackState = [captureFileSnapshot(CONFIG_PATH), captureFileSnapshot(MODELS_JSON_PATH)];
          }
          restoreSnapshotsWithCompareAndSwap(rollbackSnapshots, expectedRollbackState);
          clearProviderAuthOrder('xai');
          if (xaiSetup && !credentialSaved && !credentialCommitIndeterminate) rollbackXaiSetup(xaiSetup);
          else if (xaiSetup) commitXaiSetup(xaiSetup);
          await restartGateway();
        } catch (rollbackError: any) {
          if (xaiSetup && (credentialSaved || credentialCommitIndeterminate)) {
            commitXaiSetup(xaiSetup);
          } else if (xaiSetup) {
            try { rollbackXaiSetup(xaiSetup); } catch {}
          }
          settleFailedWriteClaim(false);
          res.status(500).json({
            success: false,
            credentialSaved,
            credentialState: credentialCommitIndeterminate ? 'indeterminate' : (credentialSaved ? 'committed' : 'absent'),
            error: `xAI setup failed and the restored gateway configuration did not recover: ${rollbackError?.message || rollbackError}`,
          });
          return;
        }
      } else if (xaiSetup && !credentialSaved && !credentialCommitIndeterminate) {
        try {
          rollbackXaiSetup(xaiSetup);
        } catch (rollbackError: any) {
          pluginRollbackError = rollbackError?.message || String(rollbackError);
        }
      }
      const detail = `${error?.message || 'Failed to save API key'}${pluginRollbackError ? ` Plugin policy rollback also failed: ${pluginRollbackError}` : ''}`;
      const safeToRelease = writeDisposition === 'admitted'
        && !mutationStarted
        && (!(error instanceof ProviderApiKeySaveError) || error.credentialState === 'absent');
      settleFailedWriteClaim(safeToRelease);
      const operationNotAdmitted = credentialOperationWasNotAdmitted(error, {
        claim: writeClaim,
        disposition: writeDisposition,
        mutationStarted,
      });
      res.status(providerSetupErrorStatus(error)).json({
        success: false,
        credentialSaved,
        credentialState: credentialCommitIndeterminate ? 'indeterminate' : (credentialSaved ? 'committed' : 'absent'),
        ...(operationNotAdmitted ? { operationDisposition: 'not_admitted' } : {}),
        error: credentialSaved && provider === 'xai'
          ? `The xAI credential was saved, but final setup failed and configuration changes were rolled back: ${detail}`
          : (credentialCommitIndeterminate && provider === 'xai'
            ? `Portal could not prove whether OpenClaw committed the xAI credential. The xAI plugin was left enabled; retry status or disconnect xAI before entering another key. ${detail}`
            : detail),
      });
    }
  });

  // ── Claude setup-token flow (automated) ──────────────────────────
  router.post('/claude/start', async (req: Request, res: Response) => {
    try {
      const ownerId = getOAuthRequestOwnerId(req);
      const result = await runClaudeSetupStartOnce(ownerId, async () => {
        const started = await startClaudeSetupTokenFlow(ownerId);
        return { success: true, ...started };
      });
      res.json(result);
    } catch (error: any) {
      console.error('[Claude] start error:', error.message);
      res.status(providerSetupErrorStatus(error))
        .json(oauthStartFailurePayload(error, 'Failed to start Claude setup'));
    }
  });

  router.post('/claude/paste-code', async (req: Request, res: Response) => {
    const { sessionId, code } = req.body;
    if (!sessionId || !code) { res.status(400).json({ error: 'sessionId and code required' }); return; }

    try {
      const result = await pasteCodeToClaudeSession(sessionId, code, getOAuthRequestOwnerId(req));
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
      const ownerId = getOAuthRequestOwnerId(req);
      if (!getOAuthFlowStatus(sessionId, ownerId)) {
        res.status(404).json({ success: false, error: 'Claude setup session not found' });
        return;
      }
      const response = await runClaudeSetupCompletionOnce(sessionId, async () => {
        const generation = beginClaudeSetupTokenFinalization(sessionId, ownerId);
        if (generation === null) {
          return { success: false, error: 'Claude setup completion no longer owns an active authorization session.' };
        }
        try {
          const result = await getClaudeSetupToken(sessionId, ownerId);
          if (!result.success) return result;
          if (!result.token) {
            return { success: false, error: 'Claude authentication completed, but the owned setup-token session did not produce a reusable token.' };
          }

          const saveResult = commitClaudeSetupTokenCredential(
            sessionId,
            result.token,
            generation,
            ownerId,
          );
          if (!saveResult.success) return saveResult;

          await registerProviderModels('anthropic');
          // Restart gateway after the allowlist/fallback updates are persisted.
          await restartGateway();
          return { success: true };
        } catch (error: any) {
          markOAuthFlowFinalizationError(sessionId, error?.message || String(error));
          throw error;
        } finally {
          finishClaudeSetupTokenFinalization(sessionId, generation, ownerId);
        }
      });
      res.json(response);
    } catch (error: any) {
      console.error('[Claude] complete error:', error.message);
      res.status(error instanceof ProviderSetupInProgressError ? error.statusCode : 500)
        .json({ success: false, error: error?.message || 'Failed to complete Claude setup' });
    }
  });

  router.post('/save-setup-token', async (req: Request, res: Response) => {
    const parsed = saveSetupTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i: any) => i.message).join("; ") || "Invalid request",
        operationDisposition: 'not_admitted',
      });
      return;
    }

    const { provider, token, setDefault, model, operationId } = parsed.data;
    const authProviderId = provider;
    const lifecycleNamespace = getCredentialLifecycleNamespaceForOpenClawProvider(authProviderId);
    const ownerId = getOAuthRequestOwnerId(req);
    const savedProfileId = `${provider}:portal-setup-token`;
    const normalizedModel = canonicalizeProviderModelId(provider, model || '');
    const responsePayload = { success: true, profileId: savedProfileId, model: normalizedModel || null };
    const requestFingerprint = credentialWriteRequestFingerprint({
      provider,
      secret: token,
      setDefault: Boolean(setDefault && normalizedModel),
      model: normalizedModel || null,
    });
    let writeClaim: ClaimedProviderCredentialLifecycle | null = null;
    let writeDisposition: 'admitted' | 'recovered' | 'completed' | null = null;
    let mutationStarted = false;

    try {
      const admission = claimProviderCredentialWriteLifecycle(
        lifecycleNamespace,
        ownerId,
        operationId,
        requestFingerprint,
        'openclaw-and-portal',
      );
      writeClaim = admission.claim;
      writeDisposition = admission.disposition;

      if (admission.disposition === 'admitted') {
        const admissionProof = await readStableCredentialWriteProof(
          () => readOpenClawAndPortalCredentialProof(provider, authProviderId),
        );
        setProviderCredentialWriteAdmissionBaseline(admission.claim, admissionProof.fingerprint);
      }

      if (admission.disposition === 'completed') {
        const proof = await readStableCredentialWriteProof(
          () => readOpenClawAndPortalCredentialProof(provider, authProviderId),
        );
        const credentialPresent = await expectedProviderCredentialPresent(provider, authProviderId, savedProfileId);
        if (proof.absent || !credentialPresent || !verifyProviderCredentialWriteCompletionReceipt(
          lifecycleNamespace,
          ownerId,
          operationId,
          requestFingerprint,
          credentialWriteResultFingerprint(responsePayload, proof.fingerprint),
        )) {
          throw new DurableCredentialLifecycleRecoveryRequiredError(
            'Portal could not re-attest the completed setup-token write. The domain remains locked for review.',
          );
        }
        releaseProviderCredentialLifecycle(writeClaim);
        writeClaim = null;
        res.json(responsePayload);
        return;
      }

      if (admission.disposition === 'recovered') {
        // OpenClaw intentionally does not expose setup-token material. Profile
        // presence or aggregate alias drift cannot identify which token won a
        // pre-receipt crash, so recovery must remain parked.
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'Portal cannot prove that the interrupted request committed this setup-token. The token will not be written again.',
        );
      } else {
        mutationStarted = true;
        runOpenClawWithSecretInput([
          'models',
          'auth',
          'paste-token',
          '--provider',
          provider,
          '--profile-id',
          savedProfileId,
        ], token, 30000);
      }

      if (setDefault && normalizedModel) {
        runOpenClaw(['models', 'set', normalizedModel], 10000);
        repairClaudeSubscriptionConfig(normalizedModel);
      }

      await registerProviderModels(provider);
      await restartGateway();

      const finalProof = await readStableCredentialWriteProof(
        () => readOpenClawAndPortalCredentialProof(provider, authProviderId),
      );
      if (finalProof.absent || !await expectedProviderCredentialPresent(provider, authProviderId, savedProfileId)) {
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'Provider setup finished without authoritative setup-token readback. The credential domain remains locked for review.',
        );
      }
      {
        const probeWarning = runAdvisoryAuthProbe(
          provider,
          savedProfileId,
          20_000,
          setDefault && normalizedModel ? normalizedModel : undefined,
        );
        if (probeWarning) (responsePayload as any).warning = probeWarning;
      }

      completeProviderCredentialWriteLifecycle(
        writeClaim,
        ownerId,
        operationId,
        requestFingerprint,
        credentialWriteResultFingerprint(responsePayload, finalProof.fingerprint),
      );
      writeClaim = null;
      res.json(responsePayload);
    } catch (error: any) {
      const operationNotAdmitted = credentialOperationWasNotAdmitted(error, {
        claim: writeClaim,
        disposition: writeDisposition,
        mutationStarted,
      });
      if (writeClaim) {
        if (writeDisposition === 'admitted' && !mutationStarted) releaseProviderCredentialLifecycle(writeClaim);
        else parkProviderCredentialRemovalLifecycle(writeClaim);
        writeClaim = null;
      }
      res.status(providerSetupErrorStatus(error))
        .json({
          success: false,
          ...(operationNotAdmitted ? { operationDisposition: 'not_admitted' } : {}),
          error: error?.message || 'Failed to save setup-token',
        });
    }
  });

  router.post('/set-default-model', async (req: Request, res: Response) => {
    const parsed = setDefaultSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i: any) => i.message).join("; ") || "Invalid request" });
      return;
    }

    let rollbackSnapshots: FileSnapshot[] = [];
    let expectedRollbackState: FileSnapshot[] = [];
    let xaiModelToken: string | null = null;
    try {
      const normalizedModel = normalizePortalModelId(parsed.data.model);
      if (parsed.data.provider === 'xai' || normalizedModel.startsWith('xai/')) {
        xaiModelToken = xaiOperationGate.acquire('model-selection');
      }
      const currentConfig = readOpenClawConfig();
      const configuredModels = currentConfig?.agents?.defaults?.models;
      const registrationProvider = resolveModelRegistrationProvider(
        normalizedModel,
        parsed.data.provider,
        configuredModels,
      );
      if (parsed.data.provider && !matchesProviderModel(parsed.data.provider, normalizedModel)) {
        res.status(400).json({ error: 'Selected model must belong to the provider being configured' });
        return;
      }
      if (registrationProvider === 'xai' && !getSafeXaiChatModelCatalog().includes(normalizedModel)) {
        res.status(400).json({ error: 'The selected xAI model is not an OpenClaw chat model and cannot be used as the agent default.' });
        return;
      }
      if (registrationProvider === 'xai') {
        if (!parsed.data.profileId) {
          res.status(400).json({ error: 'The exact xAI credential profile is required before Portal can live-test this model.' });
          return;
        }
        invalidateOpenClawAuthStoreProfilesCache();
        const exactProfile = (await readOpenClawAuthStoreProfilesAsync('xai', { strict: true }))[parsed.data.profileId];
        if (!exactProfile || exactProfile.provider !== 'xai' || !['oauth', 'api_key'].includes(exactProfile.type)) {
          res.status(400).json({ error: 'The selected xAI credential is no longer present in OpenClaw. Reconnect xAI before choosing a default model.' });
          return;
        }
        rollbackSnapshots = [captureFileSnapshot(CONFIG_PATH), captureFileSnapshot(MODELS_JSON_PATH)];
      }
      runOpenClaw(['models', 'set', normalizedModel], 10000);
      if (rollbackSnapshots.length) {
        expectedRollbackState = [captureFileSnapshot(CONFIG_PATH), captureFileSnapshot(MODELS_JSON_PATH)];
      }
      repairClaudeSubscriptionConfig(normalizedModel);
      // Also register all models for this provider (handles auto-completion case)
      if (registrationProvider) await registerProviderModels(registrationProvider);
      if (rollbackSnapshots.length) {
        expectedRollbackState = [captureFileSnapshot(CONFIG_PATH), captureFileSnapshot(MODELS_JSON_PATH)];
      }
      await restartGateway();
      const probeWarning = registrationProvider === 'xai' && parsed.data.profileId
        ? runAdvisoryAuthProbe('xai', parsed.data.profileId, 20_000, normalizedModel)
        : null;
      res.json({
        success: true,
        model: normalizedModel,
        ...(probeWarning ? { warning: probeWarning } : {}),
      });
    } catch (error: any) {
      if (rollbackSnapshots.length) {
        try {
          if (expectedRollbackState.length) {
            restoreSnapshotsWithCompareAndSwap(rollbackSnapshots, expectedRollbackState);
          } else if (!rollbackSnapshots.every(fileSnapshotMatchesCurrent)) {
            throw new Error('OpenClaw failed before Portal could establish a rollback checkpoint; the current configuration was left untouched for safety.');
          }
          await restartGateway();
        } catch (rollbackError: any) {
          res.status(500).json({
            success: false,
            error: `The xAI model failed its live credential test and Portal could not restore the prior gateway configuration: ${rollbackError?.message || rollbackError}`,
          });
          return;
        }
      }
      const statusCode = error instanceof ProviderSetupInProgressError ? error.statusCode : 500;
      res.status(statusCode).json({ success: false, error: error?.message || 'Failed to set default model' });
    } finally {
      xaiOperationGate.release(xaiModelToken);
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
      const xaiFallbacks = normalizedFallbacks.filter((model) => model.startsWith('xai/'));
      if (xaiFallbacks.length) {
        res.status(400).json({ error: 'xAI fallback models require exact-profile live verification and cannot be added through this endpoint yet. Choose a live-tested xAI default model instead.' });
        return;
      }
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
    const exactNativeCatalog = req.query.exact === '1';
    const fallbackModels = getProviderDefaultModelPayload(providerFilter);
    const warnings: string[] = [];

    if (providerFilter && DEFAULT_ONLY_MODEL_DISCOVERY_PROVIDERS.has(providerFilter)) {
      res.json({ models: fallbackModels, source: 'defaults' });
      return;
    }

    if (providerFilter === 'google-antigravity') {
      let readiness: Awaited<ReturnType<typeof getNativeProviderReadiness>> | null = null;
      if (exactNativeCatalog) {
        readiness = await getNativeProviderReadiness('GEMINI', { force: true });
        if (readiness.state !== 'live_verified' || !readiness.usable) {
          res.status(readiness.state === 'needs_login' ? 409 : 503).json({
            error: readiness.message,
            source: 'native-cli',
            exact: true,
            readiness,
          });
          return;
        }
        // Exact setup handoff must reflect the current account, not a model
        // list cached before re-authentication.
        invalidateAntigravityModelCache();
      }
      const antigravityModels = listAntigravityModelsFromCli();
      if (antigravityModels.length) {
        const models = exactNativeCatalog
          ? antigravityModels.map((model) => ({
            id: `google-antigravity/${model.id}`,
            name: model.displayName,
            provider: providerFilter,
          }))
          : normalizeModelPayload(
            antigravityModels.map((model) => ({
              id: `google-antigravity/${model.id}`,
              name: model.displayName,
            })),
            providerFilter,
          ).filter((model) => matchesProviderModel(providerFilter, model.id || model.name || ''));
        res.json({ models, source: 'native-cli', ...(exactNativeCatalog ? { exact: true, readiness } : {}) });
        return;
      }
      if (exactNativeCatalog) {
        res.status(503).json({
          error: 'Antigravity is authenticated, but its exact model catalog could not be loaded. Retry before choosing an Agent Chat model.',
          source: 'native-cli',
          exact: true,
          readiness,
        });
        return;
      }
      warnings.push('Antigravity native model list unavailable; using defaults.');
    }

    // xAI transports pass registered model ids through, and the save path
    // registers + live-probes whatever is chosen — so Portal-curated catalog
    // models must stay selectable even when the gateway only has the models a
    // previous setup already registered (e.g. Grok 4.5 next to grok-4.3).
    const withCuratedXaiModels = (models: any[]): any[] => {
      if (providerFilter !== 'xai') return models;
      const seen = new Set(models.map((model) => String(model?.id || '').toLowerCase()).filter(Boolean));
      return [
        ...models,
        ...fallbackModels.filter((model) => {
          const id = String(model?.id || '').toLowerCase();
          return id && !seen.has(id);
        }),
      ];
    };

    try {
      const rpcResult = await listGatewayModels();
      if (rpcResult.ok) {
        let models = normalizeModelPayload(rpcResult.models || [], providerFilter);
        if (providerFilter) models = models.filter((model) => matchesProviderModel(providerFilter, model.id || model.name || ''));
        models = withCuratedXaiModels(models);
        res.json({ models: models.length ? models : fallbackModels, source: models.length ? 'gateway' : 'defaults' });
        return;
      }
      if (rpcResult.error) warnings.push(`Gateway model catalog unavailable: ${rpcResult.error}`);
    } catch (error: any) {
      warnings.push(`Gateway model catalog unavailable: ${error?.message || String(error)}`);
    }

    try {
      const cliModels = JSON.parse(runOpenClaw(['models', 'list', '--json'], 20000));
      let models = normalizeModelPayload(Array.isArray(cliModels) ? cliModels : cliModels.models || [], providerFilter);
      if (providerFilter) models = models.filter((model) => matchesProviderModel(providerFilter, model.id || model.name || ''));
      models = withCuratedXaiModels(models);
      res.json({ models: models.length ? models : fallbackModels, source: models.length ? 'cli' : 'defaults', warnings });
      return;
    } catch (error: any) {
      warnings.push(`OpenClaw model list unavailable: ${error?.message || 'Failed to list models'}`);
    }

    // Setup must be able to proceed before OpenClaw is fully configured. Model
    // discovery is a convenience, not a wizard-blocking prerequisite; the UI can
    // render static provider defaults and let the save path register models after
    // auth completes.
    res.json({ models: fallbackModels, source: 'defaults', warnings });
  });

  router.delete('/provider/:id', async (req: Request, res: Response) => {
    const providerId = String(req.params.id || '').trim().toLowerCase();
    const providerMeta = getAiProviderMeta(providerId);
    if (!providerMeta) {
      res.status(404).json({
        success: false,
        code: 'PROVIDER_NOT_FOUND',
        error: 'That configured AI provider is not known to this Portal build.',
      });
      return;
    }
    const capability = getProviderRemovalCapability(providerId);
    if (!capability.supported) {
      res.status(409).json({
        success: false,
        code: 'PROVIDER_REMOVAL_UNSUPPORTED',
        error: `${providerMeta.name} cannot be disconnected safely from Portal. ${capability.reason}`,
      });
      return;
    }
    const parsed = removeProviderSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.confirmationProvider !== providerId) {
      res.status(400).json({
        success: false,
        code: 'INVALID_PROVIDER_REMOVAL_REQUEST',
        error: `Type the exact provider id "${providerId}" to confirm this disconnect request.`,
      });
      return;
    }

    const ownerId = getOAuthRequestOwnerId(req);
    const targetNamespace = getCredentialLifecycleNamespaceForOpenClawProvider(providerId);
    const requestFingerprint = createHash('sha256').update(JSON.stringify({
      version: 1,
      providerId,
      confirmationProvider: parsed.data.confirmationProvider,
      credentialSurface: 'portal-owned-api-key',
    })).digest('hex');
    const resultFingerprint = createHash('sha256').update(JSON.stringify({
      version: 1,
      providerId,
      disconnected: true,
      credentialSurface: 'portal-owned-api-key',
    })).digest('hex');
    let claim: ClaimedProviderCredentialLifecycle | null = null;
    let mutationMayHaveStarted = false;
    let changed = false;
    let beforeRollback: FileSnapshot[] = [];
    let expectedRollbackState: FileSnapshot[] = [];

    try {
      const admission = claimProviderCredentialRemovalOperationLifecycle(
        targetNamespace,
        ownerId,
        parsed.data.operationId,
        requestFingerprint,
        resultFingerprint,
        {
          allowedTargetCredentialScopes: ['portal-json'],
          operationKind: 'provider-removal-portal-api-key',
          operationCredentialScope: 'combined-domain',
          snapshotExistingTarget: true,
          takeOverParkedWrite: true,
        },
      );
      if (admission.disposition === 'completed') {
        res.json({
          success: true,
          provider: providerId,
          disconnected: true,
          alreadyAbsent: true,
          replayed: true,
        });
        return;
      }
      claim = admission.claim;
      assertProviderRemovalLease(claim);

      const initialGatewaySnapshot = await readGatewayConfigSnapshot();
      const initialInventory = await readPortalOwnedApiKeyRemovalInventory(providerId, initialGatewaySnapshot);
      const initialPreflight = classifyPortalOwnedApiKeyRemoval(providerId, initialInventory);
      if (!initialPreflight.allowed) {
        throw new ProviderRemovalPreflightBlockedError(
          'The provider credential inventory is not an exact Portal-owned API-key configuration.',
        );
      }

      const configBefore = captureFileSnapshot(CONFIG_PATH);
      const fileMutation = applyPortalOwnedProviderFileRemoval(providerId);
      changed = fileMutation.changed;
      beforeRollback = [...fileMutation.before, configBefore];
      expectedRollbackState = [...fileMutation.after, configBefore];

      // From this point a lost control-plane response could conceal a committed
      // config patch. Treat the operation as mutation-bearing until exact
      // readback either releases the fence or rollback proves restoration.
      mutationMayHaveStarted = true;
      const configMutation = await applyProviderRemovalConfigPatch({
        aliases: new Set([providerId]),
        initialSnapshot: initialGatewaySnapshot,
        assertLease: () => assertProviderRemovalLease(claim!),
        revalidate: async (snapshot) => {
          assertProviderRemovalLease(claim!);
          if (!fileMutation.after.every(fileSnapshotMatchesCurrent)) {
            throw new DurableCredentialLifecycleRecoveryRequiredError(
              'Portal-owned provider files changed while OpenClaw configuration was being updated.',
            );
          }
          const inventory = await readPortalOwnedApiKeyRemovalInventory(providerId, snapshot);
          const preflight = classifyPortalOwnedApiKeyRemoval(providerId, inventory);
          if (!preflight.allowed) {
            throw new ProviderRemovalPreflightBlockedError(
              'The provider credential inventory changed during disconnect preflight.',
            );
          }
        },
      });
      changed = changed || configMutation.patched;
      expectedRollbackState = [
        ...fileMutation.after,
        captureFileSnapshot(CONFIG_PATH),
      ];
      assertProviderRemovalLease(claim);

      if (changed) {
        await restartGateway();
        if (!(await fetchGatewayHealth())) {
          throw new ProviderRemovalControlPlaneUnavailableError(
            'The OpenClaw gateway did not become healthy after provider removal.',
          );
        }
      }

      const released = await verifyAndReleaseProviderCredentialRemovalLifecycle(
        claim,
        targetNamespace,
        () => readPortalOwnedProviderRemovalProof(providerId),
        {
          expectedPresence: 'absent',
          proofCredentialScope: 'combined-domain',
          stableReads: 3,
          intervalMs: 100,
          completionReceipt: {
            ownerId,
            operationId: parsed.data.operationId,
            requestFingerprint,
            resultFingerprint,
          },
        },
      );
      if (!released) {
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'Portal could not prove stable provider absence after the disconnect transaction.',
        );
      }

      res.json({
        success: true,
        provider: providerId,
        disconnected: true,
        alreadyAbsent: !changed,
      });
    } catch (error: any) {
      let rollbackVerified = false;
      let recoveryRequired = false;

      if (claim && mutationMayHaveStarted && beforeRollback.length > 0 && expectedRollbackState.length > 0) {
        try {
          restoreSnapshotsWithCompareAndSwap(beforeRollback, expectedRollbackState);
          await restartGateway();
          if (!(await fetchGatewayHealth())) {
            throw new Error('gateway health did not recover after rollback');
          }
          rollbackVerified = await verifyAndReleaseProviderCredentialRemovalLifecycle(
            claim,
            targetNamespace,
            () => readPortalOwnedProviderRemovalProof(providerId),
            {
              expectedPresence: 'present',
              proofCredentialScope: 'combined-domain',
              stableReads: 3,
              intervalMs: 100,
            },
          );
          recoveryRequired = !rollbackVerified;
        } catch {
          recoveryRequired = true;
        }
      } else if (claim) {
        if (shouldParkProviderRemovalFailure(claim, false)) {
          recoveryRequired = true;
        } else {
          releaseProviderCredentialLifecycle(claim);
        }
      }

      if (claim && recoveryRequired) parkProviderCredentialRemovalLifecycle(claim);
      const operationNotAdmitted = !claim
        && error instanceof DurableCredentialOperationEnvelopeMismatchError;
      const code = operationNotAdmitted
        ? 'PROVIDER_REMOVAL_OPERATION_MISMATCH'
        : recoveryRequired
        ? 'PROVIDER_REMOVAL_RECOVERY_REQUIRED'
        : rollbackVerified
          ? 'PROVIDER_REMOVAL_ROLLED_BACK'
          : error instanceof ProviderRemovalPreflightBlockedError
            ? error.code
            : error?.code === 'PROVIDER_CREDENTIAL_LIFECYCLE_CONFLICT'
              ? 'PROVIDER_REMOVAL_BUSY'
              : error instanceof ProviderRemovalControlPlaneUnavailableError
                ? error.code
                : 'PROVIDER_REMOVAL_FAILED';
      const statusCode = recoveryRequired
        ? 409
        : operationNotAdmitted
          ? 409
        : rollbackVerified
          ? 503
          : error instanceof ProviderRemovalPreflightBlockedError
            ? 409
            : Number(error?.statusCode) === 409 || Number(error?.statusCode) === 503
              ? Number(error.statusCode)
              : 500;
      console.error('[AI-Setup] provider removal failed', {
        provider: providerId,
        code,
        mutationMayHaveStarted,
        rollbackVerified,
      });
      res.status(statusCode).json({
        success: false,
        code,
        error: recoveryRequired
          ? 'Portal could not prove removal or rollback after the provider state changed. The credential domain is locked for exact-operation retry or reviewed maintenance.'
          : rollbackVerified
            ? 'Provider disconnect did not complete, and Portal restored the prior configuration. Retry the same disconnect request.'
            : error instanceof ProviderRemovalPreflightBlockedError
              ? 'Portal refused disconnect because the live provider inventory is not an exact Portal-owned API-key configuration. No unsupported credential surface was changed.'
              : error?.code === 'PROVIDER_CREDENTIAL_LIFECYCLE_CONFLICT'
                ? 'Another credential operation currently owns this provider. Finish it before disconnecting the provider.'
                : 'Provider disconnect could not complete safely. No credential detail was exposed.',
        ...(operationNotAdmitted ? { operationDisposition: 'not_admitted' } : {}),
        ...(recoveryRequired ? { operationDisposition: 'retained' } : {}),
      });
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
    const { provider, forceReauth } = req.body;
    if (!['claude-code', 'codex', 'gemini', 'grok'].includes(provider)) {
      res.status(400).json({ error: 'Invalid native CLI provider' });
      return;
    }

    try {
      const ownerId = getOAuthRequestOwnerId(req);
      const result = await startNativeCliFlow(provider, {
        forceReauth: provider === 'gemini' && forceReauth === true,
        ownerId,
      });
      if (result.status === 'complete') {
        await finalizeNativeCliCompletion(getOAuthFlowStatus(result.sessionId, ownerId));
      }
      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error(`[NativeCLI] start error for ${provider}:`, error.message);
      res.status(providerSetupErrorStatus(error))
        .json(oauthStartFailurePayload(error, 'Failed to start native CLI flow'));
    }
  });

  router.get('/native-cli/status/:sessionId', async (req: Request, res: Response) => {
    const status = getOAuthFlowStatus(req.params.sessionId, getOAuthRequestOwnerId(req));
    if (!status) {
      res.status(404).json({ error: 'Native CLI session not found' });
      return;
    }

    if (status.status === 'complete') {
      try {
        await finalizeNativeCliCompletion(status);
      } catch (error: any) {
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
      const ownerId = getOAuthRequestOwnerId(req);
      const result = await completeNativeCliFlow(sessionId, callbackUrl, ownerId);
      if (result?.success) {
        try {
          const status = getOAuthFlowStatus(sessionId, ownerId);
          await finalizeNativeCliCompletion(status);
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
      const notFound = error?.message === 'Native CLI session not found';
      if (!notFound) console.error('[NativeCLI] callback error:', error.message);
      res.status(notFound ? 404 : 500).json({
        success: false,
        error: error?.message || 'Failed to complete native CLI flow',
      });
    }
  });

  return router;
}

export default createAiSetupRouter;
