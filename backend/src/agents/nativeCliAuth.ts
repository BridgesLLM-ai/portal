import fs from 'fs';
import { execFile } from 'child_process';
import type { AgentProviderName } from './AgentProvider.interface';
import { getAgentZeroAuthReadinessSnapshot } from './providers/agentZero/AgentZeroAuthSession';
import {
  buildNativeCliEnvironment,
  resolveNativeCliCredentialPaths,
} from './providers/native/NativeCliEnvironment';

export type NativeCliAuthState = 'not_applicable' | 'authenticated' | 'needs_login' | 'unknown';

export interface NativeCliAuthStatus {
  provider: AgentProviderName;
  status: NativeCliAuthState;
  message: string;
  loginCommand?: string;
  requiresSeparateLogin: boolean;
}

const NATIVE_TO_OPENCLAW_PROVIDER_IDS: Record<AgentProviderName, string[]> = {
  OPENCLAW: [],
  CLAUDE_CODE: ['anthropic'],
  CODEX: ['openai-codex'],
  GROK: ['xai'],
  AGENT_ZERO: [],
  // Antigravity is Portal's native GEMINI harness. OpenClaw's Gemini CLI
  // OAuth provider has a separate credential store and setup flow.
  GEMINI: ['google-antigravity'],
  OLLAMA: [],
};

const OPENCLAW_TO_NATIVE_PROVIDER: Record<string, AgentProviderName> = {
  anthropic: 'CLAUDE_CODE',
  'openai-codex': 'CODEX',
  xai: 'GROK',
  'google-antigravity': 'GEMINI',
};

let cachedGeminiAuth: { expiresAt: number; status: NativeCliAuthStatus } | null = null;
let pendingGeminiAuth: Promise<NativeCliAuthStatus> | null = null;
let geminiAuthEpoch = 0;

function safeReadJson(targetPath: string): any | null {
  try {
    if (!fs.existsSync(targetPath)) return null;
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    return null;
  }
}

function directoryHasEntries(targetPath: string): boolean {
  try {
    return fs.readdirSync(targetPath).length > 0;
  } catch {
    return false;
  }
}

function hasEnvValue(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

function runAntigravityModelsAsync(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = execFile('agy', ['models'], {
      encoding: 'utf8',
      env: buildNativeCliEnvironment('GEMINI'),
      timeout: 8000,
      maxBuffer: 1024 * 1024 * 2,
    }, (error, stdout, stderr) => {
      const output = `${stdout || ''}\n${stderr || ''}`.trim();
      resolve({ ok: !error, output });
    });
    // `agy models` is a non-interactive probe. Explicit EOF prevents a changed
    // or misbehaving CLI from waiting on the Portal service's inherited stdin.
    child?.stdin?.end();
  });
}

function cacheGeminiAuthStatus(
  status: NativeCliAuthStatus,
  ttlMs: number,
  expectedEpoch = geminiAuthEpoch,
): NativeCliAuthStatus {
  if (expectedEpoch === geminiAuthEpoch) {
    cachedGeminiAuth = { status, expiresAt: Date.now() + ttlMs };
  }
  return status;
}

function classifyGeminiAuthProbe(
  agy: { ok: boolean; output: string },
  expectedEpoch = geminiAuthEpoch,
): NativeCliAuthStatus {
  if (agy.ok) {
    return cacheGeminiAuthStatus({
      provider: 'GEMINI',
      status: 'authenticated',
      message: 'Google Antigravity is authenticated on this server.',
      loginCommand: 'agy',
      requiresSeparateLogin: true,
    }, 60_000, expectedEpoch);
  }

  if (/please sign in|not signed in|authentication required|launch the cli without arguments to sign in/i.test(agy.output)) {
    return cacheGeminiAuthStatus({
      provider: 'GEMINI',
      status: 'needs_login',
      message: 'Google Antigravity is installed, but it is not signed in on this server. OpenClaw auth is separate.',
      loginCommand: 'agy',
      requiresSeparateLogin: true,
    }, 5_000, expectedEpoch);
  }

  const [antigravityConfigDir] = resolveNativeCliCredentialPaths('GEMINI');
  if (directoryHasEntries(antigravityConfigDir)) {
    return cacheGeminiAuthStatus({
      provider: 'GEMINI',
      status: 'unknown',
      message: 'Google Antigravity has config files on this server, but the portal could not verify a usable login.',
      loginCommand: 'agy',
      requiresSeparateLogin: true,
    }, 5_000, expectedEpoch);
  }

  return cacheGeminiAuthStatus({
    provider: 'GEMINI',
    status: 'needs_login',
    message: 'Google Antigravity is installed, but the local `agy` CLI has no usable auth. Start `agy` and complete Google sign-in. OpenClaw auth is separate.',
    loginCommand: 'agy',
    requiresSeparateLogin: true,
  }, 5_000, expectedEpoch);
}

