import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { requireApproved } from '../middleware/requireApproved';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';

const router = Router();

router.use(authenticateToken, requireApproved, requireAdmin);

const AUTOMATIONS_LIST_CACHE_TTL_MS = 5000;
let automationsListCache: { at: number; jobs: any[] } | null = null;
let automationsListInflight: Promise<any[]> | null = null;

type CronRpcResult = { ok: true; data: any } | { ok: false; error: string; data?: any };

type CronSchedule =
  | { kind: 'every'; everyMs: number }
  | { kind: 'cron'; expr: string; tz?: string };

type AutomationInput = {
  name?: string;
  message?: string;
  agent?: string;
  model?: string | null;
  thinking?: string | null;
  disabled?: boolean;
  tz?: string;
  schedule?: string;
  scheduleType?: 'interval' | 'hourly' | 'daily' | 'weekly' | 'custom';
  interval?: string;
  time?: string;
  dayOfWeek?: number;
};

const AUTOMATION_LIMITS = Object.freeze({
  id: 256,
  name: 200,
  message: 65_536,
  agent: 128,
  model: 256,
  thinking: 32,
  timezone: 100,
  cron: 256,
  minimumIntervalMs: 60_000,
  maximumIntervalMs: 365 * 24 * 60 * 60 * 1000,
});

const AUTOMATION_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive']);

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  if (typeof value !== 'string' || value.length > maxLength || hasControlCharacters(value)) return false;
  return allowEmpty || value.trim().length > 0;
}

function isValidAutomationId(value: unknown): value is string {
  return isBoundedString(value, AUTOMATION_LIMITS.id) && !/[\\/]/.test(value);
}

function isValidAgentId(value: string): boolean {
  return value.length <= AUTOMATION_LIMITS.agent && /^[a-zA-Z0-9_-]+$/.test(value);
}

function isValidModelId(value: string): boolean {
  return value.length <= AUTOMATION_LIMITS.model && /^[a-zA-Z0-9._:/-]+$/.test(value);
}

function isValidTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function isValidTimeZone(value: string): boolean {
  if (!isBoundedString(value, AUTOMATION_LIMITS.timezone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function isValidCronShape(value: string): boolean {
  if (!isBoundedString(value, AUTOMATION_LIMITS.cron)) return false;
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => /^[a-zA-Z0-9*?,/\-#LW]+$/.test(field));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientGatewayError(text: string): boolean {
  const normalized = String(text || '').toLowerCase();
  return normalized.includes('gateway connect failed')
    || normalized.includes('gateway not connected')
    || normalized.includes('gateway closed')
    || normalized.includes('gateway rpc timeout')
    || normalized.includes('connect challenge timeout')
    || normalized.includes('websocket closed unexpectedly')
    || normalized.includes('websocket error')
    || normalized.includes('econnrefused')
    || normalized.includes('socket hang up');
}

function formatGatewayRpcError(error: any): string {
  if (typeof error === 'string') return error;
  if (error?.message) return String(error.message);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error || 'Gateway RPC failed');
  }
}

function cronFailureStatus(error: string): number {
  const normalized = String(error || '').toLowerCase();
  if (normalized.includes('not found') || normalized.includes('unknown cron job id')) return 404;
  if (normalized.includes('invalid cron') || normalized.includes('invalid request') || normalized.includes('requires')) return 400;
  if (isTransientGatewayError(normalized)) return 503;
  return 502;
}

function sendCronFailure(res: Response, result: Extract<CronRpcResult, { ok: false }>, fallback: string): void {
  const message = result.error || fallback;
  res.status(cronFailureStatus(message)).json({ error: message });
}

async function runCronOnce(method: string, params: Record<string, any> = {}, timeoutMs = 30000): Promise<CronRpcResult> {
  const result = await gatewayRpcCall(method, params, timeoutMs);
  if (result.ok) return { ok: true, data: result.data };
  return { ok: false, error: formatGatewayRpcError(result.error), data: result.data };
}

async function runCron(method: string, params: Record<string, any> = {}, timeoutMs = 30000, retries = 0): Promise<CronRpcResult> {
  let lastResult: CronRpcResult | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await runCronOnce(method, params, timeoutMs);
    if (result.ok) return result;

    lastResult = result;
    const combined = `${result.error}
${JSON.stringify(result.data || {})}`;
    if (attempt >= retries || !isTransientGatewayError(combined)) {
      return result;
    }

    const delayMs = Math.min(3000, 500 * Math.pow(2, attempt));
    await sleep(delayMs);
  }
  return lastResult || { ok: false, error: 'Cron gateway call failed' };
}

function parseJsonLoose(output: string): any | null {
  const text = (output || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  const firstObject = text.match(/\{[\s\S]*\}$/);
  if (firstObject) {
    try { return JSON.parse(firstObject[0]); } catch { /* ignore */ }
  }
  const firstArray = text.match(/\[[\s\S]*\]$/);
  if (firstArray) {
    try { return JSON.parse(firstArray[0]); } catch { /* ignore */ }
  }
  return null;
}

function parseRuns(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.runs)) return payload.runs;
  if (Array.isArray(payload?.entries)) return payload.entries;
  if (Array.isArray(payload?.data?.entries)) return payload.data.entries;

  const output = typeof payload === 'string' ? payload : '';
  const json = parseJsonLoose(output);
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.runs)) return json.runs;
  if (Array.isArray(json?.entries)) return json.entries;
  if (Array.isArray(json?.data?.entries)) return json.data.entries;

  const lines = String(output || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const parsed: any[] = [];
  for (const line of lines) {
    if (!(line.startsWith('{') && line.endsWith('}'))) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // ignore malformed line
    }
  }
  return parsed;
}

