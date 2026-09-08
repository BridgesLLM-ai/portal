import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'fs';
import path from 'path';
import type { AgentProviderName } from '../../../AgentProvider.interface';
import { buildNativeCliEnvironment } from '../NativeCliEnvironment';

type AcpProviderName = Extract<AgentProviderName, 'GROK' | 'HERMES' | 'OPENCODE'>;

const SAFE_BASE_ENV_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
] as const;

function dedicatedRootPath(
  provider: Exclude<AcpProviderName, 'GROK'>,
  source: NodeJS.ProcessEnv,
): string {
  const overrideKey = provider === 'HERMES' ? 'PORTAL_HERMES_HOME' : 'PORTAL_OPENCODE_HOME';
  const fallback = provider === 'HERMES'
    ? '/var/lib/bridgesllm/hermes'
    : '/var/lib/bridgesllm/opencode';
  const raw = String(source[overrideKey] || fallback).trim();
  if (!path.isAbsolute(raw)) throw new Error(`${overrideKey} must be an absolute path`);
  return path.resolve(raw);
}

function resolveDedicatedRoot(
  provider: Exclude<AcpProviderName, 'GROK'>,
  source: NodeJS.ProcessEnv,
): string {
  const overrideKey = provider === 'HERMES' ? 'PORTAL_HERMES_HOME' : 'PORTAL_OPENCODE_HOME';
  const resolved = dedicatedRootPath(provider, source);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${overrideKey} must identify a real directory`);
  }
  chmodSync(resolved, 0o700);
  return realpathSync(resolved);
}

function ensurePrivateDirectory(parent: string, name: string): string {
  const directory = path.resolve(parent, name);
  if (path.dirname(directory) !== path.resolve(parent)) {
    throw new Error('ACP harness state path escaped its dedicated root');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('ACP harness state path is not a real directory');
  }
  chmodSync(directory, 0o700);
  return realpathSync(directory);
}

function baseEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_BASE_ENV_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  env.PATH ||= '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  env.NO_COLOR = '1';
  return env;
}

/**
 * ACP harnesses never inherit the Portal service environment. Hermes and
 * OpenCode receive dedicated HOME/XDG roots so their own login/config flows
 * remain isolated from OpenClaw and from one another.
 */
export function buildAcpHarnessEnvironment(
  provider: AcpProviderName,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (provider === 'GROK') return buildNativeCliEnvironment('GROK', source);

  const root = resolveDedicatedRoot(provider, source);
  const home = ensurePrivateDirectory(root, 'home');
  const config = ensurePrivateDirectory(root, 'config');
  const cache = ensurePrivateDirectory(root, 'cache');
  const data = ensurePrivateDirectory(root, 'data');
  const env = baseEnvironment(source);
  env.HOME = home;
  env.XDG_CONFIG_HOME = config;
  env.XDG_CACHE_HOME = cache;
  env.XDG_DATA_HOME = data;

  if (provider === 'HERMES') {
    env.HERMES_HOME = root;
    env.HERMES_DISABLE_LAZY_INSTALLS = '1';
    env.HERMES_ACP_SKIP_CONFIGURED_MCP = '1';
  } else {
    env.OPENCODE_DISABLE_AUTOUPDATE = '1';
    env.OPENCODE_DISABLE_LSP_DOWNLOAD = '1';
    env.OPENCODE_DISABLE_SHARE = '1';
  }
  return env;
}

export function resolveAcpHarnessCredentialPaths(
  provider: Extract<AcpProviderName, 'HERMES' | 'OPENCODE'>,
  source: NodeJS.ProcessEnv = process.env,
): string[] {
  const root = dedicatedRootPath(provider, source);
  if (provider === 'HERMES') {
    return [
      path.join(root, 'auth.json'),
      path.join(root, '.env'),
      path.join(root, 'config.yaml'),
    ];
  }
  return [path.join(root, 'data', 'opencode', 'auth.json')];
}

/**
 * State whose content can change whether a previously admitted ACP harness is
 * usable. Host readiness must invalidate when provider/model routing changes.
 * Project Chat does not receive these reusable harness credentials.
 */
export function resolveAcpHarnessReadinessPaths(
  provider: Extract<AcpProviderName, 'HERMES' | 'OPENCODE'>,
  source: NodeJS.ProcessEnv = process.env,
): string[] {
  const credentials = resolveAcpHarnessCredentialPaths(provider, source);
  if (provider === 'HERMES') return credentials;
  const root = dedicatedRootPath(provider, source);
  const configRoot = path.join(root, 'config', 'opencode');
  return [
    ...credentials,
    path.join(configRoot, 'opencode.json'),
    path.join(configRoot, 'opencode.jsonc'),
  ];
}
