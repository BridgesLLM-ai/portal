import fs from 'fs';
import path from 'path';
import {
  advanceProjectDeploymentLifecycleRevision,
  claimProjectRuntimeRecoveryProof,
  completeProjectRuntimeRecovery,
  failProjectRuntimeRecovery,
  issueProjectRuntimeRecoveryProof,
  readProjectDeploymentLifecycleRevision,
  readProjectRuntimeRecoveryStatus,
  type ProjectRuntimeRecoveryReceipt,
  type ProjectRuntimeRecoveryReplayDatabase,
  type ProjectRuntimeRecoveryScope,
} from './projectRuntimeRecoveryReplay';

const OWNER = 'owner-recovery-test';
const PROJECT = 'project-recovery-test';
const APP = 'app-recovery-test';
const NOW = new Date('2026-08-09T08:00:00.000Z');
const SOURCE_DIGEST = 'a'.repeat(64);
const RECOVERY_MIGRATION_SQL = fs.readFileSync(path.resolve(
  __dirname,
  '../../prisma/migrations/20260809_project_runtime_recovery_replay/migration.sql',
), 'utf8');

interface MemoryState {
  identity: {
    id: string;
    workspaceOwnerId: string;
    generation: number;
    lifecycleStatus: string;
  } | null;
  app: {
    id: string;
    userId: string;
    projectIdentityId: string | null;
    processStatus?: string;
  } | null;
  lifecycle: Map<string, { projectIdentityId: string; revision: bigint; createdAt: Date; updatedAt: Date }>;
  operations: Map<string, ProjectRuntimeRecoveryReceipt>;
}

function matchesWhere(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === null || typeof value !== 'object' || typeof value === 'bigint' || value instanceof Date) {
      return row[key] === value;
    }
    return matchesWhere(row[key] as Record<string, any>, value as Record<string, any>);
  });
}

class MemoryDatabase implements ProjectRuntimeRecoveryReplayDatabase {
  state: MemoryState;
  transactionOptions: unknown[] = [];
  failClaimReceiptUpdate = false;
  failTerminalReceiptUpdate = false;

  constructor(app: MemoryState['app'] = null) {
    this.state = {
      identity: {
        id: PROJECT,
        workspaceOwnerId: OWNER,
        generation: 3,
        lifecycleStatus: 'ACTIVE',
      },
      app,
      lifecycle: new Map(),
      operations: new Map(),
    };
  }

  async $transaction<T>(
    operation: (transaction: any) => Promise<T>,
    options?: unknown,
  ): Promise<T> {
    this.transactionOptions.push(options);
    const draft = structuredClone(this.state);
    const transaction = {
      projectIdentity: {
        findUnique: jest.fn(async ({ where }: any) => (
          draft.identity?.id === where.id ? structuredClone(draft.identity) : null
        )),
      },
      app: {
        findUnique: jest.fn(async ({ where }: any) => (
          draft.app?.projectIdentityId === where.projectIdentityId
            ? structuredClone(draft.app)
            : null
        )),
      },
      projectDeploymentLifecycleRevision: {
        findUnique: jest.fn(async ({ where }: any) => (
          structuredClone(draft.lifecycle.get(where.projectIdentityId) || null)
        )),
        create: jest.fn(async ({ data }: any) => {
          if (draft.lifecycle.has(data.projectIdentityId)) {
            throw Object.assign(new Error('unique lifecycle'), {
              code: 'P2002',
              meta: { target: ['projectIdentityId'] },
            });
          }
          const row = {
            projectIdentityId: data.projectIdentityId,
            revision: BigInt(data.revision),
            createdAt: NOW,
            updatedAt: NOW,
          };
          draft.lifecycle.set(row.projectIdentityId, row);
          return structuredClone(row);
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = draft.lifecycle.get(where.projectIdentityId);
          if (!row || !matchesWhere(row, where)) return { count: 0 };
          if (data.revision?.increment != null) {
            row.revision += BigInt(data.revision.increment);
          }
          if (data.updatedAt instanceof Date) row.updatedAt = new Date(data.updatedAt);
          return { count: 1 };
        }),
      },
      projectRuntimeRecoveryOperation: {
        findUnique: jest.fn(async ({ where }: any) => (
          structuredClone(draft.operations.get(where.id) || null)
        )),
        create: jest.fn(async ({ data }: any) => {
          if (draft.operations.has(data.id)) throw new Error('duplicate operation');
          const row = structuredClone({ result: null, ...data }) as ProjectRuntimeRecoveryReceipt;
          draft.operations.set(row.id, row);
          return structuredClone(row);
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = draft.operations.get(where.id);
          if (!row || !matchesWhere(row as any, where)) return { count: 0 };
          if (this.failClaimReceiptUpdate && data.status === 'RUNNING') return { count: 0 };
          if (this.failTerminalReceiptUpdate && (data.status === 'COMPLETED' || data.status === 'FAILED')) {
            return { count: 0 };
          }
          Object.assign(row, structuredClone(data));
          return { count: 1 };
        }),
      },
    };
    const result = await operation(transaction);
    this.state = draft;
    return result;
  }
}

