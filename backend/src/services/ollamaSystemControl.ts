import { execFile } from 'child_process';
import { promisify } from 'util';
import { NativeOllamaBackendBindingState } from '@prisma/client';
import {
  canonicalizeLocalOllamaEndpoint,
  resolveLocalOllamaEndpoint,
} from '../utils/localOllamaEndpoint';
import {
  requestLocalOllamaJson,
} from './localOllamaTransport';
import {
  OllamaBackendAuthorityError,
  requestResolvedOllama,
  resolveOllamaBackendAuthority,
  type OllamaBackendAuthority,
  type OllamaBackendAuthorityRequest,
  type ResolvedOllamaBackendAuthority,
} from './ollamaBackendAuthority';
import { readNativeOllamaBinding } from './nativeOllamaBinding';
import { readLegacyOllamaBindingPresence } from './legacyOllamaBindingRead';

const execFileAsync = promisify(execFile);
const OLLAMA_REQUEST_TIMEOUT_MS = 15_000;
const OLLAMA_RESTART_TIMEOUT_MS = 45_000;
const OLLAMA_LOCAL_PROBE_TIMEOUT_MS = 3_000;
const OLLAMA_MAX_MODELS = 1_000;
const OLLAMA_SERVICE = 'ollama.service';
const SYSTEMCTL = '/usr/bin/systemctl';

export type OllamaControlErrorCode =
  | 'OLLAMA_UNAVAILABLE'
  | 'OLLAMA_REJECTED'
  | 'OLLAMA_RESTART_FAILED';

export class OllamaSystemControlError extends Error {
  constructor(
    public readonly code: OllamaControlErrorCode,
    message: string,
    public readonly statusCode = 502,
  ) {
    super(message);
    this.name = 'OllamaSystemControlError';
  }
}

type FetchLike = typeof fetch;
type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<unknown>;

export interface OllamaSystemControlDependencies {
  resolveAuthorityImpl?: () => Promise<ResolvedOllamaBackendAuthority>;
  readNativeBindingImpl?: typeof readNativeOllamaBinding;
  readLegacyBindingPresenceImpl?: typeof readLegacyOllamaBindingPresence;
  requestResolvedImpl?: typeof requestResolvedOllama;
  fetchImpl?: FetchLike;
  requestLocalImpl?: typeof requestLocalOllamaJson;
  execFileImpl?: ExecFileLike;
  localOllamaBaseUrl?: string;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface OllamaRuntimeAuthorityMetadata {
  kind: OllamaBackendAuthority['kind'];
  generation: number | null;
  version: number | null;
  bindingFingerprint: string;
  displayName: string | null;
  selectedModel: string | null;
}

export interface OllamaRuntimeStatus {
  available: boolean;
  backend: string;
  version: string | null;
  models: Array<{ name: string; size: string; family: string }>;
  runningModels: string[];
  isGpu: boolean;
  authority: OllamaRuntimeAuthorityMetadata | null;
}

export interface OllamaUnloadResult {
  unloadedModels: string[];
  alreadyIdle: boolean;
}

export type OllamaLocalRestartCapability =
  | Readonly<{
    available: true;
    code: null;
    message: null;
    statusCode: null;
  }>
  | Readonly<{
    available: false;
    code: 'OLLAMA_REJECTED' | 'OLLAMA_UNAVAILABLE';
    message: string;
    statusCode: number;
  }>;

const REMOTE_RESTART_BLOCKED_MESSAGE =
  'Local Ollama restart is unavailable while a Remote GPU authority is active or disconnected. This action controls the Portal host, not the Windows Ollama service.';
const RESTART_AUTHORITY_UNVERIFIED_MESSAGE =
  'Portal could not verify whether a Remote GPU authority exists, so the local Ollama restart was blocked.';

function requireLocalBaseUrl(value: string): string {
  try {
    return canonicalizeLocalOllamaEndpoint(value);
  } catch {
    throw new OllamaSystemControlError(
      'OLLAMA_UNAVAILABLE',
      'Portal permits Ollama control only through loopback port 11434.',
      503,
    );
  }
}

async function runtimeDependencies(overrides: OllamaSystemControlDependencies = {}) {
  try {
    return {
      resolved: await (overrides.resolveAuthorityImpl ?? resolveOllamaBackendAuthority)(),
      requestResolvedImpl: overrides.requestResolvedImpl ?? requestResolvedOllama,
      sleep: overrides.sleep || ((milliseconds: number) => new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      })),
    };
  } catch {
    throw new OllamaSystemControlError(
      'OLLAMA_UNAVAILABLE',
      'The configured Ollama backend is unavailable.',
      503,
    );
  }
}

