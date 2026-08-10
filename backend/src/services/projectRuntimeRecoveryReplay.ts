import crypto from 'crypto';
import { prisma } from '../config/database';

export const PROJECT_RUNTIME_RECOVERY_DEFAULT_TTL_MS = 30 * 60_000;
export const PROJECT_RUNTIME_RECOVERY_MIN_TTL_MS = 60_000;
export const PROJECT_RUNTIME_RECOVERY_MAX_TTL_MS = 30 * 60_000;
export const PROJECT_RUNTIME_RECOVERY_MAX_RESPONSE_BYTES = 24 * 1024;

const MAX_SERIALIZABLE_ATTEMPTS = 4;
const MAX_IDENTIFIER_BYTES = 255;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROOF_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const FORBIDDEN_STRING_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type ProjectRuntimeRecoveryAction = 'deploy' | 'start' | 'restart';
export type ProjectRuntimeRecoveryPersistedStatus = 'ISSUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export interface ProjectRuntimeRecoveryResponse {
  statusCode: 200 | 201;
  body: {
    success: true;
    action: ProjectRuntimeRecoveryAction;
    projectIdentityId: string;
    projectIdentityGeneration: number;
    appId: string;
    deploymentRevision: string;
  };
}

export interface ProjectRuntimeRecoveryScope {
  ownerUserId: string;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  action: ProjectRuntimeRecoveryAction;
  expectedAppId: string | null;
  expectedFullstack?: boolean | null;
  sourceDigest?: string | null;
}

export interface IssueProjectRuntimeRecoveryProofInput extends ProjectRuntimeRecoveryScope {
  expectedDeploymentRevision: string | number | bigint;
  ttlMs?: number;
  now?: Date;
}

export interface ProjectRuntimeRecoveryProofInput extends ProjectRuntimeRecoveryScope {
  proof: string;
  now?: Date;
}

export interface ProjectRuntimeRecoveryReceipt {
  id: string;
  projectIdentityId: string;
  ownerUserId: string;
  projectIdentityGeneration: number;
  action: string;
  expectedAppId: string | null;
  expectedDeploymentRevision: bigint;
  claimedDeploymentRevision: bigint | null;
  expectedFullstack: boolean | null;
  sourceDigest: string | null;
  proofSecretHash: string;
  status: string;
  result: unknown;
  failureCode: string | null;
  expiresAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ProjectIdentitySnapshot {
  id: string;
  workspaceOwnerId: string;
  generation: number;
  lifecycleStatus: string;
}

interface AppSnapshot {
  id: string;
  userId: string;
  projectIdentityId: string | null;
}

interface DeploymentRevisionRow {
  projectIdentityId: string;
  revision: bigint;
  createdAt?: Date;
  updatedAt?: Date;
}

interface RecoveryTransaction {
  projectIdentity: {
    findUnique(args: unknown): Promise<ProjectIdentitySnapshot | null>;
  };
  app: {
    findUnique(args: unknown): Promise<AppSnapshot | null>;
  };
  projectDeploymentLifecycleRevision: {
    findUnique(args: unknown): Promise<DeploymentRevisionRow | null>;
    create(args: unknown): Promise<DeploymentRevisionRow>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  projectRuntimeRecoveryOperation: {
    findUnique(args: unknown): Promise<ProjectRuntimeRecoveryReceipt | null>;
    create(args: unknown): Promise<ProjectRuntimeRecoveryReceipt>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

export interface ProjectRuntimeRecoveryReplayDatabase {
  $transaction<T>(
    callback: (transaction: RecoveryTransaction) => Promise<T>,
    options?: {
      isolationLevel?: 'Serializable';
      maxWait?: number;
      timeout?: number;
    },
  ): Promise<T>;
}

const defaultDatabase = prisma as unknown as ProjectRuntimeRecoveryReplayDatabase;

export type ProjectRuntimeRecoveryErrorCode =
  | 'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT'
  | 'PROJECT_RUNTIME_RECOVERY_PROOF_INVALID'
  | 'PROJECT_RUNTIME_RECOVERY_PROOF_EXPIRED'
  | 'PROJECT_RUNTIME_RECOVERY_PROOF_MISMATCH'
  | 'PROJECT_RUNTIME_RECOVERY_STALE'
  | 'PROJECT_RUNTIME_RECOVERY_STATE_INVALID'
  | 'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID'
  | 'PROJECT_RUNTIME_RECOVERY_CONTENDED';

export class ProjectRuntimeRecoveryReplayError extends Error {
  constructor(
    public readonly code: ProjectRuntimeRecoveryErrorCode,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'ProjectRuntimeRecoveryReplayError';
  }
}

interface NormalizedScope {
  ownerUserId: string;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  action: ProjectRuntimeRecoveryAction;
  expectedAppId: string | null;
  expectedFullstack: boolean | null;
  sourceDigest: string | null;
}

type NormalizedProjectIdentityScope = Pick<
  NormalizedScope,
  'ownerUserId' | 'projectIdentityId' | 'projectIdentityGeneration'
>;

interface ParsedProof {
  operationId: string;
  secret: string;
  secretHash: string;
}

export type ProjectRuntimeRecoveryStatus =
  | {
      kind: 'issued';
      operationId: string;
      deploymentRevision: string;
      expiresAt: Date;
    }
  | {
      kind: 'claimed';
      operationId: string;
      deploymentRevision: string;
    }
  | {
      kind: 'running';
      operationId: string;
      deploymentRevision: string;
    }
  | {
      kind: 'completed';
      operationId: string;
      deploymentRevision: string;
      result: ProjectRuntimeRecoveryResponse;
    }
  | {
      kind: 'failed';
      operationId: string;
      deploymentRevision: string;
      failureCode: string;
    };

function replayError(
  code: ProjectRuntimeRecoveryErrorCode,
  message: string,
  httpStatus: number,
): ProjectRuntimeRecoveryReplayError {
  return new ProjectRuntimeRecoveryReplayError(code, message, httpStatus);
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT',
      `Invalid ${label}`,
      400,
    );
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (!value || bytes > MAX_IDENTIFIER_BYTES || FORBIDDEN_STRING_CONTROL.test(value)) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT',
      `Invalid ${label}`,
      400,
    );
  }
  return value;
}

function requireGeneration(value: unknown): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT',
      'Invalid Project identity generation',
      400,
    );
  }
  return generation;
}

