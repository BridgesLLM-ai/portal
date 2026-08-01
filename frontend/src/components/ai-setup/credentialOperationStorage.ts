export type CredentialOperationKind = 'api-key' | 'setup-token';

const CREDENTIAL_OPERATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_OPERATION_RETIRED_PREFIX = 'retired:';

export class CredentialOperationStorageError extends Error {
  constructor(message = 'Portal cannot verify durable credential-operation storage. No credential was sent.') {
    super(message);
    this.name = 'CredentialOperationStorageError';
  }
}

export function createCredentialOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : ((random & 0x3) | 0x8);
    return value.toString(16);
  });
}

export function credentialOperationStorageKey(
  actorScope: string,
  kind: CredentialOperationKind,
  providerId: string,
): string {
  return `portal:credential-operation:${encodeURIComponent(actorScope)}:${kind}:${encodeURIComponent(providerId)}`;
}

function readStorageValue(storageKey: string): string | null {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    throw new CredentialOperationStorageError();
  }
}

export interface DurableCredentialOperation {
  operationId: string;
  storageKey: string;
}

function credentialOperationRetirementMarker(operationId: string): string {
  return `${CREDENTIAL_OPERATION_RETIRED_PREFIX}${operationId}`;
}

function credentialOperationRecoveryStorageKey(storageKey: string): string {
  return `${storageKey}:recovery`;
}

function readRetiredOperationId(value: string): string | null {
  if (!value.startsWith(CREDENTIAL_OPERATION_RETIRED_PREFIX)) return null;
  const operationId = value.slice(CREDENTIAL_OPERATION_RETIRED_PREFIX.length);
  return CREDENTIAL_OPERATION_UUID.test(operationId) ? operationId : null;
}

function persistAndVerifyOperationValue(storageKey: string, value: string): void {
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    throw new CredentialOperationStorageError();
  }
  if (readStorageValue(storageKey) !== value) {
    throw new CredentialOperationStorageError();
  }
}

/**
 * Claim the actor/provider's durable operation identity. The value is a bare
 * UUID: request fields, credentials, and credential hashes never reach web
 * storage. A malformed or unavailable record is ambiguous and therefore
 * blocks the write instead of silently replacing its identity.
 */
export function loadOrCreateCredentialOperation(
  actorScope: string,
  kind: CredentialOperationKind,
  providerId: string,
): DurableCredentialOperation {
  const storageKey = credentialOperationStorageKey(actorScope, kind, providerId);
  const recoveryStorageKey = credentialOperationRecoveryStorageKey(storageKey);
  const existing = readStorageValue(storageKey);
  const recoveryValue = readStorageValue(recoveryStorageKey);
  if (existing !== null) {
    if (!CREDENTIAL_OPERATION_UUID.test(existing)) {
      throw new CredentialOperationStorageError(
        'Portal found a malformed durable credential-operation record. No credential was sent.',
      );
    }
    if (recoveryValue !== null) {
      const retiredOperationId = readRetiredOperationId(recoveryValue);
      const recoveryIsCurrent = recoveryValue === existing;
      const recoveryIsPriorRetirement = retiredOperationId !== null && retiredOperationId !== existing;
      if (!recoveryIsCurrent && !recoveryIsPriorRetirement) {
        throw new CredentialOperationStorageError(
          'Portal found conflicting durable credential-operation records. No credential was sent.',
        );
      }
    }
    return { operationId: existing, storageKey };
  }

  if (recoveryValue !== null) {
    if (CREDENTIAL_OPERATION_UUID.test(recoveryValue)) {
      // Retirement became ambiguous after the primary UUID was removed. Put
      // the exact UUID back before permitting a retry, so the server can use
      // its receipt/fence rather than admitting a second write identity.
      persistAndVerifyOperationValue(storageKey, recoveryValue);
      return { operationId: recoveryValue, storageKey };
    }
    if (readRetiredOperationId(recoveryValue) === null) {
      throw new CredentialOperationStorageError(
        'Portal found a malformed credential-operation recovery record. No credential was sent.',
      );
    }
  }

  const operationId = createCredentialOperationId();
  persistAndVerifyOperationValue(storageKey, operationId);
  return { operationId, storageKey };
}

