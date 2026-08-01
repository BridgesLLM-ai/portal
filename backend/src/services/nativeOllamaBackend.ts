import {
  NativeOllamaBackendBindingState,
  OllamaBackendAddressFamily,
} from '@prisma/client';
import { createHash } from 'crypto';
import { isIP } from 'net';
import { isValidOllamaModelName } from '../utils/ollamaRecommendations';
import {
  NATIVE_OLLAMA_SERVE_PORT,
  NativeOllamaBindingError,
  clearNativeOllamaModel,
  createOrReplaceNativeOllamaBinding,
  readNativeOllamaBinding,
  reverifyNativeOllamaBinding,
  selectNativeOllamaModel,
  type PublicNativeOllamaBindingSnapshot,
  type PublicNativeOllamaBindingView,
} from './nativeOllamaBinding';
import {
  NativeOllamaTransportError,
  requestNativeOllama,
  type NativeOllamaEndpoint,
  type NativeOllamaTransportMethod,
  type NativeOllamaTransportPath,
} from './nativeOllamaTransport';
import {
  listCurrentAttestedTailscalePeers,
  reattestTailscalePeer,
  TailscalePeerAttestationError,
  type TailscalePeerAttestation,
  type TailscalePeerInventory,
  type TailscalePeerReattestationResult,
} from './tailscalePeerAttestor';
import {
  withOllamaAuthorityMutationFence,
  withOllamaAuthorityRunLease,
} from './ollamaAuthorityBarrier';
import {
  readTailnetServerNetworkStatus,
} from './tailnetServerNetwork';

export const NATIVE_OLLAMA_PROBE_TIMEOUT_MS = 5_000;
export const NATIVE_OLLAMA_MODEL_LIST_TIMEOUT_MS = 10_000;
export const NATIVE_OLLAMA_MODEL_SHOW_TIMEOUT_MS = 30_000;
export const NATIVE_OLLAMA_MODEL_TEST_TIMEOUT_MS = 2 * 60_000;
export const NATIVE_OLLAMA_MODEL_SELECTION_TIMEOUT_MS = 3 * 60_000;
export const NATIVE_OLLAMA_MAX_INSTALLED_MODELS = 2_048;
export const NATIVE_OLLAMA_MAX_RUNNING_MODELS = 512;
export const NATIVE_OLLAMA_GPU_GRANT_ADDRESS_TOKEN =
  '__BRIDGESLLM_GPU_TAILSCALE_IP__';
export const NATIVE_OLLAMA_PORTAL_GRANT_ADDRESS_TOKEN =
  '__BRIDGESLLM_PORTAL_TAILSCALE_IP__';

const MAX_JSON_OBJECT_KEYS = 128;
const MAX_MODEL_ENTRY_KEYS = 64;
const MAX_MODEL_INFO_KEYS = 2_048;
const MAX_CAPABILITIES = 64;
const MAX_CAPABILITY_BYTES = 128;
const MAX_VERSION_BYTES = 128;
const MAX_MODEL_TEST_RESPONSE_BYTES = 4 * 1024;
const VERSION_RESPONSE_BYTES = 64 * 1024;
const TAGS_RESPONSE_BYTES = 8 * 1024 * 1024;
const SHOW_RESPONSE_BYTES = 2 * 1024 * 1024;
const MODEL_TEST_RESPONSE_BYTES = 64 * 1024;
const PS_RESPONSE_BYTES = 2 * 1024 * 1024;

export type NativeOllamaBackendErrorCode =
  | 'INPUT_INVALID'
  | 'GRANT_ACKNOWLEDGEMENT_REQUIRED'
  | 'GRANT_SNAPSHOT_CHANGED'
  | 'PEER_NOT_FOUND'
  | 'PEER_NOT_ATTESTED'
  | 'PEER_IDENTITY_CHANGED'
  | 'TAILSCALE_UNAVAILABLE'
  | 'AUTHORITY_NOT_FOUND'
  | 'AUTHORITY_CHANGED'
  | 'AUTHORITY_STATE_CONFLICT'
  | 'OLLAMA_UNAVAILABLE'
  | 'OLLAMA_REJECTED'
  | 'TAILNET_ACCESS_DENIED'
  | 'OLLAMA_RESPONSE_INVALID'
  | 'MODEL_NOT_INSTALLED'
  | 'MODEL_DIGEST_MISMATCH'
  | 'MODEL_NOT_SELECTED'
  | 'MODEL_TEST_FAILED'
  | 'MODEL_SELECTION_TIMEOUT'
  | 'REQUEST_ABORTED'
  | 'CLOCK_INVALID'
  | 'BINDING_FAILED';

const ERROR_MESSAGES: Readonly<Record<NativeOllamaBackendErrorCode, string>> =
  Object.freeze({
    INPUT_INVALID: 'The native Remote GPU request is invalid.',
    GRANT_ACKNOWLEDGEMENT_REQUIRED:
      'Acknowledge the exact Portal-to-GPU Tailscale Grant before connecting.',
    GRANT_SNAPSHOT_CHANGED:
      'The selected peer or exact Tailscale Grant changed. Refresh, review the current Grant, and acknowledge it again.',
    PEER_NOT_FOUND: 'The selected Tailscale peer is not currently attestable.',
    PEER_NOT_ATTESTED: 'The native Remote GPU Tailscale peer is unavailable.',
    PEER_IDENTITY_CHANGED:
      'The native Remote GPU node identity changed and must be connected as a new generation.',
    TAILSCALE_UNAVAILABLE:
      'The Portal server could not read its current Tailscale network map.',
    AUTHORITY_NOT_FOUND: 'No native Remote GPU authority is configured.',
    AUTHORITY_CHANGED: 'The native Remote GPU authority changed; refresh and retry.',
    AUTHORITY_STATE_CONFLICT:
      'The native Remote GPU authority is not in the required state.',
    OLLAMA_UNAVAILABLE: 'The native Ollama API is unavailable through Tailscale Serve.',
    OLLAMA_REJECTED: 'The native Ollama API rejected the bounded request.',
    TAILNET_ACCESS_DENIED:
      'The Remote GPU refused this connection at its private listener. '
      + 'Re-run the Remote GPU setup on that machine, and confirm your tailnet policy '
      + 'still allows the Portal to reach it.',
    OLLAMA_RESPONSE_INVALID: 'The native Ollama API returned an invalid response.',
    MODEL_NOT_INSTALLED: 'The requested Ollama model is not installed on the Remote GPU.',
    MODEL_DIGEST_MISMATCH:
      'The installed Ollama model digest changed; refresh the model list and retry.',
    MODEL_NOT_SELECTED: 'No active Ollama model is selected for the Remote GPU.',
    MODEL_TEST_FAILED: 'The selected Remote GPU model failed its bounded one-token test.',
    MODEL_SELECTION_TIMEOUT:
      'Remote GPU model qualification exceeded its bounded three-minute deadline.',
    REQUEST_ABORTED: 'The native Remote GPU request was cancelled.',
    CLOCK_INVALID: 'The native Remote GPU verification clock is invalid.',
    BINDING_FAILED: 'The native Remote GPU binding could not be updated.',
  });

