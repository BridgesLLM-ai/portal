import fs from 'fs';
import path from 'path';
import type { AgentProviderName } from './AgentProvider.interface';

export type NativeCliAuthState = 'not_applicable' | 'authenticated' | 'needs_login' | 'unknown';

export interface NativeCliAuthStatus {
  provider: AgentProviderName;
  status: NativeCliAuthState;
  message: string;
  loginCommand?: string;
  requiresSeparateLogin: boolean;
}

import { getPortalApiKeysForEnv } from '../services/openclawConfigManager';

const HOME_DIR = process.env.HOME || '/root';
const CLAUDE_CREDENTIALS_PATH = path.join(HOME_DIR, '.claude', '.credentials.json');
const CODEX_AUTH_PATH = path.join(HOME_DIR, '.codex', 'auth.json');
const GEMINI_CONFIG_DIR = path.join(HOME_DIR, '.config', 'gemini');
const GEMINI_OAUTH_CREDS_PATH = path.join(HOME_DIR, '.gemini', 'oauth_creds.json');

const NATIVE_TO_OPENCLAW_PROVIDER_IDS: Record<AgentProviderName, string[]> = {
  OPENCLAW: [],
  CLAUDE_CODE: ['anthropic'],
  CODEX: ['openai-codex'],
  AGENT_ZERO: [],
  GEMINI: ['google-gemini-cli', 'google'],
  OLLAMA: [],
};

const OPENCLAW_TO_NATIVE_PROVIDER: Record<string, AgentProviderName> = {
  anthropic: 'CLAUDE_CODE',
  'openai-codex': 'CODEX',
  'google-gemini-cli': 'GEMINI',
  google: 'GEMINI',
};

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

function fileHasJsonKey(targetPath: string, keys: string[]): boolean {
  const parsed = safeReadJson(targetPath);
  if (!parsed) return false;
  for (const key of keys) {
    const value = key.split('.').reduce<any>((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), parsed);
    if (typeof value === 'string' && value.trim()) return true;
  }
  return false;
}

function hasEnvValue(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

function detectClaudeAuth(): NativeCliAuthStatus {
  const creds = safeReadJson(CLAUDE_CREDENTIALS_PATH);
  const oauth = creds?.claudeAiOauth;
  const hasToken = Boolean(oauth?.accessToken || oauth?.refreshToken);
  const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null;

  if (hasToken && (!expiresAt || expiresAt > Date.now())) {
    return {
      provider: 'CLAUDE_CODE',
      status: 'authenticated',
      message: 'Claude Code CLI is logged in on this server.',
      loginCommand: 'claude',
      requiresSeparateLogin: true,
    };
  }

  // If access token expired but refresh token exists, Claude Code will auto-refresh on next invocation.
  // Treat this as authenticated — the CLI handles token refresh transparently.
  if (expiresAt && expiresAt <= Date.now() && oauth?.refreshToken) {
    return {
      provider: 'CLAUDE_CODE',
      status: 'authenticated',
      message: 'Claude Code CLI has a refresh token and will auto-renew on next use.',
      loginCommand: 'claude',
      requiresSeparateLogin: true,
    };
  }

  if (expiresAt && expiresAt <= Date.now()) {
    return {
      provider: 'CLAUDE_CODE',
      status: 'needs_login',
      message: 'Claude Code CLI credentials on this server have expired. OpenClaw auth is separate.',
      loginCommand: 'claude',
      requiresSeparateLogin: true,
    };
  }

  // Check if portal has an Anthropic API key that the CLI can use as fallback
  const portalKeys = getPortalApiKeysForEnv('CLAUDE_CODE');
  if (portalKeys.ANTHROPIC_API_KEY) {
    return {
      provider: 'CLAUDE_CODE',
      status: 'authenticated',
      message: 'Claude Code CLI will use the portal-configured Anthropic API key.',
      loginCommand: 'claude',
      requiresSeparateLogin: false,
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
  const auth = safeReadJson(CODEX_AUTH_PATH);
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

  // Check if portal has an OpenAI API key that the CLI can use as fallback
  const codexPortalKeys = getPortalApiKeysForEnv('CODEX');
  if (codexPortalKeys.OPENAI_API_KEY) {
    return {
      provider: 'CODEX',
      status: 'authenticated',
      message: 'Codex CLI will use the portal-configured OpenAI API key.',
      loginCommand: 'codex auth',
      requiresSeparateLogin: false,
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

function detectGeminiAuth(): NativeCliAuthStatus {
  if (hasEnvValue('GEMINI_API_KEY') || hasEnvValue('GOOGLE_API_KEY')) {
    return {
      provider: 'GEMINI',
      status: 'authenticated',
      message: 'Gemini CLI can authenticate from the current service environment.',
      loginCommand: 'gemini',
      requiresSeparateLogin: true,
    };
  }

  if (fileHasJsonKey(GEMINI_OAUTH_CREDS_PATH, ['access_token', 'refresh_token']) || directoryHasEntries(GEMINI_CONFIG_DIR)) {
    return {
      provider: 'GEMINI',
      status: 'authenticated',
      message: 'Gemini CLI has local auth/config files on this server.',
      loginCommand: 'gemini',
      requiresSeparateLogin: true,
    };
  }

  // Check if portal has a Google/Gemini API key that the CLI can use as fallback
  const geminiPortalKeys = getPortalApiKeysForEnv('GEMINI');
  if (geminiPortalKeys.GEMINI_API_KEY || geminiPortalKeys.GOOGLE_API_KEY) {
    return {
      provider: 'GEMINI',
      status: 'authenticated',
      message: 'Gemini CLI will use the portal-configured Google API key.',
      loginCommand: 'gemini',
      requiresSeparateLogin: false,
    };
  }

  return {
    provider: 'GEMINI',
    status: 'needs_login',
    message: 'Gemini is installed, but the local Gemini CLI has no usable auth. Start `gemini` and choose Google sign-in, or provide `GEMINI_API_KEY` / `GOOGLE_API_KEY` to the service. OpenClaw auth is separate.',
    loginCommand: 'gemini',
    requiresSeparateLogin: true,
  };
}

export function getNativeCliAuthStatus(provider: AgentProviderName): NativeCliAuthStatus {
  switch (provider) {
    case 'CLAUDE_CODE':
      return detectClaudeAuth();
    case 'CODEX':
      return detectCodexAuth();
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
      return {
        provider,
        status: 'unknown',
        message: 'Agent Zero auth could not be determined.',
        requiresSeparateLogin: false,
      };
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

export function getLinkedOpenClawProviderIds(nativeProvider: AgentProviderName): string[] {
  return NATIVE_TO_OPENCLAW_PROVIDER_IDS[nativeProvider] || [];
}

export function getNativeProviderLinkedToOpenClawProvider(providerId: string): AgentProviderName | null {
  return OPENCLAW_TO_NATIVE_PROVIDER[providerId] || null;
}

export function nativeCliAuthBlocksUsage(status: NativeCliAuthStatus | null | undefined): boolean {
  return status?.status === 'needs_login';
}