function detectClaudeAuth(): NativeCliAuthStatus {
  const [credentialsPath] = resolveNativeCliCredentialPaths('CLAUDE_CODE');
  const creds = safeReadJson(credentialsPath);
  const oauth = creds?.claudeAiOauth;
  const hasAccessToken = Boolean(oauth?.accessToken);
  const hasRefreshToken = Boolean(oauth?.refreshToken);
  const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null;

  // Claude Code refreshes an expired access token itself when a refresh token
  // is present. Treating expiresAt alone as terminal disabled a credential
  // that the exact confined CLI could use successfully.
  if (hasRefreshToken || (hasAccessToken && (!expiresAt || expiresAt > Date.now()))) {
    return {
      provider: 'CLAUDE_CODE',
      status: 'authenticated',
      message: 'Claude Code CLI is logged in on this server.',
      loginCommand: 'claude',
      requiresSeparateLogin: true,
    };
  }

  if (hasAccessToken && expiresAt && expiresAt <= Date.now()) {
    return {
      provider: 'CLAUDE_CODE',
      status: 'needs_login',
      message: 'Claude Code CLI credentials on this server have expired. OpenClaw auth is separate.',
      loginCommand: 'claude',
      requiresSeparateLogin: true,
    };
  }

  return {
    provider: 'CLAUDE_CODE',
    status: 'needs_login',
    message: 'Claude Code is installed, but the local Claude CLI is not logged in. Start `claude`, then run `/login` on the server.',
    loginCommand: 'claude',
    requiresSeparateLogin: true,
  };
}

function detectCodexAuth(): NativeCliAuthStatus {
  const [authPath] = resolveNativeCliCredentialPaths('CODEX');
  const auth = safeReadJson(authPath);
  const apiKey = typeof auth?.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY.trim() : '';
  const tokenSet = auth?.tokens;
  const hasOauthTokens = Boolean(tokenSet?.access_token || tokenSet?.refresh_token || tokenSet?.id_token);

  if (apiKey || hasOauthTokens) {
    return {
      provider: 'CODEX',
      status: 'authenticated',
      message: 'Codex CLI is authenticated on this server.',
      loginCommand: 'codex auth',
      requiresSeparateLogin: true,
    };
  }

  return {
    provider: 'CODEX',
    status: 'needs_login',
    message: 'Codex is installed, but the local Codex CLI is not authenticated. Run `codex auth` on the server. OpenClaw OAuth is separate.',
    loginCommand: 'codex auth',
    requiresSeparateLogin: true,
  };
}

type GrokAuthClassification = 'authenticated' | 'needs_login' | 'unknown';

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function parseExpiryMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Pure classifier exported for credential-shape regression tests. */
export function classifyGrokAuthStore(raw: unknown, now = Date.now()): GrokAuthClassification {
  const store = asRecord(raw);
  if (!store) return 'unknown';

  const directCredential = typeof store.key === 'string' || typeof store.refresh_token === 'string';
  const candidates = directCredential
    ? [['direct', store] as const]
    : Object.entries(store).map(([scope, value]) => [scope, asRecord(value)] as const);

  if (candidates.length === 0) return 'needs_login';
  let sawCredentialShape = false;
  let sawExpiredCredential = false;

  for (const [scope, credential] of candidates) {
    if (!credential) continue;
    const key = typeof credential.key === 'string' ? credential.key.trim() : '';
    const refreshToken = typeof credential.refresh_token === 'string' ? credential.refresh_token.trim() : '';
    const authMode = String(credential.auth_mode || '').trim().toLowerCase();
    const expiresAt = parseExpiryMs(credential.expires_at);
    if (!key && !refreshToken) continue;
    sawCredentialShape = true;

    // API keys do not expire locally. OAuth/OIDC credentials remain usable
    // when a refresh token is available even if the current access token aged out.
    if (scope === 'xai::api_key' || authMode === 'api_key' || refreshToken) return 'authenticated';
    if (key && (!expiresAt || expiresAt > now)) return 'authenticated';
    if (key && expiresAt !== null && expiresAt <= now) sawExpiredCredential = true;
  }

  if (sawExpiredCredential || sawCredentialShape) return 'needs_login';
  return 'unknown';
}

