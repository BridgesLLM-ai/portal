import fs from 'node:fs';
import path from 'node:path';
import {
  NativeOllamaBackendBindingState,
  OllamaBackendAddressFamily,
  OllamaBackendBindingState,
  type NativeOllamaBackendBinding,
} from '@prisma/client';
import {
  NATIVE_OLLAMA_SERVE_PORT,
  acknowledgeNativeOllamaLegacyHelperRetirement,
  clearNativeOllamaModel,
  createOrReplaceNativeOllamaBinding,
  markNativeOllamaBindingDisconnected,
  readNativeOllamaBinding,
  removeNativeOllamaBinding,
  reverifyNativeOllamaBinding,
  selectNativeOllamaModel,
  updateNativeOllamaBindingObservation,
  type CreateOrReplaceNativeOllamaBindingInput,
  type NativeOllamaBindingDatabase,
  type ReverifyNativeOllamaBindingInput,
  type UpdateNativeOllamaBindingObservationInput,
} from './nativeOllamaBinding';

const GRANT_ACKNOWLEDGED_AT = new Date('2026-07-26T17:59:00.000Z');
const OBSERVED_AT = new Date('2026-07-26T18:00:00.000Z');
const VERIFIED_AT = new Date('2026-07-26T18:00:05.000Z');
const ACTIVATED_AT = new Date('2026-07-26T18:00:06.000Z');
const MODEL_DIGEST_ONE = `sha256:${'a'.repeat(64)}`;
const MODEL_DIGEST_TWO = `sha256:${'b'.repeat(64)}`;
const GRANT_PEER_ATTESTATION_FINGERPRINT = 'c'.repeat(64);
const GRANT_TEMPLATE_HASH = `sha256:${'d'.repeat(64)}`;

type Query = Record<string, any>;
type LegacyRow = {
  purposeId: string;
  state: OllamaBackendBindingState;
  version: number;
  pairingSecretCiphertext: string | null;
  candidateExpiresAt: Date | null;
  removedAt: Date | null;
};

