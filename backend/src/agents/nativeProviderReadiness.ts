import { createHash } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { AgentProviderName } from './AgentProvider.interface';
import { requireHarnessDefinition } from './harnessCatalog';
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
  buildAcpHarnessEnvironment,
  resolveAcpHarnessReadinessPaths,
} from './providers/native/acp/AcpHarnessEnvironment';
import {
  HERMES_ACP_PROFILE,
  OPENCODE_ACP_PROFILE,
} from './providers/native/acp/AcpHarnessProfiles';
import { AcpStdioBroker } from './providers/native/acp/AcpStdioBroker';
import {
  isNativeProviderAuthFailure,
  redactNativeProviderText,
} from './providers/native/NativeProviderDiagnostics';
import {
  attestNativeHostCli,
  type NativeHostCliId,
} from '../services/nativeHostCliAdmission';
import {
  isUnqualifiedNativeBinaryProvider,
  unqualifiedNativeBinaryReason,
} from '../config/unqualifiedNativeBinaryLane';

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
  runtimeVersion?: string;
  runtimeInstalled?: boolean;
  runtimeAdmissionCode?: string;
}

type LiveProbeResult = {
  state: 'live_verified' | 'needs_login' | 'runtime_unavailable' | 'unknown';
  diagnostic?: string;
};

type LiveProbe = (provider: AgentProviderName) => Promise<LiveProbeResult>;

const EXECUTABLE_READINESS_PROVIDERS = [
  'HERMES',
  'OPENCODE',
] as const satisfies readonly AgentProviderName[];

const COMMANDS: Partial<Record<AgentProviderName, { command: string; versionArgs: string[] }>> =
  Object.freeze(Object.fromEntries(EXECUTABLE_READINESS_PROVIDERS.map((provider) => {
    const command = requireHarnessDefinition(provider).command;
    if (!command.executable) throw new Error(`Missing native readiness command for ${provider}`);
    return [provider, {
      command: command.executable,
      versionArgs: [...command.versionArgs],
    }];
  })));

const cache = new Map<AgentProviderName, NativeProviderReadiness>();
const hostAdmissionCache = new Map<AgentProviderName, NativeProviderReadiness>();
const pending = new Map<string, Promise<NativeProviderReadiness>>();
const testProbes = new Map<AgentProviderName, LiveProbe>();
const rejectedCredentialGenerations = new Map<AgentProviderName, {
  credentialFingerprint: string;
  runtimeFingerprint: string;
  message: string;
}>();
const invalidationListeners = new Set<(provider: AgentProviderName) => void>();
let readinessEpoch = 0;

const HOST_CLI_ADMISSION = Object.freeze({
  CODEX: Object.freeze({ toolId: 'codex', executablePath: '/usr/bin/codex' }),
  CLAUDE_CODE: Object.freeze({ toolId: 'claude-code', executablePath: '/usr/bin/claude' }),
} satisfies Readonly<Record<'CODEX' | 'CLAUDE_CODE', Readonly<{
  toolId: NativeHostCliId;
  executablePath: string;
}>>>);

function admissionFailureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code || '');
    if (/^[A-Z0-9_]{1,80}$/.test(code)) return code;
  }
  return 'NATIVE_HOST_CLI_ADMISSION_FAILED';
}

function admissionObservedVersion(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('observedVersion' in error)) return undefined;
  const version = (error as { observedVersion?: unknown }).observedVersion;
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    ? version
    : undefined;
}

function admissionInstalledEvidence(code: string): boolean | undefined {
  if (code === 'ABSENT') return false;
  if (code === 'UNSUPPORTED_VERSION'
    || code === 'STATUS_ONLY_VERSION'
    || code === 'DRIFT_DETECTED'
    || code === 'RACE_DETECTED'
    || code === 'BOUND_EXCEEDED') return true;
  return undefined;
}

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
  runtimeVersion?: string,
  runtimeInstalled?: boolean,
  runtimeAdmissionCode?: string,
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
    ...(runtimeVersion ? { runtimeVersion } : {}),
    ...(runtimeInstalled !== undefined ? { runtimeInstalled } : {}),
    ...(runtimeAdmissionCode ? { runtimeAdmissionCode } : {}),
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
  const paths = provider === 'HERMES' || provider === 'OPENCODE'
    ? resolveAcpHarnessReadinessPaths(provider)
    : resolveNativeCliCredentialPaths(provider);
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

