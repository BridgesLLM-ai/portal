// @vitest-environment jsdom
import '../../test/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialOperationStorageError,
  loadOrCreateCredentialOperation,
  retireCredentialOperation,
  verifyCredentialOperation,
} from './credentialOperationStorage';

describe('durable credential-operation retirement', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('records exact retirement before allowing a fresh operation identity', () => {
    const operation = loadOrCreateCredentialOperation('user:owner', 'api-key', 'openai');
    const recoveryStorageKey = `${operation.storageKey}:recovery`;

    retireCredentialOperation(operation);

    expect(window.localStorage.getItem(operation.storageKey)).toBeNull();
    expect(window.localStorage.getItem(recoveryStorageKey)).toBe(`retired:${operation.operationId}`);
    expect(() => verifyCredentialOperation(operation)).toThrow(CredentialOperationStorageError);

    const next = loadOrCreateCredentialOperation('user:owner', 'api-key', 'openai');
    expect(next.operationId).not.toBe(operation.operationId);
    expect(window.localStorage.getItem(operation.storageKey)).toBe(next.operationId);
  });

  it('recovers the same UUID when primary absence becomes unreadable after removal', () => {
    const operation = loadOrCreateCredentialOperation('user:owner', 'api-key', 'openai');
    const recoveryStorageKey = `${operation.storageKey}:recovery`;
    const originalGetItem = Storage.prototype.getItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    let primaryRemoved = false;

    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function removeItem(
      this: Storage,
      key: string,
    ) {
      originalRemoveItem.call(this, key);
      if (this === window.localStorage && key === operation.storageKey) primaryRemoved = true;
    });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function getItem(
      this: Storage,
      key: string,
    ) {
      if (this === window.localStorage && key === operation.storageKey && primaryRemoved) {
        throw new Error('post-remove storage read unavailable');
      }
      return originalGetItem.call(this, key);
    });

    expect(() => retireCredentialOperation(operation)).toThrow(CredentialOperationStorageError);
    getItem.mockRestore();

    expect(window.localStorage.getItem(operation.storageKey)).toBeNull();
    expect(window.localStorage.getItem(recoveryStorageKey)).toBe(operation.operationId);

    const recovered = loadOrCreateCredentialOperation('user:owner', 'api-key', 'openai');
    expect(recovered.operationId).toBe(operation.operationId);
    expect(window.localStorage.getItem(operation.storageKey)).toBe(operation.operationId);
    expect(() => verifyCredentialOperation(recovered)).not.toThrow();
  });

  it('retains the UUID in an exact marker when final retirement readback is unavailable', () => {
    const operation = loadOrCreateCredentialOperation('user:owner', 'setup-token', 'anthropic');
    const recoveryStorageKey = `${operation.storageKey}:recovery`;
    const retirementMarker = `retired:${operation.operationId}`;
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    let retirementWritten = false;

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(
      this: Storage,
      key: string,
      value: string,
    ) {
      originalSetItem.call(this, key, value);
      if (this === window.localStorage && key === recoveryStorageKey && value === retirementMarker) {
        retirementWritten = true;
      }
    });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function getItem(
      this: Storage,
      key: string,
    ) {
      if (this === window.localStorage && key === recoveryStorageKey && retirementWritten) {
        throw new Error('final retirement readback unavailable');
      }
      return originalGetItem.call(this, key);
    });

    expect(() => retireCredentialOperation(operation)).toThrow(CredentialOperationStorageError);
    getItem.mockRestore();

    expect(window.localStorage.getItem(operation.storageKey)).toBeNull();
    expect(window.localStorage.getItem(recoveryStorageKey)).toBe(retirementMarker);
    expect(() => retireCredentialOperation(operation)).not.toThrow();
  });
});