function resolveGrokAuthPath(): string {
  return resolveNativeCliCredentialPaths('GROK')[0];
}

function detectGrokAuth(): NativeCliAuthStatus {
  if (hasEnvValue('XAI_API_KEY') || hasEnvValue('GROK_CODE_XAI_API_KEY') || hasEnvValue('GROK_DEPLOYMENT_KEY')) {
    return {
      provider: 'GROK',
      status: 'authenticated',
      message: 'Grok Build has a server-side xAI credential available.',
      loginCommand: 'grok --no-auto-update login --device-auth',
      requiresSeparateLogin: true,
    };
  }

  const inlineAuth = String(process.env.GROK_AUTH || '').trim();
  let classification: GrokAuthClassification;
  if (inlineAuth) {
    try {
      classification = classifyGrokAuthStore(JSON.parse(inlineAuth));
    } catch {
      classification = 'unknown';
    }
  } else {
    const authPath = resolveGrokAuthPath();
    if (!fs.existsSync(authPath)) classification = 'needs_login';
    else {
      try {
        classification = classifyGrokAuthStore(JSON.parse(fs.readFileSync(authPath, 'utf8')));
      } catch {
        classification = 'unknown';
      }
    }
  }

  if (classification === 'authenticated') {
    return {
      provider: 'GROK',
      status: 'authenticated',
      message: 'Grok Build CLI is authenticated on this server.',
      loginCommand: 'grok --no-auto-update login --device-auth',
      requiresSeparateLogin: true,
    };
  }
  if (classification === 'unknown') {
    return {
      provider: 'GROK',
      status: 'unknown',
      message: 'Grok Build has local auth state, but Portal could not safely verify a usable credential.',
      loginCommand: 'grok --no-auto-update login --device-auth',
      requiresSeparateLogin: true,
    };
  }
  return {
    provider: 'GROK',
    status: 'needs_login',
    message: 'Grok Build is installed, but its native CLI is not signed in. Use device login on this server. OpenClaw xAI auth is separate.',
    loginCommand: 'grok --no-auto-update login --device-auth',
    requiresSeparateLogin: true,
  };
}

function detectGeminiAuth(): NativeCliAuthStatus {
  if (cachedGeminiAuth && cachedGeminiAuth.expiresAt > Date.now()) {
    return cachedGeminiAuth.status;
  }

  if (hasEnvValue('GEMINI_API_KEY') || hasEnvValue('GOOGLE_API_KEY')) {
    return cacheGeminiAuthStatus({
      provider: 'GEMINI',
      status: 'authenticated',
      message: 'Google environment credentials are present, but the preferred native Google agent is Antigravity.',
      loginCommand: 'agy',
      requiresSeparateLogin: true,
    }, 60_000);
  }

  const [antigravityConfigDir] = resolveNativeCliCredentialPaths('GEMINI');
  if (directoryHasEntries(antigravityConfigDir)) {
    return {
      provider: 'GEMINI',
      status: 'unknown',
      message: 'Google Antigravity has local config; live authentication is checked asynchronously.',
      loginCommand: 'agy',
      requiresSeparateLogin: true,
    };
  }

  return {
    provider: 'GEMINI',
    status: 'needs_login',
    message: 'Google Antigravity is installed, but the local `agy` CLI has no usable auth. Start `agy` and complete Google sign-in. OpenClaw auth is separate.',
    loginCommand: 'agy',
    requiresSeparateLogin: true,
  };
}

