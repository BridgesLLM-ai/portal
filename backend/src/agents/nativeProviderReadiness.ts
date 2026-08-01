import { createHash } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { AgentProviderName } from './AgentProvider.interface';
import {
  getNativeCliAuthStatusAsync,
  invalidateNativeCliAuthStatus,
  type NativeCliAuthStatus,
} from './nativeCliAuth';
import {
  buildNativeCliEnvironment,
  resolveNativeCliCredentialPaths,
} from './providers/native/NativeCliEnvironment';
import {
  isNativeProviderAuthFailure,
  redactNativeProviderText,
} from './providers/native/NativeProviderDiagnostics';

export type NativeProviderReadinessState =
  | 'login_present'
  | 'live_verified'
  | 'needs_login'
  | 'runtime_unavailable'
  | 'unknown';

export interface NativeProviderReadiness {
  provider: AgentProviderName;
  state: NativeProviderReadinessState;
  usable: boolean;
  message: string;
  checkedAt: string;
  expiresAt: string;
  credentialFingerprint: string;
  runtimeFingerprint: string;
}

type LiveProbeResult = {
  state: 'live_verified' | 'needs_login' | 'runtime_unavailable' | 'unknown';
  diagnostic?: string;
};

type LiveProbe = (provider: AgentProviderName) => Promise<LiveProbeResult>;

const COMMANDS: Partial<Record<AgentProviderName, { command: string; versionArgs: string[] }>> = {
  CLAUDE_CODE: { command: 'claude', versionArgs: ['--version'] },
  CODEX: { command: 'codex', versionArgs: ['--version'] },
  GEMINI: { command: 'agy', versionArgs: ['--version'] },
  GROK: { command: 'grok', versionArgs: ['--no-auto-update', '--version'] },
};

const cache = new Map<AgentProviderName, NativeProviderReadiness>();
const pending = new Map<string, Promise<NativeProviderReadiness>>();
const testProbes = new Map<AgentProviderName, LiveProbe>();
const rejectedCredentialGenerations = new Map<AgentProviderName, {
  credentialFingerprint: string;
  runtimeFingerprint: string;
  message: string;
}>();
const invalidationListeners = new Set<(provider: AgentProviderName) => void>();
let readinessEpoch = 0;

function notifyInvalidation(provider: AgentProviderName): void {
  for (const listener of invalidationListeners) {
    try { listener(provider); } catch {}
  }
}

function ttlFor(state: NativeProviderReadinessState): number {
  if (state === 'live_verified') return 3 * 60_000;
  if (state === 'login_present') return 2 * 60_000;
  if (state === 'needs_login') return 20_000;
  return 10_000;
}

function result(
  provider: AgentProviderName,
  state: NativeProviderReadinessState,
  message: string,
  credentialFingerprint: string,
  runtimeFingerprint: string,
): NativeProviderReadiness {
  const now = Date.now();
  return {
    provider,
    state,
    usable: state === 'live_verified' || state === 'login_present',
    message,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlFor(state)).toISOString(),
    credentialFingerprint,
    runtimeFingerprint,
  };
}

const CREDENTIAL_FINGERPRINT_MAX_BYTES = 512 * 1024;
const CREDENTIAL_FINGERPRINT_MAX_ENTRIES = 200;
const CREDENTIAL_FINGERPRINT_MAX_DEPTH = 3;

