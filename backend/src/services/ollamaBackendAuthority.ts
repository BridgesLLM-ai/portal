import {
  NativeOllamaBackendBindingState,
  OllamaBackendAddressFamily,
  OllamaBackendBindingState,
} from '@prisma/client';
import {
  LegacyOllamaBindingError,
  markLegacyOllamaBindingDisconnected,
  readLegacyOllamaBindingView,
  withLegacyOllamaPairingSecret,
  type LegacyOllamaBindingSnapshot,
  type LegacyOllamaBindingView,
} from './legacyOllamaBindingRead';
import {
  NativeOllamaBindingError,
  markNativeOllamaBindingDisconnected,
  readNativeOllamaBinding,
  updateNativeOllamaBindingObservation,
  type PublicNativeOllamaBindingSnapshot,
} from './nativeOllamaBinding';
import {
  NativeOllamaTransportError,
  requestNativeOllama,
  streamNativeOllama,
  type NativeOllamaStreamConsumerResult,
  type NativeOllamaStreamResponse,
  type NativeOllamaTransportMethod,
  type NativeOllamaTransportPath,
} from './nativeOllamaTransport';
import {
  OLLAMA_TAILNET_PATH_POLICY,
  type OllamaTailnetMethod,
  type OllamaTailnetPath,
} from './ollamaTailnetProtocol';
import {
  OllamaTailnetTransportError,
  requestOllamaOverTailnet,
} from './ollamaTailnetTransport';
import { getLocalOllamaRuntimeConfiguration } from './localOllamaRuntime';
import {
  reattestTailscalePeer,
  type TailscalePeerAttestation,
  type TailscalePeerReattestationResult,
} from './tailscalePeerAttestor';
import {
  deferOllamaAuthorityMutationUntilRunsSettle,
  withOllamaAuthorityRunLease,
} from './ollamaAuthorityBarrier';
import {
  NativeOllamaBackendError,
  assertCurrentNativeOllamaGrantSnapshot,
} from './nativeOllamaBackend';

export type OllamaBackendAuthorityErrorCode =
  | 'LOCAL_DISABLED'
  | 'REMOTE_DISCONNECTED'
  | 'REMOTE_IDENTITY_UNAVAILABLE'
  | 'REMOTE_IDENTITY_CHANGED'
  | 'GRANT_SNAPSHOT_CHANGED'
  | 'REMOTE_PATH_UNSUPPORTED'
  | 'BINDING_INVALID'
  | 'BINDING_CHANGED'
  | 'MODEL_MISMATCH'
  | 'REQUEST_INVALID'
  | 'ABORTED'
  | 'TIMED_OUT'
  | 'HTTP_STATUS'
  | 'RESPONSE_INVALID'
  | 'RESPONSE_TOO_LARGE'
  | 'BACKEND_UNAVAILABLE';

const ERROR_MESSAGES: Readonly<Record<OllamaBackendAuthorityErrorCode, string>> =
  Object.freeze({
    LOCAL_DISABLED: 'Local Ollama is disabled and no active Tailnet backend is configured.',
    REMOTE_DISCONNECTED: 'The configured Tailnet Ollama backend must be reverified before use.',
    REMOTE_IDENTITY_UNAVAILABLE: 'The configured Tailnet Ollama peer is not currently available.',
    REMOTE_IDENTITY_CHANGED:
      'The configured Tailnet Ollama peer identity changed and must be connected again.',
    GRANT_SNAPSHOT_CHANGED:
      'The Remote GPU peer or required Tailscale Grant changed. Review the current Grant and reconnect.',
    REMOTE_PATH_UNSUPPORTED: 'The configured Tailnet Ollama backend does not allow this operation.',
    BINDING_INVALID: 'The configured Tailnet Ollama binding is incomplete.',
    BINDING_CHANGED: 'The configured Tailnet Ollama binding changed; retry with fresh state.',
    MODEL_MISMATCH: 'The Ollama request model does not match the active backend model.',
    REQUEST_INVALID: 'The Ollama backend request is invalid.',
    ABORTED: 'The Ollama backend request was aborted.',
    TIMED_OUT: 'The Ollama backend request timed out.',
    HTTP_STATUS: 'Ollama returned a non-success status.',
    RESPONSE_INVALID: 'Ollama returned an invalid response.',
    RESPONSE_TOO_LARGE: 'Ollama returned a response larger than the allowed limit.',
    BACKEND_UNAVAILABLE: 'The selected Ollama backend is unavailable.',
  });

export class OllamaBackendAuthorityError extends Error {
  constructor(
    public readonly code: OllamaBackendAuthorityErrorCode,
    public readonly statusCode = 503,
    public readonly upstreamStatus?: number,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'OllamaBackendAuthorityError';
  }

  toJSON(): Readonly<{
    name: 'OllamaBackendAuthorityError';
    code: OllamaBackendAuthorityErrorCode;
    message: string;
    statusCode: number;
  }> {
    return Object.freeze({
      name: 'OllamaBackendAuthorityError' as const,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
    });
  }
}

export interface LocalOllamaBackendAuthority {
  readonly kind: 'LOCAL';
  readonly source: 'local-policy';
  readonly endpoint: 'http://127.0.0.1:11434';
  readonly generation: null;
  readonly version: null;
  readonly bindingFingerprint: 'local-ollama-v1:127.0.0.1:11434';
  readonly selectedModel: null;
  readonly selectedModelDigest: null;
}

export interface TailnetOllamaBackendAuthority {
  readonly kind: 'TAILNET';
  readonly source: 'tailnet-binding';
  readonly endpoint: null;
  readonly generation: number;
  readonly version: number;
  readonly bindingFingerprint: string;
  readonly selectedModel: string | null;
  readonly selectedModelDigest: string | null;
}

export type OllamaBackendAuthority =
  | LocalOllamaBackendAuthority
  | TailnetOllamaBackendAuthority;

export interface OllamaBackendAuthorityResponse {
  readonly authority: OllamaBackendAuthority;
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
  readonly streaming: false;
}

export interface OllamaBackendAuthorityStreamResponse {
  readonly authority: OllamaBackendAuthority;
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly responseBytes: number;
  readonly streaming: true;
}