export class NativeOllamaBackendError extends Error {
  readonly statusCode: number;

  constructor(
    public readonly code: NativeOllamaBackendErrorCode,
    public readonly httpStatus: number,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'NativeOllamaBackendError';
    this.statusCode = httpStatus;
  }

  toJSON(): Readonly<{
    name: 'NativeOllamaBackendError';
    code: NativeOllamaBackendErrorCode;
    message: string;
    statusCode: number;
  }> {
    return Object.freeze({
      name: 'NativeOllamaBackendError' as const,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
    });
  }
}

export interface PublicNativeOllamaPeer {
  readonly tailnetName: string;
  readonly stableNodeId: string;
  readonly nodePublicKey: string;
  readonly observedAddress: string;
  readonly addressFamily: 'IPV4' | 'IPV6';
  readonly observedAt: string;
  readonly displayName: string | null;
  readonly operatingSystem: string | null;
}

export interface PublicNativeOllamaInstalledModel {
  readonly name: string;
  readonly digest: `sha256:${string}`;
  readonly sizeBytes: number | null;
  readonly modifiedAt: string | null;
}

export interface PublicNativeOllamaModelInspection {
  readonly capabilities: readonly string[];
  readonly format: string | null;
  readonly family: string | null;
  readonly parameterSize: string | null;
  readonly quantizationLevel: string | null;
}

export interface PublicNativeOllamaProbe {
  readonly peer: PublicNativeOllamaPeer;
  readonly ollamaVersion: string;
  readonly models: readonly PublicNativeOllamaInstalledModel[];
  readonly verifiedAt: string;
}

export interface PublicNativeOllamaConnection {
  readonly binding: PublicNativeOllamaBindingSnapshot;
  readonly probe: PublicNativeOllamaProbe;
}

export interface PublicNativeOllamaModelList {
  readonly binding: PublicNativeOllamaBindingSnapshot;
  readonly peer: PublicNativeOllamaPeer;
  readonly models: readonly PublicNativeOllamaInstalledModel[];
}

export interface PublicNativeOllamaModelSelection {
  readonly binding: PublicNativeOllamaBindingSnapshot;
  readonly model: PublicNativeOllamaInstalledModel;
  readonly inspection: PublicNativeOllamaModelInspection;
}

export interface PublicNativeOllamaModelTest {
  readonly model: string;
  readonly digest: `sha256:${string}`;
  readonly response: string;
  readonly thinking: string | null;
  readonly evalCount: number | null;
  readonly totalDurationNs: number | null;
}

export interface PublicNativeOllamaRunningModel {
  readonly name: string;
  readonly digest: `sha256:${string}` | null;
  readonly sizeBytes: number | null;
  readonly sizeVramBytes: number | null;
  readonly expiresAt: string | null;
}

export interface PublicNativeOllamaRuntimeDiagnostic {
  readonly binding: PublicNativeOllamaBindingSnapshot;
  readonly peer: PublicNativeOllamaPeer;
  readonly runningModels: readonly PublicNativeOllamaRunningModel[];
}

export interface ProbeNativeOllamaPeerInput {
  readonly stableNodeId: string;
  readonly signal?: AbortSignal;
}

export interface ConnectNativeOllamaBackendInput extends ProbeNativeOllamaPeerInput {
  readonly expectedAuthorityGeneration: number | null;
  readonly expectedAuthorityVersion: number | null;
  readonly expectedPeerAttestationFingerprint: string;
  readonly expectedGrantTemplateHash: string;
  readonly grantAcknowledged: boolean;
  readonly configuredByUserId: string;
}

export interface NativeOllamaAuthorityCasInput {
  readonly generation: number;
  readonly expectedVersion: number;
  readonly signal?: AbortSignal;
}

export interface SelectNativeOllamaBackendModelInput
  extends NativeOllamaAuthorityCasInput {
  readonly model: string;
  readonly expectedDigest: string;
}

export interface NativeOllamaBackendDependencies {
  readonly listPeers?: typeof listCurrentAttestedTailscalePeers;
  readonly reattestPeer?: typeof reattestTailscalePeer;
  readonly request?: typeof requestNativeOllama;
  readonly readBinding?: typeof readNativeOllamaBinding;
  readonly createBinding?: typeof createOrReplaceNativeOllamaBinding;
  readonly reverifyBinding?: typeof reverifyNativeOllamaBinding;
  readonly selectModel?: typeof selectNativeOllamaModel;
  readonly clearModel?: typeof clearNativeOllamaModel;
  readonly withMutationFence?: typeof withOllamaAuthorityMutationFence;
  readonly withRunLease?: typeof withOllamaAuthorityRunLease;
  readonly readServerNetworkStatus?: typeof readTailnetServerNetworkStatus;
  readonly now?: () => Date;
}

interface ExactAuthorityOptions {
  readonly allowActive: boolean;
  readonly allowDisconnected: boolean;
}

