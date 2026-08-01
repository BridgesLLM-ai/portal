import crypto from 'node:crypto';
import net from 'node:net';
import {
  NativeOllamaBackendBindingState,
  OllamaBackendAddressFamily,
  OllamaBackendBindingState,
  Prisma,
  type NativeOllamaBackendBinding,
} from '@prisma/client';
import { prisma } from '../config/database';
import { isValidOllamaModelName } from '../utils/ollamaRecommendations';

export const NATIVE_OLLAMA_BACKEND_PURPOSE_ID = 'PRIMARY';
export const NATIVE_OLLAMA_SERVE_PORT = 11435 as const;
export const OLLAMA_LOCAL_ENABLED_SETTING_KEY = 'ollama.localEnabled';

const BINDING_FINGERPRINT_DOMAIN = 'native-ollama-binding:v1';
const LEGACY_HELPER_RETIREMENT_EVIDENCE_DOMAIN =
  'legacy-helper-retirement:v1';
const LEGACY_HELPER_RETIREMENT_PROCEDURE =
  'windows-exact-helper-retirement:v1';
const MAX_IDENTIFIER_BYTES = 512;
const MAX_MODEL_BYTES = 1024;
const SERIALIZABLE_MAX_ATTEMPTS = 4;

export type NativeOllamaBindingErrorCode =
  | 'INVALID_INPUT'
  | 'CAS_MISMATCH'
  | 'NOT_FOUND'
  | 'STATE_CONFLICT'
  | 'IDENTITY_MISMATCH'
  | 'DATABASE_CONFLICT';

export class NativeOllamaBindingError extends Error {
  constructor(
    public readonly code: NativeOllamaBindingErrorCode,
    message: string,
    public readonly httpStatus = 409,
  ) {
    super(message);
    this.name = 'NativeOllamaBindingError';
  }
}

type NativeBindingDelegate = {
  findFirst(args: Record<string, unknown>): Promise<NativeOllamaBackendBinding | null>;
  findUnique(args: Record<string, unknown>): Promise<NativeOllamaBackendBinding | null>;
  create(args: Record<string, unknown>): Promise<NativeOllamaBackendBinding>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
};

type NativeBindingTransaction = {
  nativeOllamaBackendBinding: NativeBindingDelegate;
  ollamaBackendBinding: {
    updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  };
  systemSetting: {
    findUnique(args: Record<string, unknown>): Promise<{
      key: string;
      value: string;
    } | null>;
    upsert(args: Record<string, unknown>): Promise<unknown>;
    deleteMany(args: Record<string, unknown>): Promise<{ count: number }>;
  };
};

export interface NativeOllamaBindingDatabase {
  nativeOllamaBackendBinding: Pick<NativeBindingDelegate, 'findFirst' | 'findUnique'>;
  $transaction<T>(
    operation: (transaction: NativeBindingTransaction) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
}

const defaultDatabase = prisma as unknown as NativeOllamaBindingDatabase;

export interface PublicNativeOllamaBindingSnapshot {
  id: string;
  purposeId: typeof NATIVE_OLLAMA_BACKEND_PURPOSE_ID;
  generation: number;
  version: number;
  state: NativeOllamaBackendBindingState;
  tailnetName: string;
  stableNodeId: string;
  nodePublicKey: string;
  observedAddress: string;
  addressFamily: OllamaBackendAddressFamily;
  servePort: typeof NATIVE_OLLAMA_SERVE_PORT;
  bindingFingerprint: string;
  selectedModel: string | null;
  selectedModelDigest: string | null;
  grantPeerAttestationFingerprint: string;
  grantTemplateHash: string;
  grantAcknowledgedAt: Date;
  grantAcknowledgedBy: string;
  legacyHelperRetirementAcknowledgedAt: Date | null;
  legacyHelperRetirementAcknowledgedBy: string | null;
  legacyHelperRetirementEvidence: string | null;
  configuredByUserId: string | null;
  observedAt: Date;
  verifiedAt: Date;
  activatedAt: Date;
  disconnectedAt: Date | null;
  removedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicNativeOllamaBindingView {
  purposeId: typeof NATIVE_OLLAMA_BACKEND_PURPOSE_ID;
  authority: PublicNativeOllamaBindingSnapshot | null;
}

interface NativeOllamaPeerObservation {
  purposeId?: string;
  tailnetName: string;
  stableNodeId: string;
  nodePublicKey: string;
  observedAddress: string;
  addressFamily: OllamaBackendAddressFamily | string;
  servePort?: number;
  observedAt: Date;
}

export interface CreateOrReplaceNativeOllamaBindingInput
  extends NativeOllamaPeerObservation {
  expectedAuthorityGeneration: number | null;
  expectedAuthorityVersion: number | null;
  selectedModel?: string | null;
  selectedModelDigest?: string | null;
  grantPeerAttestationFingerprint: string;
  grantTemplateHash: string;
  grantAcknowledgedAt: Date;
  grantAcknowledgedBy: string;
  configuredByUserId: string;
  verifiedAt: Date;
  activatedAt?: Date;
}

export interface UpdateNativeOllamaBindingObservationInput
  extends NativeOllamaPeerObservation {
  generation: number;
  expectedVersion: number;
}

export interface SelectNativeOllamaModelInput {
  purposeId?: string;
  generation: number;
  expectedVersion: number;
  selectedModel: string;
  selectedModelDigest: string;
  verifiedAt: Date;
}

export interface ClearNativeOllamaModelInput {
  purposeId?: string;
  generation: number;
  expectedVersion: number;
}

export interface AcknowledgeNativeOllamaLegacyHelperRetirementInput {
  purposeId?: string;
  generation: number;
  expectedVersion: number;
  acknowledgedBy: string;
  acknowledgedAt?: Date;
}

export interface MarkNativeOllamaBindingDisconnectedInput {
  purposeId?: string;
  generation: number;
  expectedVersion: number;
  disconnectedAt?: Date;
}

export interface ReverifyNativeOllamaBindingInput
  extends NativeOllamaPeerObservation {
  generation: number;
  expectedVersion: number;
  verifiedAt: Date;
}

export interface RemoveNativeOllamaBindingInput {
  purposeId?: string;
  generation: number;
  expectedVersion: number;
  removedAt?: Date;
}

interface NormalizedPeerObservation {
  purposeId: typeof NATIVE_OLLAMA_BACKEND_PURPOSE_ID;
  tailnetName: string;
  stableNodeId: string;
  nodePublicKey: string;
  observedAddress: string;
  addressFamily: OllamaBackendAddressFamily;
  servePort: typeof NATIVE_OLLAMA_SERVE_PORT;
  observedAt: Date;
}

function inputError(message: string): never {
  throw new NativeOllamaBindingError('INVALID_INPUT', message, 400);
}

function boundedText(
  value: unknown,
  label: string,
  maxBytes = MAX_IDENTIFIER_BYTES,
): string {
  if (typeof value !== 'string') return inputError(`Invalid ${label}`);
  const normalized = value.trim();
  const byteLength = Buffer.byteLength(normalized, 'utf8');
  if (
    !normalized
    || normalized !== value
    || normalized.includes('\u0000')
    || byteLength > maxBytes
    || /[\u0001-\u001f\u007f]/u.test(normalized)
  ) {
    return inputError(`Invalid ${label}`);
  }
  return normalized;
}

function purposeId(value: unknown): typeof NATIVE_OLLAMA_BACKEND_PURPOSE_ID {
  const normalized = value === undefined
    ? NATIVE_OLLAMA_BACKEND_PURPOSE_ID
    : boundedText(value, 'native Ollama backend purpose');
  if (normalized !== NATIVE_OLLAMA_BACKEND_PURPOSE_ID) {
    return inputError('Unsupported native Ollama backend purpose');
  }
  return NATIVE_OLLAMA_BACKEND_PURPOSE_ID;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return inputError(`Invalid ${label}`);
  }
  return value;
}

function optionalCasInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  return positiveInteger(value, label);
}

function validDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return inputError(`Invalid ${label}`);
  }
  return new Date(value.getTime());
}

function dateAtOrAfter(value: Date, floor: Date, label: string): Date {
  if (value.getTime() < floor.getTime()) return inputError(`Invalid ${label}`);
  return value;
}

function fixedServePort(value: unknown): typeof NATIVE_OLLAMA_SERVE_PORT {
  const port = value === undefined ? NATIVE_OLLAMA_SERVE_PORT : value;
  if (port !== NATIVE_OLLAMA_SERVE_PORT) {
    return inputError(`Native Ollama Serve port must be ${NATIVE_OLLAMA_SERVE_PORT}`);
  }
  return NATIVE_OLLAMA_SERVE_PORT;
}

function normalizedAddressFamily(value: unknown): OllamaBackendAddressFamily {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (normalized === OllamaBackendAddressFamily.IPV4) {
    return OllamaBackendAddressFamily.IPV4;
  }
  if (normalized === OllamaBackendAddressFamily.IPV6) {
    return OllamaBackendAddressFamily.IPV6;
  }
  return inputError('Invalid native Ollama address family');
}

function normalizedTailnetAddress(
  value: unknown,
  family: OllamaBackendAddressFamily,
): string {
  if (typeof value !== 'string' || value !== value.trim() || value.includes('%') || value.includes('/')) {
    return inputError('Invalid literal Tailscale address');
  }
  if (family === OllamaBackendAddressFamily.IPV4) {
    if (net.isIP(value) !== 4) return inputError('Invalid literal Tailscale IPv4 address');
    const octets = value.split('.').map((part) => Number(part));
    if (octets[0] !== 100 || octets[1] < 64 || octets[1] > 127) {
      return inputError('Native Ollama IPv4 address is outside the Tailscale range');
    }
    return value;
  }

  const normalized = value.toLowerCase();
  if (
    net.isIP(normalized) !== 6
    || normalized.includes('.')
    || !normalized.startsWith('fd7a:115c:a1e0:')
  ) {
    return inputError('Native Ollama IPv6 address is outside the Tailscale range');
  }
  return normalized;
}

function normalizedPeerObservation(
  input: NativeOllamaPeerObservation,
): NormalizedPeerObservation {
  const tailnetName = boundedText(input.tailnetName, 'Tailnet name', 253);
  if (
    !/^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._@+-]{0,251}[A-Za-z0-9])$/.test(
      tailnetName,
    )
  ) {
    return inputError('Invalid Tailnet name');
  }

  const stableNodeId = boundedText(input.stableNodeId, 'Tailscale stable node ID', 128);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(stableNodeId)) {
    return inputError('Invalid Tailscale stable node ID');
  }

  const nodePublicKey = boundedText(input.nodePublicKey, 'Tailscale node public key', 72);
  if (
    !/^nodekey:[a-f0-9]{64}$/.test(nodePublicKey)
    || nodePublicKey === `nodekey:${'0'.repeat(64)}`
  ) {
    return inputError('Invalid Tailscale node public key');
  }

  const addressFamily = normalizedAddressFamily(input.addressFamily);
  return {
    purposeId: purposeId(input.purposeId),
    tailnetName,
    stableNodeId,
    nodePublicKey,
    observedAddress: normalizedTailnetAddress(input.observedAddress, addressFamily),
    addressFamily,
    servePort: fixedServePort(input.servePort),
    observedAt: validDate(input.observedAt, 'native Ollama observation time'),
  };
}