async function fetchJson(
  dependencies: Awaited<ReturnType<typeof runtimeDependencies>>,
  path: OllamaBackendAuthorityRequest['path'],
  method: OllamaBackendAuthorityRequest['method'],
  body: Record<string, unknown> | undefined,
  unavailableMessage: string,
  timeoutMs = OLLAMA_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  try {
    const response = await dependencies.requestResolvedImpl(
      dependencies.resolved,
      {
        path,
        method,
        ...(body === undefined ? {} : { json: body }),
        timeoutMs,
        // No explicit response cap: the local transport enforces a per-path
        // policy budget, and a blanket caller value above a path's cap is
        // rejected as REQUEST_INVALID (which previously read as "offline").
      },
    );
    try {
      const value = JSON.parse(response.body.toString('utf8')) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    } catch {
      throw new OllamaSystemControlError(
        'OLLAMA_REJECTED',
        'Ollama returned an invalid control response.',
        502,
      );
    } finally {
      response.body.fill(0);
    }
  } catch (error) {
    if (error instanceof OllamaSystemControlError) throw error;
    if (
      error instanceof OllamaBackendAuthorityError
      && [
        'HTTP_STATUS',
        'RESPONSE_INVALID',
        'RESPONSE_TOO_LARGE',
        'REQUEST_INVALID',
        'MODEL_MISMATCH',
      ].includes(error.code)
    ) {
      throw new OllamaSystemControlError(
        'OLLAMA_REJECTED',
        'Ollama rejected the control request. Check its service status and retry.',
        502,
      );
    }
    throw new OllamaSystemControlError(
      'OLLAMA_UNAVAILABLE',
      unavailableMessage,
      503,
    );
  }
}

function modelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.slice(0, OLLAMA_MAX_MODELS).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const name = String(record.name || record.model || '').trim();
    return name ? [name] : [];
  })));
}

async function listRunningModels(
  dependencies: Awaited<ReturnType<typeof runtimeDependencies>>,
): Promise<string[]> {
  const payload = await fetchJson(
    dependencies,
    '/api/ps',
    'GET',
    undefined,
    'Ollama is unavailable, so Portal could not inspect its running models.',
  );
  const names = modelNames(payload.models);
  return names;
}

export async function getOllamaRuntimeStatus(
  overrides: OllamaSystemControlDependencies = {},
): Promise<OllamaRuntimeStatus> {
  try {
    const dependencies = await runtimeDependencies(overrides);
    const [versionPayload, tagsPayload] = await Promise.all([
      fetchJson(
        dependencies,
        '/api/version',
        'GET',
        undefined,
        'Ollama version is unavailable.',
        3_000,
      ),
      fetchJson(
        dependencies,
        '/api/tags',
        'GET',
        undefined,
        'Ollama catalog is unavailable.',
        3_000,
      ),
    ]);
    const models = (Array.isArray(tagsPayload.models)
      ? tagsPayload.models.slice(0, OLLAMA_MAX_MODELS).flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const model = entry as Record<string, unknown>;
        const details = model.details && typeof model.details === 'object' && !Array.isArray(model.details)
          ? model.details as Record<string, unknown>
          : {};
        const name = String(model.name || model.model || '').trim();
        if (!name) return [];
        return [{
          name,
          size: String(details.parameter_size || 'unknown'),
          family: String(details.family || 'unknown'),
        }];
      })
      : []);

    let runningModels: string[] = [];
    try {
      runningModels = await listRunningModels(dependencies);
    } catch {
      // Catalog/version health still proves Ollama is available. A transient
      // process-list failure should not make the entire sidebar disappear.
    }

    const { authority } = dependencies.resolved;
    const authorityMetadata: OllamaRuntimeAuthorityMetadata = {
      kind: authority.kind,
      generation: authority.generation,
      version: authority.version,
      bindingFingerprint: authority.bindingFingerprint,
      // Native bindings persist the peer's pinned identity, not its mutable
      // presentation hostname. Do not mislabel the opaque stable node ID as a
      // user-facing display name.
      displayName: null,
      selectedModel: authority.selectedModel,
    };
    return {
      available: true,
      backend: authority.kind === 'TAILNET' ? 'tailnet' : 'local',
      version: String(versionPayload.version || '').trim() || null,
      models,
      runningModels,
      isGpu: authority.kind === 'TAILNET',
      authority: authorityMetadata,
    };
  } catch (error) {
    warnRuntimeStatusUnavailable(error);
    return {
      available: false,
      backend: 'offline',
      version: null,
      models: [],
      runningModels: [],
      isGpu: false,
      authority: null,
    };
  }
}

// The status poller calls this every few seconds, so an offline backend must
// not flood the journal — but a swallowed error must always leave a trace:
// this exact catch silently ate a deterministic request-contract bug as
// "Ollama offline" for weeks.
const RUNTIME_STATUS_WARN_INTERVAL_MS = 60_000;
let lastRuntimeStatusWarn = { key: '', at: 0 };

function warnRuntimeStatusUnavailable(error: unknown): void {
  const code = error instanceof OllamaSystemControlError || error instanceof OllamaBackendAuthorityError
    ? error.code
    : 'UNKNOWN';
  const message = error instanceof Error ? error.message : String(error);
  const key = `${code}:${message}`;
  const now = Date.now();
  if (lastRuntimeStatusWarn.key === key && now - lastRuntimeStatusWarn.at < RUNTIME_STATUS_WARN_INTERVAL_MS) {
    return;
  }
  lastRuntimeStatusWarn = { key, at: now };
  console.warn(`[ollamaSystemControl] Runtime status unavailable (${code}): ${message}`);
}

