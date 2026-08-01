import { config } from '../config/env';
import {
  canonicalizeLocalOllamaEndpoint,
  resolveLocalOllamaEndpoint,
} from '../utils/localOllamaEndpoint';
import {
  requestResolvedOllamaJson,
  resolveOllamaBackendAuthority,
  type OllamaBackendAuthority,
  type ResolvedOllamaBackendAuthority,
} from './ollamaBackendAuthority';

const MODEL_RE = /^[^\u0000-\u001f\u007f]{1,256}$/;
const DIGEST_RE = /^(?:sha256:)?([a-f0-9]{64})$/i;
const BACKEND_FINGERPRINT_RE = /^[^\u0000-\u001f\u007f]{1,256}$/;
const BINDING_PREFIX = 'ollama-project:v2:';
const LOCAL_BACKEND_FINGERPRINT = 'local-ollama-v1:127.0.0.1:11434';
const MAX_INSTALLED_MODELS = 1_000;
const MAX_CAPABILITY_PROBES = 64;
const REQUEST_TIMEOUT_MS = 5_000;

export interface OllamaProjectBackendIdentity {
  readonly backendKind: 'LOCAL' | 'TAILNET';
  readonly backendFingerprint: string;
  readonly backendGeneration: number | null;
}

export interface OllamaProjectModelSelection {
  readonly model: string;
  readonly digest: `sha256:${string}`;
  readonly capabilities: readonly string[];
  readonly backendKind: 'LOCAL' | 'TAILNET';
  readonly backendFingerprint: string;
  readonly backendGeneration: number | null;
}

export interface OllamaProjectModelResolverDependencies {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  resolveAuthority?: typeof resolveOllamaBackendAuthority;
  requestResolvedJson?: typeof requestResolvedOllamaJson;
}

export class OllamaProjectModelSelectionError extends Error {
  readonly code = 'OLLAMA_PROJECT_MODEL_UNAVAILABLE';

  constructor(message = 'The requested Ollama model is not available for Project Chat.') {
    super(message);
    this.name = 'OllamaProjectModelSelectionError';
  }
}

function fail(message: string): never {
  throw new OllamaProjectModelSelectionError(message);
}

function normalizeModel(value: unknown): string {
  const model = String(value || '').trim();
  if (!MODEL_RE.test(model)) return '';
  return model;
}

function normalizeDigest(value: unknown): `sha256:${string}` {
  const match = String(value || '').trim().match(DIGEST_RE);
  if (!match) return fail('The installed Ollama model did not expose an immutable sha256 digest.');
  return `sha256:${match[1].toLowerCase()}`;
}

export function requireLoopbackOllamaProjectBaseUrl(value: unknown): string {
  try {
    return canonicalizeLocalOllamaEndpoint(value);
  } catch {
    return fail('Ollama Project Chat requires a valid loopback Ollama endpoint.');
  }
}

function normalizeCapabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const capabilities = Array.from(new Set(value
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter((entry) => /^[a-z][a-z0-9_-]{0,63}$/.test(entry))))
    .sort();
  return Object.freeze(capabilities);
}

function backendIdentity(
  authority: OllamaBackendAuthority,
): OllamaProjectBackendIdentity {
  return Object.freeze({
    backendKind: authority.kind,
    backendFingerprint: authority.bindingFingerprint,
    backendGeneration: authority.generation,
  });
}

function normalizeBackendIdentity(
  value: Partial<OllamaProjectBackendIdentity> | null | undefined,
): OllamaProjectBackendIdentity {
  const backendKind = value?.backendKind;
  const backendFingerprint = String(value?.backendFingerprint || '').trim();
  const backendGeneration = value?.backendGeneration;
  if (
    (backendKind !== 'LOCAL' && backendKind !== 'TAILNET')
    || !BACKEND_FINGERPRINT_RE.test(backendFingerprint)
    || (
      backendKind === 'LOCAL'
      && (
        backendFingerprint !== LOCAL_BACKEND_FINGERPRINT
        || backendGeneration !== null
      )
    )
    || (
      backendKind === 'TAILNET'
      && (
        !Number.isSafeInteger(backendGeneration)
        || Number(backendGeneration) < 1
      )
    )
  ) {
    return fail('The Ollama Project backend identity is invalid.');
  }
  return Object.freeze({
    backendKind,
    backendFingerprint,
    backendGeneration: backendGeneration as number | null,
  });
}

interface InstalledModel {
  name: string;
  aliases: readonly string[];
  digest: `sha256:${string}`;
}

function installedModels(payload: unknown): InstalledModel[] {
  const rows = Array.isArray((payload as any)?.models) ? (payload as any).models : [];
  if (rows.length > MAX_INSTALLED_MODELS) {
    return fail('Ollama returned too many installed models to qualify safely.');
  }
  return rows.flatMap((entry: any): InstalledModel[] => {
    const name = normalizeModel(entry?.name);
    if (!name) return [];
    const modelAlias = normalizeModel(entry?.model);
    return [{
      name,
      aliases: Object.freeze(Array.from(new Set([name, modelAlias].filter(Boolean)))),
      digest: normalizeDigest(entry?.digest),
    }];
  });
}