function normalizedModelPair(
  modelValue: unknown,
  digestValue: unknown,
): { selectedModel: string | null; selectedModelDigest: string | null } {
  const hasModel = modelValue !== null && modelValue !== undefined && modelValue !== '';
  const hasDigest = digestValue !== null && digestValue !== undefined && digestValue !== '';
  if (hasModel !== hasDigest) {
    return inputError('Native Ollama model and digest must be supplied together');
  }
  if (!hasModel) return { selectedModel: null, selectedModelDigest: null };
  if (!isValidOllamaModelName(modelValue)) {
    return inputError('Invalid native Ollama model name');
  }
  const selectedModel = boundedText(modelValue, 'native Ollama model', MAX_MODEL_BYTES);
  if (
    typeof digestValue !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(digestValue)
  ) {
    return inputError('Native Ollama model digest must be normalized lowercase sha256');
  }
  return { selectedModel, selectedModelDigest: digestValue };
}

function normalizedGrantPeerAttestationFingerprint(value: unknown): string {
  const normalized = boundedText(
    value,
    'Tailscale Grant peer attestation fingerprint',
    64,
  );
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    return inputError('Invalid Tailscale Grant peer attestation fingerprint');
  }
  return normalized;
}

function normalizedGrantTemplateHash(value: unknown): string {
  const normalized = boundedText(
    value,
    'Tailscale Grant template hash',
    71,
  );
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) {
    return inputError('Invalid Tailscale Grant template hash');
  }
  return normalized;
}

/**
 * The fingerprint intentionally excludes observedAddress/addressFamily and
 * selectedModel/selectedModelDigest. Address observations and model selection
 * can therefore advance by CAS without silently changing the pinned Tailscale
 * node identity.
 */
