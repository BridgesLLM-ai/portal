import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { execFile } from 'child_process';

const router = Router();

router.use(authenticateToken, requireAdmin);

type CronResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string; stdout: string; stderr: string };

type AutomationInput = {
  name?: string;
  message?: string;
  agent?: string;
  model?: string;
  thinking?: string;
  disabled?: boolean;
  tz?: string;
  schedule?: string;
  scheduleType?: 'interval' | 'hourly' | 'daily' | 'weekly' | 'custom';
  interval?: string;
  time?: string;
  dayOfWeek?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientGatewayError(text: string): boolean {
  const normalized = String(text || '').toLowerCase();
  return normalized.includes('gateway connect failed')
    || normalized.includes('gateway not connected')
    || normalized.includes('gateway closed')
    || normalized.includes('connect challenge timeout')
    || normalized.includes('econnrefused')
    || normalized.includes('socket hang up');
}

function runCronOnce(args: string[], timeoutMs = 30000): Promise<CronResult> {
  return new Promise((resolve) => {
    execFile('openclaw', ['cron', ...args], { timeout: timeoutMs, encoding: 'utf-8' }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          error: (stderr || error.message || 'Cron command failed').trim(),
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function runCron(args: string[], timeoutMs = 30000, retries = 5): Promise<CronResult> {
  let lastResult: CronResult | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await runCronOnce(args, timeoutMs);
    if (result.ok) return result;

    lastResult = result;
    const combined = `${result.error}\n${result.stderr}\n${result.stdout}`;
    if (attempt >= retries || !isTransientGatewayError(combined)) {
      return result;
    }

    const delayMs = Math.min(3000, 500 * Math.pow(2, attempt));
    await sleep(delayMs);
  }
  return lastResult || { ok: false, error: 'Cron command failed', stdout: '', stderr: '' };
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

function parseRuns(output: string): any[] {
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

function buildScheduleArgs(input: AutomationInput): string[] {
  const args: string[] = [];
  const { schedule, scheduleType, interval, time, dayOfWeek } = input || {};

  let cronExpr = '';
  if (scheduleType === 'custom' && schedule) {
    cronExpr = String(schedule).trim();
  } else if (scheduleType === 'interval' && interval) {
    args.push('--every', String(interval).trim());
  } else if (scheduleType === 'daily' && time) {
    const [hour, minute] = String(time).split(':');
    cronExpr = `${parseInt(minute, 10)} ${parseInt(hour, 10)} * * *`;
  } else if (scheduleType === 'weekly' && time && dayOfWeek !== undefined) {
    const [hour, minute] = String(time).split(':');
    cronExpr = `${parseInt(minute, 10)} ${parseInt(hour, 10)} * * ${Number(dayOfWeek)}`;
  } else if (scheduleType === 'hourly') {
    cronExpr = '0 * * * *';
  }

  if (cronExpr) args.push('--cron', cronExpr);
  return args;
}

function scheduleUsesCron(input: AutomationInput): boolean {
  switch (input.scheduleType) {
    case 'custom':
    case 'daily':
    case 'weekly':
    case 'hourly':
      return true;
    default:
      return false;
  }
}

function validateAutomationInput(input: AutomationInput, mode: 'create' | 'update'): string | null {
  if (mode === 'create') {
    if (!input.name?.trim()) return 'name is required';
    if (!input.message?.trim()) return 'message is required';
    if (!input.scheduleType) return 'scheduleType is required';
  }

  if (input.name !== undefined && !String(input.name).trim()) return 'name cannot be empty';
  if (input.message !== undefined && !String(input.message).trim()) return 'message cannot be empty';

  switch (input.scheduleType) {
    case undefined:
      return mode === 'create' ? 'scheduleType is required' : null;
    case 'interval':
      return input.interval?.trim() ? null : 'interval is required for interval schedules';
    case 'daily':
      return input.time?.trim() ? null : 'time is required for daily schedules';
    case 'weekly':
      if (!input.time?.trim()) return 'time is required for weekly schedules';
      if (!Number.isInteger(Number(input.dayOfWeek)) || Number(input.dayOfWeek) < 0 || Number(input.dayOfWeek) > 6) {
        return 'dayOfWeek must be between 0 and 6 for weekly schedules';
      }
      return null;
    case 'custom':
      return input.schedule?.trim() ? null : 'schedule is required for custom schedules';
    case 'hourly':
      return null;
    default:
      return 'invalid scheduleType';
  }
}

async function listAutomations(req: Request, res: Response) {
  const result = await runCron(['list', '--json', '--all']);
  if (!result.ok) {
    res.status(500).json({ error: result.error || 'Failed to list cron jobs' });
    return;
  }

  const parsed = parseJsonLoose(result.stdout);
  let jobs = normalizeJobs(parsed);
  const agentId = typeof req.query.agentId === 'string'
    ? req.query.agentId
    : (typeof req.query.agent === 'string' ? req.query.agent : undefined);

  if (agentId) {
    jobs = jobs.filter((job: any) => job?.agentId === agentId || job?.agent === agentId);
  }

  res.json({ jobs });
}

router.get('/', listAutomations);
router.get('/list', listAutomations);

router.get('/status', async (_req: Request, res: Response) => {
  const result = await runCron(['status', '--json']);
  if (!result.ok) {
    res.status(500).json({ error: result.error || 'Failed to get scheduler status' });
    return;
  }
  res.json(parseJsonLoose(result.stdout) || { status: 'unknown', raw: result.stdout.trim() });
});

router.post('/', async (req: Request, res: Response) => {
  const input = req.body as AutomationInput;
  const validationError = validateAutomationInput(input, 'create');
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { name, message, agent, model, thinking, disabled, tz } = input;
  const args: string[] = ['add', '--json', '--name', String(name).trim(), '--message', String(message).trim(), '--session', 'isolated'];
  args.push(...buildScheduleArgs(input));
  if (tz && scheduleUsesCron(input)) args.push('--tz', String(tz));
  if (agent) args.push('--agent', String(agent));
  if (model) args.push('--model', String(model));
  if (thinking) args.push('--thinking', String(thinking));
  if (disabled) args.push('--disabled');

  const result = await runCron(args, 45000);
  if (!result.ok) {
    res.status(500).json({ error: result.error || 'Failed to create cron job' });
    return;
  }
  res.json({ ok: true, result: parseJsonLoose(result.stdout) || { message: result.stdout.trim() } });
});

router.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const input = req.body as AutomationInput;
  const validationError = validateAutomationInput(input, 'update');
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { name, message, agent, model, thinking, tz } = input;
  const args: string[] = ['edit', id];
  args.push(...buildScheduleArgs(input));
  if (name) args.push('--name', String(name).trim());
  if (message) args.push('--message', String(message).trim());
  if (tz && scheduleUsesCron(input)) args.push('--tz', String(tz));
  if (agent) args.push('--agent', String(agent));
  if (model) args.push('--model', String(model));
  if (thinking) args.push('--thinking', String(thinking));

  const result = await runCron(args, 45000);
  if (!result.ok) {
    res.status(500).json({ error: result.error || 'Failed to update cron job' });
    return;
  }
  res.json({ ok: true, result: parseJsonLoose(result.stdout) || { message: result.stdout.trim() } });
});

router.post('/:id/toggle', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { enabled } = req.body || {};

  let targetEnabled: boolean | null = null;
  if (typeof enabled === 'boolean') {
    targetEnabled = enabled;
  } else {
    const listResult = await runCron(['list', '--json', '--all']);
    if (!listResult.ok) {
      res.status(500).json({ error: listResult.error || 'Failed to read current cron state' });
      return;
    }
    const jobs = normalizeJobs(parseJsonLoose(listResult.stdout));
    const current = jobs.find((job: any) => job?.id === id);
    if (!current) {
      res.status(404).json({ error: 'Cron job not found' });
      return;
    }
    targetEnabled = current.enabled === false;
  }

  const result = await runCron([targetEnabled ? 'enable' : 'disable', id]);
  if (!result.ok) {
    res.status(500).json({ error: result.error || `Failed to ${targetEnabled ? 'enable' : 'disable'} cron job` });
    return;
  }
  res.json({ ok: true, enabled: targetEnabled });
});

router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await runCron(['rm', id, '--json', '--timeout', '45000'], 50000);
  if (!result.ok) {
    res.status(500).json({ error: result.error || 'Failed to delete cron job' });
    return;
  }
  res.json({ ok: true });
});

router.post('/:id/run', async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await runCron(['run', id, '--timeout', '120000', '--expect-final'], 125000, 0);
  if (!result.ok) {
    res.status(500).json({ error: result.error || 'Failed to run cron job' });
    return;
  }
  res.json({ ok: true, result: parseJsonLoose(result.stdout) || { message: result.stdout.trim() } });
});

router.get('/:id/runs', async (req: Request, res: Response) => {
  const { id } = req.params;
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  const result = await runCron(['runs', '--id', id, '--limit', String(safeLimit)], 45000);
  if (!result.ok) {
    const err = String(result.error || '').toLowerCase();
    if (err.includes('not found') || err.includes('no runs')) {
      res.json({ runs: [] });
      return;
    }
    res.status(500).json({ error: result.error || 'Failed to get run history' });
    return;
  }
  res.json({ runs: parseRuns(result.stdout) });
});

router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await runCron(['list', '--json', '--all']);
  if (!result.ok) {
    res.status(500).json({ error: result.error || 'Failed to fetch cron job' });
    return;
  }
  const jobs = normalizeJobs(parseJsonLoose(result.stdout));
  const job = jobs.find((entry: any) => entry?.id === id);
  if (!job) {
    res.status(404).json({ error: 'Cron job not found' });
    return;
  }
  res.json({ job });
});

export default router;