function requireAction(value: unknown): ProjectRuntimeRecoveryAction {
  if (value !== 'deploy' && value !== 'start' && value !== 'restart') {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT',
      'Invalid Project runtime recovery action',
      400,
    );
  }
  return value;
}

function optionalAppId(value: unknown): string | null {
  if (value == null) return null;
  return requireIdentifier(value, 'expected App identity');
}

function optionalBoolean(value: unknown, label: string): boolean | null {
  if (value == null) return null;
  if (typeof value !== 'boolean') {
    throw replayError('PROJECT_RUNTIME_RECOVERY_INVALID_INPUT', `Invalid ${label}`, 400);
  }
  return value;
}

function optionalDigest(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT',
      'Invalid Project source digest',
      400,
    );
  }
  return value;
}

function normalizeScope(input: ProjectRuntimeRecoveryScope): NormalizedScope {
  const identity = normalizeProjectIdentityScope(input);
  const action = requireAction(input.action);
  const expectedAppId = optionalAppId(input.expectedAppId);
  const expectedFullstack = optionalBoolean(input.expectedFullstack, 'full-stack source attestation');
  if ((action === 'start' || action === 'restart') && expectedAppId === null) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT',
      'Project process recovery requires an expected App identity',
      400,
    );
  }
  if ((action === 'start' || action === 'restart') && expectedFullstack !== true) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT',
      'Project process recovery requires a full-stack source attestation',
      400,
    );
  }
  const sourceDigest = optionalDigest(input.sourceDigest);
  if (action === 'deploy' && (expectedFullstack !== true || sourceDigest === null)) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT',
      'Project deploy recovery requires a full-stack source digest',
      400,
    );
  }
  if (sourceDigest !== null && expectedFullstack === null) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT',
      'Project source digest requires a source-type attestation',
      400,
    );
  }
  return Object.freeze({
    ...identity,
    action,
    expectedAppId,
    expectedFullstack,
    sourceDigest,
  });
}