function deployScope(expectedAppId: string | null = null): ProjectRuntimeRecoveryScope {
  return {
    ownerUserId: OWNER,
    projectIdentityId: PROJECT,
    projectIdentityGeneration: 3,
    action: 'deploy',
    expectedAppId,
    expectedFullstack: true,
    sourceDigest: SOURCE_DIGEST,
  };
}

function restartScope(): ProjectRuntimeRecoveryScope {
  return {
    ...deployScope(APP),
    action: 'restart',
  };
}

async function issue(scope: ProjectRuntimeRecoveryScope, database: MemoryDatabase) {
  const expectedDeploymentRevision = database.state.lifecycle.get(PROJECT)?.revision || 0n;
  return issueProjectRuntimeRecoveryProof({
    ...scope,
    expectedDeploymentRevision,
    now: NOW,
    ttlMs: 5 * 60_000,
  }, database);
}

test('issues an initial deploy proof against revision zero with no App row', async () => {
  const database = new MemoryDatabase(null);

  const issued = await issue(deployScope(null), database);

  expect(issued).toMatchObject({
    operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    proof: expect.stringMatching(/^v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
    deploymentRevision: '0',
    expiresAt: new Date(NOW.getTime() + 5 * 60_000),
  });
  const receipt = database.state.operations.get(issued.operationId)!;
  expect(receipt).toMatchObject({
    projectIdentityId: PROJECT,
    ownerUserId: OWNER,
    projectIdentityGeneration: 3,
    action: 'deploy',
    expectedAppId: null,
    expectedDeploymentRevision: 0n,
    expectedFullstack: true,
    sourceDigest: SOURCE_DIGEST,
    status: 'ISSUED',
  });
  expect(receipt.proofSecretHash).toMatch(/^[0-9a-f]{64}$/);
  expect(receipt.proofSecretHash).not.toContain(issued.proof.split('.')[2]);
  expect(database.transactionOptions).toContainEqual({
    isolationLevel: 'Serializable',
    maxWait: 5_000,
    timeout: 15_000,
  });
});

test('only one concurrently issued lifecycle proof can claim the same revision', async () => {
  const database = new MemoryDatabase({ id: APP, userId: OWNER, projectIdentityId: PROJECT });
  const first = await issue(restartScope(), database);
  const second = await issue(restartScope(), database);

  await expect(claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: first.proof, now: NOW,
  }, database)).resolves.toEqual({
    kind: 'claimed',
    operationId: first.operationId,
    deploymentRevision: '1',
  });
  await expect(claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: second.proof, now: NOW,
  }, database)).rejects.toMatchObject({
    code: 'PROJECT_RUNTIME_RECOVERY_STALE',
    httpStatus: 409,
  });
  expect(database.state.lifecycle.get(PROJECT)?.revision).toBe(1n);
  expect(database.state.operations.get(second.operationId)?.status).toBe('ISSUED');
});

