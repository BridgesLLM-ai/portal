import { isDeepStrictEqual } from 'util';

export type OpenClawAgentConfigFamily = '2026.7.1' | '2026.9.1';

export type OpenClawAgentConfigContract =
  | {
      family: '2026.7.1';
      storage: 'list';
      agentsConfig: Record<string, any>;
      list: Record<string, any>[];
    }
  | {
      family: '2026.9.1';
      storage: 'entries';
      agentsConfig: Record<string, any>;
      entries: Record<string, Record<string, any>>;
    };

const MAX_CONFIG_AGENTS = 2_048;
const CONFIG_AGENT_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/i;
const CONFIG_BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class OpenClawAgentConfigContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenClawAgentConfigContractError';
  }
}

export function isOpenClawConfigRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, any>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasPersistedOwn(value: Record<string, any>, key: string): boolean {
  // 9.1 can expose a non-enumerable agents.list compatibility projection on
  // the materialized config object. It is not part of the authored/persisted
  // contract and JSON config.patch cannot copy it. Enumerable list+entries is
  // the ambiguous mixed shape that must fail closed.
  return Object.prototype.propertyIsEnumerable.call(value, key);
}

function assertCompatibleAgentListProjection(
  agentsConfig: Record<string, any>,
  entries: Record<string, Record<string, any>>,
): void {
  if (!hasOwn(agentsConfig, 'list')) return;
  const descriptor = Object.getOwnPropertyDescriptor(agentsConfig, 'list');
  const projection = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  const expected = Object.entries(entries).map(([id, entry]) => ({ ...entry, id }));
  if (
    !descriptor
    || descriptor.enumerable
    || !Array.isArray(projection)
    || projection.length > MAX_CONFIG_AGENTS
    || !isDeepStrictEqual(projection, expected)
  ) {
    throw new OpenClawAgentConfigContractError(
      'OpenClaw agents.list compatibility projection did not match canonical agents.entries',
    );
  }
}

function requireExactAgentId(
  id: unknown,
  normalizedIds: Set<string>,
  label: string,
): string {
  const exactId = typeof id === 'string' ? id : '';
  const normalizedId = exactId.toLowerCase();
  if (
    !CONFIG_AGENT_ID_PATTERN.test(exactId)
    || CONFIG_BLOCKED_KEYS.has(exactId)
    || normalizedIds.has(normalizedId)
  ) {
    throw new OpenClawAgentConfigContractError(`${label} contained an invalid or duplicate agent id`);
  }
  normalizedIds.add(normalizedId);
  return exactId;
}

/**
 * Decode only the two Portal-qualified, canonical roster contracts.
 *
 * OpenClaw 2026.7.1 owns agent identity inside each agents.list entry.
 * OpenClaw 2026.9.1 owns identity in the agents.entries key and rejects an
 * embedded id. A missing, mixed, or hybrid roster is deliberately not
 * normalized: the caller must fail closed instead of guessing which write
 * contract the installed runtime will persist.
 */