function normalizeProjectIdentityScope(input: {
  ownerUserId: string;
  projectIdentityId: string;
  projectIdentityGeneration: number;
}): NormalizedProjectIdentityScope {
  return Object.freeze({
    ownerUserId: requireIdentifier(input.ownerUserId, 'Project owner identity'),
    projectIdentityId: requireIdentifier(input.projectIdentityId, 'Project identity'),
    projectIdentityGeneration: requireGeneration(input.projectIdentityGeneration),
  });
}

function requireDate(value: unknown, label: string): Date {
  const isDate = value instanceof Date || Object.prototype.toString.call(value) === '[object Date]';
  const timestamp = isDate && typeof (value as Date).getTime === 'function'
    ? (value as Date).getTime()
    : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw replayError('PROJECT_RUNTIME_RECOVERY_INVALID_INPUT', `Invalid ${label}`, 400);
  }
  return new Date(timestamp);
}

function requireTtl(value: unknown): number {
  const ttl = value == null ? PROJECT_RUNTIME_RECOVERY_DEFAULT_TTL_MS : Number(value);
  if (
    !Number.isSafeInteger(ttl)
    || ttl < PROJECT_RUNTIME_RECOVERY_MIN_TTL_MS
    || ttl > PROJECT_RUNTIME_RECOVERY_MAX_TTL_MS
  ) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT',
      'Invalid Project runtime recovery proof lifetime',
      400,
    );
  }
  return ttl;
}

function revision(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw replayError(
    'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
    'Project deployment lifecycle revision is invalid',
    503,
  );
}

function expectedRevisionInput(value: unknown): bigint {
  try {
    return revision(value);
  } catch {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT',
      'Invalid expected Project deployment lifecycle revision',
      400,
    );
  }
}

function proofHash(operationId: string, secret: string): string {
  return crypto
    .createHash('sha256')
    .update('bridgesllm-project-runtime-recovery-v1\0', 'utf8')
    .update(operationId, 'utf8')
    .update('\0', 'utf8')
    .update(secret, 'utf8')
    .digest('hex');
}

function parseProof(value: unknown): ParsedProof {
  if (typeof value !== 'string' || value.length > 160) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_PROOF_INVALID',
      'Project runtime recovery proof is invalid',
      400,
    );
  }
  const parts = value.split('.');
  if (
    parts.length !== 3
    || parts[0] !== 'v1'
    || !UUID_V4_PATTERN.test(parts[1])
    || !PROOF_SECRET_PATTERN.test(parts[2])
  ) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_PROOF_INVALID',
      'Project runtime recovery proof is invalid',
      400,
    );
  }
  return {
    operationId: parts[1],
    secret: parts[2],
    secretHash: proofHash(parts[1], parts[2]),
  };
}

function hashesMatch(left: string, right: string): boolean {
  if (!DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function sameScope(receipt: ProjectRuntimeRecoveryReceipt, scope: NormalizedScope): boolean {
  return receipt.ownerUserId === scope.ownerUserId
    && receipt.projectIdentityId === scope.projectIdentityId
    && receipt.projectIdentityGeneration === scope.projectIdentityGeneration
    && receipt.action === scope.action
    && receipt.expectedAppId === scope.expectedAppId
    && receipt.expectedFullstack === scope.expectedFullstack
    && receipt.sourceDigest === scope.sourceDigest;
}

async function readVerifiedReceipt(
  transaction: RecoveryTransaction,
  parsedProof: ParsedProof,
  scope: NormalizedScope,
): Promise<ProjectRuntimeRecoveryReceipt> {
  const receipt = await transaction.projectRuntimeRecoveryOperation.findUnique({
    where: { id: parsedProof.operationId },
  });
  if (!receipt || !hashesMatch(receipt.proofSecretHash, parsedProof.secretHash)) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_PROOF_INVALID',
      'Project runtime recovery proof is invalid',
      400,
    );
  }
  if (!sameScope(receipt, scope)) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_PROOF_MISMATCH',
      'Project runtime recovery proof does not match this operation',
      409,
    );
  }
  return receipt;
}

async function readActiveIdentity(
  transaction: RecoveryTransaction,
  scope: NormalizedProjectIdentityScope,
): Promise<ProjectIdentitySnapshot> {
  const identity = await transaction.projectIdentity.findUnique({
    where: { id: scope.projectIdentityId },
    select: {
      id: true,
      workspaceOwnerId: true,
      generation: true,
      lifecycleStatus: true,
    },
  });
  if (
    !identity
    || identity.id !== scope.projectIdentityId
    || identity.workspaceOwnerId !== scope.ownerUserId
    || identity.generation !== scope.projectIdentityGeneration
    || identity.lifecycleStatus !== 'ACTIVE'
  ) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_STALE',
      'Project runtime recovery proof is stale',
      409,
    );
  }
  return identity;
}