async function hashPath(targetPath: string): Promise<string> {
  try {
    const digest = createHash('sha256').update(targetPath);
    let remainingBytes = CREDENTIAL_FINGERPRINT_MAX_BYTES;
    let remainingEntries = CREDENTIAL_FINGERPRINT_MAX_ENTRIES;

    const appendNode = async (nodePath: string, relativePath: string, depth: number): Promise<void> => {
      const stat = await fs.stat(nodePath);
      const kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
      digest.update(relativePath).update('\u0000').update(kind).update('\u0000');

      if (stat.isFile()) {
        digest.update(String(stat.size)).update('\u0000');
        const bytesToRead = Math.min(stat.size, remainingBytes);
        if (bytesToRead <= 0) return;
        const handle = await fs.open(nodePath, 'r');
        try {
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
          digest.update(buffer.subarray(0, bytesRead));
          remainingBytes -= bytesRead;
        } finally {
          await handle.close();
        }
        return;
      }

      if (!stat.isDirectory()) {
        digest.update(String(stat.size));
        return;
      }

      const entries = (await fs.readdir(nodePath, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (remainingEntries <= 0) {
          digest.update('entries-truncated');
          break;
        }
        remainingEntries -= 1;
        const childRelativePath = path.join(relativePath, entry.name);
        const childPath = path.join(nodePath, entry.name);
        if (entry.isSymbolicLink()) {
          digest.update(childRelativePath).update('\u0000symlink\u0000');
          try { digest.update(await fs.readlink(childPath)); } catch { digest.update('unreadable'); }
          continue;
        }
        if (depth >= CREDENTIAL_FINGERPRINT_MAX_DEPTH) {
          digest.update(childRelativePath).update('\u0000depth-truncated\u0000');
          continue;
        }
        try {
          await appendNode(childPath, childRelativePath, depth + 1);
        } catch {
          digest.update(childRelativePath).update('\u0000unreadable\u0000');
        }
      }
    };

    // Content, not rewrite time or mode, defines a credential generation. A
    // CLI may rewrite an unchanged store during a failed refresh; metadata-only
    // drift must never release the exact generation that upstream rejected.
    await appendNode(targetPath, '.', 0);
    return digest.digest('hex');
  } catch {
    return 'missing';
  }
}

async function credentialFingerprint(provider: AgentProviderName): Promise<string> {
  const paths = resolveNativeCliCredentialPaths(provider);
  const pathHashes = await Promise.all(paths.map(hashPath));
  const envCredentialMaterial = provider === 'CLAUDE_CODE'
    ? [
        process.env.ANTHROPIC_API_KEY,
        process.env.ANTHROPIC_AUTH_TOKEN,
        process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ]
    : provider === 'CODEX'
      ? [process.env.OPENAI_API_KEY]
      : provider === 'GEMINI'
        ? [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY]
        : provider === 'GROK'
          ? [
              process.env.XAI_API_KEY,
              process.env.GROK_CODE_XAI_API_KEY,
              process.env.GROK_DEPLOYMENT_KEY,
              process.env.GROK_AUTH,
            ]
          : [];
  const envCredentialFingerprint = createHash('sha256')
    .update(envCredentialMaterial.map((value) => value || '').join('\u0000'))
    .digest('hex');
  return createHash('sha256')
    .update(`${pathHashes.join(':')}:${envCredentialFingerprint}`)
    .digest('hex');
}

function execFileBounded(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      encoding: 'utf8',
      env: buildNativeCliEnvironment(command === 'agy' ? 'GEMINI' : command === 'claude' ? 'CLAUDE_CODE' : command === 'codex' ? 'CODEX' : 'GROK'),
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        output: redactNativeProviderText(`${stdout || ''}\n${stderr || ''}`, 16 * 1024),
      });
    });
    if (command === 'agy') child?.stdin?.end();
  });
}

async function runtimeFingerprint(provider: AgentProviderName): Promise<string> {
  const definition = COMMANDS[provider];
  if (!definition) return 'not-applicable';
  const probe = await execFileBounded(definition.command, definition.versionArgs, 5_000);
  if (!probe.ok) return 'missing';
  return createHash('sha256').update(probe.output).digest('hex');
}

async function defaultLiveProbe(provider: AgentProviderName): Promise<LiveProbeResult> {
  // Claude and Codex do not expose a supported, non-billable auth verification
  // command. Their local login can be reported honestly, but not called live.
  if (provider === 'CLAUDE_CODE' || provider === 'CODEX' || provider === 'GROK') {
    return { state: 'unknown' };
  }
  if (provider !== 'GEMINI') return { state: 'unknown' };

  const probe = await execFileBounded('agy', ['models'], 8_000);
  if (probe.ok) return { state: 'live_verified' };
  if (isNativeProviderAuthFailure(probe.output)) {
    return { state: 'needs_login', diagnostic: probe.output };
  }
  if (/\b(?:enoent|not found|failed to spawn)\b/i.test(probe.output)) {
    return { state: 'runtime_unavailable', diagnostic: probe.output };
  }
  return { state: 'unknown', diagnostic: probe.output };
}