test('a competing normal user lifecycle mutation makes an issued proof stale', async () => {
  const database = new MemoryDatabase({ id: APP, userId: OWNER, projectIdentityId: PROJECT });
  const issued = await issue(restartScope(), database);

  await expect(advanceProjectDeploymentLifecycleRevision({
    ownerUserId: OWNER,
    projectIdentityId: PROJECT,
    projectIdentityGeneration: 3,
    expectedDeploymentRevision: '0',
    now: NOW,
  }, database)).resolves.toEqual({ deploymentRevision: '1' });

  await expect(claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: issued.proof, now: NOW,
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_STALE' });
});

test('refuses to rebase proof issuance after a competing lifecycle advance', async () => {
  const database = new MemoryDatabase({ id: APP, userId: OWNER, projectIdentityId: PROJECT });
  await expect(readProjectDeploymentLifecycleRevision({
    ownerUserId: OWNER,
    projectIdentityId: PROJECT,
    projectIdentityGeneration: 3,
  }, database)).resolves.toEqual({ deploymentRevision: '0' });
  await advanceProjectDeploymentLifecycleRevision({
    ownerUserId: OWNER,
    projectIdentityId: PROJECT,
    projectIdentityGeneration: 3,
    expectedDeploymentRevision: '0',
    now: NOW,
  }, database);

  await expect(issueProjectRuntimeRecoveryProof({
    ...restartScope(),
    expectedDeploymentRevision: '0',
    now: NOW,
  }, database)).rejects.toMatchObject({
    code: 'PROJECT_RUNTIME_RECOVERY_STALE',
    httpStatus: 409,
  });
  expect(database.state.operations.size).toBe(0);
});

test('automated process-status churn does not advance the deployment lifecycle revision', async () => {
  const database = new MemoryDatabase({
    id: APP,
    userId: OWNER,
    projectIdentityId: PROJECT,
    processStatus: 'stopped',
  });
  const issued = await issue(restartScope(), database);
  database.state.app!.processStatus = 'starting';
  database.state.app!.processStatus = 'running';

  await expect(readProjectRuntimeRecoveryStatus({
    ...restartScope(), proof: issued.proof, now: NOW,
  }, database)).resolves.toMatchObject({ kind: 'issued', deploymentRevision: '0' });
  expect(database.state.lifecycle.get(PROJECT)?.revision).toBe(0n);
});

test('a duplicate claim observes RUNNING and never authorizes a second launch', async () => {
  const database = new MemoryDatabase({ id: APP, userId: OWNER, projectIdentityId: PROJECT });
  const issued = await issue(restartScope(), database);

  const first = await claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: issued.proof, now: NOW,
  }, database);
  const duplicate = await claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: issued.proof, now: new Date(NOW.getTime() + 1_000),
  }, database);

  expect(first.kind).toBe('claimed');
  expect(duplicate).toEqual({
    kind: 'running',
    operationId: issued.operationId,
    deploymentRevision: '1',
  });
  expect(database.state.lifecycle.get(PROJECT)?.revision).toBe(1n);
});

test('a lost COMPLETED response replays the exact bounded durable result', async () => {
  const database = new MemoryDatabase({ id: APP, userId: OWNER, projectIdentityId: PROJECT });
  const issued = await issue(restartScope(), database);
  await claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: issued.proof, now: NOW,
  }, database);
  const response = {
    statusCode: 200,
    body: {
      success: true,
      action: 'restart',
      projectIdentityId: PROJECT,
      projectIdentityGeneration: 3,
      appId: APP,
      deploymentRevision: '1',
    },
  } as const;

  await expect(completeProjectRuntimeRecovery({
    ...restartScope(), proof: issued.proof, now: NOW, response,
  }, database)).resolves.toEqual(response);

  await expect(claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: issued.proof, now: new Date(NOW.getTime() + 2_000),
  }, database)).resolves.toEqual({
    kind: 'completed',
    operationId: issued.operationId,
    deploymentRevision: '1',
    result: response,
  });
  await expect(completeProjectRuntimeRecovery({
    ...restartScope(), proof: issued.proof, now: NOW, response,
  }, database)).resolves.toEqual(response);
});

test('RUNNING remains indeterminate across a crash and FAILED is terminal without raw errors', async () => {
  const database = new MemoryDatabase({ id: APP, userId: OWNER, projectIdentityId: PROJECT });
  const issued = await issue(restartScope(), database);
  await claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: issued.proof, now: NOW,
  }, database);

  await expect(readProjectRuntimeRecoveryStatus({
    ...restartScope(), proof: issued.proof, now: new Date(NOW.getTime() + 60_000),
  }, database)).resolves.toMatchObject({ kind: 'running' });

  await expect(failProjectRuntimeRecovery({
    ...restartScope(),
    proof: issued.proof,
    now: new Date(NOW.getTime() + 61_000),
    failureCode: 'RUNTIME_IMAGE_REPAIR_FAILED',
  }, database)).resolves.toMatchObject({
    kind: 'failed',
    failureCode: 'RUNTIME_IMAGE_REPAIR_FAILED',
  });
  await expect(claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: issued.proof, now: new Date(NOW.getTime() + 62_000),
  }, database)).resolves.toMatchObject({
    kind: 'failed',
    failureCode: 'RUNTIME_IMAGE_REPAIR_FAILED',
  });
  expect(database.state.operations.get(issued.operationId)).toMatchObject({
    status: 'FAILED',
    result: null,
    failureCode: 'RUNTIME_IMAGE_REPAIR_FAILED',
  });
});

