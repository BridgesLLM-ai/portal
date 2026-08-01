import { promises as fs } from 'fs';
import path from 'path';
import {
  normalizeUsageCronJobsPayload,
  normalizeUsageSessionsPayload,
} from './usageStats';

interface GatewayResult {
  ok: boolean;
  data?: any;
}

export interface UsageStatsSourceDependencies {
  gatewayCall: (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<GatewayResult>;
  runOpenClaw: (args: string[], timeoutMs: number) => Promise<string>;
  agentsDir: string;
  readDir?: (directory: string) => Promise<string[]>;
  readFile?: (file: string) => Promise<string>;
}

export interface UsageStatsSources {
  sessions: any[];
  cronJobs: any[];
}

const SESSION_PAGE_SIZE = 200;
const SESSION_PAGE_LIMIT = 50;
const CRON_PAGE_SIZE = 200;
const CRON_PAGE_LIMIT = 25;

export class UsageStatsUnavailableError extends Error {
  readonly statusCode = 503;

  constructor(source: 'sessions' | 'automations') {
    super(`${source === 'sessions' ? 'Session' : 'Automation'} usage data is temporarily unavailable`);
    this.name = 'UsageStatsUnavailableError';
  }
}

function nextPageOffset(data: any, currentOffset: number, pageLength: number): number | null {
  if (!data?.hasMore) return null;
  const explicit = Number(data?.nextOffset);
  const next = Number.isFinite(explicit) ? explicit : currentOffset + pageLength;
  return next > currentOffset ? next : null;
}

async function loadGatewaySessions(
  selectedAgent: string,
  gatewayCall: UsageStatsSourceDependencies['gatewayCall'],
): Promise<any[] | null> {
  const sessions: any[] = [];
  let offset = 0;

  for (let page = 0; page < SESSION_PAGE_LIMIT; page += 1) {
    let result: GatewayResult;
    try {
      result = await gatewayCall('sessions.list', {
        limit: SESSION_PAGE_SIZE,
        offset,
        ...(selectedAgent ? { agentId: selectedAgent } : {}),
      }, 10_000);
    } catch {
      return null;
    }
    if (!result.ok) return null;
    const rows = normalizeUsageSessionsPayload(result.data);
    if (rows === null) return null;
    sessions.push(...rows);

    const next = nextPageOffset(result.data, offset, rows.length);
    if (next === null) return result.data?.hasMore ? null : sessions;
    offset = next;
  }
  return null;
}

function normalizeStoredSessions(payload: unknown, agentId: string): any[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const source = Array.isArray((payload as any).sessions) ? (payload as any).sessions : payload;
  const rows = Array.isArray(source) ? source : Object.values(source);
  return rows.flatMap((session) => {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return [];
    return [{ ...(session as Record<string, unknown>), agentId: (session as any).agentId || agentId }];
  });
}

async function loadStoredSessions(
  selectedAgent: string,
  dependencies: UsageStatsSourceDependencies,
): Promise<any[] | null> {
  const readDir = dependencies.readDir || ((directory: string) => fs.readdir(directory));
  const readFile = dependencies.readFile || ((file: string) => fs.readFile(file, 'utf8'));
  let agentIds: string[];
  try {
    agentIds = await readDir(dependencies.agentsDir);
  } catch {
    return null;
  }

  const relevantAgentIds = selectedAgent ? agentIds.filter((agentId) => agentId === selectedAgent) : agentIds;
  const sessions: any[] = [];
  for (const agentId of relevantAgentIds) {
    const sessionsFile = path.join(dependencies.agentsDir, agentId, 'sessions', 'sessions.json');
    let raw: string;
    try {
      raw = await readFile(sessionsFile);
    } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      return null;
    }
    try {
      const rows = normalizeStoredSessions(JSON.parse(raw), agentId);
      if (rows === null) return null;
      sessions.push(...rows);
    } catch {
      return null;
    }
  }
  return sessions;
}

async function loadCliSessions(
  selectedAgent: string,
  runOpenClaw: UsageStatsSourceDependencies['runOpenClaw'],
): Promise<any[] | null> {
  const args = ['sessions', '--json', '--limit', 'all'];
  args.push(...(selectedAgent ? ['--agent', selectedAgent] : ['--all-agents']));
  try {
    const payload = JSON.parse(await runOpenClaw(args, 30_000));
    return normalizeUsageSessionsPayload(payload);
  } catch {
    return null;
  }
}

async function loadSessions(
  selectedAgent: string,
  dependencies: UsageStatsSourceDependencies,
): Promise<any[]> {
  const gatewaySessions = await loadGatewaySessions(selectedAgent, dependencies.gatewayCall);
  if (gatewaySessions !== null) return gatewaySessions;

  const storedSessions = await loadStoredSessions(selectedAgent, dependencies);
  if (storedSessions !== null) return storedSessions;

  const cliSessions = await loadCliSessions(selectedAgent, dependencies.runOpenClaw);
  if (cliSessions !== null) return cliSessions;
  throw new UsageStatsUnavailableError('sessions');
}

async function loadGatewayCronJobs(
  selectedAgent: string,
  gatewayCall: UsageStatsSourceDependencies['gatewayCall'],
): Promise<any[] | null> {
  const jobs: any[] = [];
  let offset = 0;
  for (let page = 0; page < CRON_PAGE_LIMIT; page += 1) {
    let result: GatewayResult;
    try {
      result = await gatewayCall('cron.list', {
        includeDisabled: true,
        limit: CRON_PAGE_SIZE,
        offset,
        ...(selectedAgent ? { agentId: selectedAgent } : {}),
      }, 10_000);
    } catch {
      return null;
    }
    if (!result.ok) return null;
    const rows = normalizeUsageCronJobsPayload(result.data);
    if (rows === null) return null;
    jobs.push(...rows);

    const next = nextPageOffset(result.data, offset, rows.length);
    if (next === null) return result.data?.hasMore ? null : jobs;
    offset = next;
  }
  return null;
}

async function loadCliCronJobs(
  selectedAgent: string,
  runOpenClaw: UsageStatsSourceDependencies['runOpenClaw'],
): Promise<any[] | null> {
  const args = ['cron', 'list', '--json', '--all'];
  if (selectedAgent) args.push('--agent', selectedAgent);
  try {
    const payload = JSON.parse(await runOpenClaw(args, 10_000));
    return normalizeUsageCronJobsPayload(payload);
  } catch {
    return null;
  }
}

async function loadCronJobs(
  selectedAgent: string,
  dependencies: UsageStatsSourceDependencies,
): Promise<any[]> {
  const gatewayJobs = await loadGatewayCronJobs(selectedAgent, dependencies.gatewayCall);
  if (gatewayJobs !== null) return gatewayJobs;
  const cliJobs = await loadCliCronJobs(selectedAgent, dependencies.runOpenClaw);
  if (cliJobs !== null) return cliJobs;
  throw new UsageStatsUnavailableError('automations');
}

export async function loadUsageStatsSources(
  selectedAgent: string,
  dependencies: UsageStatsSourceDependencies,
): Promise<UsageStatsSources> {
  const [sessions, cronJobs] = await Promise.all([
    loadSessions(selectedAgent, dependencies),
    loadCronJobs(selectedAgent, dependencies),
  ]);
  return { sessions, cronJobs };
}