async function readExpectedApp(
  transaction: RecoveryTransaction,
  scope: NormalizedScope,
): Promise<AppSnapshot | null> {
  const app = await transaction.app.findUnique({
    where: { projectIdentityId: scope.projectIdentityId },
    select: { id: true, userId: true, projectIdentityId: true },
  });
  if (scope.expectedAppId === null) {
    if (app !== null) {
      throw replayError(
        'PROJECT_RUNTIME_RECOVERY_STALE',
        'Project runtime recovery App snapshot is stale',
        409,
      );
    }
    return null;
  }
  if (
    !app
    || app.id !== scope.expectedAppId
    || app.userId !== scope.ownerUserId
    || app.projectIdentityId !== scope.projectIdentityId
  ) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_STALE',
      'Project runtime recovery App snapshot is stale',
      409,
    );
  }
  return app;
}

async function readOrCreateLifecycleRevision(
  transaction: RecoveryTransaction,
  projectIdentityId: string,
): Promise<DeploymentRevisionRow> {
  const existing = await transaction.projectDeploymentLifecycleRevision.findUnique({
    where: { projectIdentityId },
  });
  if (existing) return existing;
  return transaction.projectDeploymentLifecycleRevision.create({
    data: { projectIdentityId, revision: 0n },
  });
}

function isSerializableConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'P2034') return true;
  if (code !== 'P2002') return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const rendered = Array.isArray(target) ? target.join(',') : String(target || '');
  return rendered.includes('projectIdentityId');
}

async function serializable<T>(
  database: ProjectRuntimeRecoveryReplayDatabase,
  operation: (transaction: RecoveryTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await database.$transaction(operation, {
        isolationLevel: 'Serializable',
        maxWait: 5_000,
        timeout: 15_000,
      });
    } catch (error) {
      if (!isSerializableConflict(error)) throw error;
      if (attempt === MAX_SERIALIZABLE_ATTEMPTS) {
        throw replayError(
          'PROJECT_RUNTIME_RECOVERY_CONTENDED',
          'Project deployment lifecycle changed concurrently',
          409,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5 * attempt));
    }
  }
  throw replayError(
    'PROJECT_RUNTIME_RECOVERY_CONTENDED',
    'Project deployment lifecycle changed concurrently',
    409,
  );
}

function persistedStatus(value: unknown): ProjectRuntimeRecoveryPersistedStatus {
  if (value === 'ISSUED' || value === 'RUNNING' || value === 'COMPLETED' || value === 'FAILED') {
    return value;
  }
  throw replayError(
    'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
    'Project runtime recovery receipt state is invalid',
    503,
  );
}