function messageFor(provider: AgentProviderName, state: NativeProviderReadinessState, local: NativeCliAuthStatus): string {
  const name = provider === 'CLAUDE_CODE' ? 'Claude Code'
    : provider === 'CODEX' ? 'Codex'
      : provider === 'GEMINI' ? 'Google Antigravity'
        : provider === 'GROK' ? 'Grok Build'
          : provider;
  if (state === 'live_verified') return `${name} login was verified against its local provider runtime.`;
  if (state === 'login_present') return `${name} login is present locally. This CLI has no supported non-billable live auth probe, so upstream revocation is checked on the next turn.`;
  if (state === 'needs_login') return local.message || `${name} needs to be signed in on this server.`;
  if (state === 'runtime_unavailable') return `${name} is not available on this server right now.`;
  return `${name} readiness could not be verified. Retry the check or reconnect it in AI Settings.`;
}

async function refresh(provider: AgentProviderName, credential: string, runtime: string): Promise<NativeProviderReadiness> {
  const local = await getNativeCliAuthStatusAsync(provider);
  if (runtime === 'missing') {
    return result(provider, 'runtime_unavailable', messageFor(provider, 'runtime_unavailable', local), credential, runtime);
  }
  if (local.status === 'needs_login') {
    return result(provider, 'needs_login', messageFor(provider, 'needs_login', local), credential, runtime);
  }
  if (local.status === 'unknown') {
    return result(provider, 'unknown', messageFor(provider, 'unknown', local), credential, runtime);
  }

  if (provider === 'GEMINI'
    && local.status === 'authenticated'
    && !testProbes.has(provider)
    && !process.env.GEMINI_API_KEY
    && !process.env.GOOGLE_API_KEY) {
    // getNativeCliAuthStatusAsync reached this state only after its bounded
    // `agy models` probe succeeded; do not execute the same live probe twice.
    return result(provider, 'live_verified', messageFor(provider, 'live_verified', local), credential, runtime);
  }

  const probe = await (testProbes.get(provider) || defaultLiveProbe)(provider);
  const state: NativeProviderReadinessState = probe.state === 'unknown'
    && local.status === 'authenticated'
      // Claude/Codex/Grok have no supported non-billable live check, so local
      // credential evidence is the strongest honest state available. Gemini
      // does have `agy models`; an ambiguous result from that check must remain
      // fail-closed even when an API-key environment variable is present.
      ? provider === 'GEMINI' ? 'unknown' : 'login_present'
      : probe.state;
  return result(provider, state, messageFor(provider, state, local), credential, runtime);
}

