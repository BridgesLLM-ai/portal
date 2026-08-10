import fs from 'fs';
import path from 'path';
import type { AgentProviderName } from '../../AgentProvider.interface';

const COMMON_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
] as const;

const PROVIDER_ENV_KEYS: Partial<Record<AgentProviderName, readonly string[]>> = {
  CLAUDE_CODE: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
  CODEX: ['OPENAI_API_KEY', 'CODEX_HOME'],
  GEMINI: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
  GROK: ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY', 'GROK_DEPLOYMENT_KEY', 'GROK_AUTH', 'GROK_AUTH_PATH', 'GROK_HOME'],
};

export function resolveNativeCliCredentialPaths(
  providerName: AgentProviderName,
  source: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = String(source.HOME || '/root');
  if (providerName === 'CLAUDE_CODE') {
    const configDir = String(source.CLAUDE_CONFIG_DIR || '').trim() || path.join(home, '.claude');
    return [path.join(configDir, '.credentials.json')];
  }
  if (providerName === 'CODEX') {
    const codexHome = String(source.CODEX_HOME || '').trim() || path.join(home, '.codex');
    return [path.join(codexHome, 'auth.json')];
  }
  if (providerName === 'GEMINI') {
    // Attest only credential-bearing state, never the CLI's whole working
    // tree. ~/.gemini/antigravity-cli also holds the self-updating binary
    // under bin/ (~18 MB), logs, caches, and a conversation database, so a
    // whole-directory walk outgrows any fixed attestation budget as soon as
    // the tool is actually used — which surfaced as every Google sign-in
    // being refused before it started.
    const antigravityDir = path.join(home, '.gemini', 'antigravity-cli');
    const paths = [
      path.join(antigravityDir, 'jetski_state.pbtxt'),
      path.join(antigravityDir, 'settings.json'),
      path.join(antigravityDir, 'installation_id'),
      path.join(home, '.gemini', 'config', 'config.json'),
    ];
    const applicationCredentials = String(source.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
    if (applicationCredentials) paths.push(applicationCredentials);
    return paths;
  }
  if (providerName === 'GROK') {
    const explicit = String(source.GROK_AUTH_PATH || '').trim();
    if (explicit) return [explicit];
    const grokHome = String(source.GROK_HOME || '').trim() || path.join(home, '.grok');
    return [path.join(grokHome, 'auth.json')];
  }
  return [];
}

function localClaudeOauthPresent(source: NodeJS.ProcessEnv): boolean {
  try {
    const [credentialsPath] = resolveNativeCliCredentialPaths('CLAUDE_CODE', source);
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    return Boolean(parsed?.claudeAiOauth?.accessToken || parsed?.claudeAiOauth?.refreshToken);
  } catch {
    return false;
  }
}

/**
 * Native coding CLIs must never inherit the Portal service environment. Only
 * OS process basics and credentials belonging to the selected provider cross
 * this boundary.
 */
export function buildNativeCliEnvironment(
  providerName: AgentProviderName,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...COMMON_ENV_KEYS, ...(PROVIDER_ENV_KEYS[providerName] || [])]) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }

  env.PATH ||= '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  env.HOME ||= '/root';
  env.NO_COLOR = '1';

  if (providerName === 'CLAUDE_CODE' && localClaudeOauthPresent(source)) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  if (providerName === 'GROK') env.GROK_DISABLE_AUTOUPDATER = '1';
  if (providerName === 'GEMINI') {
    env.AGY_CLI_DISABLE_AUTO_UPDATE = '1';
    env.SSH_CONNECTION = source.SSH_CONNECTION || 'portal-native-check 127.0.0.1 127.0.0.1 0';
  }
  return env;
}
