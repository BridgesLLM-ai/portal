export interface UsageStatsPayload {
  totalSessions: number;
  activeSessions: number;
  cronJobs: number;
  activeCrons: number;
  modelBreakdown: Array<{ model: string; sessions: number }>;
  recentSessions: Array<{
    key: string;
    agent: string;
    model: string;
    lastActivity: number | null;
    turns: number | null;
  }>;
}

const ACTIVE_SESSION_WINDOW_MS = 60 * 60 * 1000;
const MAX_RECENT_SESSIONS = 20;
const MAX_MODEL_ROWS = 100;

export function normalizeUsageTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
  }

  let timestamp: number;
  if (typeof value === 'number') {
    timestamp = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    timestamp = /^\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  } else {
    return null;
  }

  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  // OpenClaw records have existed in both Unix-seconds and Unix-milliseconds
  // forms. Values below the year 5138 in milliseconds are safely seconds.
  if (timestamp < 100_000_000_000) timestamp *= 1000;
  // Tolerate microsecond/nanosecond values without leaking impossible dates to
  // the client if a runtime changes precision again.
  while (timestamp > 10_000_000_000_000) timestamp /= 1000;
  return Math.floor(timestamp);
}

function sessionLastActivity(session: any): number | null {
  for (const candidate of [
    session?.lastActivityMs,
    session?.lastActivity,
    session?.updatedAtMs,
    session?.updatedAt,
    session?.endedAt,
    session?.createdAt,
  ]) {
    const normalized = normalizeUsageTimestamp(candidate);
    if (normalized !== null) return normalized;
  }
  return null;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function sessionKey(session: any): string {
  const value = session?.sessionKey ?? session?.key ?? session?.id;
  return typeof value === 'string' ? value.trim() : '';
}

function sessionAgent(session: any): string {
  return String(session?.agentId || session?.agent || 'main');
}

function attachAgentId(session: unknown, agentId: string): any | null {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
  return { ...(session as Record<string, unknown>), agentId: (session as any).agentId || agentId };
}

/**
 * Normalize both Gateway/CLI session payload shapes. A null result means the
 * payload shape was not recognized and must not be presented as an empty list.
 */
export function normalizeUsageSessionsPayload(payload: unknown): any[] | null {
  if (Array.isArray(payload)) return payload.filter((session) => session && typeof session === 'object');
  if (!payload || typeof payload !== 'object') return null;

  const candidate = payload as any;
  if (Array.isArray(candidate.sessions)) {
    return candidate.sessions.filter((session: unknown) => session && typeof session === 'object');
  }
  if (candidate.agents && typeof candidate.agents === 'object' && !Array.isArray(candidate.agents)) {
    const sessions: any[] = [];
    for (const [agentId, agent] of Object.entries(candidate.agents)) {
      if (!Array.isArray((agent as any)?.sessions)) continue;
      for (const session of (agent as any).sessions) {
        const normalized = attachAgentId(session, agentId);
        if (normalized) sessions.push(normalized);
      }
    }
    return sessions;
  }
  return null;
}

/** Normalize Gateway and CLI cron-list payloads without turning errors into zero jobs. */
export function normalizeUsageCronJobsPayload(payload: unknown): any[] | null {
  if (Array.isArray(payload)) return payload.filter((job) => job && typeof job === 'object');
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as any;
  if (Array.isArray(candidate.jobs)) return candidate.jobs;
  if (Array.isArray(candidate.data?.jobs)) return candidate.data.jobs;
  return null;
}

export function isValidUsageAgentFilter(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

export function buildUsageStatsPayload(
  sessionsInput: unknown,
  cronJobsInput: unknown,
  selectedAgent: string,
  normalizeModel: (value: unknown) => string,
  now = Date.now(),
): UsageStatsPayload {
  const sessions = Array.isArray(sessionsInput) ? sessionsInput : [];
  const cronJobs = Array.isArray(cronJobsInput) ? cronJobsInput : [];
  const agentFilteredSessions = selectedAgent
    ? sessions.filter((session: any) => sessionAgent(session) === selectedAgent)
    : sessions;
  const agentFilteredCrons = selectedAgent
    ? cronJobs.filter((job: any) => String(job?.agentId || job?.agent || 'main') === selectedAgent)
    : cronJobs;

  const normalizedSessions = agentFilteredSessions.map((session: any) => ({
    source: session,
    key: sessionKey(session),
    agent: sessionAgent(session),
    model: normalizeModel(session?.model ?? session?.defaultModel) || 'unknown',
    lastActivity: sessionLastActivity(session),
    turns: optionalNonNegativeInteger(session?.turns ?? session?.turnCount),
  }));

  const modelCounts = new Map<string, number>();
  for (const session of normalizedSessions) {
    modelCounts.set(session.model, (modelCounts.get(session.model) || 0) + 1);
  }

  const recentSessions = normalizedSessions
    .filter((session) => session.key.length > 0)
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
    .slice(0, MAX_RECENT_SESSIONS)
    .map(({ source: _source, ...session }) => session);

  return {
    totalSessions: normalizedSessions.length,
    activeSessions: normalizedSessions.filter((session) => (
      session.lastActivity !== null
      && session.lastActivity <= now
      && now - session.lastActivity < ACTIVE_SESSION_WINDOW_MS
    )).length,
    cronJobs: agentFilteredCrons.length,
    activeCrons: agentFilteredCrons.filter((job: any) => job?.enabled !== false).length,
    modelBreakdown: Array.from(modelCounts.entries())
      .map(([model, count]) => ({ model, sessions: count }))
      .sort((a, b) => b.sessions - a.sessions || a.model.localeCompare(b.model))
      .slice(0, MAX_MODEL_ROWS),
    recentSessions,
  };
}