export async function getNativeProviderReadiness(
  provider: AgentProviderName,
  options: { force?: boolean } = {},
): Promise<NativeProviderReadiness> {
  const credential = await credentialFingerprint(provider);
  const rejection = rejectedCredentialGenerations.get(provider);
  if (rejection) {
    if (rejection.credentialFingerprint === 'unknown'
      || rejection.credentialFingerprint === credential) {
      const blocked = result(
        provider,
        'needs_login',
        rejection.message,
        credential,
        rejection.runtimeFingerprint,
      );
      cache.set(provider, blocked);
      return blocked;
    }

    // A different credential generation is explicit recovery evidence. Clear
    // the old rejection before probing, and epoch any older work admitted
    // against the rejected generation so it cannot overwrite the new one.
    rejectedCredentialGenerations.delete(provider);
    invalidateNativeCliAuthStatus(provider, 'state_changed');
    readinessEpoch += 1;
    cache.delete(provider);
    for (const key of pending.keys()) {
      if (key.startsWith(`${provider}:`)) pending.delete(key);
    }
    notifyInvalidation(provider);
  }
  const current = cache.get(provider);
  if (!options.force
    && current
    && current.credentialFingerprint === credential
    && Date.parse(current.expiresAt) > Date.now()) {
    return current;
  }

  // Singleflight the whole cold path, including the CLI version probe. Checking
  // only after runtimeFingerprint would let concurrent catalog requests spawn
  // one provider process each before they converged on the auth probe.
  const key = `${provider}:${credential}`;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const taskEpoch = readinessEpoch;
  const task = (async () => {
    // Version probes spawn provider CLIs. Keep them behind the cheap credential
    // and TTL cache boundary so ordinary status reads do not execute every CLI.
    const runtime = await runtimeFingerprint(provider);
    const next = await refresh(provider, credential, runtime);
    if (taskEpoch === readinessEpoch) {
      cache.set(provider, next);
      return next;
    }
    const replacement = cache.get(provider);
    if (replacement && Date.parse(replacement.expiresAt) > Date.now()) return replacement;
    return result(
      provider,
      'unknown',
      'Provider readiness changed while its live status was being checked. Retry the check before starting a turn.',
      credential,
      runtime,
    );
  })().finally(() => {
    if (pending.get(key) === task) pending.delete(key);
  });
  pending.set(key, task);
  return task;
}

export function getCachedNativeProviderReadiness(provider: AgentProviderName): NativeProviderReadiness | null {
  const current = cache.get(provider);
  return current && Date.parse(current.expiresAt) > Date.now() ? current : null;
}

export function invalidateNativeProviderReadiness(provider: AgentProviderName): void {
  readinessEpoch += 1;
  cache.delete(provider);
  rejectedCredentialGenerations.delete(provider);
  for (const key of pending.keys()) {
    if (key.startsWith(`${provider}:`)) pending.delete(key);
  }
  notifyInvalidation(provider);
}

export function recordNativeProviderAuthFailure(
  provider: AgentProviderName,
  rawDiagnostic: string,
  admission?: Pick<NativeProviderReadiness, 'credentialFingerprint' | 'runtimeFingerprint'>,
  options: { confirmed?: boolean } = {},
): void {
  if (options.confirmed !== true && !isNativeProviderAuthFailure(rawDiagnostic)) return;
  invalidateNativeCliAuthStatus(provider, 'auth_rejected');
  readinessEpoch += 1;
  for (const key of pending.keys()) {
    if (key.startsWith(`${provider}:`)) pending.delete(key);
  }
  const current = cache.get(provider);
  const message = `${provider === 'CLAUDE_CODE' ? 'Claude Code' : provider === 'GEMINI' ? 'Google Antigravity' : provider} authentication was rejected. Reconnect it in AI Settings and retry.`;
  const rejectedCredentialFingerprint = admission?.credentialFingerprint
    || current?.credentialFingerprint
    || 'unknown';
  const rejectedRuntimeFingerprint = admission?.runtimeFingerprint
    || current?.runtimeFingerprint
    || 'unknown';
  rejectedCredentialGenerations.set(provider, {
    credentialFingerprint: rejectedCredentialFingerprint,
    runtimeFingerprint: rejectedRuntimeFingerprint,
    message,
  });
  const next = result(
    provider,
    'needs_login',
    message,
    rejectedCredentialFingerprint,
    rejectedRuntimeFingerprint,
  );
  cache.set(provider, next);
  notifyInvalidation(provider);
}

export function subscribeNativeProviderReadinessInvalidation(
  listener: (provider: AgentProviderName) => void,
): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

export function __setNativeReadinessProbeForTests(provider: AgentProviderName, probe: LiveProbe | null): void {
  invalidateNativeProviderReadiness(provider);
  if (probe) testProbes.set(provider, probe);
  else testProbes.delete(provider);
}

export function __resetNativeReadinessForTests(): void {
  readinessEpoch += 1;
  cache.clear();
  pending.clear();
  testProbes.clear();
  rejectedCredentialGenerations.clear();
}