function normalizeSingleJob(job: any): any {
  if (!job || typeof job !== 'object') return job;

  const schedule = job.schedule || {};
  let normalizedSchedule = schedule;
  if (schedule.kind === 'every' && schedule.everyMs) {
    const ms = Number(schedule.everyMs) || 0;
    const minutes = Math.round(ms / 60000);
    const hours = Math.round(ms / 3600000);
    normalizedSchedule = {
      ...schedule,
      expr: ms % 3600000 === 0 ? `0 */${Math.max(1, hours)} * * *` : `*/${Math.max(1, minutes)} * * * *`,
    };
  } else if (schedule.kind === 'at' && schedule.at) {
    normalizedSchedule = {
      ...schedule,
      expr: String(schedule.at),
    };
  }

  return {
    ...job,
    schedule: normalizedSchedule,
    payload: job.payload || {},
    enabled: job.enabled !== false,
  };
}

function normalizeJobs(payload: any): any[] {
  const jobs = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.jobs)
      ? payload.jobs
      : Array.isArray(payload?.data?.jobs)
        ? payload.data.jobs
        : [];
  return jobs.map(normalizeSingleJob);
}

function isPortalEditableAgentJob(job: any): boolean {
  return job?.payload?.kind === 'agentTurn' && job?.sessionTarget !== 'main';
}

async function requirePortalEditableAgentJob(id: string, res: Response): Promise<any | null> {
  const currentResult = await listAllCronJobs();
  if (!currentResult.ok) {
    sendCronFailure(res, currentResult, 'Failed to verify cron job type');
    return null;
  }
  const currentJob = normalizeJobs(currentResult.data).find((job: any) => job?.id === id);
  if (!currentJob) {
    res.status(404).json({ error: 'Cron job not found' });
    return null;
  }
  if (!isPortalEditableAgentJob(currentJob)) {
    res.status(409).json({ error: 'This cron job type must be managed in OpenClaw' });
    return null;
  }
  return currentJob;
}

async function listAllCronJobs(): Promise<CronRpcResult> {
  const limit = 200;
  let offset = 0;
  const jobs: any[] = [];

  for (let page = 0; page < 25; page += 1) {
    const result = await runCron('cron.list', { includeDisabled: true, limit, offset }, 30_000, 2);
    if (!result.ok) return result;

    const pageJobs = normalizeJobs(result.data);
    jobs.push(...pageJobs);

    if (!result.data?.hasMore) break;
    const nextOffset = Number(result.data?.nextOffset);
    offset = Number.isFinite(nextOffset) ? nextOffset : offset + pageJobs.length;
    if (offset <= 0 || pageJobs.length === 0) break;
  }

  return { ok: true, data: { jobs } };
}