function normalizeResponse(
  value: unknown,
  scope: NormalizedScope,
  expectedDeploymentRevision?: bigint,
): ProjectRuntimeRecoveryResponse {
  if (!isPlainDataRecord(value)) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID',
      'Project runtime recovery response is invalid',
      500,
    );
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  if (keys.length !== 2 || keys[0] !== 'body' || keys[1] !== 'statusCode') {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID',
      'Project runtime recovery response shape is invalid',
      500,
    );
  }
  const statusCode = (value as { statusCode?: unknown }).statusCode;
  if (statusCode !== 200 && statusCode !== 201) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID',
      'Project runtime recovery response status is invalid',
      500,
    );
  }
  const body = (value as { body?: unknown }).body;
  if (!isPlainDataRecord(body)) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID',
      'Project runtime recovery response body is invalid',
      500,
    );
  }
  const bodyRecord = body as Record<string, unknown>;
  const bodyKeys = Object.keys(bodyRecord).sort();
  const expectedKeys = [
    'action',
    'appId',
    'deploymentRevision',
    'projectIdentityGeneration',
    'projectIdentityId',
    'success',
  ];
  if (
    bodyKeys.length !== expectedKeys.length
    || bodyKeys.some((key, index) => key !== expectedKeys[index])
    || bodyRecord.success !== true
    || bodyRecord.action !== scope.action
    || bodyRecord.projectIdentityId !== scope.projectIdentityId
    || bodyRecord.projectIdentityGeneration !== scope.projectIdentityGeneration
  ) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID',
      'Project runtime recovery response does not match its operation',
      500,
    );
  }
  const appId = requireIdentifier(bodyRecord.appId, 'recovered App identity');
  if (scope.expectedAppId !== null && appId !== scope.expectedAppId) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID',
      'Project runtime recovery response has the wrong App identity',
      500,
    );
  }
  const deploymentRevision = revision(bodyRecord.deploymentRevision);
  if (
    expectedDeploymentRevision !== undefined
    && deploymentRevision !== expectedDeploymentRevision
  ) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID',
      'Project runtime recovery response has the wrong deployment revision',
      500,
    );
  }
  const response: ProjectRuntimeRecoveryResponse = {
    statusCode,
    body: {
      success: true,
      action: scope.action,
      projectIdentityId: scope.projectIdentityId,
      projectIdentityGeneration: scope.projectIdentityGeneration,
      appId,
      deploymentRevision: deploymentRevision.toString(),
    },
  };
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > PROJECT_RUNTIME_RECOVERY_MAX_RESPONSE_BYTES) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID',
      'Project runtime recovery response is too large',
      500,
    );
  }
  return response;
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.prototype.toString.call(value) !== '[object Object]'
  ) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every((descriptor) => (
    descriptor.get === undefined && descriptor.set === undefined
  ));
}

function responseFromReceipt(
  receipt: ProjectRuntimeRecoveryReceipt,
  scope: NormalizedScope,
  claimedRevision: bigint,
): ProjectRuntimeRecoveryResponse {
  return normalizeResponse(receipt.result, scope, claimedRevision);
}

function failureCodeFromReceipt(receipt: ProjectRuntimeRecoveryReceipt): string {
  if (typeof receipt.failureCode !== 'string' || !FAILURE_CODE_PATTERN.test(receipt.failureCode)) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
      'Project runtime recovery failure state is invalid',
      503,
    );
  }
  return receipt.failureCode;
}

function statusFromReceipt(
  receipt: ProjectRuntimeRecoveryReceipt,
  scope: NormalizedScope,
): ProjectRuntimeRecoveryStatus {
  const expectedRevision = revision(receipt.expectedDeploymentRevision);
  const claimedRevision = receipt.claimedDeploymentRevision == null
    ? null
    : revision(receipt.claimedDeploymentRevision);
  switch (persistedStatus(receipt.status)) {
    case 'ISSUED':
      return {
        kind: 'issued',
        operationId: receipt.id,
        deploymentRevision: expectedRevision.toString(),
        expiresAt: requireDate(receipt.expiresAt, 'Project runtime recovery expiry'),
      };
    case 'RUNNING':
      if (claimedRevision !== expectedRevision + 1n) {
        throw replayError(
          'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
          'Project runtime recovery claim revision is invalid',
          503,
        );
      }
      return {
        kind: 'running',
        operationId: receipt.id,
        deploymentRevision: claimedRevision.toString(),
      };
    case 'COMPLETED':
      if (claimedRevision !== expectedRevision + 1n) {
        throw replayError(
          'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
          'Project runtime recovery completion revision is invalid',
          503,
        );
      }
      return {
        kind: 'completed',
        operationId: receipt.id,
        deploymentRevision: claimedRevision.toString(),
        result: responseFromReceipt(receipt, scope, claimedRevision),
      };
    case 'FAILED':
      if (claimedRevision !== expectedRevision + 1n) {
        throw replayError(
          'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
          'Project runtime recovery failure revision is invalid',
          503,
        );
      }
      return {
        kind: 'failed',
        operationId: receipt.id,
        deploymentRevision: claimedRevision.toString(),
        failureCode: failureCodeFromReceipt(receipt),
      };
  }
}