function backendError(
  code: NativeOllamaBackendErrorCode,
  statusCode: number,
): never {
  throw new NativeOllamaBackendError(code, statusCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedString(
  value: unknown,
  maxBytes: number,
): string | null {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  if (
    !value
    || Buffer.byteLength(value, 'utf8') > maxBytes
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function stableNodeId(value: unknown): string {
  const normalized = boundedString(value, 128);
  if (!normalized || !/^[A-Za-z0-9_-]{6,128}$/.test(normalized)) {
    return backendError('INPUT_INVALID', 400);
  }
  return normalized;
}

function actorId(value: unknown): string {
  const normalized = boundedString(value, 512);
  if (!normalized) return backendError('INPUT_INVALID', 400);
  return normalized;
}

function peerAttestationFingerprint(value: unknown): string {
  const normalized = boundedString(value, 64);
  if (!normalized || !/^[a-f0-9]{64}$/u.test(normalized)) {
    return backendError('INPUT_INVALID', 400);
  }
  return normalized;
}

function grantTemplateHash(value: unknown): `sha256:${string}` {
  const normalized = boundedString(value, 71);
  if (!normalized || !/^sha256:[a-f0-9]{64}$/u.test(normalized)) {
    return backendError('INPUT_INVALID', 400);
  }
  return normalized as `sha256:${string}`;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return backendError('INPUT_INVALID', 400);
  }
  return value;
}

export function renderNativeOllamaGrantTemplate(
  portalAddress: string | null,
  gpuAddress: string | null = null,
): string {
  return JSON.stringify({
    grants: [{
      src: [
        portalAddress ?? NATIVE_OLLAMA_PORTAL_GRANT_ADDRESS_TOKEN,
      ],
      dst: [
        gpuAddress ?? NATIVE_OLLAMA_GPU_GRANT_ADDRESS_TOKEN,
      ],
      ip: [`tcp:${NATIVE_OLLAMA_SERVE_PORT}`],
    }],
  }, null, 2);
}

export function hashNativeOllamaGrantTemplate(
  renderedTemplate: string,
): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(renderedTemplate, 'utf8')
    .digest('hex')}`;
}

export function exactNativeOllamaGrantForPeer(
  portalAddress: string | null,
  gpuAddress: string,
): Readonly<{
  template: string;
  templateHash: `sha256:${string}`;
}> | null {
  if (
    !portalAddress
    || isIP(portalAddress) === 0
    || isIP(gpuAddress) === 0
  ) {
    return null;
  }
  const template = renderNativeOllamaGrantTemplate(
    portalAddress,
    gpuAddress,
  );
  return Object.freeze({
    template,
    templateHash: hashNativeOllamaGrantTemplate(template),
  });
}

function optionalCasInteger(value: unknown): number | null {
  if (value === null) return null;
  return positiveInteger(value);
}

function currentTime(
  dependencies: NativeOllamaBackendDependencies,
  notBefore?: Date,
): Date {
  const value = (dependencies.now ?? (() => new Date()))();
  if (
    !(value instanceof Date)
    || !Number.isFinite(value.getTime())
    || (notBefore && value.getTime() < notBefore.getTime())
  ) {
    return backendError('CLOCK_INVALID', 500);
  }
  return new Date(value);
}

function observedDate(attestation: TailscalePeerAttestation): Date {
  const value = new Date(attestation.observedAt);
  if (!Number.isFinite(value.getTime())) return backendError('CLOCK_INVALID', 500);
  return value;
}

function endpointFor(attestation: TailscalePeerAttestation): NativeOllamaEndpoint {
  return Object.freeze({
    address: attestation.address,
    family: attestation.addressFamily === 'IPV4' ? 4 as const : 6 as const,
    port: NATIVE_OLLAMA_SERVE_PORT,
  });
}

function publicPeer(attestation: TailscalePeerAttestation): PublicNativeOllamaPeer {
  return Object.freeze({
    tailnetName: attestation.tailnetName,
    stableNodeId: attestation.stableNodeId,
    nodePublicKey: attestation.nodePublicKey,
    observedAddress: attestation.address,
    addressFamily: attestation.addressFamily,
    observedAt: attestation.observedAt,
    displayName: attestation.displayName ?? null,
    operatingSystem: attestation.operatingSystem ?? null,
  });
}

function normalizeDigest(
  value: unknown,
  invalidCode: NativeOllamaBackendErrorCode = 'OLLAMA_RESPONSE_INVALID',
): `sha256:${string}` {
  if (typeof value !== 'string') return backendError(invalidCode, invalidCode === 'INPUT_INVALID' ? 400 : 502);
  const lower = value.trim().toLowerCase();
  const normalized = lower.startsWith('sha256:') ? lower : `sha256:${lower}`;
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    return backendError(invalidCode, invalidCode === 'INPUT_INVALID' ? 400 : 502);
  }
  return normalized as `sha256:${string}`;
}

function normalizedModelName(value: unknown): string {
  if (!isValidOllamaModelName(value)) return backendError('INPUT_INVALID', 400);
  return value;
}

function safeOptionalInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return backendError('OLLAMA_RESPONSE_INVALID', 502);
  }
  return value;
}

function safeOptionalDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const bounded = boundedString(value, 128);
  if (!bounded) return backendError('OLLAMA_RESPONSE_INVALID', 502);
  const parsed = new Date(bounded);
  if (!Number.isFinite(parsed.getTime())) {
    return backendError('OLLAMA_RESPONSE_INVALID', 502);
  }
  return parsed.toISOString();
}

function exactAuthority(
  view: PublicNativeOllamaBindingView,
  generation: number,
  version: number,
  options: ExactAuthorityOptions,
): PublicNativeOllamaBindingSnapshot {
  const authority = view.authority;
  if (!authority) return backendError('AUTHORITY_NOT_FOUND', 404);
  if (authority.generation !== generation || authority.version !== version) {
    return backendError('AUTHORITY_CHANGED', 409);
  }
  if (
    (authority.state === NativeOllamaBackendBindingState.ACTIVE && !options.allowActive)
    || (
      authority.state === NativeOllamaBackendBindingState.DISCONNECTED
      && !options.allowDisconnected
    )
    || authority.state === NativeOllamaBackendBindingState.REMOVED
  ) {
    return backendError('AUTHORITY_STATE_CONFLICT', 409);
  }
  return authority;
}

function exactExpectedAuthority(
  view: PublicNativeOllamaBindingView,
  generation: number | null,
  version: number | null,
): void {
  const authority = view.authority;
  if (
    (authority === null) !== (generation === null)
    || (
      authority
      && (authority.generation !== generation || authority.version !== version)
    )
  ) {
    return backendError('AUTHORITY_CHANGED', 409);
  }
}

async function readBindingView(
  dependencies: NativeOllamaBackendDependencies,
): Promise<PublicNativeOllamaBindingView> {
  try {
    return await (dependencies.readBinding ?? readNativeOllamaBinding)();
  } catch (error) {
    return translateBindingError(error);
  }
}

function translateTransportError(error: unknown): never {
  if (error instanceof NativeOllamaBackendError) throw error;
  if (error instanceof NativeOllamaTransportError) {
    if (error.code === 'ABORTED') return backendError('REQUEST_ABORTED', 499);
    if (error.code === 'TIMEOUT' || error.code === 'CONNECTION_FAILED') {
      return backendError('OLLAMA_UNAVAILABLE', 503);
    }
    // A bare 401/403 at the serve port is an access refusal, not Ollama
    // refusing the work asked of it: either the tailnet policy blocks the
    // Portal, or Ollama rejected the Host it was presented. Calling it "the
    // Ollama API rejected the request" sent people to inspect a healthy GPU.
    if (
      error.code === 'HTTP_STATUS'
      && (error.statusCode === 401 || error.statusCode === 403)
    ) {
      return backendError('TAILNET_ACCESS_DENIED', 502);
    }
    return backendError('OLLAMA_REJECTED', 502);
  }
  return backendError('OLLAMA_UNAVAILABLE', 503);
}

function translateBindingError(error: unknown): never {
  if (error instanceof NativeOllamaBackendError) throw error;
  if (!(error instanceof NativeOllamaBindingError)) {
    return backendError('BINDING_FAILED', 500);
  }
  if (error.code === 'CAS_MISMATCH') return backendError('AUTHORITY_CHANGED', 409);
  if (error.code === 'NOT_FOUND') return backendError('AUTHORITY_NOT_FOUND', 404);
  if (error.code === 'IDENTITY_MISMATCH') {
    return backendError('PEER_IDENTITY_CHANGED', 409);
  }
  if (error.code === 'STATE_CONFLICT') {
    return backendError('AUTHORITY_STATE_CONFLICT', 409);
  }
  if (error.code === 'INVALID_INPUT') return backendError('INPUT_INVALID', 400);
  return backendError('BINDING_FAILED', 500);
}

async function boundedJsonRequest(
  endpoint: NativeOllamaEndpoint,
  input: Readonly<{
    path: NativeOllamaTransportPath;
    method: NativeOllamaTransportMethod;
    json?: Record<string, unknown>;
    timeoutMs: number;
    maxResponseBytes: number;
    signal?: AbortSignal;
  }>,
  dependencies: NativeOllamaBackendDependencies,
): Promise<Record<string, unknown>> {
  let response;
  try {
    response = await (dependencies.request ?? requestNativeOllama)({
      endpoint,
      path: input.path,
      method: input.method,
      ...(input.json === undefined ? {} : { body: JSON.stringify(input.json) }),
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    return translateTransportError(error);
  }

  try {
    // Tailscale Serve answers a denied peer with a bare 401/403 and no body,
    // while Ollama always describes its own refusals in a JSON body. Reporting
    // the proxy's denial as "the Ollama API rejected the request" sent people
    // to check a healthy GPU, and the generic 502 hint told them the backend
    // might be restarting. Name the real cause instead.
    if (
      (response.statusCode === 401 || response.statusCode === 403)
      && response.body.byteLength === 0
    ) {
      return backendError('TAILNET_ACCESS_DENIED', 502);
    }
    if (
      response.statusCode < 200
      || response.statusCode >= 300
      || response.body.byteLength > input.maxResponseBytes
    ) {
      return backendError('OLLAMA_REJECTED', 502);
    }
    const parsed = JSON.parse(response.body.toString('utf8')) as unknown;
    if (!isRecord(parsed) || Object.keys(parsed).length > MAX_JSON_OBJECT_KEYS) {
      return backendError('OLLAMA_RESPONSE_INVALID', 502);
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'error')) {
      return backendError('OLLAMA_REJECTED', 502);
    }
    return parsed;
  } catch (error) {
    if (error instanceof NativeOllamaBackendError) throw error;
    return backendError('OLLAMA_RESPONSE_INVALID', 502);
  } finally {
    response.body.fill(0);
  }
}

function parseVersion(payload: Record<string, unknown>): string {
  const version = boundedString(payload.version, MAX_VERSION_BYTES);
  if (!version) return backendError('OLLAMA_RESPONSE_INVALID', 502);
  return version;
}

function parseInstalledModels(
  payload: Record<string, unknown>,
): readonly PublicNativeOllamaInstalledModel[] {
  if (!Array.isArray(payload.models) || payload.models.length > NATIVE_OLLAMA_MAX_INSTALLED_MODELS) {
    return backendError('OLLAMA_RESPONSE_INVALID', 502);
  }
  const byName = new Map<string, PublicNativeOllamaInstalledModel>();
  for (const value of payload.models) {
    if (!isRecord(value) || Object.keys(value).length > MAX_MODEL_ENTRY_KEYS) {
      return backendError('OLLAMA_RESPONSE_INVALID', 502);
    }
    const nameValue = value.name ?? value.model;
    if (!isValidOllamaModelName(nameValue)) {
      return backendError('OLLAMA_RESPONSE_INVALID', 502);
    }
    if (
      value.name !== undefined
      && value.model !== undefined
      && value.name !== value.model
    ) {
      return backendError('OLLAMA_RESPONSE_INVALID', 502);
    }
    if (byName.has(nameValue)) return backendError('OLLAMA_RESPONSE_INVALID', 502);
    const model = Object.freeze({
      name: nameValue,
      digest: normalizeDigest(value.digest),
      sizeBytes: safeOptionalInteger(value.size),
      modifiedAt: safeOptionalDate(value.modified_at),
    });
    byName.set(nameValue, model);
  }
  return Object.freeze(
    [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
  );
}

function optionalDetail(
  details: Record<string, unknown>,
  key: string,
): string | null {
  const value = details[key];
  if (value === undefined || value === null || value === '') return null;
  const normalized = boundedString(value, 256);
  if (!normalized) return backendError('OLLAMA_RESPONSE_INVALID', 502);
  return normalized;
}

function parseModelInspection(
  payload: Record<string, unknown>,
): PublicNativeOllamaModelInspection {
  const capabilitiesValue = payload.capabilities;
  if (
    capabilitiesValue !== undefined
    && (
      !Array.isArray(capabilitiesValue)
      || capabilitiesValue.length > MAX_CAPABILITIES
    )
  ) {
    return backendError('OLLAMA_RESPONSE_INVALID', 502);
  }
  const capabilities = (capabilitiesValue ?? []).map((value: unknown) => {
    const capability = boundedString(value, MAX_CAPABILITY_BYTES);
    if (!capability) return backendError('OLLAMA_RESPONSE_INVALID', 502);
    return capability.toLowerCase();
  });

  const detailsValue = payload.details;
  if (
    detailsValue !== undefined
    && (!isRecord(detailsValue) || Object.keys(detailsValue).length > MAX_MODEL_ENTRY_KEYS)
  ) {
    return backendError('OLLAMA_RESPONSE_INVALID', 502);
  }
  const details = isRecord(detailsValue) ? detailsValue : {};

  const modelInfo = payload.model_info;
  if (
    modelInfo !== undefined
    && (!isRecord(modelInfo) || Object.keys(modelInfo).length > MAX_MODEL_INFO_KEYS)
  ) {
    return backendError('OLLAMA_RESPONSE_INVALID', 502);
  }
  if (
    capabilitiesValue === undefined
    && detailsValue === undefined
    && modelInfo === undefined
    && typeof payload.parameters !== 'string'
    && typeof payload.template !== 'string'
  ) {
    return backendError('OLLAMA_RESPONSE_INVALID', 502);
  }

  return Object.freeze({
    capabilities: Object.freeze([...new Set(capabilities)].sort()),
    format: optionalDetail(details, 'format'),
    family: optionalDetail(details, 'family'),
    parameterSize: optionalDetail(details, 'parameter_size'),
    quantizationLevel: optionalDetail(details, 'quantization_level'),
  });
}

function parseRunningModels(
  payload: Record<string, unknown>,
): readonly PublicNativeOllamaRunningModel[] {
  if (!Array.isArray(payload.models) || payload.models.length > NATIVE_OLLAMA_MAX_RUNNING_MODELS) {
    return backendError('OLLAMA_RESPONSE_INVALID', 502);
  }
  const byName = new Map<string, PublicNativeOllamaRunningModel>();
  for (const value of payload.models) {
    if (!isRecord(value) || Object.keys(value).length > MAX_MODEL_ENTRY_KEYS) {
      return backendError('OLLAMA_RESPONSE_INVALID', 502);
    }
    const nameValue = value.name ?? value.model;
    if (
      !isValidOllamaModelName(nameValue)
      || byName.has(nameValue)
      || (
        value.name !== undefined
        && value.model !== undefined
        && value.name !== value.model
      )
    ) {
      return backendError('OLLAMA_RESPONSE_INVALID', 502);
    }
    const model = Object.freeze({
      name: nameValue,
      digest: value.digest === undefined || value.digest === null
        ? null
        : normalizeDigest(value.digest),
      sizeBytes: safeOptionalInteger(value.size),
      sizeVramBytes: safeOptionalInteger(value.size_vram),
      expiresAt: safeOptionalDate(value.expires_at),
    });
    byName.set(nameValue, model);
  }
  return Object.freeze(
    [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
  );
}

async function currentPeerByStableNodeId(
  requestedStableNodeId: string,
  dependencies: NativeOllamaBackendDependencies,
): Promise<TailscalePeerAttestation> {
  let inventory: TailscalePeerInventory;
  try {
    inventory = await (dependencies.listPeers ?? listCurrentAttestedTailscalePeers)();
  } catch (error) {
    if (error instanceof TailscalePeerAttestationError) {
      return backendError('TAILSCALE_UNAVAILABLE', 503);
    }
    return backendError('TAILSCALE_UNAVAILABLE', 503);
  }
  const matches = inventory.peers.filter(
    (peer) => peer.stableNodeId === requestedStableNodeId,
  );
  if (matches.length !== 1) return backendError('PEER_NOT_FOUND', 404);
  const peer = matches[0];
  if (peer.tailnetName !== inventory.tailnetName) {
    return backendError('PEER_NOT_ATTESTED', 409);
  }
  return peer;
}

async function currentGrantForPeer(
  peer: TailscalePeerAttestation,
  dependencies: NativeOllamaBackendDependencies,
): Promise<Readonly<{
  template: string;
  templateHash: `sha256:${string}`;
}>> {
  let status;
  try {
    status = await (
      dependencies.readServerNetworkStatus
      ?? readTailnetServerNetworkStatus
    )();
  } catch {
    return backendError('TAILSCALE_UNAVAILABLE', 503);
  }
  if (
    !status.running
    || !status.tailnetIp
    || isIP(status.tailnetIp) === 0
    || (
      status.tailnetName !== null
      && status.tailnetName !== peer.tailnetName
    )
  ) {
    return backendError('TAILSCALE_UNAVAILABLE', 503);
  }
  return exactNativeOllamaGrantForPeer(
    status.tailnetIp,
    peer.address,
  ) ?? backendError('TAILSCALE_UNAVAILABLE', 503);
}

export async function assertCurrentNativeOllamaGrantSnapshot(
  authority: Pick<
    PublicNativeOllamaBindingSnapshot,
    'grantPeerAttestationFingerprint' | 'grantTemplateHash'
  >,
  peer: TailscalePeerAttestation,
  dependencies: NativeOllamaBackendDependencies = {},
): Promise<void> {
  const currentGrant = await currentGrantForPeer(peer, dependencies);
  if (
    peer.fingerprint !== authority.grantPeerAttestationFingerprint
    || currentGrant.templateHash !== authority.grantTemplateHash
  ) {
    return backendError('GRANT_SNAPSHOT_CHANGED', 409);
  }
}

async function reattestAuthority(
  authority: PublicNativeOllamaBindingSnapshot,
  dependencies: NativeOllamaBackendDependencies,
): Promise<TailscalePeerAttestation> {
  let result: TailscalePeerReattestationResult;
  try {
    result = await (dependencies.reattestPeer ?? reattestTailscalePeer)({
      tailnetName: authority.tailnetName,
      stableNodeId: authority.stableNodeId,
      nodePublicKey: authority.nodePublicKey,
      boundAddress: authority.observedAddress,
    });
  } catch {
    return backendError('TAILSCALE_UNAVAILABLE', 503);
  }
  if (result.state === 'BINDING_GENERATION_ADVANCE_REQUIRED') {
    return backendError('PEER_IDENTITY_CHANGED', 409);
  }
  if (result.state === 'UNAVAILABLE') {
    return backendError('PEER_NOT_ATTESTED', 503);
  }
  const peer = result.attestation;
  if (
    peer.tailnetName !== authority.tailnetName
    || peer.stableNodeId !== authority.stableNodeId
    || peer.nodePublicKey !== authority.nodePublicKey
  ) {
    return backendError('PEER_IDENTITY_CHANGED', 409);
  }
  await assertCurrentNativeOllamaGrantSnapshot(
    authority,
    peer,
    dependencies,
  );
  return peer;
}

async function readVersion(
  peer: TailscalePeerAttestation,
  signal: AbortSignal | undefined,
  dependencies: NativeOllamaBackendDependencies,
): Promise<string> {
  return parseVersion(await boundedJsonRequest(endpointFor(peer), {
    path: '/api/version',
    method: 'GET',
    timeoutMs: NATIVE_OLLAMA_PROBE_TIMEOUT_MS,
    maxResponseBytes: VERSION_RESPONSE_BYTES,
    signal,
  }, dependencies));
}

async function readInstalledModels(
  peer: TailscalePeerAttestation,
  signal: AbortSignal | undefined,
  dependencies: NativeOllamaBackendDependencies,
): Promise<readonly PublicNativeOllamaInstalledModel[]> {
  return parseInstalledModels(await boundedJsonRequest(endpointFor(peer), {
    path: '/api/tags',
    method: 'GET',
    timeoutMs: NATIVE_OLLAMA_MODEL_LIST_TIMEOUT_MS,
    maxResponseBytes: TAGS_RESPONSE_BYTES,
    signal,
  }, dependencies));
}

async function inspectModel(
  peer: TailscalePeerAttestation,
  model: string,
  signal: AbortSignal | undefined,
  dependencies: NativeOllamaBackendDependencies,
): Promise<PublicNativeOllamaModelInspection> {
  return parseModelInspection(await boundedJsonRequest(endpointFor(peer), {
    path: '/api/show',
    method: 'POST',
    json: { model, verbose: false },
    timeoutMs: NATIVE_OLLAMA_MODEL_SHOW_TIMEOUT_MS,
    maxResponseBytes: SHOW_RESPONSE_BYTES,
    signal,
  }, dependencies));
}

async function readRunningModels(
  peer: TailscalePeerAttestation,
  signal: AbortSignal | undefined,
  dependencies: NativeOllamaBackendDependencies,
): Promise<readonly PublicNativeOllamaRunningModel[]> {
  return parseRunningModels(await boundedJsonRequest(endpointFor(peer), {
    path: '/api/ps',
    method: 'GET',
    timeoutMs: NATIVE_OLLAMA_PROBE_TIMEOUT_MS,
    maxResponseBytes: PS_RESPONSE_BYTES,
    signal,
  }, dependencies));
}

async function probeAttestedPeer(
  peer: TailscalePeerAttestation,
  signal: AbortSignal | undefined,
  dependencies: NativeOllamaBackendDependencies,
): Promise<PublicNativeOllamaProbe> {
  const ollamaVersion = await readVersion(peer, signal, dependencies);
  const models = await readInstalledModels(peer, signal, dependencies);
  const verifiedAt = currentTime(dependencies, observedDate(peer));
  return Object.freeze({
    peer: publicPeer(peer),
    ollamaVersion,
    models,
    verifiedAt: verifiedAt.toISOString(),
  });
}

function translateBindingCall<T>(operation: () => Promise<T>): Promise<T> {
  return Promise.resolve()
    .then(operation)
    .catch((error) => translateBindingError(error));
}

export async function probeNativeOllamaPeer(
  input: ProbeNativeOllamaPeerInput,
  dependencies: NativeOllamaBackendDependencies = {},
): Promise<PublicNativeOllamaProbe> {
  const requestedStableNodeId = stableNodeId(input.stableNodeId);
  const peer = await currentPeerByStableNodeId(requestedStableNodeId, dependencies);
  return probeAttestedPeer(peer, input.signal, dependencies);
}

export async function connectNativeOllamaBackend(
  input: ConnectNativeOllamaBackendInput,
  dependencies: NativeOllamaBackendDependencies = {},
): Promise<PublicNativeOllamaConnection> {
  const requestedStableNodeId = stableNodeId(input.stableNodeId);
  const expectedGeneration = optionalCasInteger(input.expectedAuthorityGeneration);
  const expectedVersion = optionalCasInteger(input.expectedAuthorityVersion);
  if ((expectedGeneration === null) !== (expectedVersion === null)) {
    return backendError('INPUT_INVALID', 400);
  }
  if (input.grantAcknowledged !== true) {
    return backendError('GRANT_ACKNOWLEDGEMENT_REQUIRED', 400);
  }
  const expectedPeerFingerprint = peerAttestationFingerprint(
    input.expectedPeerAttestationFingerprint,
  );
  const expectedGrantHash = grantTemplateHash(
    input.expectedGrantTemplateHash,
  );
  const configuredByUserId = actorId(input.configuredByUserId);
  const withFence = dependencies.withMutationFence ?? withOllamaAuthorityMutationFence;

  return withFence(async () => {
    const view = await readBindingView(dependencies);
    exactExpectedAuthority(view, expectedGeneration, expectedVersion);
    const grantAcknowledgedAt = currentTime(dependencies);
    const peer = await currentPeerByStableNodeId(requestedStableNodeId, dependencies);
    const currentGrant = await currentGrantForPeer(peer, dependencies);
    if (
      peer.fingerprint !== expectedPeerFingerprint
      || currentGrant.templateHash !== expectedGrantHash
    ) {
      return backendError('GRANT_SNAPSHOT_CHANGED', 409);
    }
    const probe = await probeAttestedPeer(peer, input.signal, dependencies);
    const verifiedAt = new Date(probe.verifiedAt);
    if (verifiedAt.getTime() < grantAcknowledgedAt.getTime()) {
      return backendError('CLOCK_INVALID', 500);
    }

    const binding = await translateBindingCall(() => (
      (dependencies.createBinding ?? createOrReplaceNativeOllamaBinding)({
        expectedAuthorityGeneration: expectedGeneration,
        expectedAuthorityVersion: expectedVersion,
        tailnetName: peer.tailnetName,
        stableNodeId: peer.stableNodeId,
        nodePublicKey: peer.nodePublicKey,
        observedAddress: peer.address,
        addressFamily: peer.addressFamily === 'IPV4'
          ? OllamaBackendAddressFamily.IPV4
          : OllamaBackendAddressFamily.IPV6,
        servePort: NATIVE_OLLAMA_SERVE_PORT,
        selectedModel: null,
        selectedModelDigest: null,
        grantPeerAttestationFingerprint: peer.fingerprint,
        grantTemplateHash: currentGrant.templateHash,
        grantAcknowledgedAt,
        grantAcknowledgedBy: configuredByUserId,
        configuredByUserId,
        observedAt: observedDate(peer),
        verifiedAt,
        activatedAt: verifiedAt,
      })
    ));
    return Object.freeze({ binding, probe });
  });
}

export async function reverifyNativeOllamaBackend(
  input: NativeOllamaAuthorityCasInput,
  dependencies: NativeOllamaBackendDependencies = {},
): Promise<PublicNativeOllamaConnection> {
  const generation = positiveInteger(input.generation);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const withFence = dependencies.withMutationFence ?? withOllamaAuthorityMutationFence;

  return withFence(async () => {
    const authority = exactAuthority(
      await readBindingView(dependencies),
      generation,
      expectedVersion,
      { allowActive: true, allowDisconnected: true },
    );
    const peer = await reattestAuthority(authority, dependencies);
    const probe = await probeAttestedPeer(peer, input.signal, dependencies);
    const binding = await translateBindingCall(() => (
      (dependencies.reverifyBinding ?? reverifyNativeOllamaBinding)({
        generation,
        expectedVersion,
        tailnetName: peer.tailnetName,
        stableNodeId: peer.stableNodeId,
        nodePublicKey: peer.nodePublicKey,
        observedAddress: peer.address,
        addressFamily: peer.addressFamily === 'IPV4'
          ? OllamaBackendAddressFamily.IPV4
          : OllamaBackendAddressFamily.IPV6,
        servePort: NATIVE_OLLAMA_SERVE_PORT,
        observedAt: observedDate(peer),
        verifiedAt: new Date(probe.verifiedAt),
      })
    ));
    return Object.freeze({ binding, probe });
  });
}

export async function listNativeOllamaInstalledModels(
  input: NativeOllamaAuthorityCasInput,
  dependencies: NativeOllamaBackendDependencies = {},
): Promise<PublicNativeOllamaModelList> {
  const generation = positiveInteger(input.generation);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const withRunLease = dependencies.withRunLease ?? withOllamaAuthorityRunLease;

  return withRunLease(async () => {
    const binding = exactAuthority(
      await readBindingView(dependencies),
      generation,
      expectedVersion,
      { allowActive: true, allowDisconnected: false },
    );
    const peer = await reattestAuthority(binding, dependencies);
    const models = await readInstalledModels(peer, input.signal, dependencies);
    return Object.freeze({ binding, peer: publicPeer(peer), models });
  });
}

async function withModelSelectionDeadline<T>(
  callerSignal: AbortSignal | undefined,
  operation: (scope: Readonly<{
    signal: AbortSignal;
    enterCommit: () => void;
  }>) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let abortCause: 'caller' | 'deadline' | null = null;
  let commitEntered = false;
  const abortFromCaller = () => {
    if (abortCause !== null || commitEntered) return;
    abortCause = 'caller';
    controller.abort(callerSignal?.reason);
  };
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  const deadline = setTimeout(() => {
    if (abortCause !== null || commitEntered) return;
    abortCause = 'deadline';
    controller.abort();
  }, NATIVE_OLLAMA_MODEL_SELECTION_TIMEOUT_MS);
  deadline.unref();
  const enterCommit = () => {
    // JavaScript cannot interleave an abort callback between this synchronous
    // check and cleanup. From this point forward the exact database CAS is the
    // non-cancellable commit point and its authoritative outcome is returned.
    assertModelSelectionSignal(controller.signal);
    commitEntered = true;
    clearTimeout(deadline);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  };

  try {
    return await operation(Object.freeze({
      signal: controller.signal,
      enterCommit,
    }));
  } catch (error) {
    if (abortCause === 'deadline') {
      return backendError('MODEL_SELECTION_TIMEOUT', 504);
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

function assertModelSelectionSignal(signal: AbortSignal): void {
  if (signal.aborted) return backendError('REQUEST_ABORTED', 499);
}

export async function selectNativeOllamaBackendModel(
  input: SelectNativeOllamaBackendModelInput,
  dependencies: NativeOllamaBackendDependencies = {},
): Promise<PublicNativeOllamaModelSelection> {
  const generation = positiveInteger(input.generation);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const modelName = normalizedModelName(input.model);
  const expectedDigest = normalizeDigest(input.expectedDigest, 'INPUT_INVALID');
  const withFence = dependencies.withMutationFence ?? withOllamaAuthorityMutationFence;

  return withModelSelectionDeadline(input.signal, async ({
    signal: selectionSignal,
    enterCommit,
  }) => (
    withFence(async () => {
      assertModelSelectionSignal(selectionSignal);
      const authority = exactAuthority(
        await readBindingView(dependencies),
        generation,
        expectedVersion,
        { allowActive: true, allowDisconnected: false },
      );
      const peer = await reattestAuthority(authority, dependencies);
      const firstModels = await readInstalledModels(
        peer,
        selectionSignal,
        dependencies,
      );
      const installed = firstModels.find((entry) => entry.name === modelName);
      if (!installed) return backendError('MODEL_NOT_INSTALLED', 409);
      if (installed.digest !== expectedDigest) {
        return backendError('MODEL_DIGEST_MISMATCH', 409);
      }

      const inspection = await inspectModel(
        peer,
        modelName,
        selectionSignal,
        dependencies,
      );
      await runBoundedOneTokenModelTest(
        peer,
        modelName,
        expectedDigest,
        selectionSignal,
        dependencies,
      );

      // Ollama does not provide a transaction spanning /api/tags and /api/show.
      // Re-read the exact digest after bounded inference and immediately before
      // the binding CAS so a model replacement during inspection or execution
      // is not silently selected.
      const confirmedModels = await readInstalledModels(
        peer,
        selectionSignal,
        dependencies,
      );
      const confirmed = confirmedModels.find((entry) => entry.name === modelName);
      if (!confirmed) return backendError('MODEL_NOT_INSTALLED', 409);
      if (confirmed.digest !== expectedDigest) {
        return backendError('MODEL_DIGEST_MISMATCH', 409);
      }
      enterCommit();

      const binding = await translateBindingCall(() => (
        (dependencies.selectModel ?? selectNativeOllamaModel)({
          generation,
          expectedVersion,
          selectedModel: modelName,
          selectedModelDigest: confirmed.digest,
          verifiedAt: currentTime(
            dependencies,
            new Date(Math.max(
              authority.verifiedAt.getTime(),
              observedDate(peer).getTime(),
            )),
          ),
        })
      ));
      return Object.freeze({ binding, model: confirmed, inspection });
    })
  ));
}

export async function clearNativeOllamaBackendModel(
  input: Omit<NativeOllamaAuthorityCasInput, 'signal'>,
  dependencies: NativeOllamaBackendDependencies = {},
): Promise<PublicNativeOllamaBindingSnapshot> {
  const generation = positiveInteger(input.generation);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const withFence = dependencies.withMutationFence ?? withOllamaAuthorityMutationFence;

  return withFence(async () => {
    exactAuthority(
      await readBindingView(dependencies),
      generation,
      expectedVersion,
      { allowActive: true, allowDisconnected: true },
    );
    return translateBindingCall(() => (
      (dependencies.clearModel ?? clearNativeOllamaModel)({
        generation,
        expectedVersion,
      })
    ));
  });
}

function parseModelTest(
  payload: Record<string, unknown>,
  model: string,
  digest: `sha256:${string}`,
): PublicNativeOllamaModelTest {
  const response = payload.response === undefined
    ? ''
    : typeof payload.response === 'string'
      ? payload.response
      : null;
  const thinking = payload.thinking === undefined
    ? null
    : typeof payload.thinking === 'string'
      ? payload.thinking
      : null;
  const responseBytes = response === null
    ? Number.POSITIVE_INFINITY
    : Buffer.byteLength(response, 'utf8');
  const thinkingBytes = thinking === null
    ? 0
    : Buffer.byteLength(thinking, 'utf8');
  if (
    payload.done !== true
    || response === null
    || (payload.thinking !== undefined && thinking === null)
    || (response.length === 0 && (!thinking || thinking.length === 0))
    || responseBytes + thinkingBytes > MAX_MODEL_TEST_RESPONSE_BYTES
    || (payload.model !== undefined && payload.model !== model)
  ) {
    return backendError('MODEL_TEST_FAILED', 502);
  }
  const evalCount = safeOptionalInteger(payload.eval_count);
  if (evalCount !== null && evalCount > 1) {
    return backendError('MODEL_TEST_FAILED', 502);
  }
  const totalDurationNs = safeOptionalInteger(payload.total_duration);
  return Object.freeze({
    model,
    digest,
    response,
    thinking,
    evalCount,
    totalDurationNs,
  });
}

async function runBoundedOneTokenModelTest(
  peer: TailscalePeerAttestation,
  model: string,
  digest: `sha256:${string}`,
  signal: AbortSignal | undefined,
  dependencies: NativeOllamaBackendDependencies,
): Promise<PublicNativeOllamaModelTest> {
  const payload = await boundedJsonRequest(endpointFor(peer), {
    path: '/api/generate',
    method: 'POST',
    json: {
      model,
      prompt: 'Reply with one character.',
      stream: false,
      // Thinking-capable models otherwise may spend the single bounded token
      // exclusively in Ollama's separate `thinking` field. Most models honor
      // false; the parser still safely accepts a bounded thinking-only terminal
      // record for models that cannot disable reasoning.
      think: false,
      options: {
        num_predict: 1,
        temperature: 0,
      },
    },
    timeoutMs: NATIVE_OLLAMA_MODEL_TEST_TIMEOUT_MS,
    maxResponseBytes: MODEL_TEST_RESPONSE_BYTES,
    signal,
  }, dependencies);
  return parseModelTest(payload, model, digest);
}

export async function testNativeOllamaBackendModel(
  input: NativeOllamaAuthorityCasInput,
  dependencies: NativeOllamaBackendDependencies = {},
): Promise<PublicNativeOllamaModelTest> {
  const generation = positiveInteger(input.generation);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const withRunLease = dependencies.withRunLease ?? withOllamaAuthorityRunLease;

  return withRunLease(async () => {
    const authority = exactAuthority(
      await readBindingView(dependencies),
      generation,
      expectedVersion,
      { allowActive: true, allowDisconnected: false },
    );
    if (!authority.selectedModel || !authority.selectedModelDigest) {
      return backendError('MODEL_NOT_SELECTED', 409);
    }
    const peer = await reattestAuthority(authority, dependencies);
    const installed = (await readInstalledModels(peer, input.signal, dependencies))
      .find((entry) => entry.name === authority.selectedModel);
    if (!installed) return backendError('MODEL_NOT_INSTALLED', 409);
    if (installed.digest !== authority.selectedModelDigest) {
      return backendError('MODEL_DIGEST_MISMATCH', 409);
    }

    return runBoundedOneTokenModelTest(
      peer,
      authority.selectedModel,
      authority.selectedModelDigest as `sha256:${string}`,
      input.signal,
      dependencies,
    );
  });
}

export async function diagnoseNativeOllamaBackend(
  input: NativeOllamaAuthorityCasInput,
  dependencies: NativeOllamaBackendDependencies = {},
): Promise<PublicNativeOllamaRuntimeDiagnostic> {
  const generation = positiveInteger(input.generation);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const withRunLease = dependencies.withRunLease ?? withOllamaAuthorityRunLease;

  return withRunLease(async () => {
    const binding = exactAuthority(
      await readBindingView(dependencies),
      generation,
      expectedVersion,
      { allowActive: true, allowDisconnected: false },
    );
    const peer = await reattestAuthority(binding, dependencies);
    return Object.freeze({
      binding,
      peer: publicPeer(peer),
      runningModels: await readRunningModels(peer, input.signal, dependencies),
    });
  });
}

/** Exposed for regression coverage of transport error classification. */
export const translateTransportErrorForTests = translateTransportError;