function parseIntervalMs(raw: string | undefined): number | null {
  const value = String(raw || '').trim().toLowerCase();
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = match[2] || 'm';
  const multiplier = unit === 'ms'
    ? 1
    : unit === 's'
      ? 1000
      : unit === 'm'
        ? 60000
        : unit === 'h'
          ? 3600000
          : 86400000;

  const ms = Math.round(amount * multiplier);
  return ms >= AUTOMATION_LIMITS.minimumIntervalMs && ms <= AUTOMATION_LIMITS.maximumIntervalMs ? ms : null;
}

function buildSchedule(input: AutomationInput): CronSchedule | null {
  const { schedule, scheduleType, interval, time, dayOfWeek } = input || {};

  let cronExpr = '';
  if (scheduleType === 'custom' && schedule) {
    cronExpr = String(schedule).trim();
  } else if (scheduleType === 'interval' && interval) {
    const everyMs = parseIntervalMs(interval);
    return everyMs ? { kind: 'every', everyMs } : null;
  } else if (scheduleType === 'daily' && isValidTime(time)) {
    const [hour, minute] = String(time).split(':');
    cronExpr = `${parseInt(minute, 10)} ${parseInt(hour, 10)} * * *`;
  } else if (scheduleType === 'weekly' && isValidTime(time) && dayOfWeek !== undefined) {
    const [hour, minute] = String(time).split(':');
    cronExpr = `${parseInt(minute, 10)} ${parseInt(hour, 10)} * * ${Number(dayOfWeek)}`;
  } else if (scheduleType === 'hourly') {
    cronExpr = '0 * * * *';
  }

  if (!cronExpr) return null;
  const tz = input.tz?.trim();
  return tz ? { kind: 'cron', expr: cronExpr, tz } : { kind: 'cron', expr: cronExpr };
}

function validateAutomationInput(input: AutomationInput, mode: 'create' | 'update'): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'request body must be an object';
  if (mode === 'create') {
    if (!isBoundedString(input.name, AUTOMATION_LIMITS.name)) return 'name is required and must not exceed 200 characters';
    if (!isBoundedString(input.message, AUTOMATION_LIMITS.message)) return 'message is required and must not exceed 65536 characters';
    if (!input.scheduleType) return 'scheduleType is required';
  }

  if (input.name !== undefined && !isBoundedString(input.name, AUTOMATION_LIMITS.name)) return 'name cannot be empty or exceed 200 characters';
  if (input.message !== undefined && !isBoundedString(input.message, AUTOMATION_LIMITS.message)) return 'message cannot be empty or exceed 65536 characters';
  if (input.agent !== undefined && (!isBoundedString(input.agent, AUTOMATION_LIMITS.agent, true) || (input.agent.trim() && !isValidAgentId(input.agent.trim())))) {
    return 'agent must contain only letters, numbers, underscores, or hyphens';
  }
  if (input.model !== undefined && input.model !== null && (!isBoundedString(input.model, AUTOMATION_LIMITS.model, true) || (input.model.trim() && !isValidModelId(input.model.trim())))) {
    return 'model contains invalid characters or exceeds 256 characters';
  }
  if (input.thinking !== undefined && input.thinking !== null && (!isBoundedString(input.thinking, AUTOMATION_LIMITS.thinking, true) || (input.thinking.trim() && !AUTOMATION_THINKING_LEVELS.has(input.thinking.trim())))) {
    return 'thinking level is not supported';
  }
  if (input.tz !== undefined && (typeof input.tz !== 'string' || !isValidTimeZone(input.tz.trim()))) return 'timezone is invalid';
  if (input.disabled !== undefined && typeof input.disabled !== 'boolean') return 'disabled must be a boolean';

  switch (input.scheduleType) {
    case undefined:
      return mode === 'create' ? 'scheduleType is required' : null;
    case 'interval':
      return parseIntervalMs(input.interval) ? null : 'interval must be between 1 minute and 365 days';
    case 'daily':
      return isValidTime(input.time) ? null : 'time must be a valid 24-hour HH:MM value';
    case 'weekly':
      if (!isValidTime(input.time)) return 'time must be a valid 24-hour HH:MM value';
      if (!Number.isInteger(Number(input.dayOfWeek)) || Number(input.dayOfWeek) < 0 || Number(input.dayOfWeek) > 6) {
        return 'dayOfWeek must be between 0 and 6 for weekly schedules';
      }
      return null;
    case 'custom':
      return typeof input.schedule === 'string' && isValidCronShape(input.schedule)
        ? null
        : 'schedule must be a bounded five-field cron expression';
    case 'hourly':
      return null;
    default:
      return 'invalid scheduleType';
  }
}