async function jsonResponse(response: Response, label: string): Promise<any> {
  if (!response.ok) return fail(`${label} failed with HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    return fail(`${label} returned invalid JSON.`);
  }
}

async function showInstalledModel(input: {
  model: InstalledModel;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  resolved?: ResolvedOllamaBackendAuthority;
  requestResolvedJson?: typeof requestResolvedOllamaJson;
  timeoutMs: number;
}): Promise<OllamaProjectModelSelection> {
  let payload: any;
  try {
    if (input.fetchImpl) {
      const response = await input.fetchImpl(`${input.baseUrl}/api/show`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: input.model.name, verbose: false }),
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      payload = await jsonResponse(response, 'Ollama model inspection');
    } else if (input.resolved) {
      const result = await (input.requestResolvedJson ?? requestResolvedOllamaJson)<any>(input.resolved, {
        path: '/api/show',
        method: 'POST',
        json: { model: input.model.name, verbose: false },
        timeoutMs: input.timeoutMs,
        maxResponseBytes: 8 * 1024 * 1024,
      });
      payload = result.value;
    } else {
      return fail('The Ollama backend authority was not resolved.');
    }
  } catch (error) {
    if (error instanceof OllamaProjectModelSelectionError) throw error;
    return fail('The exact installed Ollama model could not be inspected.');
  }
  const capabilities = normalizeCapabilities(payload?.capabilities);
  if (!capabilities.includes('tools')) {
    return fail(`The installed Ollama model ${input.model.name} does not advertise native tool calling.`);
  }
  return Object.freeze({
    model: input.model.name,
    digest: input.model.digest,
    capabilities,
    ...normalizeBackendIdentity(input.resolved
      ? backendIdentity(input.resolved.authority)
      : {
          backendKind: 'LOCAL',
          backendFingerprint: LOCAL_BACKEND_FINGERPRINT,
          backendGeneration: null,
        }),
  });
}

function exactInstalledModel(rows: readonly InstalledModel[], requested: string): InstalledModel | null {
  const matches = rows.filter((entry) => entry.aliases.includes(requested));
  if (matches.length > 1) {
    return fail(`The installed Ollama model identity ${requested} is ambiguous.`);
  }
  return matches[0] || null;
}

/**
 * Resolves one exact, locally installed, tool-capable Ollama model. The
 * returned digest is part of qualification and binding evidence, so replacing
 * a tag in place invalidates Project admission instead of silently changing
 * the model behind an existing session.
 */
export async function resolveAllowedOllamaProjectModel(
  candidates: Array<string | null | undefined>,
  explicitModel?: string | null,
  dependencies: OllamaProjectModelResolverDependencies = {},
): Promise<OllamaProjectModelSelection> {
  const baseUrl = dependencies.baseUrl
    ? requireLoopbackOllamaProjectBaseUrl(dependencies.baseUrl)
    : resolveLocalOllamaEndpoint(
      process.env.OLLAMA_HOST,
      process.env.OLLAMA_API_URL,
      config.ollamaApiUrl,
    );
  const fetchImpl = dependencies.fetchImpl;
  const requestResolvedJson = dependencies.requestResolvedJson ?? requestResolvedOllamaJson;
  const timeoutMs = dependencies.timeoutMs || REQUEST_TIMEOUT_MS;
  let resolved: ResolvedOllamaBackendAuthority | undefined;
  if (!fetchImpl) {
    try {
      resolved = await (dependencies.resolveAuthority ?? resolveOllamaBackendAuthority)();
    } catch {
      return fail('The configured Ollama backend is unavailable for Project Chat.');
    }
  }
  const effectiveBaseUrl = resolved
    ? (resolved.authority.kind === 'LOCAL'
        ? resolved.authority.endpoint
        : 'http://127.0.0.1:11434')
    : baseUrl;
  let catalogPayload: any;
  try {
    if (fetchImpl) {
      const response = await fetchImpl(`${baseUrl}/api/tags`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      catalogPayload = await jsonResponse(response, 'Ollama model catalog');
    } else if (resolved) {
      const result = await requestResolvedJson<any>(resolved, {
        path: '/api/tags',
        method: 'GET',
        timeoutMs,
        maxResponseBytes: 8 * 1024 * 1024,
      });
      catalogPayload = result.value;
    } else {
      return fail('The Ollama backend authority was not resolved.');
    }
  } catch (error) {
    if (error instanceof OllamaProjectModelSelectionError) throw error;
    return fail('The loopback Ollama model catalog is unavailable.');
  }
  const rows = installedModels(catalogPayload);
  if (rows.length === 0) return fail('No Ollama models are installed for Project Chat.');

  const explicit = normalizeModel(explicitModel);
  if (String(explicitModel || '').trim() && !explicit) {
    return fail('The requested Ollama model identity is invalid.');
  }
  if (resolved?.authority.kind === 'TAILNET') {
    const selectedModel = normalizeModel(resolved.authority.selectedModel);
    const selectedDigest = normalizeDigest(resolved.authority.selectedModelDigest);
    if (!selectedModel) {
      return fail('The Tailnet Ollama binding has no exact selected model.');
    }
    if (explicit && explicit !== selectedModel) {
      return fail('Project Chat must use the exact model selected on the Tailnet Ollama backend.');
    }
    const selected = exactInstalledModel(rows, selectedModel);
    if (!selected || selected.digest !== selectedDigest) {
      return fail('The Tailnet Ollama model no longer matches its selected immutable digest.');
    }
    return showInstalledModel({
      model: selected,
      baseUrl: effectiveBaseUrl,
      resolved,
      requestResolvedJson,
      timeoutMs,
    });
  }
  if (explicit) {
    const selected = exactInstalledModel(rows, explicit);
    if (!selected) return fail(`The exact Ollama model ${explicit} is not installed.`);
    return showInstalledModel({
      model: selected,
      baseUrl: effectiveBaseUrl,
      fetchImpl,
      resolved,
      requestResolvedJson,
      timeoutMs,
    });
  }

  const preferred = Array.from(new Set([
    ...candidates.map(normalizeModel),
    normalizeModel(config.ollamaModel),
  ].filter(Boolean)));
  for (const candidate of preferred) {
    const selected = exactInstalledModel(rows, candidate);
    if (!selected) continue;
    try {
      return await showInstalledModel({
        model: selected,
        baseUrl: effectiveBaseUrl,
        fetchImpl,
        resolved,
        requestResolvedJson,
        timeoutMs,
      });
    } catch (error) {
      if (!(error instanceof OllamaProjectModelSelectionError)) throw error;
    }
  }

  for (const selected of rows.slice(0, MAX_CAPABILITY_PROBES)) {
    try {
      return await showInstalledModel({
        model: selected,
        baseUrl: effectiveBaseUrl,
        fetchImpl,
        resolved,
        requestResolvedJson,
        timeoutMs,
      });
    } catch (error) {
      if (!(error instanceof OllamaProjectModelSelectionError)) throw error;
    }
  }
  return fail('No installed Ollama model proved native tool-calling support for Project Chat.');
}

export function ollamaProjectModelBindingValue(selection: OllamaProjectModelSelection): string {
  const model = normalizeModel(selection?.model);
  const digest = normalizeDigest(selection?.digest);
  const backend = normalizeBackendIdentity(selection);
  if (!model || !selection.capabilities.includes('tools')) {
    return fail('The Ollama Project model selection is incomplete.');
  }
  if (backend.backendKind === 'LOCAL') return `${model}@${digest}`;
  return BINDING_PREFIX + Buffer.from(JSON.stringify({
    backendFingerprint: backend.backendFingerprint,
    backendGeneration: backend.backendGeneration,
    backendKind: backend.backendKind,
    digest,
    model,
  }), 'utf8').toString('base64url');
}

export function parseOllamaProjectModelBinding(value: unknown): OllamaProjectModelSelection {
  const binding = String(value || '').trim();
  if (binding.startsWith(BINDING_PREFIX)) {
    const encoded = binding.slice(BINDING_PREFIX.length);
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(encoded)) {
      return fail('The Ollama Project binding is invalid.');
    }
    let parsed: Record<string, unknown>;
    try {
      const decoded = Buffer.from(encoded, 'base64url');
      if (decoded.toString('base64url') !== encoded) throw new Error('non-canonical base64url');
      parsed = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
    } catch {
      return fail('The Ollama Project binding is invalid.');
    }
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(',') !== [
        'backendFingerprint',
        'backendGeneration',
        'backendKind',
        'digest',
        'model',
      ].join(',')
    ) {
      return fail('The Ollama Project binding is invalid.');
    }
    const model = normalizeModel(parsed.model);
    const digest = normalizeDigest(parsed.digest);
    const backend = normalizeBackendIdentity(parsed as Partial<OllamaProjectBackendIdentity>);
    if (!model) return fail('The Ollama Project binding model is invalid.');
    const selection = Object.freeze({
      model,
      digest,
      capabilities: Object.freeze(['tools']),
      ...backend,
    });
    if (ollamaProjectModelBindingValue(selection) !== binding) {
      return fail('The Ollama Project binding is not canonical.');
    }
    return selection;
  }
  const marker = binding.lastIndexOf('@sha256:');
  if (marker <= 0) return fail('The Ollama Project binding has no exact model digest.');
  const model = normalizeModel(binding.slice(0, marker));
  const digest = normalizeDigest(binding.slice(marker + 1));
  if (!model) return fail('The Ollama Project binding model is invalid.');
  return Object.freeze({
    model,
    digest,
    capabilities: Object.freeze(['tools']),
    backendKind: 'LOCAL' as const,
    backendFingerprint: LOCAL_BACKEND_FINGERPRINT,
    backendGeneration: null,
  });
}