function execFileBounded(
  provider: AgentProviderName,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      encoding: 'utf8',
      env: provider === 'HERMES' || provider === 'OPENCODE'
        ? buildAcpHarnessEnvironment(provider)
        : buildNativeCliEnvironment(provider),
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

async function runtimeFingerprint(
  provider: AgentProviderName,
  scope: 'HOST_OPERATOR' | 'PROJECT_SANDBOX',
): Promise<string> {
  if (scope === 'PROJECT_SANDBOX' && (provider === 'CODEX' || provider === 'CLAUDE_CODE')) {
    // Project providers execute their independently pinned container runtime;
    // host CLI identity is neither launch authority nor a Project prerequisite.
    return createHash('sha256').update(`project-sandbox:${provider}`).digest('hex');
  }
  const definition = COMMANDS[provider];
  if (!definition) return 'not-applicable';
  const probe = await execFileBounded(provider, definition.command, definition.versionArgs, 5_000);
  if (!probe.ok) return 'missing';
  return createHash('sha256').update(probe.output).digest('hex');
}

async function defaultLiveProbe(provider: AgentProviderName): Promise<LiveProbeResult> {
  // Claude and Codex do not expose a supported, non-billable auth verification
  // command. Their local login can be reported honestly, but not called live.
  if (provider === 'CLAUDE_CODE'
    || provider === 'CODEX'
    || provider === 'GROK') {
    return { state: 'unknown' };
  }
  if (provider === 'HERMES' || provider === 'OPENCODE') {
    const broker = new AcpStdioBroker({
      profile: provider === 'HERMES' ? HERMES_ACP_PROFILE : OPENCODE_ACP_PROFILE,
      cwd: process.cwd(),
      environment: buildAcpHarnessEnvironment(provider),
      controlTimeoutMs: 10_000,
      closeGraceMs: 1_000,
    });
    try {
      await broker.attest();
      // Hermes' agent-managed auth method is advertised only after it resolves
      // a usable provider credential. OpenCode's fixed method merely opens its
      // own login flow, so local auth evidence remains the honest maximum.
      return { state: provider === 'HERMES' ? 'live_verified' : 'unknown' };
    } catch (error) {
      const diagnostic = redactNativeProviderText(
        error instanceof Error ? error.message : String(error),
        16 * 1024,
      );
      if (provider === 'HERMES'
        && /(?:authenticated runtime method|confirm its advertised authentication method|ACP authenticate failed)/i.test(diagnostic)) {
        return { state: 'needs_login', diagnostic };
      }
      return { state: 'runtime_unavailable', diagnostic };
    } finally {
      try { await broker.dispose(); } catch {}
    }
  }
  if (provider !== 'GEMINI') return { state: 'unknown' };

  const probe = await execFileBounded('GEMINI', 'agy', ['models'], 8_000);
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
  const name = requireHarnessDefinition(provider).displayName;
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
    && !testProbes.has(provider)) {
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
  options: {
    force?: boolean;
    executionScope?: 'HOST_OPERATOR' | 'PROJECT_SANDBOX';
  } = {},
): Promise<NativeProviderReadiness> {
  const executionScope = options.executionScope || 'HOST_OPERATOR';
  if ((provider === 'GROK' || provider === 'GEMINI')
    && (isUnqualifiedNativeBinaryProvider(provider) || executionScope === 'PROJECT_SANDBOX')) {
    return result(
      provider,
      'runtime_unavailable',
      unqualifiedNativeBinaryReason(provider),
      'not-inspected',
      'unqualified-native-binary-lane',
    );
  }
  if (
    executionScope === 'HOST_OPERATOR'
    && (provider === 'CODEX' || provider === 'CLAUDE_CODE')
  ) {
    const admissionContract = HOST_CLI_ADMISSION[provider];
    const credential = await credentialFingerprint(provider);
    const cached = hostAdmissionCache.get(provider);
    if (!options.force
      && cached
      && cached.credentialFingerprint === credential
      && Date.parse(cached.expiresAt) > Date.now()) {
      return cached;
    }
    const key = `${provider}:host:${credential}`;
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    let taskEpoch = readinessEpoch;
    const task = (async () => {
      const [local, admission] = await Promise.all([
        getNativeCliAuthStatusAsync(provider),
        attestNativeHostCli(admissionContract.toolId, admissionContract.executablePath).then(
          (identity) => ({ ok: true as const, identity }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]);
      const admissionCode = admission.ok ? null : admissionFailureCode(admission.error);
      const runtime = admission.ok
        ? admission.identity.fingerprint
        : createHash('sha256')
          .update(`unavailable\u0000${admissionCode}`)
          .digest('hex');
      const finish = (value: NativeProviderReadiness): NativeProviderReadiness => {
        if (taskEpoch === readinessEpoch) {
          hostAdmissionCache.set(provider, value);
          return value;
        }
        const replacement = hostAdmissionCache.get(provider);
        if (replacement && Date.parse(replacement.expiresAt) > Date.now()) return replacement;
        return result(
          provider,
          'unknown',
          'Provider readiness changed while native host admission was being checked. Retry before starting a turn.',
          credential,
          runtime,
        );
      };

      // Package admission is independent of authentication. A retained auth
      // rejection must never relabel an absent or drifted executable as a
      // login problem, nor imply that Portal can mutate the host package.
      if (!admission.ok) {
        return finish(result(
          provider,
          'runtime_unavailable',
          `${requireHarnessDefinition(provider).displayName} host CLI admission failed (${admissionCode}). The package was not changed; Portal does not currently provide host CLI package maintenance.`,
          credential,
          runtime,
          admissionObservedVersion(admission.error),
          admissionInstalledEvidence(admissionCode || ''),
          admissionCode || undefined,
        ));
      }

      const rejection = rejectedCredentialGenerations.get(provider);
      if (rejection && (
        rejection.credentialFingerprint === 'unknown'
        || rejection.credentialFingerprint === credential
      )) {
        return finish(result(
          provider,
          'needs_login',
          rejection.message,
          credential,
          runtime,
          admission.identity.version,
          true,
        ));
      }
      if (rejection) {
        rejectedCredentialGenerations.delete(provider);
        invalidateNativeCliAuthStatus(provider, 'state_changed');
        readinessEpoch += 1;
        taskEpoch = readinessEpoch;
        cache.delete(provider);
        hostAdmissionCache.delete(provider);
        for (const pendingKey of pending.keys()) {
          if (pendingKey.startsWith(`${provider}:`) && pendingKey !== key) pending.delete(pendingKey);
        }
        notifyInvalidation(provider);
      }
      if (local.status === 'needs_login') {
        return finish(result(
          provider,
          'needs_login',
          messageFor(provider, 'needs_login', local),
          credential,
          runtime,
          admission.identity.version,
          true,
        ));
      }
      if (local.status !== 'authenticated') {
        return finish(result(
          provider,
          'unknown',
          messageFor(provider, 'unknown', local),
          credential,
          runtime,
          admission.identity.version,
          true,
        ));
      }
      // Advisory only. NativeCliAdapterProvider performs the same filesystem
      // admission again immediately before every Host Operator attempt.
      return finish(result(
        provider,
        'login_present',
        messageFor(provider, 'login_present', local),
        credential,
        runtime,
        admission.identity.version,
        true,
      ));
    })().finally(() => {
      if (pending.get(key) === task) pending.delete(key);
    });
    pending.set(key, task);
    return task;
  }
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
    const runtime = await runtimeFingerprint(provider, executionScope);
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
  const current = provider === 'CODEX' || provider === 'CLAUDE_CODE'
    ? hostAdmissionCache.get(provider)
    : cache.get(provider);
  return current && Date.parse(current.expiresAt) > Date.now() ? current : null;
}

export function invalidateNativeProviderReadiness(provider: AgentProviderName): void {
  readinessEpoch += 1;
  cache.delete(provider);
  hostAdmissionCache.delete(provider);
  rejectedCredentialGenerations.delete(provider);
  for (const key of pending.keys()) {
    if (key.startsWith(`${provider}:`)) pending.delete(key);
  }
  notifyInvalidation(provider);
}

export function recordNativeProviderAuthFailure(
  provider: AgentProviderName,
  rawDiagnostic: string,
  admission?: Pick<
    NativeProviderReadiness,
    | 'credentialFingerprint'
    | 'runtimeFingerprint'
    | 'runtimeVersion'
    | 'runtimeInstalled'
    | 'runtimeAdmissionCode'
  >,
  options: { confirmed?: boolean } = {},
): void {
  if (options.confirmed !== true && !isNativeProviderAuthFailure(rawDiagnostic)) return;
  invalidateNativeCliAuthStatus(provider, 'auth_rejected');
  readinessEpoch += 1;
  for (const key of pending.keys()) {
    if (key.startsWith(`${provider}:`)) pending.delete(key);
  }
  const current = provider === 'CODEX' || provider === 'CLAUDE_CODE'
    ? hostAdmissionCache.get(provider)
    : cache.get(provider);
  const message = `${requireHarnessDefinition(provider).displayName} authentication was rejected. Reconnect it in AI Settings and retry.`;
  const rejectedCredentialFingerprint = admission?.credentialFingerprint
    || current?.credentialFingerprint
    || 'unknown';
  const rejectedRuntimeFingerprint = admission?.runtimeFingerprint
    || current?.runtimeFingerprint
    || 'unknown';
  const rejectedRuntimeVersion = admission?.runtimeVersion ?? current?.runtimeVersion;
  const rejectedRuntimeInstalled = admission?.runtimeInstalled ?? current?.runtimeInstalled;
  const rejectedRuntimeAdmissionCode = admission?.runtimeAdmissionCode
    ?? current?.runtimeAdmissionCode;
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
    rejectedRuntimeVersion,
    rejectedRuntimeInstalled,
    rejectedRuntimeAdmissionCode,
  );
  if (provider === 'CODEX' || provider === 'CLAUDE_CODE') {
    // Authentication evidence is shared by the independently admitted host and
    // Project runtimes. Publish the exact-generation rejection into both cache
    // domains so an older in-flight probe in either scope cannot overwrite it.
    hostAdmissionCache.set(provider, next);
    cache.set(provider, next);
  } else {
    cache.set(provider, next);
  }
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
  hostAdmissionCache.clear();
  pending.clear();
  testProbes.clear();
  rejectedCredentialGenerations.clear();
}