function cloneRow(row: NativeOllamaBackendBinding): NativeOllamaBackendBinding {
  return {
    ...row,
    grantAcknowledgedAt: new Date(row.grantAcknowledgedAt),
    legacyHelperRetirementAcknowledgedAt:
      row.legacyHelperRetirementAcknowledgedAt
        ? new Date(row.legacyHelperRetirementAcknowledgedAt)
        : null,
    observedAt: new Date(row.observedAt),
    verifiedAt: new Date(row.verifiedAt),
    activatedAt: new Date(row.activatedAt),
    disconnectedAt: row.disconnectedAt ? new Date(row.disconnectedAt) : null,
    removedAt: row.removedAt ? new Date(row.removedAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

class MemoryNativeBindingDatabase implements NativeOllamaBindingDatabase {
  readonly rows: NativeOllamaBackendBinding[] = [];
  readonly legacyRows: LegacyRow[] = [];
  readonly systemSettings = new Map<string, string>();
  readonly transactionOptions: Array<Record<string, unknown> | undefined> = [];
  failNextCreate = false;

  private matches(row: NativeOllamaBackendBinding, where: Query = {}): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.purposeId !== undefined && row.purposeId !== where.purposeId) return false;
    if (where.generation !== undefined && row.generation !== where.generation) return false;
    if (where.version !== undefined && row.version !== where.version) return false;
    if (
      where.legacyHelperRetirementAcknowledgedAt !== undefined
      && row.legacyHelperRetirementAcknowledgedAt
        !== where.legacyHelperRetirementAcknowledgedAt
    ) return false;
    if (
      where.legacyHelperRetirementAcknowledgedBy !== undefined
      && row.legacyHelperRetirementAcknowledgedBy
        !== where.legacyHelperRetirementAcknowledgedBy
    ) return false;
    if (
      where.legacyHelperRetirementEvidence !== undefined
      && row.legacyHelperRetirementEvidence
        !== where.legacyHelperRetirementEvidence
    ) return false;
    if (
      where.bindingFingerprint !== undefined
      && row.bindingFingerprint !== where.bindingFingerprint
    ) return false;
    if (where.state !== undefined) {
      if (typeof where.state === 'string' && row.state !== where.state) return false;
      if (where.state?.in && !where.state.in.includes(row.state)) return false;
    }
    return true;
  }

  private async findFirst(
    rows: NativeOllamaBackendBinding[],
    args: Query,
  ): Promise<NativeOllamaBackendBinding | null> {
    const matches = rows.filter((row) => this.matches(row, args.where));
    if (args.orderBy?.generation === 'desc') {
      matches.sort((left, right) => right.generation - left.generation);
    }
    return matches[0] ?? null;
  }

  private async findUnique(
    rows: NativeOllamaBackendBinding[],
    args: Query,
  ): Promise<NativeOllamaBackendBinding | null> {
    const compound = args.where?.purposeId_generation;
    if (compound) {
      return rows.find((row) => (
        row.purposeId === compound.purposeId
        && row.generation === compound.generation
      )) ?? null;
    }
    return rows.find((row) => row.id === args.where?.id) ?? null;
  }

  private async create(
    rows: NativeOllamaBackendBinding[],
    args: Query,
  ): Promise<NativeOllamaBackendBinding> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('injected native binding insert failure');
    }
    const now = new Date(
      (args.data.activatedAt as Date | undefined)?.getTime()
      ?? ACTIVATED_AT.getTime(),
    );
    const row = {
      id: `native-binding-${rows.length + 1}`,
      purposeId: 'PRIMARY',
      generation: 1,
      version: 1,
      state: NativeOllamaBackendBindingState.ACTIVE,
      selectedModel: null,
      selectedModelDigest: null,
      legacyHelperRetirementAcknowledgedAt: null,
      legacyHelperRetirementAcknowledgedBy: null,
      legacyHelperRetirementEvidence: null,
      configuredByUserId: null,
      disconnectedAt: null,
      removedAt: null,
      createdAt: now,
      updatedAt: now,
      ...args.data,
    } as NativeOllamaBackendBinding;
    rows.push(row);
    return row;
  }

  private async updateMany(
    rows: NativeOllamaBackendBinding[],
    args: Query,
  ): Promise<{ count: number }> {
    const matched = rows.filter((row) => this.matches(row, args.where));
    for (const row of matched) {
      for (const [key, value] of Object.entries(args.data ?? {})) {
        if (
          key === 'version'
          && value
          && typeof value === 'object'
          && 'increment' in value
        ) {
          row.version += Number((value as { increment: unknown }).increment);
        } else {
          (row as unknown as Record<string, unknown>)[key] = value;
        }
      }
      row.updatedAt = new Date(row.updatedAt.getTime() + 1);
    }
    return { count: matched.length };
  }

  private async updateLegacyMany(
    rows: LegacyRow[],
    args: Query,
  ): Promise<{ count: number }> {
    const states = args.where?.state?.in as
      | readonly OllamaBackendBindingState[]
      | undefined;
    const matched = rows.filter((row) => (
      row.purposeId === args.where?.purposeId
      && (!states || states.includes(row.state))
    ));
    for (const row of matched) {
      for (const [key, value] of Object.entries(args.data ?? {})) {
        if (
          key === 'version'
          && value
          && typeof value === 'object'
          && 'increment' in value
        ) {
          row.version += Number((value as { increment: unknown }).increment);
        } else {
          (row as unknown as Record<string, unknown>)[key] = value;
        }
      }
    }
    return { count: matched.length };
  }

  readonly nativeOllamaBackendBinding = {
    findFirst: (args: Query) => this.findFirst(this.rows, args),
    findUnique: (args: Query) => this.findUnique(this.rows, args),
  };

  async $transaction<T>(
    operation: (transaction: any) => Promise<T>,
    options?: Record<string, unknown>,
  ): Promise<T> {
    this.transactionOptions.push(options);
    const workingRows = this.rows.map(cloneRow);
    const workingLegacyRows = this.legacyRows.map((row) => ({
      ...row,
      candidateExpiresAt: row.candidateExpiresAt
        ? new Date(row.candidateExpiresAt)
        : null,
      removedAt: row.removedAt ? new Date(row.removedAt) : null,
    }));
    const workingSettings = new Map(this.systemSettings);
    const result = await operation({
      nativeOllamaBackendBinding: {
        findFirst: (args: Query) => this.findFirst(workingRows, args),
        findUnique: (args: Query) => this.findUnique(workingRows, args),
        create: (args: Query) => this.create(workingRows, args),
        updateMany: (args: Query) => this.updateMany(workingRows, args),
      },
      ollamaBackendBinding: {
        updateMany: (args: Query) => (
          this.updateLegacyMany(workingLegacyRows, args)
        ),
      },
      systemSetting: {
        findUnique: async (args: Query) => {
          const key = String(args.where?.key || '');
          return workingSettings.has(key)
            ? { key, value: workingSettings.get(key)! }
            : null;
        },
        upsert: async (args: Query) => {
          const key = String(args.where?.key || args.create?.key || '');
          const value = String(
            workingSettings.has(key)
              ? args.update?.value
              : args.create?.value,
          );
          workingSettings.set(key, value);
          return { key, value };
        },
        deleteMany: async (args: Query) => {
          const key = String(args.where?.key || '');
          const deleted = workingSettings.delete(key);
          return { count: deleted ? 1 : 0 };
        },
      },
    });
    this.rows.splice(0, this.rows.length, ...workingRows);
    this.legacyRows.splice(
      0,
      this.legacyRows.length,
      ...workingLegacyRows,
    );
    this.systemSettings.clear();
    for (const [key, value] of workingSettings) {
      this.systemSettings.set(key, value);
    }
    return result;
  }
}