function invalidateAutomationsListCache() {
  automationsListCache = null;
}

async function getCachedAutomationJobs(): Promise<any[]> {
  const now = Date.now();
  if (automationsListCache && (now - automationsListCache.at) < AUTOMATIONS_LIST_CACHE_TTL_MS) {
    return automationsListCache.jobs;
  }

  if (automationsListInflight) {
    return automationsListInflight;
  }

  automationsListInflight = (async () => {
    const result = await listAllCronJobs();
    if (!result.ok) {
      throw new Error(result.error || 'Failed to list cron jobs');
    }

    const jobs = normalizeJobs(result.data);
    automationsListCache = { at: Date.now(), jobs };
    return jobs;
  })();

  try {
    return await automationsListInflight;
  } finally {
    automationsListInflight = null;
  }
}

async function listAutomations(req: Request, res: Response) {
  let jobs: any[];
  try {
    jobs = [...await getCachedAutomationJobs()];
  } catch (error: any) {
    const message = error?.message || 'Failed to list cron jobs';
    res.status(cronFailureStatus(message)).json({ error: message });
    return;
  }
  const agentId = typeof req.query.agentId === 'string'
    ? req.query.agentId
    : (typeof req.query.agent === 'string' ? req.query.agent : undefined);

  if (agentId) {
    if (!isValidAgentId(agentId)) {
      res.status(400).json({ error: 'agentId is invalid' });
      return;
    }
    jobs = jobs.filter((job: any) => job?.agentId === agentId || job?.agent === agentId);
  }

  res.json({ jobs });
}

router.get('/', listAutomations);
router.get('/list', listAutomations);

router.get('/status', async (_req: Request, res: Response) => {
  const result = await runCron('cron.status', {}, 15_000, 2);
  if (!result.ok) {
    sendCronFailure(res, result, 'Failed to get scheduler status');
    return;
  }
  res.json(result.data || { status: 'unknown' });
});

router.post('/', async (req: Request, res: Response) => {
  const input = req.body as AutomationInput;
  const validationError = validateAutomationInput(input, 'create');
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { name, message, agent, model, thinking, disabled } = input;
  const schedule = buildSchedule(input);
  if (!schedule) {
    res.status(400).json({ error: 'invalid schedule' });
    return;
  }

  const payload: Record<string, any> = {
    kind: 'agentTurn',
    message: String(message).trim(),
  };
  if (typeof model === 'string' && model.trim()) payload.model = model.trim();
  if (typeof thinking === 'string' && thinking.trim() && thinking.trim() !== 'off') payload.thinking = thinking.trim();

  const jobCreate: Record<string, any> = {
    name: String(name).trim(),
    enabled: disabled !== true,
    schedule,
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload,
    // Portal automations have no external delivery target; announce mode with
    // nowhere to deliver marks every successful run as an error on OpenClaw
    // 2026.7.1. Run output is still captured in the runs history the UI shows.
    delivery: { mode: 'none' },
  };
  if (agent) jobCreate.agentId = String(agent).trim();

  const result = await runCron('cron.add', jobCreate, 45000);
  if (!result.ok) {
    sendCronFailure(res, result, 'Failed to create cron job');
    return;
  }
  invalidateAutomationsListCache();
  res.json({ ok: true, result: result.data });
});

