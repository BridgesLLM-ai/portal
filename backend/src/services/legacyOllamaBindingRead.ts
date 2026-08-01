import crypto from 'crypto';
import {
  OllamaBackendAddressFamily,
  OllamaBackendBindingState,
  type OllamaBackendBinding,
} from '@prisma/client';
import { prisma } from '../config/database';
import {
  decryptSecret,
  digestAuthToken,
  isEncryptedSecret,
} from '../utils/authSecrets';

const LEGACY_PURPOSE_ID = 'PRIMARY' as const;
const LEGACY_HELPER_PORT = 11434 as const;
const LEGACY_PROTOCOL_VERSION = 2 as const;
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 4_096;

type LegacyBindingDelegate = Readonly<{
  findMany(
    args: Readonly<Record<string, unknown>>,
  ): Promise<readonly Pick<OllamaBackendBinding, 'state'>[]>;
  findFirst(
    args: Readonly<Record<string, unknown>>,
  ): Promise<OllamaBackendBinding | null>;
  findUnique(
    args: Readonly<Record<string, unknown>>,
  ): Promise<OllamaBackendBinding | null>;
  updateMany(
    args: Readonly<Record<string, unknown>>,
  ): Promise<{ count: number }>;
}>;

export type LegacyOllamaBindingReadDatabase = Readonly<{
  ollamaBackendBinding: LegacyBindingDelegate;
}>;

export type LegacyOllamaBindingPresence = Readonly<{
  hasAuthority: boolean;
  hasCandidate: boolean;
}>;

export interface LegacyOllamaBindingSnapshot {
  readonly id: string;
  readonly purposeId: typeof LEGACY_PURPOSE_ID;
  readonly generation: number;
  readonly version: number;
  readonly state: OllamaBackendBindingState;
  readonly tailnetName: string;
  readonly stableNodeId: string;
  readonly nodePublicKey: string;
  readonly address: string;
  readonly addressFamily: OllamaBackendAddressFamily;
  readonly helperPort: typeof LEGACY_HELPER_PORT;
  readonly protocolVersion: typeof LEGACY_PROTOCOL_VERSION;
  readonly helperId: string;
  readonly bindingFingerprint: string;
  readonly selectedModel: string | null;
  readonly selectedModelDigest: string | null;
  readonly hasPairingSecret: boolean;
  readonly attestationVerified: boolean;
  readonly protocolVerified: boolean;
  readonly observedAt: Date;
  readonly verifiedAt: Date | null;
  readonly activatedAt: Date | null;
}

export interface LegacyOllamaBindingView {
  readonly purposeId: typeof LEGACY_PURPOSE_ID;
  readonly authority: LegacyOllamaBindingSnapshot | null;
  readonly candidate: LegacyOllamaBindingSnapshot | null;
}

export type LegacyOllamaBindingErrorCode =
  | 'BINDING_CHANGED'
  | 'SECRET_UNAVAILABLE';

export class LegacyOllamaBindingError extends Error {
  constructor(
    public readonly code: LegacyOllamaBindingErrorCode,
  ) {
    super(code === 'BINDING_CHANGED'
      ? 'The legacy Ollama authority changed concurrently.'
      : 'The legacy Ollama pairing secret is unavailable.');
    this.name = 'LegacyOllamaBindingError';
  }
}

const defaultDatabase =
  prisma as unknown as LegacyOllamaBindingReadDatabase;

function publicSnapshot(
  row: OllamaBackendBinding,
): LegacyOllamaBindingSnapshot {
  if (
    row.purposeId !== LEGACY_PURPOSE_ID
    || row.helperPort !== LEGACY_HELPER_PORT
    || row.protocolVersion !== LEGACY_PROTOCOL_VERSION
  ) {
    throw new LegacyOllamaBindingError('BINDING_CHANGED');
  }
  return Object.freeze({
    id: row.id,
    purposeId: LEGACY_PURPOSE_ID,
    generation: row.generation,
    version: row.version,
    state: row.state,
    tailnetName: row.tailnetName,
    stableNodeId: row.stableNodeId,
    nodePublicKey: row.nodePublicKey,
    address: row.address,
    addressFamily: row.addressFamily,
    helperPort: LEGACY_HELPER_PORT,
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    helperId: row.helperId,
    bindingFingerprint: row.bindingFingerprint,
    selectedModel: row.selectedModel,
    selectedModelDigest: row.selectedModelDigest,
    hasPairingSecret: Boolean(row.pairingSecretCiphertext),
    attestationVerified: Boolean(row.attestationProofDigest),
    protocolVerified: Boolean(row.protocolProofDigest),
    observedAt: row.observedAt,
    verifiedAt: row.verifiedAt,
    activatedAt: row.activatedAt,
  });
}

/**
 * Compatibility-only existence check used by native onboarding/retirement UI.
 * It intentionally projects only state and never returns helper secrets.
 */
export async function readLegacyOllamaBindingPresence(
  database: LegacyOllamaBindingReadDatabase = defaultDatabase,
): Promise<LegacyOllamaBindingPresence> {
  const rows = await database.ollamaBackendBinding.findMany({
    where: {
      purposeId: LEGACY_PURPOSE_ID,
      state: {
        in: [
          OllamaBackendBindingState.ACTIVE,
          OllamaBackendBindingState.DISCONNECTED,
          OllamaBackendBindingState.PENDING,
        ],
      },
    },
    select: { state: true },
  });
  return Object.freeze({
    hasAuthority: rows.some((row) => (
      row.state === OllamaBackendBindingState.ACTIVE
      || row.state === OllamaBackendBindingState.DISCONNECTED
    )),
    hasCandidate: rows.some(
      (row) => row.state === OllamaBackendBindingState.PENDING,
    ),
  });
}