test('owner, Project generation, App, source, and tampered proof mismatches fail closed', async () => {
  const database = new MemoryDatabase({ id: APP, userId: OWNER, projectIdentityId: PROJECT });
  const issued = await issue(restartScope(), database);
  const tampered = `${issued.proof.slice(0, -1)}${issued.proof.endsWith('A') ? 'B' : 'A'}`;

  await expect(claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: tampered, now: NOW,
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_PROOF_INVALID' });
  await expect(claimProjectRuntimeRecoveryProof({
    ...restartScope(), ownerUserId: 'another-owner', proof: issued.proof, now: NOW,
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_PROOF_MISMATCH' });
  await expect(claimProjectRuntimeRecoveryProof({
    ...restartScope(), projectIdentityGeneration: 4, proof: issued.proof, now: NOW,
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_PROOF_MISMATCH' });
  await expect(claimProjectRuntimeRecoveryProof({
    ...restartScope(), sourceDigest: 'b'.repeat(64), proof: issued.proof, now: NOW,
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_PROOF_MISMATCH' });

  database.state.app = { id: 'replacement-app', userId: OWNER, projectIdentityId: PROJECT };
  await expect(claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: issued.proof, now: NOW,
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_STALE' });
});

test('a null-App deploy proof cannot be claimed through another Project with the same digest', async () => {
  const database = new MemoryDatabase(null);
  const issued = await issue(deployScope(null), database);

  await expect(claimProjectRuntimeRecoveryProof({
    ...deployScope(null),
    projectIdentityId: 'different-project',
    proof: issued.proof,
    now: NOW,
  }, database)).rejects.toMatchObject({
    code: 'PROJECT_RUNTIME_RECOVERY_PROOF_MISMATCH',
    httpStatus: 409,
  });
  expect(database.state.lifecycle.get(PROJECT)?.revision).toBe(0n);
  expect(database.state.operations.get(issued.operationId)?.status).toBe('ISSUED');
});

test('completion binds the durable result to the expected or newly created Project App', async () => {
  const restartDatabase = new MemoryDatabase({
    id: APP,
    userId: OWNER,
    projectIdentityId: PROJECT,
  });
  const restart = await issue(restartScope(), restartDatabase);
  await claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: restart.proof, now: NOW,
  }, restartDatabase);
  await expect(completeProjectRuntimeRecovery({
    ...restartScope(),
    proof: restart.proof,
    now: NOW,
    response: {
      statusCode: 200,
      body: {
        success: true,
        action: 'restart',
        projectIdentityId: PROJECT,
        projectIdentityGeneration: 3,
        appId: 'foreign-app',
        deploymentRevision: '1',
      },
    },
  }, restartDatabase)).rejects.toMatchObject({
    code: 'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID',
  });

  const deployDatabase = new MemoryDatabase(null);
  const deploy = await issue(deployScope(null), deployDatabase);
  await claimProjectRuntimeRecoveryProof({
    ...deployScope(null), proof: deploy.proof, now: NOW,
  }, deployDatabase);
  deployDatabase.state.app = {
    id: 'created-app',
    userId: OWNER,
    projectIdentityId: PROJECT,
  };
  await expect(completeProjectRuntimeRecovery({
    ...deployScope(null),
    proof: deploy.proof,
    now: NOW,
    response: {
      statusCode: 201,
      body: {
        success: true,
        action: 'deploy',
        projectIdentityId: PROJECT,
        projectIdentityGeneration: 3,
        appId: 'foreign-app',
        deploymentRevision: '1',
      },
    },
  }, deployDatabase)).rejects.toMatchObject({
    code: 'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID',
  });
  expect(deployDatabase.state.operations.get(deploy.operationId)?.status).toBe('RUNNING');

  await expect(completeProjectRuntimeRecovery({
    ...deployScope(null),
    proof: deploy.proof,
    now: NOW,
    response: {
      statusCode: 201,
      body: {
        success: true,
        action: 'deploy',
        projectIdentityId: PROJECT,
        projectIdentityGeneration: 3,
        appId: 'created-app',
        deploymentRevision: '1',
      },
    },
  }, deployDatabase)).resolves.toMatchObject({
    body: { appId: 'created-app', deploymentRevision: '1' },
  });
});

test('claim rollback leaves both revision and receipt ISSUED when the receipt CAS loses', async () => {
  const database = new MemoryDatabase({ id: APP, userId: OWNER, projectIdentityId: PROJECT });
  const issued = await issue(restartScope(), database);
  database.failClaimReceiptUpdate = true;

  await expect(claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: issued.proof, now: NOW,
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_STALE' });

  expect(database.state.lifecycle.get(PROJECT)?.revision).toBe(0n);
  expect(database.state.operations.get(issued.operationId)).toMatchObject({
    status: 'ISSUED',
    claimedDeploymentRevision: null,
    claimedAt: null,
  });
});

test('failed terminal persistence leaves the receipt safely RUNNING', async () => {
  const database = new MemoryDatabase({ id: APP, userId: OWNER, projectIdentityId: PROJECT });
  const issued = await issue(restartScope(), database);
  await claimProjectRuntimeRecoveryProof({
    ...restartScope(), proof: issued.proof, now: NOW,
  }, database);
  database.failTerminalReceiptUpdate = true;

  await expect(failProjectRuntimeRecovery({
    ...restartScope(), proof: issued.proof, now: NOW, failureCode: 'SAFE_FAILURE',
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_STATE_INVALID' });
  expect(database.state.operations.get(issued.operationId)).toMatchObject({
    status: 'RUNNING',
    failureCode: null,
    failedAt: null,
  });
});

test('rejects expired ISSUED proofs and non-allowlisted or prototype-polluted replay responses', async () => {
  const database = new MemoryDatabase({ id: APP, userId: OWNER, projectIdentityId: PROJECT });
  const issued = await issue(restartScope(), database);
  await expect(claimProjectRuntimeRecoveryProof({
    ...restartScope(),
    proof: issued.proof,
    now: new Date(NOW.getTime() + 5 * 60_000 + 1),
  }, database)).rejects.toMatchObject({
    code: 'PROJECT_RUNTIME_RECOVERY_PROOF_EXPIRED',
    httpStatus: 410,
  });

  const second = await issue(restartScope(), database);
  await claimProjectRuntimeRecoveryProof({ ...restartScope(), proof: second.proof, now: NOW }, database);
  await expect(completeProjectRuntimeRecovery({
    ...restartScope(),
    proof: second.proof,
    now: NOW,
    response: { statusCode: 200, body: { accessToken: 'do-not-store' } } as any,
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID' });
  const pollutedBody: Record<string, unknown> = {
    success: true,
    action: 'restart',
    projectIdentityId: PROJECT,
    projectIdentityGeneration: 3,
    appId: APP,
    deploymentRevision: '1',
  };
  Object.defineProperty(pollutedBody, '__proto__', {
    enumerable: true,
    value: { polluted: true },
  });
  await expect(completeProjectRuntimeRecovery({
    ...restartScope(),
    proof: second.proof,
    now: NOW,
    response: { statusCode: 200, body: pollutedBody } as any,
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID' });
  expect(database.state.operations.get(second.operationId)?.status).toBe('RUNNING');
});

test('strictly rejects incoherent process and source attestations', async () => {
  const database = new MemoryDatabase({ id: APP, userId: OWNER, projectIdentityId: PROJECT });
  await expect(issueProjectRuntimeRecoveryProof({
    ...restartScope(), expectedFullstack: null, expectedDeploymentRevision: '0', now: NOW,
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT' });
  await expect(issueProjectRuntimeRecoveryProof({
    ...deployScope(APP), expectedFullstack: null, sourceDigest: SOURCE_DIGEST, expectedDeploymentRevision: '0', now: NOW,
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT' });
  await expect(issueProjectRuntimeRecoveryProof({
    ...deployScope(APP), expectedFullstack: true, sourceDigest: null, expectedDeploymentRevision: '0', now: NOW,
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT' });
  await expect(issueProjectRuntimeRecoveryProof({
    ...deployScope(APP), expectedFullstack: false, sourceDigest: null, expectedDeploymentRevision: '0', now: NOW,
  }, database)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT' });
});

test('database claim trigger uses wall-clock expiry so a direct update cannot backdate claimedAt', () => {
  expect(RECOVERY_MIGRATION_SQL).toContain(
    'IF clock_timestamp() >= NEW."expiresAt" THEN',
  );
  expect(RECOVERY_MIGRATION_SQL).toContain(
    "RAISE EXCEPTION 'Project runtime recovery operation expired before claim';",
  );
});
