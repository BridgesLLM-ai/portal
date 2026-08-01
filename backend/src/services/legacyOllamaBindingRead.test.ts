import {
  OllamaBackendAddressFamily,
  OllamaBackendBindingState,
  type OllamaBackendBinding,
} from '@prisma/client';
import fs from 'fs';
import path from 'path';

jest.mock('../config/env', () => ({
  config: {
    jwtSecret: 'test-jwt-secret-that-is-at-least-thirty-two-bytes',
  },
}));

import {
  digestAuthToken,
  encryptPlaintextSecret,
} from '../utils/authSecrets';
import {
  readLegacyOllamaBindingPresence,
  withLegacyOllamaPairingSecret,
  type LegacyOllamaBindingReadDatabase,
} from './legacyOllamaBindingRead';

function database(
  states: readonly OllamaBackendBindingState[],
): LegacyOllamaBindingReadDatabase {
  return {
    ollamaBackendBinding: {
      findMany: jest.fn(async () => states.map((state) => ({ state }))),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
  };
}

function legacyRow(
  secret: string,
): OllamaBackendBinding {
  const now = new Date('2026-07-27T00:00:00.000Z');
  return {
    id: 'legacy-binding-1',
    purposeId: 'PRIMARY',
    generation: 5,
    version: 8,
    state: OllamaBackendBindingState.ACTIVE,
    tailnetName: 'example.ts.net',
    stableNodeId: 'stable_node_legacy',
    nodePublicKey: `nodekey:${'a'.repeat(64)}`,
    address: '100.64.0.8',
    addressFamily: OllamaBackendAddressFamily.IPV4,
    helperPort: 11434,
    protocolVersion: 2,
    helperId: 'helper_existing_runtime',
    pairingSecretCiphertext: encryptPlaintextSecret(secret),
    pairingSecretDigest: digestAuthToken(
      'ollama-backend-pairing',
      secret,
    ),
    pairingSecretFingerprint: digestAuthToken(
      'ollama-backend-pairing-fingerprint',
      secret,
    ),
    bindingFingerprint: 'legacy-fingerprint',
    selectedModel: 'qwen3:8b',
    selectedModelDigest: `sha256:${'b'.repeat(64)}`,
    attestationProofDigest: 'attested',
    protocolProofDigest: 'verified',
    configuredByUserId: null,
    observedAt: now,
    candidateExpiresAt: null,
    verifiedAt: now,
    activatedAt: now,
    createdAt: now,
    updatedAt: now,
    removedAt: null,
  };
}

describe('legacy Ollama binding presence reader', () => {
  test.each([
    [[], false, false],
    [[OllamaBackendBindingState.ACTIVE], true, false],
    [[OllamaBackendBindingState.DISCONNECTED], true, false],
    [[OllamaBackendBindingState.PENDING], false, true],
    [[
      OllamaBackendBindingState.ACTIVE,
      OllamaBackendBindingState.PENDING,
    ], true, true],
  ] as const)(
    'maps %j to authority=%s candidate=%s',
    async (states, hasAuthority, hasCandidate) => {
      await expect(readLegacyOllamaBindingPresence(
        database(states),
      )).resolves.toEqual({ hasAuthority, hasCandidate });
    },
  );

  test('presence query projects only state while compatibility code cannot create a helper', async () => {
    const db = database([OllamaBackendBindingState.ACTIVE]);
    await readLegacyOllamaBindingPresence(db);

    expect(db.ollamaBackendBinding.findMany).toHaveBeenCalledWith({
      where: {
        purposeId: 'PRIMARY',
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

    const source = fs.readFileSync(
      path.resolve(__dirname, 'legacyOllamaBindingRead.ts'),
      'utf8',
    );
    expect(source).toContain('withLegacyOllamaPairingSecret');
    expect(source).not.toMatch(
      /createOrReplaceOllamaBackendBinding|activateOllamaBackendBinding|encryptPlaintextSecret/u,
    );
  });

  test('authenticates one exact existing secret and zeroes the callback buffer', async () => {
    const encodedSecret = Buffer.alloc(32, 9).toString('base64url');
    const row = legacyRow(encodedSecret);
    const db = database([]);
    (db.ollamaBackendBinding.findUnique as jest.Mock)
      .mockResolvedValue(row);
    let observedSecret: Buffer | null = null;

    await expect(withLegacyOllamaPairingSecret({
      generation: row.generation,
      expectedVersion: row.version,
    }, async (secret) => {
      observedSecret = secret;
      expect(secret.toString('base64url')).toBe(encodedSecret);
      return 'ok';
    }, db)).resolves.toBe('ok');

    expect(observedSecret).not.toBeNull();
    expect(observedSecret!.every((byte) => byte === 0)).toBe(true);
  });

  test('preserves callback failures while still zeroing the secret buffer', async () => {
    const encodedSecret = Buffer.alloc(32, 4).toString('base64url');
    const row = legacyRow(encodedSecret);
    const db = database([]);
    (db.ollamaBackendBinding.findUnique as jest.Mock)
      .mockResolvedValue(row);
    const transportFailure = new Error('typed transport failure');
    let observedSecret: Buffer | null = null;

    await expect(withLegacyOllamaPairingSecret({
      generation: row.generation,
      expectedVersion: row.version,
    }, async (secret) => {
      observedSecret = secret;
      throw transportFailure;
    }, db)).rejects.toBe(transportFailure);

    expect(observedSecret).not.toBeNull();
    expect(observedSecret!.every((byte) => byte === 0)).toBe(true);
  });
});