/**
 * Read-only runtime compatibility for an authority created by 4.0 beta's
 * helper transport. This cannot create, activate, reverify, or remove legacy
 * rows; it exists solely to prevent an upgrade outage while the Owner moves to
 * native Tailscale Serve.
 */
export async function readLegacyOllamaBindingView(
  database: LegacyOllamaBindingReadDatabase = defaultDatabase,
): Promise<LegacyOllamaBindingView> {
  const [authority, candidate] = await Promise.all([
    database.ollamaBackendBinding.findFirst({
      where: {
        purposeId: LEGACY_PURPOSE_ID,
        state: {
          in: [
            OllamaBackendBindingState.ACTIVE,
            OllamaBackendBindingState.DISCONNECTED,
          ],
        },
      },
      orderBy: { generation: 'desc' },
    }),
    database.ollamaBackendBinding.findFirst({
      where: {
        purposeId: LEGACY_PURPOSE_ID,
        state: OllamaBackendBindingState.PENDING,
      },
      orderBy: { generation: 'desc' },
    }),
  ]);
  return Object.freeze({
    purposeId: LEGACY_PURPOSE_ID,
    authority: authority ? publicSnapshot(authority) : null,
    candidate: candidate ? publicSnapshot(candidate) : null,
  });
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  try {
    return leftBuffer.byteLength === rightBuffer.byteLength
      && crypto.timingSafeEqual(leftBuffer, rightBuffer);
  } finally {
    leftBuffer.fill(0);
    rightBuffer.fill(0);
  }
}

function decodePairingSecret(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
  if (
    decoded.byteLength < MIN_SECRET_BYTES
    || decoded.byteLength > MAX_SECRET_BYTES
    || decoded.toString('base64url') !== value
  ) {
    decoded.fill(0);
    return null;
  }
  return decoded;
}

/**
 * Decrypt one exact legacy secret for the duration of a single request. The
 * plaintext Buffer is authenticated against the stored keyed digest and
 * zeroed on every callback outcome.
 */
export async function withLegacyOllamaPairingSecret<T>(
  input: Readonly<{
    generation: number;
    expectedVersion: number;
    allowedStates?: readonly OllamaBackendBindingState[];
  }>,
  callback: (secret: Buffer) => T | Promise<T>,
  database: LegacyOllamaBindingReadDatabase = defaultDatabase,
): Promise<T> {
  const row = await database.ollamaBackendBinding.findUnique({
    where: {
      purposeId_generation: {
        purposeId: LEGACY_PURPOSE_ID,
        generation: input.generation,
      },
    },
  });
  const allowedStates = input.allowedStates
    ?? [OllamaBackendBindingState.ACTIVE];
  if (
    !row
    || row.generation !== input.generation
    || row.version !== input.expectedVersion
    || !allowedStates.includes(row.state)
    || !row.pairingSecretCiphertext
    || !isEncryptedSecret(row.pairingSecretCiphertext)
  ) {
    throw new LegacyOllamaBindingError('SECRET_UNAVAILABLE');
  }

  let encodedSecret = '';
  let secret: Buffer | null = null;
  try {
    let actualDigest: string;
    try {
      encodedSecret = decryptSecret(row.pairingSecretCiphertext);
      secret = decodePairingSecret(encodedSecret);
      actualDigest = digestAuthToken(
        'ollama-backend-pairing',
        encodedSecret,
      );
    } catch {
      throw new LegacyOllamaBindingError('SECRET_UNAVAILABLE');
    }
    encodedSecret = '';
    if (
      !secret
      || !safeStringEqual(actualDigest, row.pairingSecretDigest)
    ) {
      throw new LegacyOllamaBindingError('SECRET_UNAVAILABLE');
    }
    return await callback(secret);
  } finally {
    encodedSecret = '';
    secret?.fill(0);
  }
}

/**
 * Persist only the compatibility authority's fail-closed transition. Native
 * mutation APIs remain the sole supported management plane.
 */
export async function markLegacyOllamaBindingDisconnected(
  input: Readonly<{
    generation: number;
    expectedVersion: number;
    observedAt: Date;
  }>,
  database: LegacyOllamaBindingReadDatabase = defaultDatabase,
): Promise<LegacyOllamaBindingSnapshot> {
  const row = await database.ollamaBackendBinding.findUnique({
    where: {
      purposeId_generation: {
        purposeId: LEGACY_PURPOSE_ID,
        generation: input.generation,
      },
    },
  });
  if (
    !row
    || row.generation !== input.generation
    || row.version !== input.expectedVersion
    || row.state !== OllamaBackendBindingState.ACTIVE
  ) {
    throw new LegacyOllamaBindingError('BINDING_CHANGED');
  }
  const update = await database.ollamaBackendBinding.updateMany({
    where: {
      id: row.id,
      purposeId: LEGACY_PURPOSE_ID,
      generation: input.generation,
      version: input.expectedVersion,
      state: OllamaBackendBindingState.ACTIVE,
      bindingFingerprint: row.bindingFingerprint,
    },
    data: {
      state: OllamaBackendBindingState.DISCONNECTED,
      version: { increment: 1 },
      observedAt: input.observedAt,
    },
  });
  if (update.count !== 1) {
    throw new LegacyOllamaBindingError('BINDING_CHANGED');
  }
  return publicSnapshot({
    ...row,
    state: OllamaBackendBindingState.DISCONNECTED,
    version: row.version + 1,
    observedAt: input.observedAt,
  });
}