async function attestIssuedReceiptStillCurrent(
  transaction: RecoveryTransaction,
  receipt: ProjectRuntimeRecoveryReceipt,
  scope: NormalizedScope,
  now: Date,
): Promise<DeploymentRevisionRow> {
  if (requireDate(receipt.expiresAt, 'Project runtime recovery expiry').getTime() <= now.getTime()) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_PROOF_EXPIRED',
      'Project runtime recovery proof has expired',
      410,
    );
  }
  await readActiveIdentity(transaction, scope);
  await readExpectedApp(transaction, scope);
  const lifecycle = await transaction.projectDeploymentLifecycleRevision.findUnique({
    where: { projectIdentityId: scope.projectIdentityId },
  });
  if (
    !lifecycle
    || lifecycle.projectIdentityId !== scope.projectIdentityId
    || revision(lifecycle.revision) !== revision(receipt.expectedDeploymentRevision)
  ) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_STALE',
      'Project deployment lifecycle changed after this recovery proof was issued',
      409,
    );
  }
  return lifecycle;
}

export async function issueProjectRuntimeRecoveryProof(
  input: IssueProjectRuntimeRecoveryProofInput,
  database: ProjectRuntimeRecoveryReplayDatabase = defaultDatabase,
): Promise<{
  proof: string;
  operationId: string;
  deploymentRevision: string;
  expiresAt: Date;
}> {
  const scope = normalizeScope(input);
  const now = requireDate(input.now || new Date(), 'Project runtime recovery issue time');
  const ttlMs = requireTtl(input.ttlMs);
  const expiresAt = new Date(now.getTime() + ttlMs);
  const expectedDeploymentRevision = expectedRevisionInput(input.expectedDeploymentRevision);
  const operationId = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString('base64url');
  const secretHash = proofHash(operationId, secret);

  const issued = await serializable(database, async (transaction) => {
    await readActiveIdentity(transaction, scope);
    await readExpectedApp(transaction, scope);
    const lifecycle = await readOrCreateLifecycleRevision(transaction, scope.projectIdentityId);
    if (revision(lifecycle.revision) !== expectedDeploymentRevision) {
      throw replayError(
        'PROJECT_RUNTIME_RECOVERY_STALE',
        'Project deployment lifecycle changed before the recovery proof was issued',
        409,
      );
    }
    const receipt = await transaction.projectRuntimeRecoveryOperation.create({
      data: {
        id: operationId,
        projectIdentityId: scope.projectIdentityId,
        ownerUserId: scope.ownerUserId,
        projectIdentityGeneration: scope.projectIdentityGeneration,
        action: scope.action,
        expectedAppId: scope.expectedAppId,
        expectedDeploymentRevision,
        claimedDeploymentRevision: null,
        expectedFullstack: scope.expectedFullstack,
        sourceDigest: scope.sourceDigest,
        proofSecretHash: secretHash,
        status: 'ISSUED',
        failureCode: null,
        expiresAt,
        claimedAt: null,
        completedAt: null,
        failedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (
      receipt.id !== operationId
      || receipt.status !== 'ISSUED'
      || revision(receipt.expectedDeploymentRevision) !== expectedDeploymentRevision
    ) {
      throw replayError(
        'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
        'Project runtime recovery proof could not be verified',
        503,
      );
    }
    return expectedDeploymentRevision;
  });

  return {
    proof: `v1.${operationId}.${secret}`,
    operationId,
    deploymentRevision: issued.toString(),
    expiresAt,
  };
}

export async function claimProjectRuntimeRecoveryProof(
  input: ProjectRuntimeRecoveryProofInput,
  database: ProjectRuntimeRecoveryReplayDatabase = defaultDatabase,
): Promise<ProjectRuntimeRecoveryStatus> {
  const scope = normalizeScope(input);
  const parsedProof = parseProof(input.proof);
  const now = requireDate(input.now || new Date(), 'Project runtime recovery claim time');

  return serializable(database, async (transaction) => {
    const receipt = await readVerifiedReceipt(transaction, parsedProof, scope);
    const status = persistedStatus(receipt.status);
    if (status !== 'ISSUED') return statusFromReceipt(receipt, scope);

    const lifecycle = await attestIssuedReceiptStillCurrent(transaction, receipt, scope, now);
    const expectedRevision = revision(receipt.expectedDeploymentRevision);
    const claimedRevision = expectedRevision + 1n;
    const lifecycleUpdated = await transaction.projectDeploymentLifecycleRevision.updateMany({
      where: {
        projectIdentityId: scope.projectIdentityId,
        revision: expectedRevision,
      },
      data: {
        revision: { increment: 1n },
        updatedAt: now,
      },
    });
    if (lifecycleUpdated.count !== 1 || revision(lifecycle.revision) !== expectedRevision) {
      throw replayError(
        'PROJECT_RUNTIME_RECOVERY_STALE',
        'Project deployment lifecycle changed before recovery admission',
        409,
      );
    }
    const receiptUpdated = await transaction.projectRuntimeRecoveryOperation.updateMany({
      where: {
        id: receipt.id,
        projectIdentityId: scope.projectIdentityId,
        status: 'ISSUED',
        expectedDeploymentRevision: expectedRevision,
        claimedDeploymentRevision: null,
      },
      data: {
        status: 'RUNNING',
        claimedDeploymentRevision: claimedRevision,
        claimedAt: now,
        updatedAt: now,
      },
    });
    if (receiptUpdated.count !== 1) {
      throw replayError(
        'PROJECT_RUNTIME_RECOVERY_STALE',
        'Project runtime recovery operation was already claimed',
        409,
      );
    }
    return {
      kind: 'claimed',
      operationId: receipt.id,
      deploymentRevision: claimedRevision.toString(),
    };
  });
}

export async function readProjectRuntimeRecoveryStatus(
  input: ProjectRuntimeRecoveryProofInput,
  database: ProjectRuntimeRecoveryReplayDatabase = defaultDatabase,
): Promise<ProjectRuntimeRecoveryStatus> {
  const scope = normalizeScope(input);
  const parsedProof = parseProof(input.proof);
  const now = requireDate(input.now || new Date(), 'Project runtime recovery status time');
  return serializable(database, async (transaction) => {
    const receipt = await readVerifiedReceipt(transaction, parsedProof, scope);
    if (persistedStatus(receipt.status) === 'ISSUED') {
      await attestIssuedReceiptStillCurrent(transaction, receipt, scope, now);
    }
    return statusFromReceipt(receipt, scope);
  });
}

export async function completeProjectRuntimeRecovery(
  input: ProjectRuntimeRecoveryProofInput & { response: ProjectRuntimeRecoveryResponse },
  database: ProjectRuntimeRecoveryReplayDatabase = defaultDatabase,
): Promise<ProjectRuntimeRecoveryResponse> {
  const scope = normalizeScope(input);
  const parsedProof = parseProof(input.proof);
  const now = requireDate(input.now || new Date(), 'Project runtime recovery completion time');
  return serializable(database, async (transaction) => {
    const receipt = await readVerifiedReceipt(transaction, parsedProof, scope);
    const status = persistedStatus(receipt.status);
    const claimedRevision = revision(receipt.claimedDeploymentRevision);
    const response = normalizeResponse(input.response, scope, claimedRevision);
    const serializedResponse = JSON.stringify(response);
    if (status === 'COMPLETED') {
      const existing = responseFromReceipt(receipt, scope, claimedRevision);
      if (JSON.stringify(existing) !== serializedResponse) {
        throw replayError(
          'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
          'Project runtime recovery completion does not match its durable result',
          409,
        );
      }
      return existing;
    }
    if (status !== 'RUNNING') {
      throw replayError(
        'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
        'Project runtime recovery operation is not running',
        409,
      );
    }
    const completedApp = await transaction.app.findUnique({
      where: { projectIdentityId: scope.projectIdentityId },
      select: { id: true, userId: true, projectIdentityId: true },
    });
    if (
      !completedApp
      || completedApp.id !== response.body.appId
      || completedApp.userId !== scope.ownerUserId
      || completedApp.projectIdentityId !== scope.projectIdentityId
    ) {
      throw replayError(
        'PROJECT_RUNTIME_RECOVERY_RESPONSE_INVALID',
        'Project runtime recovery completion App does not match its Project',
        500,
      );
    }
    const updated = await transaction.projectRuntimeRecoveryOperation.updateMany({
      where: {
        id: receipt.id,
        projectIdentityId: scope.projectIdentityId,
        status: 'RUNNING',
        claimedDeploymentRevision: receipt.claimedDeploymentRevision,
      },
      data: {
        status: 'COMPLETED',
        result: response,
        completedAt: now,
        updatedAt: now,
      },
    });
    if (updated.count !== 1) {
      throw replayError(
        'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
        'Project runtime recovery completion changed concurrently',
        409,
      );
    }
    return response;
  });
}

export async function failProjectRuntimeRecovery(
  input: ProjectRuntimeRecoveryProofInput & { failureCode: string },
  database: ProjectRuntimeRecoveryReplayDatabase = defaultDatabase,
): Promise<Extract<ProjectRuntimeRecoveryStatus, { kind: 'failed' }>> {
  const scope = normalizeScope(input);
  const parsedProof = parseProof(input.proof);
  const now = requireDate(input.now || new Date(), 'Project runtime recovery failure time');
  if (!FAILURE_CODE_PATTERN.test(input.failureCode)) {
    throw replayError(
      'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT',
      'Invalid Project runtime recovery failure code',
      400,
    );
  }
  return serializable(database, async (transaction) => {
    const receipt = await readVerifiedReceipt(transaction, parsedProof, scope);
    const status = persistedStatus(receipt.status);
    if (status === 'FAILED') {
      const existing = statusFromReceipt(receipt, scope);
      if (existing.kind !== 'failed' || existing.failureCode !== input.failureCode) {
        throw replayError(
          'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
          'Project runtime recovery failure does not match its durable result',
          409,
        );
      }
      return existing;
    }
    if (status !== 'RUNNING') {
      throw replayError(
        'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
        'Project runtime recovery operation is not running',
        409,
      );
    }
    const updated = await transaction.projectRuntimeRecoveryOperation.updateMany({
      where: {
        id: receipt.id,
        projectIdentityId: scope.projectIdentityId,
        status: 'RUNNING',
        claimedDeploymentRevision: receipt.claimedDeploymentRevision,
      },
      data: {
        status: 'FAILED',
        failureCode: input.failureCode,
        failedAt: now,
        updatedAt: now,
      },
    });
    if (updated.count !== 1) {
      throw replayError(
        'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
        'Project runtime recovery failure changed concurrently',
        409,
      );
    }
    return {
      kind: 'failed',
      operationId: receipt.id,
      deploymentRevision: revision(receipt.claimedDeploymentRevision).toString(),
      failureCode: input.failureCode,
    };
  });
}

export async function advanceProjectDeploymentLifecycleRevision(
  input: {
    ownerUserId: string;
    projectIdentityId: string;
    projectIdentityGeneration: number;
    expectedDeploymentRevision: string | number | bigint;
    now?: Date;
  },
  database: ProjectRuntimeRecoveryReplayDatabase = defaultDatabase,
): Promise<{ deploymentRevision: string }> {
  const scope = normalizeProjectIdentityScope(input);
  const now = requireDate(input.now || new Date(), 'Project deployment lifecycle mutation time');
  const expected = expectedRevisionInput(input.expectedDeploymentRevision);
  return serializable(database, async (transaction) => {
    await readActiveIdentity(transaction, scope);
    const lifecycle = await readOrCreateLifecycleRevision(transaction, scope.projectIdentityId);
    const current = revision(lifecycle.revision);
    if (current !== expected) {
      throw replayError(
        'PROJECT_RUNTIME_RECOVERY_STALE',
        'Project deployment lifecycle changed before mutation admission',
        409,
      );
    }
    const updated = await transaction.projectDeploymentLifecycleRevision.updateMany({
      where: { projectIdentityId: scope.projectIdentityId, revision: current },
      data: { revision: { increment: 1n }, updatedAt: now },
    });
    if (updated.count !== 1) {
      throw replayError(
        'PROJECT_RUNTIME_RECOVERY_CONTENDED',
        'Project deployment lifecycle changed concurrently',
        409,
      );
    }
    return { deploymentRevision: (current + 1n).toString() };
  });
}

export async function readProjectDeploymentLifecycleRevision(
  input: {
    ownerUserId: string;
    projectIdentityId: string;
    projectIdentityGeneration: number;
  },
  database: ProjectRuntimeRecoveryReplayDatabase = defaultDatabase,
): Promise<{ deploymentRevision: string }> {
  const scope = normalizeProjectIdentityScope(input);
  return serializable(database, async (transaction) => {
    await readActiveIdentity(transaction, scope);
    const lifecycle = await readOrCreateLifecycleRevision(transaction, scope.projectIdentityId);
    return { deploymentRevision: revision(lifecycle.revision).toString() };
  });
}