export function readOpenClawAgentConfigContract(
  config: unknown,
): OpenClawAgentConfigContract {
  if (!isOpenClawConfigRecord(config) || !isOpenClawConfigRecord(config.agents)) {
    throw new OpenClawAgentConfigContractError('OpenClaw agents config was not a canonical object');
  }
  const agentsConfig = config.agents;
  const hasList = hasPersistedOwn(agentsConfig, 'list');
  const hasEntries = hasPersistedOwn(agentsConfig, 'entries');
  if (hasList === hasEntries) {
    throw new OpenClawAgentConfigContractError(
      hasList
        ? 'OpenClaw agents config mixed list and entries roster contracts'
        : 'OpenClaw agents config did not expose a canonical roster contract',
    );
  }

  const normalizedIds = new Set<string>();
  if (hasList) {
    if (hasOwn(agentsConfig, 'entries')) {
      throw new OpenClawAgentConfigContractError(
        'OpenClaw agents config mixed list and entries roster contracts',
      );
    }
    const raw = agentsConfig.list;
    if (!Array.isArray(raw) || raw.length > MAX_CONFIG_AGENTS) {
      throw new OpenClawAgentConfigContractError('OpenClaw agents.list was not a bounded array');
    }
    for (const entry of raw) {
      if (!isOpenClawConfigRecord(entry) || !hasOwn(entry, 'id')) {
        throw new OpenClawAgentConfigContractError('OpenClaw agents.list contained an identity-less entry');
      }
      requireExactAgentId(entry.id, normalizedIds, 'OpenClaw agents.list');
    }
    return {
      family: '2026.7.1',
      storage: 'list',
      agentsConfig,
      list: raw,
    };
  }

  const raw = agentsConfig.entries;
  if (!isOpenClawConfigRecord(raw) || Object.keys(raw).length > MAX_CONFIG_AGENTS) {
    throw new OpenClawAgentConfigContractError('OpenClaw agents.entries was not a bounded keyed object');
  }
  for (const [id, entry] of Object.entries(raw)) {
    requireExactAgentId(id, normalizedIds, 'OpenClaw agents.entries');
    if (!isOpenClawConfigRecord(entry) || hasOwn(entry, 'id')) {
      throw new OpenClawAgentConfigContractError(
        'OpenClaw agents.entries contained an invalid keyed entry',
      );
    }
  }
  assertCompatibleAgentListProjection(
    agentsConfig,
    raw as Record<string, Record<string, any>>,
  );
  return {
    family: '2026.9.1',
    storage: 'entries',
    agentsConfig,
    entries: raw as Record<string, Record<string, any>>,
  };
}

export function materializeOpenClawAgentList(
  contract: OpenClawAgentConfigContract,
): Record<string, any>[] {
  return contract.storage === 'list'
    ? contract.list
    : Object.entries(contract.entries).map(([id, entry]) => ({ ...entry, id }));
}

export function exactOpenClawAgent(
  contract: OpenClawAgentConfigContract,
  agentId: string,
): Record<string, any> | null {
  const normalized = String(agentId || '').toLowerCase();
  const matches = materializeOpenClawAgentList(contract)
    .filter((entry) => String(entry.id || '').toLowerCase() === normalized);
  if (matches.length > 1) {
    throw new OpenClawAgentConfigContractError('OpenClaw agent identity was duplicated');
  }
  const match = matches[0] || null;
  if (match && match.id !== agentId) {
    throw new OpenClawAgentConfigContractError(
      'OpenClaw agent identity did not match the exact server-owned id',
    );
  }
  return match;
}

export function persistedOpenClawAgentEntry(agent: Record<string, any>): Record<string, any> {
  const { id: _id, ...entry } = agent;
  return entry;
}

export function collectOpenClawConfigArrayPaths(
  value: unknown,
  pathPrefix: string,
): string[] {
  if (Array.isArray(value)) return [pathPrefix];
  if (!isOpenClawConfigRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => (
    collectOpenClawConfigArrayPaths(child, `${pathPrefix}.${key}`)
  ));
}

export function buildOpenClawAgentRemovalPatch(
  contract: OpenClawAgentConfigContract,
  agentId: string,
): {
  raw: string;
  replacePaths: string[];
  expected: OpenClawAgentConfigContract;
} {
  const current = exactOpenClawAgent(contract, agentId);
  if (!current) {
    throw new OpenClawAgentConfigContractError('OpenClaw agent did not exist before removal');
  }
  if (contract.storage === 'list') {
    const list = contract.list.filter((entry) => entry.id !== agentId);
    return {
      raw: JSON.stringify({ agents: { list } }),
      replacePaths: ['agents.list'],
      expected: { ...contract, list },
    };
  }
  const entries = Object.fromEntries(
    Object.entries(contract.entries).filter(([id]) => id !== agentId),
  );
  return {
    raw: JSON.stringify({ agents: { entries: { [agentId]: null } } }),
    replacePaths: collectOpenClawConfigArrayPaths(
      contract.entries[agentId],
      `agents.entries.${agentId}`,
    ),
    expected: { ...contract, entries },
  };
}

export function openClawAgentRostersEqual(
  left: OpenClawAgentConfigContract,
  right: OpenClawAgentConfigContract,
): boolean {
  if (left.storage !== right.storage) return false;
  return JSON.stringify(left.storage === 'list' ? left.list : left.entries)
    === JSON.stringify(right.storage === 'list' ? right.list : right.entries);
}