export interface OllamaBackendAuthorityRequest {
  readonly path: NativeOllamaTransportPath;
  readonly method: NativeOllamaTransportMethod;
  readonly json?: unknown;
  readonly body?: Uint8Array | string;
  /**
   * Optional immutable model identity for inference. Tailnet inference always
   * enforces the binding's selected digest; Project bridges also use this for
   * local-model scopes.
   */
  readonly expectedModelDigest?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ResolvedNativeOllamaBindingView {
  readonly purposeId: 'PRIMARY';
  readonly authority: PublicNativeOllamaBindingSnapshot | null;
  /** Runtime-only bridge for a pre-native active helper authority. */
  readonly legacyAuthority?: LegacyOllamaBindingSnapshot | null;
  // Kept as a fixed compatibility field for callers that previously rendered
  // helper candidates. Native connections are probed before publication.
  readonly candidate: null;
}

export interface OllamaBackendAuthorityDependencies {
  readonly readNativeBinding?: typeof readNativeOllamaBinding;
  /** @deprecated Test compatibility alias for readNativeBinding. */
  readonly readBinding?: typeof readNativeOllamaBinding;
  /** @deprecated Test compatibility alias for readLegacyView. */
  readonly readLegacyBinding?: typeof readLegacyOllamaBindingView;
  readonly readLegacyView?: typeof readLegacyOllamaBindingView;
  readonly getLocalRuntime?: typeof getLocalOllamaRuntimeConfiguration;
  readonly reattestPeer?: typeof reattestTailscalePeer;
  readonly assertGrantSnapshot?: typeof assertCurrentNativeOllamaGrantSnapshot;
  readonly updateNativeObservation?: typeof updateNativeOllamaBindingObservation;
  readonly markNativeDisconnected?: typeof markNativeOllamaBindingDisconnected;
  readonly requestNative?: typeof requestNativeOllama;
  readonly streamNative?: typeof streamNativeOllama;
  readonly withLegacySecret?: typeof withLegacyOllamaPairingSecret;
  readonly requestLegacy?: typeof requestOllamaOverTailnet;
  readonly markLegacyDisconnected?:
    typeof markLegacyOllamaBindingDisconnected;
  readonly revocationRetrySleep?: (milliseconds: number) => Promise<void>;
  readonly deferAuthorityMutation?: typeof deferOllamaAuthorityMutationUntilRunsSettle;
}

export interface ResolvedOllamaBackendAuthority {
  readonly authority: OllamaBackendAuthority;
  readonly bindingView: ResolvedNativeOllamaBindingView;
}

const LOCAL_AUTHORITY: LocalOllamaBackendAuthority = Object.freeze({
  kind: 'LOCAL',
  source: 'local-policy',
  endpoint: 'http://127.0.0.1:11434',
  generation: null,
  version: null,
  bindingFingerprint: 'local-ollama-v1:127.0.0.1:11434',
  selectedModel: null,
  selectedModelDigest: null,
});

const REVOCATION_RETRY_INITIAL_MS = 250;
const REVOCATION_RETRY_MAX_MS = 5_000;

function authorityError(
  code: OllamaBackendAuthorityErrorCode,
  statusCode = 503,
  upstreamStatus?: number,
): OllamaBackendAuthorityError {
  return new OllamaBackendAuthorityError(code, statusCode, upstreamStatus);
}

function nativeBindingView(
  authority: PublicNativeOllamaBindingSnapshot | null,
  legacyAuthority: LegacyOllamaBindingSnapshot | null = null,
): ResolvedNativeOllamaBindingView {
  return Object.freeze({
    purposeId: 'PRIMARY' as const,
    authority,
    legacyAuthority,
    candidate: null,
  });
}

function legacyTailnetAuthority(
  binding: LegacyOllamaBindingSnapshot,
): TailnetOllamaBackendAuthority {
  if (
    binding.state !== OllamaBackendBindingState.ACTIVE
    || !binding.hasPairingSecret
    || !binding.attestationVerified
    || !binding.protocolVerified
    || !binding.selectedModel
    || !binding.selectedModelDigest
    || !binding.bindingFingerprint
  ) {
    throw authorityError('BINDING_INVALID', 409);
  }
  return Object.freeze({
    kind: 'TAILNET' as const,
    source: 'tailnet-binding' as const,
    endpoint: null,
    generation: binding.generation,
    version: binding.version,
    bindingFingerprint: binding.bindingFingerprint,
    selectedModel: binding.selectedModel,
    selectedModelDigest: binding.selectedModelDigest,
  });
}

function tailnetAuthority(
  binding: PublicNativeOllamaBindingSnapshot,
): TailnetOllamaBackendAuthority {
  if (
    binding.state !== NativeOllamaBackendBindingState.ACTIVE
    || binding.servePort !== 11435
    || !binding.bindingFingerprint
  ) {
    throw authorityError('BINDING_INVALID', 409);
  }
  return Object.freeze({
    kind: 'TAILNET' as const,
    source: 'tailnet-binding' as const,
    endpoint: null,
    generation: binding.generation,
    version: binding.version,
    bindingFingerprint: binding.bindingFingerprint,
    selectedModel: binding.selectedModel,
    selectedModelDigest: binding.selectedModelDigest,
  });
}

async function readNativeView(
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<ResolvedNativeOllamaBindingView> {
  const read = dependencies.readNativeBinding
    ?? dependencies.readBinding
    ?? readNativeOllamaBinding;
  const view = await read();
  return nativeBindingView(view.authority);
}

export async function resolveOllamaBackendAuthority(
  dependencies: OllamaBackendAuthorityDependencies = {},
): Promise<ResolvedOllamaBackendAuthority> {
  const bindingView = await readNativeView(dependencies);
  if (bindingView.authority) {
    if (bindingView.authority.state === NativeOllamaBackendBindingState.DISCONNECTED) {
      throw authorityError('REMOTE_DISCONNECTED', 409);
    }
    return Object.freeze({
      authority: tailnetAuthority(bindingView.authority),
      bindingView,
    });
  }

  // Keep a previously activated helper authority operational during the
  // native migration window. Native ACTIVE/DISCONNECTED always wins above;
  // absent native, legacy ACTIVE/DISCONNECTED still outranks local.
  const legacyView = await (
    dependencies.readLegacyView
      ?? dependencies.readLegacyBinding
      ?? readLegacyOllamaBindingView
  )();
  if (legacyView.authority) {
    const legacyBindingView = nativeBindingView(
      null,
      legacyView.authority,
    );
    if (legacyView.authority.state === OllamaBackendBindingState.DISCONNECTED) {
      throw authorityError('REMOTE_DISCONNECTED', 409);
    }
    return Object.freeze({
      authority: legacyTailnetAuthority(legacyView.authority),
      bindingView: legacyBindingView,
    });
  }

  const local = await (
    dependencies.getLocalRuntime ?? getLocalOllamaRuntimeConfiguration
  )();
  if (!local.enabled) throw authorityError('LOCAL_DISABLED', 409);
  return Object.freeze({ authority: LOCAL_AUTHORITY, bindingView });
}

function encodedRequestBody(input: OllamaBackendAuthorityRequest): Buffer {
  if (input.json !== undefined && input.body !== undefined) {
    throw authorityError('REQUEST_INVALID', 400);
  }
  try {
    if (input.json !== undefined) return Buffer.from(JSON.stringify(input.json), 'utf8');
    if (typeof input.body === 'string') return Buffer.from(input.body, 'utf8');
    if (input.body instanceof Uint8Array) return Buffer.from(input.body);
    return Buffer.alloc(0);
  } catch {
    throw authorityError('REQUEST_INVALID', 400);
  }
}

function requestedInferenceModel(
  input: OllamaBackendAuthorityRequest,
  body: Buffer,
): string | null {
  if (input.path !== '/api/chat' && input.path !== '/api/generate') return null;
  try {
    const parsed = input.json !== undefined
      ? input.json
      : JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const model = (parsed as Record<string, unknown>).model;
    return typeof model === 'string' && model.trim() === model && model
      ? model
      : null;
  } catch {
    return null;
  }
}

function isModelUnloadRequest(
  input: OllamaBackendAuthorityRequest,
  body: Buffer,
): boolean {
  if (input.path !== '/api/generate') return false;
  try {
    const parsed = input.json !== undefined
      ? input.json
      : JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return record.keep_alive === 0
      && (record.prompt === undefined || record.prompt === '')
      && (record.stream === undefined || record.stream === false);
  } catch {
    return false;
  }
}

interface InferenceModelExpectation {
  readonly model: string;
  readonly digest: `sha256:${string}`;
}

function normalizedModelDigest(value: unknown): `sha256:${string}` | null {
  const match = String(value || '').trim().match(/^(?:sha256:)?([a-f0-9]{64})$/iu);
  return match ? `sha256:${match[1].toLowerCase()}` : null;
}

function remoteInferenceExpectation(
  binding: Pick<
    PublicNativeOllamaBindingSnapshot,
    'selectedModel' | 'selectedModelDigest'
  >,
  input: OllamaBackendAuthorityRequest,
  body: Buffer,
): InferenceModelExpectation | null {
  if (input.path !== '/api/chat' && input.path !== '/api/generate') return null;
  const model = requestedInferenceModel(input, body);
  if (model && isModelUnloadRequest(input, body)) return null;
  const selectedDigest = normalizedModelDigest(binding.selectedModelDigest);
  const suppliedDigest = input.expectedModelDigest === undefined
    ? selectedDigest
    : normalizedModelDigest(input.expectedModelDigest);
  if (
    !model
    || !binding.selectedModel
    || !selectedDigest
    || !suppliedDigest
    || model !== binding.selectedModel
    || suppliedDigest !== selectedDigest
  ) {
    throw authorityError('MODEL_MISMATCH', 409);
  }
  return Object.freeze({ model, digest: selectedDigest });
}

function optionalLocalInferenceExpectation(
  input: OllamaBackendAuthorityRequest,
  body: Buffer,
): InferenceModelExpectation | null {
  if (input.path !== '/api/chat' && input.path !== '/api/generate') return null;
  const model = requestedInferenceModel(input, body);
  if (model && isModelUnloadRequest(input, body)) return null;
  if (input.expectedModelDigest === undefined) return null;
  const digest = normalizedModelDigest(input.expectedModelDigest);
  if (!model || !digest) throw authorityError('MODEL_MISMATCH', 409);
  return Object.freeze({ model, digest });
}

async function assertEndpointModelDigest(
  endpoint: ReturnType<typeof endpointFor> | ReturnType<typeof localEndpoint>,
  expectation: InferenceModelExpectation | null,
  input: OllamaBackendAuthorityRequest,
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<void> {
  if (!expectation) return;
  const response = await (
    dependencies.requestNative ?? requestNativeOllama
  )({
    endpoint,
    path: '/api/tags',
    method: 'GET',
    timeoutMs: Math.min(input.timeoutMs ?? 10_000, 10_000),
    maxResponseBytes: 8 * 1024 * 1024,
    signal: input.signal,
  });
  try {
    let payload: unknown;
    try {
      payload = JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
      throw authorityError('RESPONSE_INVALID', 502);
    }
    const models = Array.isArray((payload as { models?: unknown } | null)?.models)
      ? (payload as { models: unknown[] }).models
      : null;
    if (!models || models.length > 1_000) {
      throw authorityError('RESPONSE_INVALID', 502);
    }
    const matches = models.filter((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const row = entry as Record<string, unknown>;
      return row.name === expectation.model || row.model === expectation.model;
    });
    if (
      matches.length !== 1
      || normalizedModelDigest(
        (matches[0] as Record<string, unknown>).digest,
      ) !== expectation.digest
    ) {
      throw authorityError('MODEL_MISMATCH', 409);
    }
  } finally {
    response.body.fill(0);
  }
}

function observedDate(value: string): Date {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function samePinnedIdentity(
  binding: PublicNativeOllamaBindingSnapshot,
  attestation: TailscalePeerAttestation,
): boolean {
  return binding.tailnetName === attestation.tailnetName
    && binding.stableNodeId === attestation.stableNodeId
    && binding.nodePublicKey === attestation.nodePublicKey;
}

function defaultRevocationRetrySleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

async function persistDisconnectedUntilSafe(
  binding: PublicNativeOllamaBindingSnapshot,
  disconnectedAt: Date,
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<void> {
  if (binding.state !== NativeOllamaBackendBindingState.ACTIVE) return;
  const mark = dependencies.markNativeDisconnected
    ?? markNativeOllamaBindingDisconnected;
  const read = dependencies.readNativeBinding
    ?? dependencies.readBinding
    ?? readNativeOllamaBinding;
  const sleep = dependencies.revocationRetrySleep ?? defaultRevocationRetrySleep;
  let expectedVersion = binding.version;
  let retryDelayMs = REVOCATION_RETRY_INITIAL_MS;
  const floor = Math.max(
    disconnectedAt.getTime(),
    binding.activatedAt.getTime(),
    binding.observedAt.getTime(),
    binding.verifiedAt.getTime(),
  );

  for (;;) {
    try {
      const disconnected = await mark({
        generation: binding.generation,
        expectedVersion,
        disconnectedAt: new Date(floor),
      });
      if (
        disconnected.generation === binding.generation
        && disconnected.state === NativeOllamaBackendBindingState.DISCONNECTED
      ) {
        return;
      }
    } catch {
      // Re-read below. An uncertain revocation must keep admission closed.
    }

    try {
      const current = (await read()).authority;
      if (
        current === null
        || current.generation > binding.generation
        || (
          current.generation === binding.generation
          && current.state === NativeOllamaBackendBindingState.DISCONNECTED
        )
      ) {
        return;
      }
      if (
        current.state === NativeOllamaBackendBindingState.ACTIVE
        && current.bindingFingerprint === binding.bindingFingerprint
      ) {
        expectedVersion = current.version;
      }
    } catch {
      // Absence of a trustworthy reread is not proof of supersession.
    }

    await sleep(retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, REVOCATION_RETRY_MAX_MS);
  }
}

function deferDisconnectedUntilRunsSettle(
  binding: PublicNativeOllamaBindingSnapshot,
  disconnectedAt: Date,
  dependencies: OllamaBackendAuthorityDependencies,
): void {
  if (binding.state !== NativeOllamaBackendBindingState.ACTIVE) return;
  const deferred = (
    dependencies.deferAuthorityMutation
    ?? deferOllamaAuthorityMutationUntilRunsSettle
  )(() => persistDisconnectedUntilSafe(binding, disconnectedAt, dependencies));
  void deferred.catch(() => {
    console.error(
      '[ollama-authority] Deferred disconnect persistence failed; Ollama authority remains fenced.',
    );
  });
}

function identityFailure(
  binding: PublicNativeOllamaBindingSnapshot,
  result: Exclude<
    TailscalePeerReattestationResult,
    { state: 'ATTESTED' }
  >,
  dependencies: OllamaBackendAuthorityDependencies,
): never {
  const when = result.state === 'UNAVAILABLE'
    ? observedDate(result.observedAt)
    : observedDate(result.candidate.observedAt);
  deferDisconnectedUntilRunsSettle(binding, when, dependencies);
  if (result.state === 'BINDING_GENERATION_ADVANCE_REQUIRED') {
    throw authorityError('REMOTE_IDENTITY_CHANGED', 409);
  }
  throw authorityError('REMOTE_IDENTITY_UNAVAILABLE', 503);
}

async function currentReattestedBinding(
  binding: PublicNativeOllamaBindingSnapshot,
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<PublicNativeOllamaBindingSnapshot> {
  const result = await (
    dependencies.reattestPeer ?? reattestTailscalePeer
  )({
    tailnetName: binding.tailnetName,
    stableNodeId: binding.stableNodeId,
    nodePublicKey: binding.nodePublicKey,
    boundAddress: binding.observedAddress,
  });
  if (result.state !== 'ATTESTED') {
    return identityFailure(binding, result, dependencies);
  }
  if (!samePinnedIdentity(binding, result.attestation)) {
    deferDisconnectedUntilRunsSettle(
      binding,
      observedDate(result.attestation.observedAt),
      dependencies,
    );
    throw authorityError('REMOTE_IDENTITY_CHANGED', 409);
  }
  try {
    await (
      dependencies.assertGrantSnapshot
      ?? assertCurrentNativeOllamaGrantSnapshot
    )(binding, result.attestation);
  } catch (error) {
    if (
      error instanceof NativeOllamaBackendError
      && error.code === 'GRANT_SNAPSHOT_CHANGED'
    ) {
      // A changed peer/Portal address or Grant template invalidates the
      // Owner's exact acknowledgement. Keep the current request fail-closed
      // and persist DISCONNECTED only after the enclosing run lease settles.
      deferDisconnectedUntilRunsSettle(
        binding,
        observedDate(result.attestation.observedAt),
        dependencies,
      );
      throw authorityError('GRANT_SNAPSHOT_CHANGED', 409);
    }
    if (
      error instanceof NativeOllamaBackendError
      && error.code === 'TAILSCALE_UNAVAILABLE'
    ) {
      throw authorityError('REMOTE_IDENTITY_UNAVAILABLE', 503);
    }
    throw error;
  }
  if (
    binding.observedAddress === result.attestation.address
    && binding.addressFamily === result.attestation.addressFamily
  ) {
    return binding;
  }

  const update = dependencies.updateNativeObservation
    ?? updateNativeOllamaBindingObservation;
  try {
    return await update({
      generation: binding.generation,
      expectedVersion: binding.version,
      tailnetName: binding.tailnetName,
      stableNodeId: binding.stableNodeId,
      nodePublicKey: binding.nodePublicKey,
      observedAddress: result.attestation.address,
      addressFamily: result.attestation.addressFamily,
      servePort: 11435,
      observedAt: observedDate(result.attestation.observedAt),
    });
  } catch (error) {
    if (!(error instanceof NativeOllamaBindingError)) throw error;
    const current = (await readNativeView(dependencies)).authority;
    if (
      current
      && current.state === NativeOllamaBackendBindingState.ACTIVE
      && current.generation === binding.generation
      && current.bindingFingerprint === binding.bindingFingerprint
      && current.observedAddress === result.attestation.address
      && current.addressFamily === result.attestation.addressFamily
    ) {
      return current;
    }
    throw authorityError('BINDING_CHANGED', 409);
  }
}

function endpointFor(binding: PublicNativeOllamaBindingSnapshot) {
  return Object.freeze({
    address: binding.observedAddress,
    family: binding.addressFamily === OllamaBackendAddressFamily.IPV4
      ? 4 as const
      : 6 as const,
    port: 11435 as const,
  });
}

function localEndpoint() {
  return Object.freeze({
    address: '127.0.0.1',
    family: 4 as const,
    port: 11434 as const,
  });
}

function mapNativeTransportError(
  error: NativeOllamaTransportError,
): OllamaBackendAuthorityError {
  switch (error.code) {
    case 'ABORTED':
      return authorityError('ABORTED', 499);
    case 'TIMEOUT':
      return authorityError('TIMED_OUT', 504);
    case 'HTTP_STATUS':
      return authorityError('HTTP_STATUS', 502, error.statusCode);
    case 'RESPONSE_INVALID':
      return authorityError('RESPONSE_INVALID', 502);
    case 'RESPONSE_TOO_LARGE':
      return authorityError('RESPONSE_TOO_LARGE', 502);
    case 'REQUEST_INVALID':
    case 'REQUEST_TOO_LARGE':
      return authorityError('REQUEST_INVALID', 400);
    case 'CONNECTION_FAILED':
    default:
      return authorityError('BACKEND_UNAVAILABLE', 503);
  }
}

function legacyPath(
  path: NativeOllamaTransportPath,
  method: NativeOllamaTransportMethod,
): Readonly<{ path: OllamaTailnetPath; method: OllamaTailnetMethod }> {
  if (!Object.prototype.hasOwnProperty.call(OLLAMA_TAILNET_PATH_POLICY, path)) {
    throw authorityError('REMOTE_PATH_UNSUPPORTED', 409);
  }
  const policy = OLLAMA_TAILNET_PATH_POLICY[path as OllamaTailnetPath];
  if (method !== policy.method) throw authorityError('REQUEST_INVALID', 400);
  return Object.freeze({
    path: path as OllamaTailnetPath,
    method: method as OllamaTailnetMethod,
  });
}

async function persistLegacyDisconnectedUntilSafe(
  binding: LegacyOllamaBindingSnapshot,
  observedAt: Date,
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<void> {
  if (binding.state !== OllamaBackendBindingState.ACTIVE) return;
  const mark = dependencies.markLegacyDisconnected
    ?? markLegacyOllamaBindingDisconnected;
  const read = dependencies.readLegacyView
    ?? dependencies.readLegacyBinding
    ?? readLegacyOllamaBindingView;
  const sleep = dependencies.revocationRetrySleep ?? defaultRevocationRetrySleep;
  let expectedVersion = binding.version;
  let retryDelayMs = REVOCATION_RETRY_INITIAL_MS;

  for (;;) {
    try {
      const disconnected = await mark({
        generation: binding.generation,
        expectedVersion,
        observedAt,
      });
      if (
        disconnected.generation === binding.generation
        && disconnected.state === OllamaBackendBindingState.DISCONNECTED
      ) {
        return;
      }
    } catch {
      // Re-read below; uncertainty keeps authority admission fail-closed.
    }

    try {
      // A native successor outranks this compatibility authority, so no
      // further legacy revocation work can affect current dispatch.
      if ((await readNativeView(dependencies)).authority) return;
      const current = (await read()).authority;
      if (
        current === null
        || current.generation > binding.generation
        || (
          current.generation === binding.generation
          && current.state === OllamaBackendBindingState.DISCONNECTED
        )
      ) {
        return;
      }
      if (
        current.state === OllamaBackendBindingState.ACTIVE
        && current.bindingFingerprint === binding.bindingFingerprint
      ) {
        expectedVersion = current.version;
      }
    } catch {
      // No trustworthy reread means no proof that the authority was replaced.
    }

    await sleep(retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, REVOCATION_RETRY_MAX_MS);
  }
}

function deferLegacyDisconnectedUntilRunsSettle(
  binding: LegacyOllamaBindingSnapshot,
  observedAt: Date,
  dependencies: OllamaBackendAuthorityDependencies,
): void {
  if (binding.state !== OllamaBackendBindingState.ACTIVE) return;
  const deferred = (
    dependencies.deferAuthorityMutation
    ?? deferOllamaAuthorityMutationUntilRunsSettle
  )(() => persistLegacyDisconnectedUntilSafe(
    binding,
    observedAt,
    dependencies,
  ));
  void deferred.catch(() => {
    console.error(
      '[ollama-authority] Deferred legacy disconnect persistence failed; Ollama authority remains fenced.',
    );
  });
}

async function requireCurrentLegacyPeer(
  binding: LegacyOllamaBindingSnapshot,
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<void> {
  const result = await (
    dependencies.reattestPeer ?? reattestTailscalePeer
  )({
    tailnetName: binding.tailnetName,
    stableNodeId: binding.stableNodeId,
    nodePublicKey: binding.nodePublicKey,
    boundAddress: binding.address,
  });
  if (result.state !== 'ATTESTED') {
    const when = result.state === 'UNAVAILABLE'
      ? observedDate(result.observedAt)
      : observedDate(result.candidate.observedAt);
    deferLegacyDisconnectedUntilRunsSettle(binding, when, dependencies);
    if (result.state === 'BINDING_GENERATION_ADVANCE_REQUIRED') {
      throw authorityError('REMOTE_IDENTITY_CHANGED', 409);
    }
    throw authorityError('REMOTE_IDENTITY_UNAVAILABLE', 503);
  }
  if (
    result.attestation.tailnetName !== binding.tailnetName
    || result.attestation.stableNodeId !== binding.stableNodeId
    || result.attestation.nodePublicKey !== binding.nodePublicKey
    // Protocol v2 authenticates the original address as part of every
    // envelope. Address rotation therefore requires native migration rather
    // than silently changing the legacy cryptographic binding.
    || result.attestation.address !== binding.address
  ) {
    deferLegacyDisconnectedUntilRunsSettle(
      binding,
      observedDate(result.attestation.observedAt),
      dependencies,
    );
    throw authorityError('REMOTE_IDENTITY_CHANGED', 409);
  }
}

function shouldDisconnectLegacyTransport(
  error: OllamaTailnetTransportError,
): boolean {
  return ![
    'ABORTED',
    'TIMED_OUT',
    'REQUEST_INVALID',
    'TIMEOUT_INVALID',
  ].includes(error.code);
}

function mapLegacyTransportError(
  error: OllamaTailnetTransportError,
): OllamaBackendAuthorityError {
  if (error.code === 'ABORTED') return authorityError('ABORTED', 499);
  if (error.code === 'TIMED_OUT') return authorityError('TIMED_OUT', 504);
  if (
    error.code === 'REQUEST_INVALID'
    || error.code === 'TIMEOUT_INVALID'
  ) {
    return authorityError('REQUEST_INVALID', 400);
  }
  return authorityError('BACKEND_UNAVAILABLE', 503);
}

async function requestLegacyRaw(
  binding: LegacyOllamaBindingSnapshot,
  input: OllamaBackendAuthorityRequest,
  body: Buffer,
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<OllamaBackendAuthorityResponse> {
  const request = legacyPath(input.path, input.method);
  await requireCurrentLegacyPeer(binding, dependencies);
  try {
    const response = await (
      dependencies.withLegacySecret ?? withLegacyOllamaPairingSecret
    )({
      generation: binding.generation,
      expectedVersion: binding.version,
      allowedStates: [OllamaBackendBindingState.ACTIVE],
    }, async (secret) => (
      (dependencies.requestLegacy ?? requestOllamaOverTailnet)({
        generation: binding.generation,
        stableNodeId: binding.stableNodeId,
        nodePublicKey: binding.nodePublicKey,
        tailnetName: binding.tailnetName,
        address: binding.address,
        helperPort: binding.helperPort,
        helperId: binding.helperId,
        secret,
      }, {
        path: request.path,
        method: request.method,
        body,
      }, {
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      })
    ));
    if (response.status < 200 || response.status >= 300) {
      response.body.fill(0);
      throw authorityError('HTTP_STATUS', 502, response.status);
    }
    if (
      input.maxResponseBytes !== undefined
      && response.body.byteLength > input.maxResponseBytes
    ) {
      response.body.fill(0);
      throw authorityError('RESPONSE_TOO_LARGE', 502);
    }
    return Object.freeze({
      authority: legacyTailnetAuthority(binding),
      statusCode: response.status,
      headers: Object.freeze({}),
      body: response.body,
      streaming: false as const,
    });
  } catch (error) {
    if (error instanceof OllamaBackendAuthorityError) throw error;
    if (error instanceof LegacyOllamaBindingError) {
      throw authorityError('BINDING_CHANGED', 409);
    }
    if (error instanceof OllamaTailnetTransportError) {
      if (shouldDisconnectLegacyTransport(error)) {
        deferLegacyDisconnectedUntilRunsSettle(
          binding,
          new Date(),
          dependencies,
        );
      }
      throw mapLegacyTransportError(error);
    }
    throw authorityError('BACKEND_UNAVAILABLE', 503);
  }
}

function assertLegacyTagsDigest(
  response: OllamaBackendAuthorityResponse,
  expectation: InferenceModelExpectation | null,
): void {
  if (!expectation) return;
  try {
    let payload: unknown;
    try {
      payload = JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
      throw authorityError('RESPONSE_INVALID', 502);
    }
    const models = Array.isArray((payload as { models?: unknown } | null)?.models)
      ? (payload as { models: unknown[] }).models
      : null;
    if (!models || models.length > 1_000) {
      throw authorityError('RESPONSE_INVALID', 502);
    }
    const matches = models.filter((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return false;
      }
      const row = entry as Record<string, unknown>;
      return row.name === expectation.model || row.model === expectation.model;
    });
    if (
      matches.length !== 1
      || normalizedModelDigest(
        (matches[0] as Record<string, unknown>).digest,
      ) !== expectation.digest
    ) {
      throw authorityError('MODEL_MISMATCH', 409);
    }
  } finally {
    response.body.fill(0);
  }
}

async function requestLegacyAuthority(
  binding: LegacyOllamaBindingSnapshot,
  input: OllamaBackendAuthorityRequest,
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<OllamaBackendAuthorityResponse> {
  if (binding.state === OllamaBackendBindingState.DISCONNECTED) {
    throw authorityError('REMOTE_DISCONNECTED', 409);
  }
  if (binding.state !== OllamaBackendBindingState.ACTIVE) {
    throw authorityError('BINDING_CHANGED', 409);
  }
  const body = encodedRequestBody(input);
  try {
    const expectation = remoteInferenceExpectation(
      binding,
      input,
      body,
    );
    if (expectation) {
      const tags = await requestLegacyRaw(binding, {
        path: '/api/tags',
        method: 'GET',
        timeoutMs: Math.min(input.timeoutMs ?? 10_000, 10_000),
        maxResponseBytes: 8 * 1024 * 1024,
        signal: input.signal,
      }, Buffer.alloc(0), dependencies);
      assertLegacyTagsDigest(tags, expectation);
    }
    return await requestLegacyRaw(binding, input, body, dependencies);
  } finally {
    body.fill(0);
  }
}

async function exactTailnetBinding(
  binding: PublicNativeOllamaBindingSnapshot,
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<PublicNativeOllamaBindingSnapshot> {
  if (binding.state === NativeOllamaBackendBindingState.DISCONNECTED) {
    throw authorityError('REMOTE_DISCONNECTED', 409);
  }
  if (binding.state !== NativeOllamaBackendBindingState.ACTIVE) {
    throw authorityError('BINDING_CHANGED', 409);
  }
  return currentReattestedBinding(binding, dependencies);
}

export async function requestExactTailnetOllama(
  binding: PublicNativeOllamaBindingSnapshot,
  input: OllamaBackendAuthorityRequest,
  options: {
    /** @deprecated Native bindings publish only after probe and have no pending dispatch state. */
    readonly allowedStates?: readonly unknown[];
    readonly dependencies?: OllamaBackendAuthorityDependencies;
  } = {},
): Promise<OllamaBackendAuthorityResponse> {
  const dependencies = options.dependencies ?? {};
  const body = encodedRequestBody(input);
  try {
    const current = await exactTailnetBinding(binding, dependencies);
    const expectation = remoteInferenceExpectation(current, input, body);
    await assertEndpointModelDigest(
      endpointFor(current),
      expectation,
      input,
      dependencies,
    );
    const response = await (
      dependencies.requestNative ?? requestNativeOllama
    )({
      endpoint: endpointFor(current),
      path: input.path,
      method: input.method,
      ...(body.byteLength > 0 ? { body } : {}),
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      signal: input.signal,
    });
    return Object.freeze({
      authority: tailnetAuthority(current),
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
      streaming: false as const,
    });
  } catch (error) {
    if (error instanceof OllamaBackendAuthorityError) throw error;
    if (error instanceof NativeOllamaBindingError) {
      throw authorityError('BINDING_CHANGED', 409);
    }
    if (error instanceof NativeOllamaTransportError) {
      if (error.code === 'CONNECTION_FAILED') {
        deferDisconnectedUntilRunsSettle(binding, new Date(), dependencies);
      }
      throw mapNativeTransportError(error);
    }
    throw authorityError('RESPONSE_INVALID', 502);
  } finally {
    body.fill(0);
  }
}

async function requestLocalAuthority(
  input: OllamaBackendAuthorityRequest,
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<OllamaBackendAuthorityResponse> {
  const body = encodedRequestBody(input);
  try {
    await assertEndpointModelDigest(
      localEndpoint(),
      optionalLocalInferenceExpectation(input, body),
      input,
      dependencies,
    );
    const response = await (
      dependencies.requestNative ?? requestNativeOllama
    )({
      endpoint: localEndpoint(),
      path: input.path,
      method: input.method,
      ...(body.byteLength > 0 ? { body } : {}),
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      signal: input.signal,
    });
    return Object.freeze({
      authority: LOCAL_AUTHORITY,
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
      streaming: false as const,
    });
  } catch (error) {
    if (error instanceof NativeOllamaTransportError) {
      throw mapNativeTransportError(error);
    }
    throw authorityError('BACKEND_UNAVAILABLE', 503);
  } finally {
    body.fill(0);
  }
}

function sameAuthorityIdentity(
  supplied: OllamaBackendAuthority,
  current: OllamaBackendAuthority,
): boolean {
  return supplied.kind === current.kind
    && supplied.source === current.source
    && supplied.endpoint === current.endpoint
    && supplied.generation === current.generation
    && supplied.bindingFingerprint === current.bindingFingerprint
    && supplied.selectedModel === current.selectedModel
    && supplied.selectedModelDigest === current.selectedModelDigest;
}

async function requestResolvedOllamaUnderLease(
  resolved: ResolvedOllamaBackendAuthority,
  input: OllamaBackendAuthorityRequest,
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<OllamaBackendAuthorityResponse> {
  if (resolved.authority.kind === 'LOCAL') {
    return requestLocalAuthority(input, dependencies);
  }
  const binding = resolved.bindingView.authority;
  if (binding) {
    return requestExactTailnetOllama(binding, input, { dependencies });
  }
  const legacyBinding = resolved.bindingView.legacyAuthority;
  if (legacyBinding) {
    return requestLegacyAuthority(legacyBinding, input, dependencies);
  }
  throw authorityError('BINDING_CHANGED', 409);
}

export async function requestConfiguredOllama(
  input: OllamaBackendAuthorityRequest,
  dependencies: OllamaBackendAuthorityDependencies = {},
): Promise<OllamaBackendAuthorityResponse> {
  return withOllamaAuthorityRunLease(async () => {
    const resolved = await resolveOllamaBackendAuthority(dependencies);
    return requestResolvedOllamaUnderLease(resolved, input, dependencies);
  });
}

export async function requestResolvedOllama(
  resolved: ResolvedOllamaBackendAuthority,
  input: OllamaBackendAuthorityRequest,
  dependencies: OllamaBackendAuthorityDependencies = {},
): Promise<OllamaBackendAuthorityResponse> {
  return withOllamaAuthorityRunLease(async () => {
    const current = await resolveOllamaBackendAuthority(dependencies);
    if (!sameAuthorityIdentity(resolved.authority, current.authority)) {
      throw authorityError('BINDING_CHANGED', 409);
    }
    return requestResolvedOllamaUnderLease(current, input, dependencies);
  });
}

async function streamTailnetUnderLease(
  binding: PublicNativeOllamaBindingSnapshot,
  input: OllamaBackendAuthorityRequest,
  onChunk: (
    chunk: Buffer,
  ) => NativeOllamaStreamConsumerResult
    | Promise<NativeOllamaStreamConsumerResult>,
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<OllamaBackendAuthorityStreamResponse> {
  const body = encodedRequestBody(input);
  let consumerFailure: unknown;
  try {
    const current = await exactTailnetBinding(binding, dependencies);
    const expectation = remoteInferenceExpectation(current, input, body);
    await assertEndpointModelDigest(
      endpointFor(current),
      expectation,
      input,
      dependencies,
    );
    const response = await (
      dependencies.streamNative ?? streamNativeOllama
    )({
      endpoint: endpointFor(current),
      path: input.path,
      method: input.method,
      ...(body.byteLength > 0 ? { body } : {}),
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      signal: input.signal,
    }, (chunk) => {
      try {
        const consumed = onChunk(chunk);
        if (consumed instanceof Promise) {
          return consumed.catch((error) => {
            consumerFailure = error;
            throw error;
          });
        }
        return consumed;
      } catch (error) {
        consumerFailure = error;
        throw error;
      }
    });
    return streamAuthorityResponse(current, response);
  } catch (error) {
    if (consumerFailure !== undefined && error === consumerFailure) throw error;
    if (error instanceof OllamaBackendAuthorityError) throw error;
    if (error instanceof NativeOllamaBindingError) {
      throw authorityError('BINDING_CHANGED', 409);
    }
    if (error instanceof NativeOllamaTransportError) {
      if (error.code === 'CONNECTION_FAILED') {
        deferDisconnectedUntilRunsSettle(binding, new Date(), dependencies);
      }
      throw mapNativeTransportError(error);
    }
    throw authorityError('RESPONSE_INVALID', 502);
  } finally {
    body.fill(0);
  }
}

function streamAuthorityResponse(
  binding: PublicNativeOllamaBindingSnapshot,
  response: NativeOllamaStreamResponse,
): OllamaBackendAuthorityStreamResponse {
  return Object.freeze({
    authority: tailnetAuthority(binding),
    statusCode: response.statusCode,
    headers: response.headers,
    responseBytes: response.responseBytes,
    streaming: true as const,
  });
}

async function streamLocalUnderLease(
  input: OllamaBackendAuthorityRequest,
  onChunk: (
    chunk: Buffer,
  ) => NativeOllamaStreamConsumerResult
    | Promise<NativeOllamaStreamConsumerResult>,
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<OllamaBackendAuthorityStreamResponse> {
  const body = encodedRequestBody(input);
  let consumerFailure: unknown;
  try {
    await assertEndpointModelDigest(
      localEndpoint(),
      optionalLocalInferenceExpectation(input, body),
      input,
      dependencies,
    );
    const response = await (
      dependencies.streamNative ?? streamNativeOllama
    )({
      endpoint: localEndpoint(),
      path: input.path,
      method: input.method,
      ...(body.byteLength > 0 ? { body } : {}),
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      signal: input.signal,
    }, (chunk) => {
      try {
        const consumed = onChunk(chunk);
        if (consumed instanceof Promise) {
          return consumed.catch((error) => {
            consumerFailure = error;
            throw error;
          });
        }
        return consumed;
      } catch (error) {
        consumerFailure = error;
        throw error;
      }
    });
    return Object.freeze({
      authority: LOCAL_AUTHORITY,
      statusCode: response.statusCode,
      headers: response.headers,
      responseBytes: response.responseBytes,
      streaming: true as const,
    });
  } catch (error) {
    if (consumerFailure !== undefined && error === consumerFailure) throw error;
    if (error instanceof NativeOllamaTransportError) {
      throw mapNativeTransportError(error);
    }
    throw authorityError('BACKEND_UNAVAILABLE', 503);
  } finally {
    body.fill(0);
  }
}

async function streamResolvedOllamaUnderLease(
  resolved: ResolvedOllamaBackendAuthority,
  input: OllamaBackendAuthorityRequest,
  onChunk: (
    chunk: Buffer,
  ) => NativeOllamaStreamConsumerResult
    | Promise<NativeOllamaStreamConsumerResult>,
  dependencies: OllamaBackendAuthorityDependencies,
): Promise<OllamaBackendAuthorityStreamResponse> {
  if (resolved.authority.kind === 'LOCAL') {
    return streamLocalUnderLease(input, onChunk, dependencies);
  }
  const binding = resolved.bindingView.authority;
  if (binding) {
    return streamTailnetUnderLease(binding, input, onChunk, dependencies);
  }
  const legacyBinding = resolved.bindingView.legacyAuthority;
  if (!legacyBinding) throw authorityError('BINDING_CHANGED', 409);
  // Protocol v2 authenticates one complete response frame. Buffering here is
  // intentionally compatibility-only: it keeps existing Agent Chat and pulls
  // working until native activation, after which the normal streamed HTTP
  // path wins automatically.
  const response = await requestLegacyAuthority(
    legacyBinding,
    input,
    dependencies,
  );
  try {
    await onChunk(response.body);
    return Object.freeze({
      authority: response.authority,
      statusCode: response.statusCode,
      headers: response.headers,
      responseBytes: response.body.byteLength,
      streaming: true as const,
    });
  } finally {
    response.body.fill(0);
  }
}

export async function streamConfiguredOllama(
  input: OllamaBackendAuthorityRequest,
  onChunk: (
    chunk: Buffer,
  ) => NativeOllamaStreamConsumerResult
    | Promise<NativeOllamaStreamConsumerResult>,
  dependencies: OllamaBackendAuthorityDependencies = {},
): Promise<OllamaBackendAuthorityStreamResponse> {
  return withOllamaAuthorityRunLease(async () => {
    const resolved = await resolveOllamaBackendAuthority(dependencies);
    return streamResolvedOllamaUnderLease(
      resolved,
      input,
      onChunk,
      dependencies,
    );
  });
}

export async function streamResolvedOllama(
  resolved: ResolvedOllamaBackendAuthority,
  input: OllamaBackendAuthorityRequest,
  onChunk: (
    chunk: Buffer,
  ) => NativeOllamaStreamConsumerResult
    | Promise<NativeOllamaStreamConsumerResult>,
  dependencies: OllamaBackendAuthorityDependencies = {},
): Promise<OllamaBackendAuthorityStreamResponse> {
  return withOllamaAuthorityRunLease(async () => {
    const current = await resolveOllamaBackendAuthority(dependencies);
    if (!sameAuthorityIdentity(resolved.authority, current.authority)) {
      throw authorityError('BINDING_CHANGED', 409);
    }
    return streamResolvedOllamaUnderLease(
      current,
      input,
      onChunk,
      dependencies,
    );
  });
}

export async function requestConfiguredOllamaJson<T>(
  input: OllamaBackendAuthorityRequest,
  dependencies: OllamaBackendAuthorityDependencies = {},
): Promise<{
  readonly authority: OllamaBackendAuthority;
  readonly value: T;
}> {
  return parseOllamaAuthorityJson<T>(
    await requestConfiguredOllama(input, dependencies),
  );
}

export async function requestResolvedOllamaJson<T>(
  resolved: ResolvedOllamaBackendAuthority,
  input: OllamaBackendAuthorityRequest,
  dependencies: OllamaBackendAuthorityDependencies = {},
): Promise<{
  readonly authority: OllamaBackendAuthority;
  readonly value: T;
}> {
  return parseOllamaAuthorityJson<T>(
    await requestResolvedOllama(resolved, input, dependencies),
  );
}

function parseOllamaAuthorityJson<T>(
  response: OllamaBackendAuthorityResponse,
): {
  readonly authority: OllamaBackendAuthority;
  readonly value: T;
} {
  try {
    return Object.freeze({
      authority: response.authority,
      value: JSON.parse(response.body.toString('utf8')) as T,
    });
  } catch {
    throw authorityError('RESPONSE_INVALID', 502);
  } finally {
    response.body.fill(0);
  }
}

// Compatibility export retained for callers that previously named the helper
// binding view. No create/activate pairing APIs are reintroduced.
export type LegacyOllamaBackendBindingView = LegacyOllamaBindingView;