function bindingFingerprint(
  identity: Pick<
    NormalizedPeerObservation,
    'purposeId' | 'tailnetName' | 'stableNodeId' | 'nodePublicKey' | 'servePort'
  >,
): string {
  const canonical = JSON.stringify({
    purposeId: identity.purposeId,
    tailnetName: identity.tailnetName,
    stableNodeId: identity.stableNodeId,
    nodePublicKey: identity.nodePublicKey,
    servePort: identity.servePort,
  });
  const digest = crypto
    .createHash('sha256')
    .update(BINDING_FINGERPRINT_DOMAIN, 'utf8')
    .update('\u0000', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
  return `${BINDING_FINGERPRINT_DOMAIN}:sha256:${digest}`;
}

function legacyHelperRetirementEvidence(
  row: NativeOllamaBackendBinding,
  acknowledgedAt: Date,
  acknowledgedBy: string,
): string {
  const canonical = JSON.stringify({
    procedure: LEGACY_HELPER_RETIREMENT_PROCEDURE,
    purposeId: row.purposeId,
    generation: row.generation,
    bindingFingerprint: row.bindingFingerprint,
    tailnetName: row.tailnetName,
    stableNodeId: row.stableNodeId,
    nodePublicKey: row.nodePublicKey,
    acknowledgedAt: acknowledgedAt.toISOString(),
    acknowledgedBy,
  });
  const digest = crypto
    .createHash('sha256')
    .update(LEGACY_HELPER_RETIREMENT_EVIDENCE_DOMAIN, 'utf8')
    .update('\u0000', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
  return `${LEGACY_HELPER_RETIREMENT_EVIDENCE_DOMAIN}:sha256:${digest}`;
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function publicSnapshot(
  row: NativeOllamaBackendBinding,
): PublicNativeOllamaBindingSnapshot {
  return {
    id: row.id,
    purposeId: row.purposeId as typeof NATIVE_OLLAMA_BACKEND_PURPOSE_ID,
    generation: row.generation,
    version: row.version,
    state: row.state,
    tailnetName: row.tailnetName,
    stableNodeId: row.stableNodeId,
    nodePublicKey: row.nodePublicKey,
    observedAddress: row.observedAddress,
    addressFamily: row.addressFamily,
    servePort: row.servePort as typeof NATIVE_OLLAMA_SERVE_PORT,
    bindingFingerprint: row.bindingFingerprint,
    selectedModel: row.selectedModel,
    selectedModelDigest: row.selectedModelDigest,
    grantPeerAttestationFingerprint:
      row.grantPeerAttestationFingerprint,
    grantTemplateHash: row.grantTemplateHash,
    grantAcknowledgedAt: new Date(row.grantAcknowledgedAt),
    grantAcknowledgedBy: row.grantAcknowledgedBy,
    legacyHelperRetirementAcknowledgedAt:
      row.legacyHelperRetirementAcknowledgedAt
        ? new Date(row.legacyHelperRetirementAcknowledgedAt)
        : null,
    legacyHelperRetirementAcknowledgedBy:
      row.legacyHelperRetirementAcknowledgedBy,
    legacyHelperRetirementEvidence: row.legacyHelperRetirementEvidence,
    configuredByUserId: row.configuredByUserId,
    observedAt: new Date(row.observedAt),
    verifiedAt: new Date(row.verifiedAt),
    activatedAt: new Date(row.activatedAt),
    disconnectedAt: row.disconnectedAt ? new Date(row.disconnectedAt) : null,
    removedAt: row.removedAt ? new Date(row.removedAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function transactionConflict(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (
      (error as { code?: unknown }).code === 'P2034'
      || (error as { code?: unknown }).code === 'P2002'
    ),
  );
}

async function serializable<T>(
  database: NativeOllamaBindingDatabase,
  operation: (transaction: NativeBindingTransaction) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SERIALIZABLE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await database.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      lastError = error;
      if (
        error instanceof NativeOllamaBindingError
        || !transactionConflict(error)
        || attempt === SERIALIZABLE_MAX_ATTEMPTS
      ) {
        break;
      }
    }
  }
  if (transactionConflict(lastError)) {
    throw new NativeOllamaBindingError(
      'DATABASE_CONFLICT',
      'Native Ollama binding changed concurrently; refresh and retry',
    );
  }
  throw lastError;
}

function assertExpectedCas(
  row: NativeOllamaBackendBinding | null,
  generation: number,
  version: number,
): NativeOllamaBackendBinding {
  if (!row) {
    throw new NativeOllamaBindingError(
      'NOT_FOUND',
      'Native Ollama binding was not found',
      404,
    );
  }
  if (row.generation !== generation || row.version !== version) {
    throw new NativeOllamaBindingError(
      'CAS_MISMATCH',
      'Native Ollama binding changed concurrently; refresh and retry',
    );
  }
  return row;
}

function assertPinnedIdentity(
  row: NativeOllamaBackendBinding,
  peer: NormalizedPeerObservation,
): void {
  const suppliedFingerprint = bindingFingerprint(peer);
  if (
    row.purposeId !== peer.purposeId
    || row.tailnetName !== peer.tailnetName
    || row.stableNodeId !== peer.stableNodeId
    || row.nodePublicKey !== peer.nodePublicKey
    || row.servePort !== peer.servePort
    || !safeStringEqual(row.bindingFingerprint, suppliedFingerprint)
  ) {
    throw new NativeOllamaBindingError(
      'IDENTITY_MISMATCH',
      'Fresh Tailscale attestation did not match the pinned native Ollama identity',
    );
  }
}

async function reRead(
  transaction: NativeBindingTransaction,
  requestedPurpose: string,
  generation: number,
): Promise<NativeOllamaBackendBinding> {
  const row = await transaction.nativeOllamaBackendBinding.findUnique({
    where: {
      purposeId_generation: {
        purposeId: requestedPurpose,
        generation,
      },
    },
  });
  if (!row) {
    throw new NativeOllamaBindingError(
      'DATABASE_CONFLICT',
      'Native Ollama binding transition could not be confirmed',
      500,
    );
  }
  return row;
}

function authorityWhere(requestedPurpose: string): Record<string, unknown> {
  return {
    purposeId: requestedPurpose,
    state: {
      in: [
        NativeOllamaBackendBindingState.ACTIVE,
        NativeOllamaBackendBindingState.DISCONNECTED,
      ],
    },
  };
}

export async function readNativeOllamaBinding(
  requestedPurposeId: string = NATIVE_OLLAMA_BACKEND_PURPOSE_ID,
  database: NativeOllamaBindingDatabase = defaultDatabase,
): Promise<PublicNativeOllamaBindingView> {
  const requestedPurpose = purposeId(requestedPurposeId);
  const authority = await database.nativeOllamaBackendBinding.findFirst({
    where: authorityWhere(requestedPurpose),
    orderBy: { generation: 'desc' },
  });
  return {
    purposeId: requestedPurpose,
    authority: authority ? publicSnapshot(authority) : null,
  };
}

/**
 * Publishes a native authority only after the caller's Tailscale/Ollama probe
 * and Grant acknowledgement have completed. There is deliberately no PENDING
 * state in this rollback-safe table. The prior native authority is retired and
 * the replacement is inserted atomically. At that promotion boundary, legacy
 * helper authority/candidate rows are deliberately preserved for the binary
 * downgrade compatibility window. Instead, the transaction forces the old
 * runtime's local-policy switch off and stores the exact prior policy on the
 * native row. A downgraded binary can therefore use a still-valid legacy
 * authority or fail closed; it can never silently fall back to local Ollama.
 */
export async function createOrReplaceNativeOllamaBinding(
  input: CreateOrReplaceNativeOllamaBindingInput,
  database: NativeOllamaBindingDatabase = defaultDatabase,
): Promise<PublicNativeOllamaBindingSnapshot> {
  const peer = normalizedPeerObservation(input);
  const expectedAuthorityGeneration = optionalCasInteger(
    input.expectedAuthorityGeneration,
    'expected native Ollama authority generation',
  );
  const expectedAuthorityVersion = optionalCasInteger(
    input.expectedAuthorityVersion,
    'expected native Ollama authority version',
  );
  if ((expectedAuthorityGeneration === null) !== (expectedAuthorityVersion === null)) {
    return inputError(
      'Expected native Ollama authority generation and version must be supplied together',
    );
  }

  const selected = normalizedModelPair(input.selectedModel, input.selectedModelDigest);
  const grantPeerAttestationFingerprint =
    normalizedGrantPeerAttestationFingerprint(
      input.grantPeerAttestationFingerprint,
    );
  const grantTemplateHash = normalizedGrantTemplateHash(
    input.grantTemplateHash,
  );
  const grantAcknowledgedAt = validDate(
    input.grantAcknowledgedAt,
    'Tailscale Grant acknowledgement time',
  );
  const grantAcknowledgedBy = boundedText(
    input.grantAcknowledgedBy,
    'Tailscale Grant acknowledgement actor',
  );
  const configuredByUserId = boundedText(
    input.configuredByUserId,
    'native Ollama configuring user ID',
  );
  const verifiedAt = dateAtOrAfter(
    validDate(input.verifiedAt, 'native Ollama verification time'),
    peer.observedAt,
    'native Ollama verification time',
  );
  const activatedAt = dateAtOrAfter(
    validDate(input.activatedAt ?? verifiedAt, 'native Ollama activation time'),
    verifiedAt,
    'native Ollama activation time',
  );
  if (grantAcknowledgedAt.getTime() > activatedAt.getTime()) {
    return inputError('Tailscale Grant must be acknowledged before native Ollama activation');
  }
  const fingerprint = bindingFingerprint(peer);

  return serializable(database, async (transaction) => {
    const authority = await transaction.nativeOllamaBackendBinding.findFirst({
      where: authorityWhere(peer.purposeId),
      orderBy: { generation: 'desc' },
    });
    if (
      (authority === null) !== (expectedAuthorityGeneration === null)
      || (
        authority
        && (
          authority.generation !== expectedAuthorityGeneration
          || authority.version !== expectedAuthorityVersion
        )
      )
    ) {
      throw new NativeOllamaBindingError(
        'CAS_MISMATCH',
        'The native Ollama authority changed concurrently; refresh and retry',
      );
    }

    const latest = await transaction.nativeOllamaBackendBinding.findFirst({
      where: { purposeId: peer.purposeId },
      orderBy: { generation: 'desc' },
    });
    const generation = latest ? latest.generation + 1 : 1;
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new NativeOllamaBindingError(
        'STATE_CONFLICT',
        'Native Ollama binding generation is exhausted',
        500,
      );
    }

    if (authority) {
      const retirementFloor = new Date(Math.max(
        authority.activatedAt.getTime(),
        authority.observedAt.getTime(),
        authority.verifiedAt.getTime(),
        authority.disconnectedAt?.getTime() ?? 0,
      ));
      if (activatedAt.getTime() < retirementFloor.getTime()) {
        throw new NativeOllamaBindingError(
          'STATE_CONFLICT',
          'Replacement activation predates the current native Ollama authority',
        );
      }
      const retired = await transaction.nativeOllamaBackendBinding.updateMany({
        where: {
          id: authority.id,
          generation: authority.generation,
          version: authority.version,
          state: authority.state,
          bindingFingerprint: authority.bindingFingerprint,
        },
        data: {
          state: NativeOllamaBackendBindingState.REMOVED,
          version: { increment: 1 },
          removedAt: activatedAt,
        },
      });
      if (retired.count !== 1) {
        throw new NativeOllamaBindingError(
          'CAS_MISMATCH',
          'The native Ollama authority changed concurrently; refresh and retry',
        );
      }
    }

    const priorLocalPolicy = authority
      ? {
          enabled: authority.localEnabledBeforeActivation,
          settingExisted: authority.localEnabledSettingExisted,
        }
      : await transaction.systemSetting.findUnique({
          where: { key: OLLAMA_LOCAL_ENABLED_SETTING_KEY },
          select: { key: true, value: true },
        }).then((setting) => ({
          // This matches the older runtime's effective-policy parser: only
          // the exact string "false" disables local Ollama.
          enabled: setting?.value !== 'false',
          settingExisted: setting !== null,
        }));

    // This setting is the downgrade fence. It must commit atomically with the
    // native authority row; otherwise an older binary could observe neither a
    // native row nor a disabled local policy and silently run on the Portal.
    await transaction.systemSetting.upsert({
      where: { key: OLLAMA_LOCAL_ENABLED_SETTING_KEY },
      update: { value: 'false' },
      create: {
        key: OLLAMA_LOCAL_ENABLED_SETTING_KEY,
        value: 'false',
      },
    });

    const created = await transaction.nativeOllamaBackendBinding.create({
      data: {
        purposeId: peer.purposeId,
        generation,
        version: 1,
        state: NativeOllamaBackendBindingState.ACTIVE,
        tailnetName: peer.tailnetName,
        stableNodeId: peer.stableNodeId,
        nodePublicKey: peer.nodePublicKey,
        observedAddress: peer.observedAddress,
        addressFamily: peer.addressFamily,
        servePort: peer.servePort,
        bindingFingerprint: fingerprint,
        ...selected,
        localEnabledBeforeActivation: priorLocalPolicy.enabled,
        localEnabledSettingExisted: priorLocalPolicy.settingExisted,
        grantPeerAttestationFingerprint,
        grantTemplateHash,
        grantAcknowledgedAt,
        grantAcknowledgedBy,
        configuredByUserId,
        observedAt: peer.observedAt,
        verifiedAt,
        activatedAt,
      },
    });
    return publicSnapshot(created);
  });
}

export async function updateNativeOllamaBindingObservation(
  input: UpdateNativeOllamaBindingObservationInput,
  database: NativeOllamaBindingDatabase = defaultDatabase,
): Promise<PublicNativeOllamaBindingSnapshot> {
  const peer = normalizedPeerObservation(input);
  const generation = positiveInteger(input.generation, 'native Ollama binding generation');
  const expectedVersion = positiveInteger(
    input.expectedVersion,
    'native Ollama binding version',
  );

  return serializable(database, async (transaction) => {
    const row = assertExpectedCas(
      await transaction.nativeOllamaBackendBinding.findUnique({
        where: {
          purposeId_generation: {
            purposeId: peer.purposeId,
            generation,
          },
        },
      }),
      generation,
      expectedVersion,
    );
    if (
      row.state !== NativeOllamaBackendBindingState.ACTIVE
      && row.state !== NativeOllamaBackendBindingState.DISCONNECTED
    ) {
      throw new NativeOllamaBindingError(
        'STATE_CONFLICT',
        'A removed native Ollama binding cannot accept observations',
      );
    }
    assertPinnedIdentity(row, peer);
    dateAtOrAfter(
      peer.observedAt,
      new Date(Math.max(row.observedAt.getTime(), row.activatedAt.getTime())),
      'native Ollama observation time',
    );

    const updated = await transaction.nativeOllamaBackendBinding.updateMany({
      where: {
        id: row.id,
        generation,
        version: expectedVersion,
        state: row.state,
        bindingFingerprint: row.bindingFingerprint,
      },
      data: {
        observedAddress: peer.observedAddress,
        addressFamily: peer.addressFamily,
        observedAt: peer.observedAt,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new NativeOllamaBindingError(
        'CAS_MISMATCH',
        'Native Ollama observation changed concurrently; refresh and retry',
      );
    }
    return publicSnapshot(await reRead(transaction, peer.purposeId, generation));
  });
}

export async function selectNativeOllamaModel(
  input: SelectNativeOllamaModelInput,
  database: NativeOllamaBindingDatabase = defaultDatabase,
): Promise<PublicNativeOllamaBindingSnapshot> {
  const requestedPurpose = purposeId(input.purposeId);
  const generation = positiveInteger(input.generation, 'native Ollama binding generation');
  const expectedVersion = positiveInteger(
    input.expectedVersion,
    'native Ollama binding version',
  );
  const selected = normalizedModelPair(input.selectedModel, input.selectedModelDigest);
  const verifiedAt = validDate(input.verifiedAt, 'native Ollama model verification time');

  return serializable(database, async (transaction) => {
    const row = assertExpectedCas(
      await transaction.nativeOllamaBackendBinding.findUnique({
        where: {
          purposeId_generation: {
            purposeId: requestedPurpose,
            generation,
          },
        },
      }),
      generation,
      expectedVersion,
    );
    if (row.state !== NativeOllamaBackendBindingState.ACTIVE) {
      throw new NativeOllamaBindingError(
        'STATE_CONFLICT',
        'Only an active native Ollama binding can select a verified model',
      );
    }
    dateAtOrAfter(
      verifiedAt,
      new Date(Math.max(
        row.observedAt.getTime(),
        row.verifiedAt.getTime(),
        row.activatedAt.getTime(),
      )),
      'native Ollama model verification time',
    );

    const updated = await transaction.nativeOllamaBackendBinding.updateMany({
      where: {
        id: row.id,
        generation,
        version: expectedVersion,
        state: NativeOllamaBackendBindingState.ACTIVE,
        bindingFingerprint: row.bindingFingerprint,
      },
      data: {
        ...selected,
        verifiedAt,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new NativeOllamaBindingError(
        'CAS_MISMATCH',
        'Native Ollama model selection changed concurrently; refresh and retry',
      );
    }
    return publicSnapshot(await reRead(transaction, requestedPurpose, generation));
  });
}

export async function clearNativeOllamaModel(
  input: ClearNativeOllamaModelInput,
  database: NativeOllamaBindingDatabase = defaultDatabase,
): Promise<PublicNativeOllamaBindingSnapshot> {
  const requestedPurpose = purposeId(input.purposeId);
  const generation = positiveInteger(input.generation, 'native Ollama binding generation');
  const expectedVersion = positiveInteger(
    input.expectedVersion,
    'native Ollama binding version',
  );

  return serializable(database, async (transaction) => {
    const row = assertExpectedCas(
      await transaction.nativeOllamaBackendBinding.findUnique({
        where: {
          purposeId_generation: {
            purposeId: requestedPurpose,
            generation,
          },
        },
      }),
      generation,
      expectedVersion,
    );
    if (
      row.state !== NativeOllamaBackendBindingState.ACTIVE
      && row.state !== NativeOllamaBackendBindingState.DISCONNECTED
    ) {
      throw new NativeOllamaBindingError(
        'STATE_CONFLICT',
        'A removed native Ollama binding cannot clear its model',
      );
    }

    const updated = await transaction.nativeOllamaBackendBinding.updateMany({
      where: {
        id: row.id,
        generation,
        version: expectedVersion,
        state: row.state,
        bindingFingerprint: row.bindingFingerprint,
      },
      data: {
        selectedModel: null,
        selectedModelDigest: null,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new NativeOllamaBindingError(
        'CAS_MISMATCH',
        'Native Ollama model selection changed concurrently; refresh and retry',
      );
    }
    return publicSnapshot(await reRead(transaction, requestedPurpose, generation));
  });
}

/**
 * Records the Owner's explicit confirmation that the separately run Windows
 * cleanup reported exact legacy-helper absence. This intentionally leaves
 * helper-era database rows untouched so an older binary can still fail closed
 * during the rollback window. The evidence hash binds the acknowledgement to
 * this exact native generation and documented cleanup procedure.
 */
export async function acknowledgeNativeOllamaLegacyHelperRetirement(
  input: AcknowledgeNativeOllamaLegacyHelperRetirementInput,
  database: NativeOllamaBindingDatabase = defaultDatabase,
): Promise<PublicNativeOllamaBindingSnapshot> {
  const requestedPurpose = purposeId(input.purposeId);
  const generation = positiveInteger(
    input.generation,
    'native Ollama binding generation',
  );
  const expectedVersion = positiveInteger(
    input.expectedVersion,
    'native Ollama binding version',
  );
  const acknowledgedBy = boundedText(
    input.acknowledgedBy,
    'legacy helper retirement acknowledgement actor',
  );
  const acknowledgedAt = validDate(
    input.acknowledgedAt ?? new Date(),
    'legacy helper retirement acknowledgement time',
  );

  return serializable(database, async (transaction) => {
    const row = assertExpectedCas(
      await transaction.nativeOllamaBackendBinding.findUnique({
        where: {
          purposeId_generation: {
            purposeId: requestedPurpose,
            generation,
          },
        },
      }),
      generation,
      expectedVersion,
    );
    if (row.state !== NativeOllamaBackendBindingState.ACTIVE) {
      throw new NativeOllamaBindingError(
        'STATE_CONFLICT',
        'Legacy helper retirement can be acknowledged only while the native Remote GPU is active',
      );
    }
    if (
      row.legacyHelperRetirementAcknowledgedAt
      && row.legacyHelperRetirementAcknowledgedBy
      && row.legacyHelperRetirementEvidence
    ) {
      return publicSnapshot(row);
    }
    dateAtOrAfter(
      acknowledgedAt,
      new Date(Math.max(
        row.activatedAt.getTime(),
        row.observedAt.getTime(),
        row.verifiedAt.getTime(),
      )),
      'legacy helper retirement acknowledgement time',
    );
    const evidence = legacyHelperRetirementEvidence(
      row,
      acknowledgedAt,
      acknowledgedBy,
    );

    const updated = await transaction.nativeOllamaBackendBinding.updateMany({
      where: {
        id: row.id,
        generation,
        version: expectedVersion,
        state: NativeOllamaBackendBindingState.ACTIVE,
        bindingFingerprint: row.bindingFingerprint,
        legacyHelperRetirementAcknowledgedAt: null,
        legacyHelperRetirementAcknowledgedBy: null,
        legacyHelperRetirementEvidence: null,
      },
      data: {
        legacyHelperRetirementAcknowledgedAt: acknowledgedAt,
        legacyHelperRetirementAcknowledgedBy: acknowledgedBy,
        legacyHelperRetirementEvidence: evidence,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new NativeOllamaBindingError(
        'CAS_MISMATCH',
        'Legacy helper retirement acknowledgement changed concurrently; refresh and retry',
      );
    }
    return publicSnapshot(
      await reRead(transaction, requestedPurpose, generation),
    );
  });
}

export async function markNativeOllamaBindingDisconnected(
  input: MarkNativeOllamaBindingDisconnectedInput,
  database: NativeOllamaBindingDatabase = defaultDatabase,
): Promise<PublicNativeOllamaBindingSnapshot> {
  const requestedPurpose = purposeId(input.purposeId);
  const generation = positiveInteger(input.generation, 'native Ollama binding generation');
  const expectedVersion = positiveInteger(
    input.expectedVersion,
    'native Ollama binding version',
  );
  const disconnectedAt = validDate(
    input.disconnectedAt ?? new Date(),
    'native Ollama disconnection time',
  );

  return serializable(database, async (transaction) => {
    const row = assertExpectedCas(
      await transaction.nativeOllamaBackendBinding.findUnique({
        where: {
          purposeId_generation: {
            purposeId: requestedPurpose,
            generation,
          },
        },
      }),
      generation,
      expectedVersion,
    );
    if (row.state !== NativeOllamaBackendBindingState.ACTIVE) {
      throw new NativeOllamaBindingError(
        'STATE_CONFLICT',
        'Only an active native Ollama binding can become disconnected',
      );
    }
    const disconnectFloor = new Date(Math.max(
      row.activatedAt.getTime(),
      row.observedAt.getTime(),
      row.verifiedAt.getTime(),
    ));
    dateAtOrAfter(disconnectedAt, disconnectFloor, 'native Ollama disconnection time');

    const updated = await transaction.nativeOllamaBackendBinding.updateMany({
      where: {
        id: row.id,
        generation,
        version: expectedVersion,
        state: NativeOllamaBackendBindingState.ACTIVE,
        bindingFingerprint: row.bindingFingerprint,
      },
      data: {
        state: NativeOllamaBackendBindingState.DISCONNECTED,
        disconnectedAt,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new NativeOllamaBindingError(
        'CAS_MISMATCH',
        'Native Ollama authority changed concurrently; refresh and retry',
      );
    }

    return publicSnapshot(await reRead(transaction, requestedPurpose, generation));
  });
}

export async function reverifyNativeOllamaBinding(
  input: ReverifyNativeOllamaBindingInput,
  database: NativeOllamaBindingDatabase = defaultDatabase,
): Promise<PublicNativeOllamaBindingSnapshot> {
  const peer = normalizedPeerObservation(input);
  const generation = positiveInteger(input.generation, 'native Ollama binding generation');
  const expectedVersion = positiveInteger(
    input.expectedVersion,
    'native Ollama binding version',
  );
  const verifiedAt = dateAtOrAfter(
    validDate(input.verifiedAt, 'native Ollama reverification time'),
    peer.observedAt,
    'native Ollama reverification time',
  );

  return serializable(database, async (transaction) => {
    const row = assertExpectedCas(
      await transaction.nativeOllamaBackendBinding.findUnique({
        where: {
          purposeId_generation: {
            purposeId: peer.purposeId,
            generation,
          },
        },
      }),
      generation,
      expectedVersion,
    );
    if (
      row.state !== NativeOllamaBackendBindingState.ACTIVE
      && row.state !== NativeOllamaBackendBindingState.DISCONNECTED
    ) {
      throw new NativeOllamaBindingError(
        'STATE_CONFLICT',
        'Only an active or disconnected native Ollama binding can be reverified',
      );
    }
    assertPinnedIdentity(row, peer);
    dateAtOrAfter(
      peer.observedAt,
      row.observedAt,
      'native Ollama observation time',
    );
    dateAtOrAfter(
      verifiedAt,
      new Date(Math.max(
        row.verifiedAt.getTime(),
        row.disconnectedAt?.getTime() ?? 0,
      )),
      'native Ollama reverification time',
    );

    const updated = await transaction.nativeOllamaBackendBinding.updateMany({
      where: {
        id: row.id,
        generation,
        version: expectedVersion,
        state: row.state,
        bindingFingerprint: row.bindingFingerprint,
      },
      data: {
        state: NativeOllamaBackendBindingState.ACTIVE,
        observedAddress: peer.observedAddress,
        addressFamily: peer.addressFamily,
        observedAt: peer.observedAt,
        verifiedAt,
        disconnectedAt: null,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new NativeOllamaBindingError(
        'CAS_MISMATCH',
        'Native Ollama authority changed concurrently; refresh and retry',
      );
    }
    return publicSnapshot(await reRead(transaction, peer.purposeId, generation));
  });
}

export async function removeNativeOllamaBinding(
  input: RemoveNativeOllamaBindingInput,
  database: NativeOllamaBindingDatabase = defaultDatabase,
): Promise<PublicNativeOllamaBindingSnapshot> {
  const requestedPurpose = purposeId(input.purposeId);
  const generation = positiveInteger(input.generation, 'native Ollama binding generation');
  const expectedVersion = positiveInteger(
    input.expectedVersion,
    'native Ollama binding version',
  );
  const removedAt = validDate(
    input.removedAt ?? new Date(),
    'native Ollama removal time',
  );

  return serializable(database, async (transaction) => {
    const row = assertExpectedCas(
      await transaction.nativeOllamaBackendBinding.findUnique({
        where: {
          purposeId_generation: {
            purposeId: requestedPurpose,
            generation,
          },
        },
      }),
      generation,
      expectedVersion,
    );
    if (row.state === NativeOllamaBackendBindingState.REMOVED) {
      throw new NativeOllamaBindingError(
        'STATE_CONFLICT',
        'Native Ollama binding is already removed',
      );
    }
    const removalFloor = new Date(Math.max(
      row.activatedAt.getTime(),
      row.observedAt.getTime(),
      row.verifiedAt.getTime(),
      row.disconnectedAt?.getTime() ?? 0,
    ));
    dateAtOrAfter(removedAt, removalFloor, 'native Ollama removal time');

    const updated = await transaction.nativeOllamaBackendBinding.updateMany({
      where: {
        id: row.id,
        generation,
        version: expectedVersion,
        state: row.state,
        bindingFingerprint: row.bindingFingerprint,
      },
      data: {
        state: NativeOllamaBackendBindingState.REMOVED,
        removedAt,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new NativeOllamaBindingError(
        'CAS_MISMATCH',
        'Native Ollama authority changed concurrently; refresh and retry',
      );
    }

    // Explicit removal is the only transition that lifts the downgrade
    // fence. Restore the exact policy state captured by the first native
    // activation, including absence (which older releases interpret as the
    // default enabled policy).
    if (row.localEnabledSettingExisted) {
      await transaction.systemSetting.upsert({
        where: { key: OLLAMA_LOCAL_ENABLED_SETTING_KEY },
        update: {
          value: row.localEnabledBeforeActivation ? 'true' : 'false',
        },
        create: {
          key: OLLAMA_LOCAL_ENABLED_SETTING_KEY,
          value: row.localEnabledBeforeActivation ? 'true' : 'false',
        },
      });
    } else {
      await transaction.systemSetting.deleteMany({
        where: { key: OLLAMA_LOCAL_ENABLED_SETTING_KEY },
      });
    }

    // The Owner-only, exact-CAS native-removal request is also explicit
    // authorization to retire predecessor Remote GPU authority. Until this
    // transition legacy rows remain untouched for binary downgrade. Here they
    // become non-authoritative and lose decryptable secrets atomically with
    // restoring local policy, so neither the current nor an older runtime can
    // resurrect a Remote GPU the Owner just removed.
    await transaction.ollamaBackendBinding.updateMany({
      where: {
        purposeId: requestedPurpose,
        state: {
          in: [
            OllamaBackendBindingState.PENDING,
            OllamaBackendBindingState.ACTIVE,
            OllamaBackendBindingState.DISCONNECTED,
          ],
        },
      },
      data: {
        state: OllamaBackendBindingState.STALE,
        version: { increment: 1 },
        pairingSecretCiphertext: null,
        candidateExpiresAt: null,
        removedAt: null,
      },
    });
    return publicSnapshot(await reRead(transaction, requestedPurpose, generation));
  });
}