function resolveAsPreNativeRuntime(
  database: MemoryNativeBindingDatabase,
): 'LEGACY_REMOTE' | 'LOCAL' | 'LOCAL_DISABLED' {
  if (database.legacyRows.some((row) => (
    row.state === OllamaBackendBindingState.ACTIVE
    || row.state === OllamaBackendBindingState.DISCONNECTED
  ))) {
    return 'LEGACY_REMOTE';
  }
  return database.systemSettings.get('ollama.localEnabled') === 'false'
    ? 'LOCAL_DISABLED'
    : 'LOCAL';
}

function createInput(
  overrides: Partial<CreateOrReplaceNativeOllamaBindingInput> = {},
): CreateOrReplaceNativeOllamaBindingInput {
  return {
    expectedAuthorityGeneration: null,
    expectedAuthorityVersion: null,
    tailnetName: 'example-tailnet.ts.net',
    stableNodeId: 'stable_node_0001',
    nodePublicKey: `nodekey:${'1'.repeat(64)}`,
    observedAddress: '100.72.18.9',
    addressFamily: OllamaBackendAddressFamily.IPV4,
    servePort: NATIVE_OLLAMA_SERVE_PORT,
    selectedModel: null,
    selectedModelDigest: null,
    grantPeerAttestationFingerprint: GRANT_PEER_ATTESTATION_FINGERPRINT,
    grantTemplateHash: GRANT_TEMPLATE_HASH,
    grantAcknowledgedAt: GRANT_ACKNOWLEDGED_AT,
    grantAcknowledgedBy: 'owner-user-id',
    configuredByUserId: 'owner-user-id',
    observedAt: OBSERVED_AT,
    verifiedAt: VERIFIED_AT,
    activatedAt: ACTIVATED_AT,
    ...overrides,
  };
}

function observationInput(
  binding: {
    generation: number;
    version: number;
    tailnetName: string;
    stableNodeId: string;
    nodePublicKey: string;
  },
  overrides: Partial<UpdateNativeOllamaBindingObservationInput> = {},
): UpdateNativeOllamaBindingObservationInput {
  return {
    generation: binding.generation,
    expectedVersion: binding.version,
    tailnetName: binding.tailnetName,
    stableNodeId: binding.stableNodeId,
    nodePublicKey: binding.nodePublicKey,
    observedAddress: '100.72.18.10',
    addressFamily: OllamaBackendAddressFamily.IPV4,
    servePort: NATIVE_OLLAMA_SERVE_PORT,
    observedAt: new Date('2026-07-26T18:01:00.000Z'),
    ...overrides,
  };
}

function reverifyInput(
  binding: {
    generation: number;
    version: number;
    tailnetName: string;
    stableNodeId: string;
    nodePublicKey: string;
  },
  overrides: Partial<ReverifyNativeOllamaBindingInput> = {},
): ReverifyNativeOllamaBindingInput {
  return {
    generation: binding.generation,
    expectedVersion: binding.version,
    tailnetName: binding.tailnetName,
    stableNodeId: binding.stableNodeId,
    nodePublicKey: binding.nodePublicKey,
    observedAddress: '100.72.18.11',
    addressFamily: OllamaBackendAddressFamily.IPV4,
    servePort: NATIVE_OLLAMA_SERVE_PORT,
    observedAt: new Date('2026-07-26T18:03:00.000Z'),
    verifiedAt: new Date('2026-07-26T18:03:05.000Z'),
    ...overrides,
  };
}