async function detectGeminiAuthAsync(): Promise<NativeCliAuthStatus> {
  if (cachedGeminiAuth && cachedGeminiAuth.expiresAt > Date.now()) {
    return cachedGeminiAuth.status;
  }

  if (hasEnvValue('GEMINI_API_KEY') || hasEnvValue('GOOGLE_API_KEY')) {
    return cacheGeminiAuthStatus({
      provider: 'GEMINI',
      status: 'authenticated',
      message: 'Google environment credentials are present, but the preferred native Google agent is Antigravity.',
      loginCommand: 'agy',
      requiresSeparateLogin: true,
    }, 60_000);
  }

  if (!pendingGeminiAuth) {
    const taskEpoch = geminiAuthEpoch;
    const pending = runAntigravityModelsAsync().then((probe) => {
      const status = classifyGeminiAuthProbe(probe, taskEpoch);
      if (taskEpoch === geminiAuthEpoch) return status;
      return {
        provider: 'GEMINI' as const,
        status: 'unknown' as const,
        message: 'Google Antigravity authentication changed while its live status was being checked.',
        loginCommand: 'agy',
        requiresSeparateLogin: true,
      };
    });
    pendingGeminiAuth = pending;
    const clearPending = () => {
      if (pendingGeminiAuth === pending) pendingGeminiAuth = null;
    };
    void pending.then(clearPending, clearPending);
  }
  return pendingGeminiAuth;
}

export function getNativeCliAuthStatus(provider: AgentProviderName): NativeCliAuthStatus {
  switch (provider) {
    case 'CLAUDE_CODE':
      return detectClaudeAuth();
    case 'CODEX':
      return detectCodexAuth();
    case 'GROK':
      return detectGrokAuth();
    case 'GEMINI':
      return detectGeminiAuth();
    case 'OLLAMA':
      return {
        provider,
        status: 'not_applicable',
        message: 'Ollama runs locally and does not require a cloud login.',
        requiresSeparateLogin: false,
      };
    case 'AGENT_ZERO':
      try {
        const readiness = getAgentZeroAuthReadinessSnapshot();
        return {
          provider,
          status: readiness.state === 'authenticated'
            ? 'authenticated'
            : ['needs_login', 'unconfigured'].includes(readiness.state)
              ? 'needs_login'
              : 'unknown',
          message: readiness.reason,
          requiresSeparateLogin: true,
        };
      } catch {
        return {
          provider,
          status: 'unknown',
          message: 'Agent Zero protected session authentication has not been verified.',
          requiresSeparateLogin: true,
        };
      }
    case 'OPENCLAW':
    default:
      return {
        provider,
        status: 'not_applicable',
        message: 'This provider does not use native CLI auth detection.',
        requiresSeparateLogin: false,
      };
  }
}

export async function getNativeCliAuthStatusAsync(provider: AgentProviderName): Promise<NativeCliAuthStatus> {
  if (provider === 'GEMINI') return detectGeminiAuthAsync();
  return getNativeCliAuthStatus(provider);
}

/**
 * Clear provider-local auth evidence after an explicit login transition or a
 * real provider rejection. Epoching prevents an older in-flight Antigravity
 * probe from repopulating the cache after invalidation.
 */
export function invalidateNativeCliAuthStatus(
  provider: AgentProviderName,
  reason: 'state_changed' | 'auth_rejected' = 'state_changed',
): void {
  if (provider !== 'GEMINI') return;
  geminiAuthEpoch += 1;
  pendingGeminiAuth = null;
  cachedGeminiAuth = reason === 'auth_rejected'
    ? {
        expiresAt: Date.now() + 20_000,
        status: {
          provider: 'GEMINI',
          status: 'needs_login',
          message: 'Google Antigravity authentication was rejected. Reconnect it in AI Settings and retry.',
          loginCommand: 'agy',
          requiresSeparateLogin: true,
        },
      }
    : null;
}

export function getLinkedOpenClawProviderIds(nativeProvider: AgentProviderName): string[] {
  return NATIVE_TO_OPENCLAW_PROVIDER_IDS[nativeProvider] || [];
}

export function getNativeProviderLinkedToOpenClawProvider(providerId: string): AgentProviderName | null {
  return OPENCLAW_TO_NATIVE_PROVIDER[providerId] || null;
}

export function nativeCliAuthBlocksUsage(status: NativeCliAuthStatus | null | undefined): boolean {
  return status?.status === 'needs_login';
}

export function __resetNativeCliAuthForTests(): void {
  geminiAuthEpoch += 1;
  cachedGeminiAuth = null;
  pendingGeminiAuth = null;
}