router.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidAutomationId(id)) {
    res.status(400).json({ error: 'invalid automation id' });
    return;
  }
  const input = req.body as AutomationInput;
  const validationError = validateAutomationInput(input, 'update');
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  // The Portal editor only understands isolated agentTurn jobs. Refuse to
  // rewrite OpenClaw command/system jobs (or the main session) into a
  // different payload shape when a caller bypasses the disabled UI control.
  if (!(await requirePortalEditableAgentJob(id, res))) return;

  const { name, message, agent, model, thinking } = input;
  const patch: Record<string, any> = {};

  if (input.scheduleType !== undefined) {
    const schedule = buildSchedule(input);
    if (!schedule) {
      res.status(400).json({ error: 'invalid schedule' });
      return;
    }
    patch.schedule = schedule;
  }
  if (name !== undefined) patch.name = String(name).trim();
  if (agent !== undefined) patch.agentId = String(agent).trim() || null;

  const payload: Record<string, any> = { kind: 'agentTurn' };
  if (message !== undefined) payload.message = String(message).trim();
  if (model !== undefined) payload.model = model === null || !model.trim() ? null : model.trim();
  if (thinking !== undefined) payload.thinking = thinking === null || !thinking.trim() || thinking.trim() === 'off' ? null : thinking.trim();
  if (Object.keys(payload).length > 1) patch.payload = payload;
  // Normalize legacy announce delivery on edit: portal jobs have no delivery
  // target, and announce-with-no-target flags successful runs as errors.
  patch.delivery = { mode: 'none' };

  if (Object.keys(patch).length === 0) {
    res.json({ ok: true, result: null });
    return;
  }

  const result = await runCron('cron.update', { id, patch }, 45000);
  if (!result.ok) {
    sendCronFailure(res, result, 'Failed to update cron job');
    return;
  }
  invalidateAutomationsListCache();
  res.json({ ok: true, result: result.data });
});

router.post('/:id/toggle', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidAutomationId(id)) {
    res.status(400).json({ error: 'invalid automation id' });
    return;
  }
  const { enabled } = req.body || {};
  const current = await requirePortalEditableAgentJob(id, res);
  if (!current) return;

  let targetEnabled: boolean | null = null;
  if (typeof enabled === 'boolean') {
    targetEnabled = enabled;
  } else {
    targetEnabled = current.enabled === false;
  }

  const result = await runCron('cron.update', { id, patch: { enabled: targetEnabled } });
  if (!result.ok) {
    sendCronFailure(res, result, `Failed to ${targetEnabled ? 'enable' : 'disable'} cron job`);
    return;
  }
  invalidateAutomationsListCache();
  res.json({ ok: true, enabled: targetEnabled });
});

router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidAutomationId(id)) {
    res.status(400).json({ error: 'invalid automation id' });
    return;
  }
  if (!(await requirePortalEditableAgentJob(id, res))) return;
  const result = await runCron('cron.remove', { id }, 50000);
  if (!result.ok) {
    sendCronFailure(res, result, 'Failed to delete cron job');
    return;
  }
  invalidateAutomationsListCache();
  res.json({ ok: true });
});

router.post('/:id/run', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidAutomationId(id)) {
    res.status(400).json({ error: 'invalid automation id' });
    return;
  }
  if (!(await requirePortalEditableAgentJob(id, res))) return;
  const result = await runCron('cron.run', { id, mode: 'force' }, 20_000, 0);
  if (!result.ok) {
    sendCronFailure(res, result, 'Failed to run cron job');
    return;
  }
  invalidateAutomationsListCache();
  res.json({ ok: true, result: result.data });
});

router.get('/:id/runs', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidAutomationId(id)) {
    res.status(400).json({ error: 'invalid automation id' });
    return;
  }
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  const result = await runCron('cron.runs', { id, limit: safeLimit }, 30_000, 2);
  if (!result.ok) {
    const err = String(result.error || '').toLowerCase();
    if (err.includes('not found') || err.includes('no runs')) {
      res.json({ runs: [] });
      return;
    }
    sendCronFailure(res, result, 'Failed to get run history');
    return;
  }
  res.json({ runs: parseRuns(result.data) });
});

router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidAutomationId(id)) {
    res.status(400).json({ error: 'invalid automation id' });
    return;
  }
  let jobs: any[];
  try {
    jobs = await getCachedAutomationJobs();
  } catch (error: any) {
    const message = error?.message || 'Failed to fetch cron job';
    res.status(cronFailureStatus(message)).json({ error: message });
    return;
  }
  const job = jobs.find((entry: any) => entry?.id === id);
  if (!job) {
    res.status(404).json({ error: 'Cron job not found' });
    return;
  }
  res.json({ job });
});

export default router;