test('schema and forward migration are additive, constrained, and keep legacy storage untouched', () => {
  const schema = fs.readFileSync(
    path.join(__dirname, '../../prisma/schema.prisma'),
    'utf8',
  );
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      '../../prisma/migrations/20260726_native_ollama_backend_binding/migration.sql',
    ),
    'utf8',
  );

  expect(schema).toContain('model NativeOllamaBackendBinding');
  expect(schema).toContain('enum NativeOllamaBackendBindingState');
  expect(schema).toMatch(/servePort\s+Int\s+@default\(11435\)/);
  expect(schema).toMatch(/grantPeerAttestationFingerprint\s+String/);
  expect(schema).toMatch(/grantTemplateHash\s+String/);
  expect(schema).toMatch(/localEnabledBeforeActivation\s+Boolean/);
  expect(schema).toMatch(/localEnabledSettingExisted\s+Boolean/);
  expect(schema).toMatch(
    /legacyHelperRetirementAcknowledgedAt\s+DateTime\?/,
  );
  expect(schema).toMatch(
    /legacyHelperRetirementEvidence\s+String\?/,
  );
  expect(schema).toMatch(/model OllamaBackendBinding[\s\S]*helperPort\s+Int\s+@default\(11434\)/);
  expect(migration).toContain('CHECK ("servePort" = 11435)');
  expect(migration).toContain('NativeOllamaBackendBinding_one_authority_purpose_key');
  expect(migration).toContain('NativeOllamaBackendBinding_tailnet_address_check');
  expect(migration).toContain('NativeOllamaBackendBinding_grant_activation_order_check');
  expect(migration).toContain('NativeOllamaBackendBinding_grant_snapshot_check');
  expect(migration).toContain(
    'NativeOllamaBackendBinding_legacy_retirement_check',
  );
  expect(migration).toContain(
    '"legacyHelperRetirementAcknowledgedBy" IS NOT NULL',
  );
  expect(migration).toContain(
    '"legacyHelperRetirementEvidence" IS NOT NULL',
  );
  expect(migration).toContain('NativeOllamaBackendBinding_state_timestamps_check');
  expect(migration).toContain('"localEnabledBeforeActivation" BOOLEAN NOT NULL');
  expect(migration).toContain('"localEnabledSettingExisted" BOOLEAN NOT NULL');
  expect(migration).not.toMatch(/ALTER TABLE "OllamaBackendBinding"/);
});

test('publishes a probed native authority directly on fixed Serve port 11435', async () => {
  const database = new MemoryNativeBindingDatabase();
  const authority = await createOrReplaceNativeOllamaBinding(createInput(), database);

  expect(authority).toMatchObject({
    purposeId: 'PRIMARY',
    generation: 1,
    version: 1,
    state: NativeOllamaBackendBindingState.ACTIVE,
    servePort: 11435,
    selectedModel: null,
    selectedModelDigest: null,
    grantPeerAttestationFingerprint:
      GRANT_PEER_ATTESTATION_FINGERPRINT,
    grantTemplateHash: GRANT_TEMPLATE_HASH,
    grantAcknowledgedBy: 'owner-user-id',
    legacyHelperRetirementAcknowledgedAt: null,
    legacyHelperRetirementEvidence: null,
    disconnectedAt: null,
    removedAt: null,
  });
  expect(authority.bindingFingerprint).toMatch(
    /^native-ollama-binding:v1:sha256:[a-f0-9]{64}$/,
  );
  expect(database.rows[0]).toMatchObject({
    localEnabledBeforeActivation: true,
    localEnabledSettingExisted: false,
  });
  expect(database.systemSettings.get('ollama.localEnabled')).toBe('false');
  expect(resolveAsPreNativeRuntime(database)).toBe('LOCAL_DISABLED');
  expect(database.transactionOptions).toEqual([{ isolationLevel: 'Serializable' }]);

  const view = await readNativeOllamaBinding('PRIMARY', database);
  expect(view.authority).toMatchObject({
    generation: 1,
    bindingFingerprint: authority.bindingFingerprint,
  });
});

test('fingerprint pins node identity while excluding mutable address and model selection', async () => {
  const database = new MemoryNativeBindingDatabase();
  const created = await createOrReplaceNativeOllamaBinding(createInput({
    selectedModel: 'qwen3:8b',
    selectedModelDigest: MODEL_DIGEST_ONE,
  }), database);

  const observed = await updateNativeOllamaBindingObservation(
    observationInput(created, {
      observedAddress: 'fd7a:115c:a1e0::1234',
      addressFamily: OllamaBackendAddressFamily.IPV6,
    }),
    database,
  );
  expect(observed.version).toBe(2);
  expect(observed.observedAddress).toBe('fd7a:115c:a1e0::1234');
  expect(observed.bindingFingerprint).toBe(created.bindingFingerprint);

  const selected = await selectNativeOllamaModel({
    generation: observed.generation,
    expectedVersion: observed.version,
    selectedModel: 'llama3.2:latest',
    selectedModelDigest: MODEL_DIGEST_TWO,
    verifiedAt: new Date('2026-07-26T18:02:00.000Z'),
  }, database);
  expect(selected).toMatchObject({
    version: 3,
    selectedModel: 'llama3.2:latest',
    selectedModelDigest: MODEL_DIGEST_TWO,
    bindingFingerprint: created.bindingFingerprint,
  });

  const cleared = await clearNativeOllamaModel({
    generation: selected.generation,
    expectedVersion: selected.version,
  }, database);
  expect(cleared).toMatchObject({
    version: 4,
    selectedModel: null,
    selectedModelDigest: null,
    bindingFingerprint: created.bindingFingerprint,
  });
});