/** Verify exact ownership immediately before a credential-bearing request. */
export function verifyCredentialOperation(operation: DurableCredentialOperation): void {
  const recoveryStorageKey = credentialOperationRecoveryStorageKey(operation.storageKey);
  const current = readStorageValue(operation.storageKey);
  const recoveryValue = readStorageValue(recoveryStorageKey);
  if (current === operation.operationId) {
    const retiredOperationId = readRetiredOperationId(recoveryValue || '');
    const recoveryIsCompatible = recoveryValue === null
      || recoveryValue === operation.operationId
      || (retiredOperationId !== null && retiredOperationId !== operation.operationId);
    if (!recoveryIsCompatible) {
      throw new CredentialOperationStorageError();
    }
    return;
  }
  if (current === null && recoveryValue === operation.operationId) {
    persistAndVerifyOperationValue(operation.storageKey, operation.operationId);
    return;
  }
  throw new CredentialOperationStorageError();
}

/**
 * Retire only the exact UUID that the settled response belongs to.
 *
 * Copy the UUID to a recovery slot before removing the primary value. The
 * recovery slot is changed to `retired:<uuid>` only after primary absence is
 * verified. If any storage call becomes ambiguous, a reload either restores
 * the exact retry UUID or observes the exact retirement marker; it never sees
 * an unexplained empty slot and silently allocates a second write identity.
 */
export function retireCredentialOperation(operation: DurableCredentialOperation): void {
  const recoveryStorageKey = credentialOperationRecoveryStorageKey(operation.storageKey);
  const retirementMarker = credentialOperationRetirementMarker(operation.operationId);
  const current = readStorageValue(operation.storageKey);
  const recoveryValue = readStorageValue(recoveryStorageKey);
  if (current === null && recoveryValue === retirementMarker) return;
  if (current !== operation.operationId
    && !(current === null && recoveryValue === operation.operationId)) {
    throw new CredentialOperationStorageError(
      'Portal could not verify the settled credential-operation owner. Its durable record was retained for review.',
    );
  }

  if (recoveryValue !== operation.operationId) {
    try {
      window.localStorage.setItem(recoveryStorageKey, operation.operationId);
    } catch {
      throw new CredentialOperationStorageError(
        'Portal could not protect the settled credential-operation record before retirement. Its UUID was retained.',
      );
    }
    if (readStorageValue(recoveryStorageKey) !== operation.operationId) {
      throw new CredentialOperationStorageError(
        'Portal could not protect the settled credential-operation record before retirement. Its UUID was retained.',
      );
    }
  }

  if (current === operation.operationId) {
    try {
      window.localStorage.removeItem(operation.storageKey);
    } catch {
      throw new CredentialOperationStorageError(
        'Portal could not retire the settled credential-operation record. Its UUID was retained for safe recovery.',
      );
    }
    if (readStorageValue(operation.storageKey) !== null) {
      throw new CredentialOperationStorageError(
        'Portal could not retire the settled credential-operation record. Its UUID was retained for safe recovery.',
      );
    }
  }

  try {
    window.localStorage.setItem(recoveryStorageKey, retirementMarker);
  } catch {
    throw new CredentialOperationStorageError(
      'Portal could not verify final credential-operation retirement. Its UUID was retained for safe recovery.',
    );
  }
  if (readStorageValue(recoveryStorageKey) !== retirementMarker) {
    throw new CredentialOperationStorageError(
      'Portal could not verify final credential-operation retirement. Its UUID was retained for safe recovery.',
    );
  }
}

export function isAuthoritativeCredentialWriteRejection(error: unknown): boolean {
  const candidate = error as { response?: { data?: { operationDisposition?: unknown } } };
  return candidate?.response?.data?.operationDisposition === 'not_admitted';
}
