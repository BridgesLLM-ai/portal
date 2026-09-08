import crypto from 'crypto';
import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { encryptPlaintextSecret } from '../utils/authSecrets';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import {
  buildOpenClawAgentRemovalPatch,
  materializeOpenClawAgentList,
  openClawAgentRostersEqual,
  readOpenClawAgentConfigContract,
  type OpenClawAgentConfigContract,
} from './openclawAgentConfigContract';

const LEGACY_AGENT_ID_PATTERN = /^portal-([a-f0-9]{8})-([a-z0-9][a-z0-9_-]*)$/u;
const LEGACY_IMAGE = 'openclaw-sandbox:bookworm-slim';
const MAX_CONFIG_AGENTS = 2_048;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const CONFIG_RPC_TIMEOUT_MS = 15_000;

interface RpcResponse {
  ok: boolean;
  data?: any;
  error?: any;
}

interface ReceiptCreateInput {
  actorUserId: string;
  agentId: string;
  metadata: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

interface LegacyOpenClawAgentDetachDependencies {
  rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<RpcResponse>;
  seal(value: string): string;
  createReceipt(input: ReceiptCreateInput): Promise<{ id: string }>;
  updateReceipt(id: string, metadata: Record<string, unknown>, severity: 'INFO' | 'WARNING' | 'ERROR'): Promise<void>;
}

export interface LegacyOpenClawAgentRegistration {
  agentId: string;
  userPrefix: string | null;
  projectSlug: string | null;
  bindCount: number | null;
  state: 'STALE_BINDLESS' | 'BOUND' | 'AMBIGUOUS' | 'DUPLICATE';
  detachable: boolean;
  reason: string;
  fingerprint: string;
  preservesTranscripts: true;
  preservesWorkspace: true;
}

export interface LegacyOpenClawAgentDetachResult {
  ok: true;
  agentId: string;
  receiptId: string;
  configHashBefore: string;
  configHashAfter: string;
  transcriptsPreserved: true;
  workspacePreserved: true;
}

export class LegacyOpenClawAgentDetachError extends Error {
  constructor(
    readonly code:
      | 'CONFIG_UNAVAILABLE'
      | 'CONFIG_INVALID'
      | 'AGENT_NOT_FOUND'
      | 'AGENT_CHANGED'
      | 'AGENT_NOT_DETACHABLE'
      | 'CONFIRMATION_MISMATCH'
      | 'PATCH_FAILED'
      | 'VERIFY_FAILED',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LegacyOpenClawAgentDetachError';
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function configFromResponse(response: RpcResponse): { config: Record<string, any>; hash: string } {
  if (!response.ok) {
    throw new LegacyOpenClawAgentDetachError(
      'CONFIG_UNAVAILABLE',
      'OpenClaw configuration could not be read. No registration was changed.',
      502,
    );
  }
  const config = response.data?.config ?? response.data?.parsed;
  const hash = String(response.data?.hash || '').trim();
  if (!isRecord(config) || !hash || Buffer.byteLength(JSON.stringify(config), 'utf8') > MAX_CONFIG_BYTES) {
    throw new LegacyOpenClawAgentDetachError(
      'CONFIG_INVALID',
      'OpenClaw returned an incomplete or oversized configuration. No registration was changed.',
      409,
    );
  }
  return { config, hash };
}

function configContract(config: Record<string, any>): OpenClawAgentConfigContract {
  try {
    return readOpenClawAgentConfigContract(config);
  } catch {
    throw new LegacyOpenClawAgentDetachError(
      'CONFIG_INVALID',
      `OpenClaw agent roster did not match a Portal-qualified 2026.7.1 or 2026.9.1 contract (limit ${MAX_CONFIG_AGENTS}).`,
      409,
    );
  }
}

function expectedLegacyWorkspace(agentId: string): string {
  const openClawHome = process.env.OPENCLAW_HOME
    || path.join(process.env.HOME || '/root', '.openclaw');
  return path.join(openClawHome, 'sandboxes', `${agentId}-workspace`);
}

function hasExactLegacyRuntimeShape(entry: Record<string, any>, agentId: string): boolean {
  const sandbox = isRecord(entry.sandbox) ? entry.sandbox : {};
  const docker = isRecord(sandbox.docker) ? sandbox.docker : {};
  return entry.workspace === expectedLegacyWorkspace(agentId)
    && sandbox.mode === 'all'
    && sandbox.scope === 'session'
    && (sandbox.backend === undefined || sandbox.backend === 'docker')
    && docker.image === LEGACY_IMAGE
    && docker.network === 'bridge'
    && docker.dangerouslyAllowExternalBindSources === true;
}

function classify(
  entry: Record<string, any>,
  duplicate: boolean,
): LegacyOpenClawAgentRegistration | null {
  const agentId = typeof entry.id === 'string' ? entry.id : '';
  if (!agentId.startsWith('portal-')) return null;
  const match = agentId.match(LEGACY_AGENT_ID_PATTERN);
  const docker = isRecord(entry?.sandbox?.docker) ? entry.sandbox.docker : {};
  const binds = docker.binds;
  const bindCount = Array.isArray(binds) ? binds.length : binds === undefined ? 0 : null;
  const base = {
    agentId,
    userPrefix: match?.[1] || null,
    projectSlug: match?.[2] || null,
    bindCount,
    fingerprint: digest(entry),
    preservesTranscripts: true as const,
    preservesWorkspace: true as const,
  };
  if (duplicate) {
    return {
      ...base,
      state: 'DUPLICATE',
      detachable: false,
      reason: 'This agent id occurs more than once. Resolve the duplicate configuration before detaching anything.',
    };
  }
  if (!match || !hasExactLegacyRuntimeShape(entry, agentId) || bindCount === null || bindCount > 1) {
    return {
      ...base,
      state: 'AMBIGUOUS',
      detachable: false,
      reason: 'This portal-* entry does not exactly match the retired Portal Project runtime and will not be changed automatically.',
    };
  }
  if (bindCount === 1) {
    return {
      ...base,
      state: 'BOUND',
      detachable: false,
      reason: 'This legacy registration still owns a Project bind. Use the migration workflow; stale-agent detach is intentionally disabled.',
    };
  }
  return {
    ...base,
    state: 'STALE_BINDLESS',
    detachable: true,
    reason: 'No Project bind remains. The config registration can be detached while its transcript and workspace directories stay preserved.',
  };
}

function inventory(config: Record<string, any>): LegacyOpenClawAgentRegistration[] {
  const agents = materializeOpenClawAgentList(configContract(config));
  const counts = new Map<string, number>();
  for (const entry of agents) {
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (id.startsWith('portal-')) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return agents
    .map((entry) => classify(entry, (counts.get(String(entry.id || '')) || 0) > 1))
    .filter((entry): entry is LegacyOpenClawAgentRegistration => entry !== null)
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
}

const defaultDependencies: LegacyOpenClawAgentDetachDependencies = {
  rpc: gatewayRpcCall,
  seal: encryptPlaintextSecret,
  createReceipt: async (input) => prisma.activityLog.create({
    data: {
      userId: input.actorUserId,
      action: 'LEGACY_OPENCLAW_AGENT_DETACH',
      resource: 'openclaw-agent-registration',
      resourceId: input.agentId,
      severity: 'WARNING',
      ipAddress: input.ipAddress || undefined,
      userAgent: input.userAgent || undefined,
      metadata: input.metadata as Prisma.InputJsonValue,
    },
    select: { id: true },
  }),
  updateReceipt: async (id, metadata, severity) => {
    await prisma.activityLog.update({
      where: { id },
      data: {
        metadata: metadata as Prisma.InputJsonValue,
        severity,
      },
    });
  },
};

export async function listLegacyOpenClawAgentRegistrations(
  dependencies: Partial<LegacyOpenClawAgentDetachDependencies> = {},
): Promise<{ configHash: string; agents: LegacyOpenClawAgentRegistration[] }> {
  const deps = { ...defaultDependencies, ...dependencies };
  const snapshot = configFromResponse(await deps.rpc('config.get', {}, CONFIG_RPC_TIMEOUT_MS));
  return { configHash: snapshot.hash, agents: inventory(snapshot.config) };
}

export async function detachLegacyOpenClawAgentRegistration(input: {
  actorUserId: string;
  agentId: string;
  expectedFingerprint: string;
  confirmation: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}, dependencies: Partial<LegacyOpenClawAgentDetachDependencies> = {}): Promise<LegacyOpenClawAgentDetachResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  const agentId = String(input.agentId || '').trim();
  const expectedConfirmation = `DETACH ${agentId}`;
  if (!LEGACY_AGENT_ID_PATTERN.test(agentId)) {
    throw new LegacyOpenClawAgentDetachError(
      'AGENT_NOT_DETACHABLE',
      'Only an exactly identified retired portal-* Project agent can be detached.',
      400,
    );
  }
  if (input.confirmation !== expectedConfirmation) {
    throw new LegacyOpenClawAgentDetachError(
      'CONFIRMATION_MISMATCH',
      `Type ${expectedConfirmation} exactly to detach this stale registration.`,
      400,
    );
  }

  const before = configFromResponse(await deps.rpc('config.get', {}, CONFIG_RPC_TIMEOUT_MS));
  const beforeContract = configContract(before.config);
  const beforeAgents = materializeOpenClawAgentList(beforeContract);
  const matches = beforeAgents
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.id === agentId);
  if (matches.length === 0) {
    throw new LegacyOpenClawAgentDetachError(
      'AGENT_NOT_FOUND',
      'The stale OpenClaw agent registration no longer exists. Refresh the inventory before retrying.',
      404,
    );
  }
  if (matches.length !== 1) {
    throw new LegacyOpenClawAgentDetachError(
      'AGENT_NOT_DETACHABLE',
      'The OpenClaw agent id is duplicated. Nothing was changed.',
      409,
    );
  }
  const [{ entry, index }] = matches;
  const registration = classify(entry, false);
  if (!registration?.detachable) {
    throw new LegacyOpenClawAgentDetachError(
      'AGENT_NOT_DETACHABLE',
      registration?.reason || 'The requested agent is not an exact retired Portal Project registration.',
      409,
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(input.expectedFingerprint) || input.expectedFingerprint !== registration.fingerprint) {
    throw new LegacyOpenClawAgentDetachError(
      'AGENT_CHANGED',
      'The OpenClaw agent registration changed after it was inspected. Refresh the inventory before retrying.',
      409,
    );
  }

  const removal = buildOpenClawAgentRemovalPatch(beforeContract, agentId);
  const remainingRoster = removal.expected.storage === 'list'
    ? removal.expected.list
    : removal.expected.entries;
  const receiptMetadata: Record<string, unknown> = {
    schemaVersion: 2,
    state: 'PREPARED',
    agentId,
    agentFingerprint: registration.fingerprint,
    originalIndex: index,
    rosterStorage: beforeContract.storage,
    ...(beforeContract.storage === 'entries' ? { originalEntryKey: agentId } : {}),
    configHashBefore: before.hash,
    remainingAgentsFingerprint: digest(remainingRoster),
    removedAgentCiphertext: deps.seal(stableJson(entry)),
    transcriptDirectoriesDeleted: false,
    workspaceDirectoriesDeleted: false,
  };
  const receipt = await deps.createReceipt({
    actorUserId: input.actorUserId,
    agentId,
    metadata: receiptMetadata,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  let patch: RpcResponse;
  try {
    patch = await deps.rpc('config.patch', {
      raw: removal.raw,
      baseHash: before.hash,
      replacePaths: removal.replacePaths,
    }, CONFIG_RPC_TIMEOUT_MS);
  } catch {
    await deps.updateReceipt(receipt.id, {
      ...receiptMetadata,
      state: 'FAILED',
      failureCode: 'PATCH_FAILED',
    }, 'ERROR').catch(() => undefined);
    throw new LegacyOpenClawAgentDetachError(
      'PATCH_FAILED',
      'OpenClaw rejected the config update. The prepared rollback receipt was retained and no successful detach was reported.',
      502,
    );
  }
  if (!patch.ok) {
    await deps.updateReceipt(receipt.id, {
      ...receiptMetadata,
      state: 'FAILED',
      failureCode: 'PATCH_FAILED',
    }, 'ERROR').catch(() => undefined);
    throw new LegacyOpenClawAgentDetachError(
      'PATCH_FAILED',
      'OpenClaw rejected the config update. The prepared rollback receipt was retained and no successful detach was reported.',
      502,
    );
  }

  const after = configFromResponse(await deps.rpc('config.get', {}, CONFIG_RPC_TIMEOUT_MS));
  const afterContract = configContract(after.config);
  if (!openClawAgentRostersEqual(removal.expected, afterContract)) {
    await deps.updateReceipt(receipt.id, {
      ...receiptMetadata,
      state: 'VERIFY_FAILED',
      configHashAfter: after.hash,
      observedAgentsFingerprint: digest(
        afterContract.storage === 'list' ? afterContract.list : afterContract.entries,
      ),
    }, 'ERROR').catch(() => undefined);
    throw new LegacyOpenClawAgentDetachError(
      'VERIFY_FAILED',
      'OpenClaw did not read back the exact expected agent roster. The rollback receipt was retained for operator recovery.',
      502,
    );
  }

  const completedMetadata = {
    ...receiptMetadata,
    state: 'DETACHED',
    configHashAfter: after.hash,
    detachedAt: new Date().toISOString(),
  };
  await deps.updateReceipt(receipt.id, completedMetadata, 'WARNING');
  return {
    ok: true,
    agentId,
    receiptId: receipt.id,
    configHashBefore: before.hash,
    configHashAfter: after.hash,
    transcriptsPreserved: true,
    workspacePreserved: true,
  };
}