test('observation update requires the exact pinned stable node and NodeKey', async () => {
  const database = new MemoryNativeBindingDatabase();
  const authority = await createOrReplaceNativeOllamaBinding(createInput(), database);

  await expect(updateNativeOllamaBindingObservation(
    observationInput(authority, {
      nodePublicKey: `nodekey:${'2'.repeat(64)}`,
    }),
    database,
  )).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  expect(database.rows[0]).toMatchObject({
    version: 1,
    observedAddress: '100.72.18.9',
  });
});

test('native promotion preserves legacy authority rows and forces downgrade local policy off', async () => {
  const database = new MemoryNativeBindingDatabase();
  const candidateExpiresAt = new Date('2026-07-26T18:20:00.000Z');
  database.legacyRows.push({
    purposeId: 'PRIMARY',
    state: OllamaBackendBindingState.ACTIVE,
    version: 4,
    pairingSecretCiphertext: 'portal-secret:v1:legacy-active',
    candidateExpiresAt: null,
    removedAt: null,
  }, {
    purposeId: 'PRIMARY',
    state: OllamaBackendBindingState.DISCONNECTED,
    version: 2,
    pairingSecretCiphertext: 'portal-secret:v1:legacy-disconnected',
    candidateExpiresAt: null,
    removedAt: null,
  }, {
    purposeId: 'PRIMARY',
    state: OllamaBackendBindingState.PENDING,
    version: 1,
    pairingSecretCiphertext: 'portal-secret:v1:legacy-candidate',
    candidateExpiresAt,
    removedAt: null,
  }, {
    purposeId: 'PRIMARY',
    state: OllamaBackendBindingState.STALE,
    version: 8,
    pairingSecretCiphertext: null,
    candidateExpiresAt: null,
    removedAt: null,
  });

  await createOrReplaceNativeOllamaBinding(createInput(), database);

  expect(database.legacyRows).toEqual([
    expect.objectContaining({
      state: OllamaBackendBindingState.ACTIVE,
      version: 4,
      pairingSecretCiphertext: 'portal-secret:v1:legacy-active',
    }),
    expect.objectContaining({
      state: OllamaBackendBindingState.DISCONNECTED,
      version: 2,
      pairingSecretCiphertext: 'portal-secret:v1:legacy-disconnected',
    }),
    expect.objectContaining({
      state: OllamaBackendBindingState.PENDING,
      version: 1,
      pairingSecretCiphertext: 'portal-secret:v1:legacy-candidate',
      candidateExpiresAt,
    }),
    expect.objectContaining({
      state: OllamaBackendBindingState.STALE,
      version: 8,
    }),
  ]);
  expect(database.systemSettings.get('ollama.localEnabled')).toBe('false');
  expect(resolveAsPreNativeRuntime(database)).toBe('LEGACY_REMOTE');
});

test('durably acknowledges exact legacy helper retirement without changing rollback-safe rows', async () => {
  const database = new MemoryNativeBindingDatabase();
  database.legacyRows.push({
    purposeId: 'PRIMARY',
    state: OllamaBackendBindingState.ACTIVE,
    version: 4,
    pairingSecretCiphertext: 'portal-secret:v1:legacy-active',
    candidateExpiresAt: null,
    removedAt: null,
  });
  const active = await createOrReplaceNativeOllamaBinding(
    createInput(),
    database,
  );
  const acknowledgedAt = new Date('2026-07-26T18:03:00.000Z');

  const acknowledged =
    await acknowledgeNativeOllamaLegacyHelperRetirement({
      generation: active.generation,
      expectedVersion: active.version,
      acknowledgedBy: 'owner-user-id',
      acknowledgedAt,
    }, database);

  expect(acknowledged).toMatchObject({
    generation: active.generation,
    version: active.version + 1,
    state: NativeOllamaBackendBindingState.ACTIVE,
    legacyHelperRetirementAcknowledgedAt: acknowledgedAt,
    legacyHelperRetirementAcknowledgedBy: 'owner-user-id',
  });
  expect(acknowledged.legacyHelperRetirementEvidence).toMatch(
    /^legacy-helper-retirement:v1:sha256:[a-f0-9]{64}$/,
  );
  expect(database.legacyRows).toEqual([expect.objectContaining({
    state: OllamaBackendBindingState.ACTIVE,
    version: 4,
    pairingSecretCiphertext: 'portal-secret:v1:legacy-active',
  })]);
  expect(database.systemSettings.get('ollama.localEnabled')).toBe('false');

  await expect(acknowledgeNativeOllamaLegacyHelperRetirement({
    generation: acknowledged.generation,
    expectedVersion: acknowledged.version,
    acknowledgedBy: 'owner-user-id',
    acknowledgedAt: new Date('2026-07-26T18:04:00.000Z'),
  }, database)).resolves.toMatchObject({
    version: acknowledged.version,
    legacyHelperRetirementEvidence:
      acknowledged.legacyHelperRetirementEvidence,
  });
});