export async function unloadAllOllamaModels(
  overrides: OllamaSystemControlDependencies = {},
): Promise<OllamaUnloadResult> {
  const dependencies = await runtimeDependencies(overrides);
  const { sleep } = dependencies;
  const runningModels = await listRunningModels(dependencies);
  if (!runningModels.length) return { unloadedModels: [], alreadyIdle: true };

  for (const model of runningModels) {
    await fetchJson(
      dependencies,
      '/api/generate',
      'POST',
      { model, keep_alive: 0, stream: false },
      'Ollama became unavailable while Portal was unloading its running models.',
    );
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const remaining = await listRunningModels(dependencies);
    if (remaining.length === 0) {
      return { unloadedModels: runningModels, alreadyIdle: false };
    }
    await sleep(250);
  }

  throw new OllamaSystemControlError(
    'OLLAMA_REJECTED',
    'Ollama did not confirm that every running model was unloaded.',
    409,
  );
}

export async function getLocalOllamaRestartCapability(
  overrides: OllamaSystemControlDependencies = {},
): Promise<OllamaLocalRestartCapability> {
  let bindingView: Awaited<ReturnType<typeof readNativeOllamaBinding>>;
  try {
    bindingView = await (
      overrides.readNativeBindingImpl ?? readNativeOllamaBinding
    )();
  } catch {
    return {
      available: false,
      code: 'OLLAMA_UNAVAILABLE',
      message: RESTART_AUTHORITY_UNVERIFIED_MESSAGE,
      statusCode: 503,
    };
  }

  const state = bindingView.authority?.state;
  if (
    state === NativeOllamaBackendBindingState.ACTIVE
    || state === NativeOllamaBackendBindingState.DISCONNECTED
  ) {
    return {
      available: false,
      code: 'OLLAMA_REJECTED',
      message: REMOTE_RESTART_BLOCKED_MESSAGE,
      statusCode: 409,
    };
  }

  try {
    const legacy = await (
      overrides.readLegacyBindingPresenceImpl
      ?? readLegacyOllamaBindingPresence
    )();
    if (legacy.hasAuthority) {
      return {
        available: false,
        code: 'OLLAMA_REJECTED',
        message: REMOTE_RESTART_BLOCKED_MESSAGE,
        statusCode: 409,
      };
    }
  } catch {
    return {
      available: false,
      code: 'OLLAMA_UNAVAILABLE',
      message: RESTART_AUTHORITY_UNVERIFIED_MESSAGE,
      statusCode: 503,
    };
  }

  return {
    available: true,
    code: null,
    message: null,
    statusCode: null,
  };
}

export async function restartLocalOllamaService(
  overrides: OllamaSystemControlDependencies = {},
): Promise<{ active: true; version: string }> {
  const capability = await getLocalOllamaRestartCapability(overrides);
  if (!capability.available) {
    throw new OllamaSystemControlError(
      capability.code,
      capability.message,
      capability.statusCode,
    );
  }

  const execFileImpl = overrides.execFileImpl || (async (file, args, options) => {
    await execFileAsync(file, [...args], options);
  });
  const fetchImpl = overrides.fetchImpl;
  const requestLocalImpl = overrides.requestLocalImpl || requestLocalOllamaJson;
  // Restart recovery must remain usable even if the configured proxy/remote
  // endpoint is malformed or offline. Verify the installer-owned service on
  // its independent loopback health endpoint.
  const localOllamaBaseUrl = overrides.localOllamaBaseUrl
    ? requireLocalBaseUrl(overrides.localOllamaBaseUrl)
    : resolveLocalOllamaEndpoint();
  const sleep = overrides.sleep || ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  try {
    await execFileImpl(SYSTEMCTL, ['restart', OLLAMA_SERVICE], {
      timeout: OLLAMA_RESTART_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch {
    throw new OllamaSystemControlError(
      'OLLAMA_RESTART_FAILED',
      'Portal could not restart the local Ollama service. Check the server service log and retry.',
      500,
    );
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await execFileImpl(SYSTEMCTL, ['is-active', '--quiet', OLLAMA_SERVICE], {
        timeout: 5_000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      });

      let payload: Record<string, unknown>;
      if (fetchImpl) {
        const response = await fetchImpl(`${localOllamaBaseUrl}/api/version`, {
          method: 'GET',
          redirect: 'manual',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(OLLAMA_LOCAL_PROBE_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error('local Ollama API is not ready');
        payload = await response.json() as Record<string, unknown>;
      } else {
        payload = await requestLocalImpl<Record<string, unknown>>({
          path: '/api/version',
          method: 'GET',
          timeoutMs: OLLAMA_LOCAL_PROBE_TIMEOUT_MS,
        });
      }
      const version = String(payload.version || '').trim();
      if (!version) throw new Error('local Ollama version is unavailable');
      return { active: true, version };
    } catch {
      if (attempt < 19) await sleep(500);
    }
  }

  throw new OllamaSystemControlError(
    'OLLAMA_RESTART_FAILED',
    'The local Ollama service did not become ready after restart.',
    500,
  );
}