test('refuses legacy helper retirement acknowledgement while native authority is disconnected', async () => {
  const database = new MemoryNativeBindingDatabase();
  const active = await createOrReplaceNativeOllamaBinding(
    createInput(),
    database,
  );
  const disconnected = await markNativeOllamaBindingDisconnected({
    generation: active.generation,
    expectedVersion: active.version,
    disconnectedAt: new Date('2026-07-26T18:03:00.000Z'),
  }, database);

  await expect(acknowledgeNativeOllamaLegacyHelperRetirement({
    generation: disconnected.generation,
    expectedVersion: disconnected.version,
    acknowledgedBy: 'owner-user-id',
    acknowledgedAt: new Date('2026-07-26T18:04:00.000Z'),
  }, database)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  expect(database.rows[0].legacyHelperRetirementAcknowledgedAt).toBeNull();
});

test('downgrade uses a preserved helper when available and cannot fall through local when it is disconnected', async () => {
  const database = new MemoryNativeBindingDatabase();
  database.legacyRows.push({
    purposeId: 'PRIMARY',
    state: OllamaBackendBindingState.ACTIVE,
    version: 4,
    pairingSecretCiphertext: 'portal-secret:v1:legacy-active',
    candidateExpiresAt: null,
    removedAt: null,
  });

  await createOrReplaceNativeOllamaBinding(createInput(), database);

  // A pre-native binary still selects the usable preserved helper.
  expect(resolveAsPreNativeRuntime(database)).toBe('LEGACY_REMOTE');
  expect(database.systemSettings.get('ollama.localEnabled')).toBe('false');

  // If that helper later becomes unavailable, the legacy DISCONNECTED row
  // remains authoritative. The older binary fails there and local remains
  // disabled instead of silently changing execution hosts.
  database.legacyRows[0].state = OllamaBackendBindingState.DISCONNECTED;
  expect(resolveAsPreNativeRuntime(database)).toBe('LEGACY_REMOTE');
  expect(database.systemSettings.get('ollama.localEnabled')).toBe('false');
});

test('failed first native insert rolls back the downgrade fence and preserves legacy authority', async () => {
  const database = new MemoryNativeBindingDatabase();
  database.legacyRows.push({
    purposeId: 'PRIMARY',
    state: OllamaBackendBindingState.ACTIVE,
    version: 4,
    pairingSecretCiphertext: 'portal-secret:v1:legacy-active',
    candidateExpiresAt: null,
    removedAt: null,
  });
  database.systemSettings.set('ollama.localEnabled', 'true');
  database.failNextCreate = true;

  await expect(createOrReplaceNativeOllamaBinding(
    createInput(),
    database,
  )).rejects.toThrow('injected native binding insert failure');

  expect(database.rows).toHaveLength(0);
  expect(database.legacyRows).toEqual([expect.objectContaining({
    state: OllamaBackendBindingState.ACTIVE,
    version: 4,
    pairingSecretCiphertext: 'portal-secret:v1:legacy-active',
  })]);
  expect(database.systemSettings.get('ollama.localEnabled')).toBe('true');
  expect(resolveAsPreNativeRuntime(database)).toBe('LEGACY_REMOTE');
});

test('fresh native activation makes an older binary fail closed and explicit removal restores absence', async () => {
  const database = new MemoryNativeBindingDatabase();
  expect(resolveAsPreNativeRuntime(database)).toBe('LOCAL');

  const active = await createOrReplaceNativeOllamaBinding(createInput(), database);

  expect(resolveAsPreNativeRuntime(database)).toBe('LOCAL_DISABLED');
  expect(database.systemSettings.get('ollama.localEnabled')).toBe('false');

  await removeNativeOllamaBinding({
    generation: active.generation,
    expectedVersion: active.version,
    removedAt: new Date('2026-07-26T18:04:00.000Z'),
  }, database);

  expect(database.systemSettings.has('ollama.localEnabled')).toBe(false);
  expect(resolveAsPreNativeRuntime(database)).toBe('LOCAL');
});

test('explicit native removal atomically retires preserved legacy authority before restoring local', async () => {
  const database = new MemoryNativeBindingDatabase();
  database.legacyRows.push({
    purposeId: 'PRIMARY',
    state: OllamaBackendBindingState.ACTIVE,
    version: 4,
    pairingSecretCiphertext: 'portal-secret:v1:legacy-active',
    candidateExpiresAt: null,
    removedAt: null,
  });
  const active = await createOrReplaceNativeOllamaBinding(createInput(), database);

  expect(resolveAsPreNativeRuntime(database)).toBe('LEGACY_REMOTE');
  expect(database.legacyRows[0]).toMatchObject({
    state: OllamaBackendBindingState.ACTIVE,
    pairingSecretCiphertext: 'portal-secret:v1:legacy-active',
  });

  await removeNativeOllamaBinding({
    generation: active.generation,
    expectedVersion: active.version,
    removedAt: new Date('2026-07-26T18:04:00.000Z'),
  }, database);

  expect(database.legacyRows[0]).toMatchObject({
    state: OllamaBackendBindingState.STALE,
    version: 5,
    pairingSecretCiphertext: null,
    candidateExpiresAt: null,
  });
  expect(database.systemSettings.has('ollama.localEnabled')).toBe(false);
  expect(resolveAsPreNativeRuntime(database)).toBe('LOCAL');
});

test('native replacement inherits the original explicit local policy and removal restores it', async () => {
  const database = new MemoryNativeBindingDatabase();
  database.systemSettings.set('ollama.localEnabled', 'true');
  const first = await createOrReplaceNativeOllamaBinding(createInput(), database);

  const replacement = await createOrReplaceNativeOllamaBinding(createInput({
    expectedAuthorityGeneration: first.generation,
    expectedAuthorityVersion: first.version,
    stableNodeId: 'stable_node_0002',
    nodePublicKey: `nodekey:${'2'.repeat(64)}`,
    observedAddress: '100.90.10.11',
    observedAt: new Date('2026-07-26T19:00:00.000Z'),
    verifiedAt: new Date('2026-07-26T19:00:05.000Z'),
    activatedAt: new Date('2026-07-26T19:00:06.000Z'),
  }), database);

  expect(database.rows[1]).toMatchObject({
    localEnabledBeforeActivation: true,
    localEnabledSettingExisted: true,
  });
  expect(database.systemSettings.get('ollama.localEnabled')).toBe('false');

  await removeNativeOllamaBinding({
    generation: replacement.generation,
    expectedVersion: replacement.version,
    removedAt: new Date('2026-07-26T19:01:00.000Z'),
  }, database);

  expect(database.systemSettings.get('ollama.localEnabled')).toBe('true');
  expect(resolveAsPreNativeRuntime(database)).toBe('LOCAL');
});

test('replacement atomically retires the prior native authority and advances generation', async () => {
  const database = new MemoryNativeBindingDatabase();
  const first = await createOrReplaceNativeOllamaBinding(createInput(), database);
  const replacementActivatedAt = new Date('2026-07-26T19:00:06.000Z');

  const replacement = await createOrReplaceNativeOllamaBinding(createInput({
    expectedAuthorityGeneration: first.generation,
    expectedAuthorityVersion: first.version,
    stableNodeId: 'stable_node_0002',
    nodePublicKey: `nodekey:${'2'.repeat(64)}`,
    observedAddress: '100.90.10.11',
    observedAt: new Date('2026-07-26T19:00:00.000Z'),
    verifiedAt: new Date('2026-07-26T19:00:05.000Z'),
    activatedAt: replacementActivatedAt,
  }), database);

  expect(replacement).toMatchObject({
    generation: 2,
    version: 1,
    state: NativeOllamaBackendBindingState.ACTIVE,
    stableNodeId: 'stable_node_0002',
  });
  expect(database.rows[0]).toMatchObject({
    generation: 1,
    version: 2,
    state: NativeOllamaBackendBindingState.REMOVED,
    removedAt: replacementActivatedAt,
  });
  expect(database.rows.filter((row) => (
    row.state === NativeOllamaBackendBindingState.ACTIVE
    || row.state === NativeOllamaBackendBindingState.DISCONNECTED
  ))).toHaveLength(1);
});

test('failed replacement insert rolls back retirement and preserves the old authority', async () => {
  const database = new MemoryNativeBindingDatabase();
  const first = await createOrReplaceNativeOllamaBinding(createInput(), database);
  database.failNextCreate = true;

  await expect(createOrReplaceNativeOllamaBinding(createInput({
    expectedAuthorityGeneration: first.generation,
    expectedAuthorityVersion: first.version,
    stableNodeId: 'stable_node_0002',
    nodePublicKey: `nodekey:${'2'.repeat(64)}`,
    observedAddress: '100.90.10.11',
    observedAt: new Date('2026-07-26T19:00:00.000Z'),
    verifiedAt: new Date('2026-07-26T19:00:05.000Z'),
    activatedAt: new Date('2026-07-26T19:00:06.000Z'),
  }), database)).rejects.toThrow('injected native binding insert failure');

  expect(database.rows).toHaveLength(1);
  expect(database.rows[0]).toMatchObject({
    generation: 1,
    version: 1,
    state: NativeOllamaBackendBindingState.ACTIVE,
    removedAt: null,
  });
});

test('stale replacement CAS leaves the current authority unchanged', async () => {
  const database = new MemoryNativeBindingDatabase();
  const first = await createOrReplaceNativeOllamaBinding(createInput(), database);

  await expect(createOrReplaceNativeOllamaBinding(createInput({
    expectedAuthorityGeneration: first.generation,
    expectedAuthorityVersion: first.version + 1,
    observedAt: new Date('2026-07-26T19:00:00.000Z'),
    verifiedAt: new Date('2026-07-26T19:00:05.000Z'),
    activatedAt: new Date('2026-07-26T19:00:06.000Z'),
  }), database)).rejects.toMatchObject({ code: 'CAS_MISMATCH' });

  expect(database.rows[0]).toMatchObject({
    version: 1,
    state: NativeOllamaBackendBindingState.ACTIVE,
  });
});

test('disconnect and reverify preserve generation and accept only fresh matching identity', async () => {
  const database = new MemoryNativeBindingDatabase();
  const active = await createOrReplaceNativeOllamaBinding(createInput(), database);
  const disconnectedAt = new Date('2026-07-26T18:02:00.000Z');
  const disconnected = await markNativeOllamaBindingDisconnected({
    generation: active.generation,
    expectedVersion: active.version,
    disconnectedAt,
  }, database);

  expect(disconnected).toMatchObject({
    generation: 1,
    version: 2,
    state: NativeOllamaBackendBindingState.DISCONNECTED,
    disconnectedAt,
  });

  await expect(reverifyNativeOllamaBinding(
    reverifyInput(disconnected, {
      stableNodeId: 'stable_node_9999',
    }),
    database,
  )).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });

  const reverified = await reverifyNativeOllamaBinding(
    reverifyInput(disconnected),
    database,
  );
  expect(reverified).toMatchObject({
    generation: 1,
    version: 3,
    state: NativeOllamaBackendBindingState.ACTIVE,
    observedAddress: '100.72.18.11',
    disconnectedAt: null,
    activatedAt: ACTIVATED_AT,
    bindingFingerprint: active.bindingFingerprint,
  });
});

test('active verify-now persists a fresh address and verification without changing state', async () => {
  const database = new MemoryNativeBindingDatabase();
  const active = await createOrReplaceNativeOllamaBinding(createInput(), database);

  const verified = await reverifyNativeOllamaBinding(
    reverifyInput(active),
    database,
  );

  expect(verified).toMatchObject({
    generation: 1,
    version: 2,
    state: NativeOllamaBackendBindingState.ACTIVE,
    observedAddress: '100.72.18.11',
    observedAt: new Date('2026-07-26T18:03:00.000Z'),
    verifiedAt: new Date('2026-07-26T18:03:05.000Z'),
    disconnectedAt: null,
    activatedAt: ACTIVATED_AT,
    bindingFingerprint: active.bindingFingerprint,
  });
});

test('remove is CAS guarded and clears the readable authority', async () => {
  const database = new MemoryNativeBindingDatabase();
  const active = await createOrReplaceNativeOllamaBinding(createInput(), database);
  const removedAt = new Date('2026-07-26T18:04:00.000Z');
  const removed = await removeNativeOllamaBinding({
    generation: active.generation,
    expectedVersion: active.version,
    removedAt,
  }, database);

  expect(removed).toMatchObject({
    version: 2,
    state: NativeOllamaBackendBindingState.REMOVED,
    removedAt,
  });
  await expect(removeNativeOllamaBinding({
    generation: removed.generation,
    expectedVersion: removed.version,
    removedAt: new Date('2026-07-26T18:05:00.000Z'),
  }, database)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  await expect(readNativeOllamaBinding('PRIMARY', database)).resolves.toEqual({
    purposeId: 'PRIMARY',
    authority: null,
  });
});

test('rejects legacy port, unsafe identity/Grant snapshots, late acknowledgement, and model half-pairs', async () => {
  const database = new MemoryNativeBindingDatabase();

  await expect(createOrReplaceNativeOllamaBinding(createInput({
    servePort: 11434,
  }), database)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(createOrReplaceNativeOllamaBinding(createInput({
    observedAddress: '192.168.1.8',
  }), database)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(createOrReplaceNativeOllamaBinding(createInput({
    grantPeerAttestationFingerprint: 'not-a-fingerprint',
  }), database)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(createOrReplaceNativeOllamaBinding(createInput({
    grantTemplateHash: 'sha256:not-a-hash',
  }), database)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(createOrReplaceNativeOllamaBinding(createInput({
    grantAcknowledgedAt: new Date('2026-07-26T18:01:00.000Z'),
  }), database)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(createOrReplaceNativeOllamaBinding(createInput({
    selectedModel: 'qwen3:8b',
    selectedModelDigest: null,
  }), database)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(database.rows).toHaveLength(0);
});
