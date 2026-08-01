import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { requireApproved } from '../middleware/requireApproved';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { AgentJobRequestError, startAgentJob } from '../services/agentJobs';
import {
  confirmationForPluginInstall,
  confirmationForSkillInstall,
  confirmationForSkillUninstall,
  isTypedConfirmationMatch,
} from '../utils/privilegedConfirmation';

const router = Router();
const EXTENSION_MUTATION_TIMEOUT = '15m';

router.use(authenticateToken, requireApproved, requireAdmin);

/* ─── Helpers ────────────────────────────────────────────── */

// CLI calls run async so multi-second skills/plugins listings cannot block the
// event loop (the old spawnSync version stalled every other request while a
// listing ran).
function runCli(command: string, args: string[], timeout = 15000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(error);
        return;
      }
      if (error && (error as any).code !== 0 && !stdout) {
        reject(new Error(stderr || stdout || `${command} ${args.join(' ')} failed`));
        return;
      }
      if (error && !stdout && !stderr) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function runOpenClaw(args: string[], timeout = 15000): Promise<string> {
  const { stdout, stderr } = await runCli('openclaw', args, timeout);
  return stdout || stderr;
}

async function runClawHub(args: string[], timeout = 30000): Promise<string> {
  const { stdout, stderr } = await runCli('clawhub', args, timeout);
  return stdout || stderr;
}

// Skills/plugins listings shell out to the OpenClaw CLI and take seconds; the
// results only change when something is installed, so serve a short cache and
// bust it on any mutation.
const SKILLS_CACHE_TTL_MS = 60_000;
const skillsListCache = new Map<string, { at: number; payload: any }>();

function bustSkillsCache(): void {
  skillsListCache.clear();
}

async function cachedListing<T>(key: string, loader: () => Promise<T>, force = false): Promise<T> {
  const cached = skillsListCache.get(key);
  if (!force && cached && Date.now() - cached.at < SKILLS_CACHE_TTL_MS) return cached.payload as T;
  const payload = await loader();
  skillsListCache.set(key, { at: Date.now(), payload });
  return payload;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveOpenClawWorkspace(): string {
  return path.resolve(
    process.env.OPENCLAW_WORKSPACE
      || path.join(process.env.HOME || '/root', '.openclaw', 'workspace-main'),
  );
}

function readManagedSkillNames(): Set<string> {
  try {
    const lockPath = path.join(resolveOpenClawWorkspace(), '.clawhub', 'lock.json');
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return new Set();
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const skills = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { skills?: unknown }).skills
      : null;
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return new Set();
    return new Set(Object.keys(skills as Record<string, unknown>));
  } catch {
    return new Set();
  }
}

function isSafeSkillName(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value)
    || /^@[a-z0-9][a-z0-9_-]{0,62}\/[a-z0-9][a-z0-9_-]{0,62}$/i.test(value);
}

function isSafeMutationValue(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

async function startSkillsMutation(input: {
  userId: string;
  actorAuthorizationVersion: number;
  toolId: string;
  title: string;
  executable: string;
  args: string[];
}) {
  bustSkillsCache();
  const operation = [input.executable, ...input.args].map(shellQuote).join(' ');
  const script = ['set -euo pipefail', operation].join('\n');
  const serializedCommand = [
    'flock',
    '--nonblock',
    '/run/bridgesllm-agent-mutation.lock',
    '--',
    'timeout',
    '--foreground',
    '--kill-after=30s',
    EXTENSION_MUTATION_TIMEOUT,
    '/bin/bash',
    '-lc',
    script,
  ];
  return startAgentJob({
    userId: input.userId,
    actorAuthorizationVersion: input.actorAuthorizationVersion,
    toolId: input.toolId,
    title: input.title,
    command: serializedCommand.map(shellQuote).join(' '),
    cwd: resolveOpenClawWorkspace(),
  });
}

function mutationErrorStatus(error: unknown): number {
  return error instanceof AgentJobRequestError ? error.statusCode : 500;
}

function isMissingClawHubError(err: unknown): boolean {
  return err instanceof Error && ((err as NodeJS.ErrnoException).code === 'ENOENT' || /spawnSync clawhub ENOENT/.test(err.message));
}

/** Extract the first JSON object or array from a string (handles ANSI/banner preamble). */
function parseJson(raw: string) {
  const trimmed = raw.trim();
  const candidates = [trimmed.indexOf('{'), trimmed.indexOf('[')].filter((n) => n >= 0);
  if (candidates.length === 0) throw new Error('No JSON found in output');
  const start = Math.min(...candidates);
  return JSON.parse(trimmed.slice(start));
}

/**
 * Parse `clawhub search` text output into structured results.
 * Lines look like:  `skill-slug  Title Words  (0.987)`
 * There's a leading spinner line `- Searching` we skip.
 */
function parseSearchOutput(raw: string): { name: string; description?: string; score?: number }[] {
  const results: { name: string; description?: string; score?: number }[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('-') || trimmed.startsWith('✓') || trimmed.startsWith('�') || trimmed.startsWith('⡀') || trimmed.startsWith('|')) continue;
    // Pattern: slug  title/summary-ish text  (score)
    const match = trimmed.match(/^(\S+)\s+(.+?)\s+\(([0-9.]+)\)\s*$/);
    if (match) {
      results.push({
        name: match[1],
        description: match[2].trim() || undefined,
        score: parseFloat(match[3]),
      });
      continue;
    }
    const bare = trimmed.match(/^(\S+)$/);
    if (bare) results.push({ name: bare[1] });
  }
  return results;
}

function normalizeMarketplaceItem(item: any) {
  const skill = item?.skill ?? item;
  const latestVersion = item?.latestVersion ?? item?.version ?? null;
  const owner = item?.owner ?? null;
  const name = skill?.slug || item?.slug || skill?.name || item?.name || skill?.displayName || item?.displayName;
  const description = skill?.summary || item?.summary || skill?.description || item?.description;
  const downloads = skill?.stats?.downloads ?? item?.stats?.downloads ?? item?.downloads;
  const score = item?.score;
  const author = owner?.displayName || owner?.handle || item?.author;
  const version = latestVersion?.version || item?.version || skill?.version;
  const updatedAt = skill?.updatedAt || item?.updatedAt;
  return {
    name,
    slug: skill?.slug || item?.slug || name,
    description,
    version,
    author,
    downloads,
    score,
    updatedAt,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function enrichMarketplaceResults(results: any[], inspectLimit = 8) {
  const enrichedItems = await mapWithConcurrency(results, 3, async (item, index) => {
    const normalized = normalizeMarketplaceItem(item);
    if ((normalized.description && normalized.author) || !normalized.slug || index >= inspectLimit) {
      return normalized;
    }
    try {
      const raw = await runClawHub(['inspect', normalized.slug, '--json'], 15000);
      const parsed = parseJson(raw);
      const enriched = normalizeMarketplaceItem(parsed);
      return {
        ...normalized,
        ...enriched,
        score: normalized.score ?? enriched.score,
      };
    } catch {
      return normalized;
    }
  });
  return enrichedItems.filter(item => item.name);
}

/* ─── Routes ─────────────────────────────────────────────── */

/** GET /api/skills — list all locally available skills (openclaw skills list --json) */
router.get('/', async (req: Request, res: Response) => {
  try {
    const raw = await cachedListing(
      'skills',
      () => runOpenClaw(['skills', 'list', '--json']),
      req.query.refresh === '1',
    );
    const parsed = parseJson(raw);
    const listedSkills = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.skills) ? parsed.skills : []);
    const managedNames = readManagedSkillNames();
    const skills = listedSkills.map((skill: any) => (
      managedNames.has(String(skill?.name || ''))
        ? { ...skill, source: 'managed', managed: true }
        : skill
    ));
    res.json({ skills });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list skills';
    res.status(500).json({ error: message });
  }
});

/** GET /api/skills/search?q=<query> — search marketplace via clawhub */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) {
      res.status(400).json({ error: 'Query required' });
      return;
    }
    if (query.length > 200) {
      res.status(400).json({ error: 'Query exceeds 200 characters' });
      return;
    }

    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 50);
    const raw = await runClawHub(['search', query, '--limit', String(limit)]);
    const results = await enrichMarketplaceResults(parseSearchOutput(raw), Math.min(limit, 10));
    res.json({ available: true, results });
  } catch (err) {
    if (isMissingClawHubError(err)) {
      res.json({ available: false, results: [], error: 'ClawHub CLI is not installed on this server.' });
      return;
    }
    const message = err instanceof Error ? err.message : 'Marketplace search failed';
    res.status(500).json({ error: message });
  }
});

/** GET /api/skills/explore — browse marketplace (clawhub explore --json, with search fallback) */
router.get('/explore', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '25'), 10) || 25, 1), 100);
    const sort = String(req.query.sort || 'trending');
    const allowedSorts = ['newest', 'downloads', 'rating', 'installs', 'installsAllTime', 'trending'];
    const safeSort = allowedSorts.includes(sort) ? sort : 'trending';

    let results: unknown[] = [];

    // Try explore first (needs clawhub auth)
    try {
      const raw = await runClawHub(['explore', '--json', '--limit', String(limit), '--sort', safeSort]);
      const parsed = parseJson(raw);
      const items = Array.isArray(parsed) ? parsed : (parsed?.items ?? parsed?.skills ?? []);
      if (Array.isArray(items) && items.length > 0) {
        results = items;
      }
    } catch {
      // explore failed (not logged in, etc.) — fall through to search fallback
    }

    // Fallback: run popular search queries to simulate browsing
    if (results.length === 0) {
      const fallbackQueries = ['automation', 'weather', 'github', 'docker', 'ai'];
      const seen = new Set<string>();
      const fallbackResults = await mapWithConcurrency(fallbackQueries, 2, async (q) => {
        try {
          const raw = await runClawHub(['search', q, '--limit', '10']);
          return parseSearchOutput(raw);
        } catch {
          return [];
        }
      });
      for (const queryResults of fallbackResults) {
        for (const item of queryResults) {
          if (seen.has(item.name)) continue;
          seen.add(item.name);
          results.push(item);
          if (results.length >= limit) break;
        }
        if (results.length >= limit) break;
      }
      results = results.slice(0, limit);
    }

    res.json({ results: await enrichMarketplaceResults(results, Math.min(limit, 10)) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Marketplace explore failed';
    res.status(500).json({ error: message });
  }
});

/** GET /api/skills/inspect/:slug — get detailed marketplace info (clawhub inspect --json) */
router.get('/inspect/:slug', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug;
    if (!slug || !isSafeSkillName(slug)) {
      res.status(400).json({ error: 'Invalid skill slug' });
      return;
    }

    const raw = await runClawHub(['inspect', slug, '--json']);
    const parsed = parseJson(raw);
    res.json(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Inspect failed';
    res.status(500).json({ error: message });
  }
});

/** POST /api/skills/install — install a skill from clawhub marketplace */
router.post('/install', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!isSafeMutationValue(name, 128)) {
      res.status(400).json({ error: 'Skill name required' });
      return;
    }

    // Allow ClawHub's unscoped and @scope/name skill identifiers only.
    if (!isSafeSkillName(name)) {
      res.status(400).json({ error: 'Invalid skill name' });
      return;
    }
    const confirmationPhrase = confirmationForSkillInstall(name);
    if (!isTypedConfirmationMatch(confirmationPhrase, req.body?.confirmation)) {
      res.status(400).json({ error: `Type ${confirmationPhrase} to confirm this host-wide skill installation.`, confirmationPhrase });
      return;
    }
    const job = await startSkillsMutation({
      userId: req.user!.userId,
      actorAuthorizationVersion: Number(req.user!.authorizationVersion ?? 1),
      toolId: `_skill:install:${name}`,
      title: `Install skill ${name}`,
      executable: 'clawhub',
      args: ['--no-input', '--workdir', resolveOpenClawWorkspace(), 'install', name],
    });
    res.status(202).json({ ok: true, jobId: job.id, room: `job:${job.id}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Install failed';
    res.status(mutationErrorStatus(err)).json({ error: message });
  }
});

/** POST /api/skills/uninstall — uninstall a clawhub skill */
router.post('/uninstall', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!isSafeMutationValue(name, 128)) {
      res.status(400).json({ error: 'Skill name required' });
      return;
    }

    if (!isSafeSkillName(name)) {
      res.status(400).json({ error: 'Invalid skill name' });
      return;
    }
    if (!readManagedSkillNames().has(name)) {
      res.status(409).json({
        error: 'Only skills tracked as ClawHub-managed can be removed here. Bundled and workspace skills are protected.',
      });
      return;
    }
    const confirmationPhrase = confirmationForSkillUninstall(name);
    if (!isTypedConfirmationMatch(confirmationPhrase, req.body?.confirmation)) {
      res.status(400).json({ error: `Type ${confirmationPhrase} to confirm this host-wide skill removal.`, confirmationPhrase });
      return;
    }
    const job = await startSkillsMutation({
      userId: req.user!.userId,
      actorAuthorizationVersion: Number(req.user!.authorizationVersion ?? 1),
      toolId: `_skill:uninstall:${name}`,
      title: `Uninstall skill ${name}`,
      executable: 'clawhub',
      args: ['--no-input', '--workdir', resolveOpenClawWorkspace(), 'uninstall', '--yes', name],
    });
    res.status(202).json({ ok: true, jobId: job.id, room: `job:${job.id}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Uninstall failed';
    res.status(mutationErrorStatus(err)).json({ error: message });
  }
});

/** GET /api/skills/plugins — list installed plugins (openclaw plugins list --json) */
router.get('/plugins', async (req: Request, res: Response) => {
  try {
    const raw = await cachedListing(
      'plugins',
      () => runOpenClaw(['plugins', 'list', '--json']),
      req.query.refresh === '1',
    );
    const parsed = parseJson(raw);
    const plugins = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.plugins) ? parsed.plugins : []);
    res.json({ plugins });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list plugins';
    res.status(500).json({ error: message });
  }
});

/** POST /api/skills/plugins/install — install a plugin spec (openclaw plugins install) */
router.post('/plugins/install', async (req: Request, res: Response) => {
  try {
    const { spec } = req.body;
    if (!isSafeMutationValue(spec, 512)) {
      res.status(400).json({ error: 'Plugin spec required' });
      return;
    }
    if (spec.trim().startsWith('-')) {
      res.status(400).json({ error: 'Plugin specifications cannot begin with an option prefix' });
      return;
    }
    const confirmationPhrase = confirmationForPluginInstall(spec);
    if (!isTypedConfirmationMatch(confirmationPhrase, req.body?.confirmation)) {
      res.status(400).json({ error: `Type ${confirmationPhrase} to confirm this host-wide plugin installation.`, confirmationPhrase });
      return;
    }
    const job = await startSkillsMutation({
      userId: req.user!.userId,
      actorAuthorizationVersion: Number(req.user!.authorizationVersion ?? 1),
      toolId: '_plugin:install',
      title: `Install OpenClaw plugin ${spec}`,
      executable: 'openclaw',
      args: ['--no-color', 'plugins', 'install', spec],
    });
    res.status(202).json({ ok: true, jobId: job.id, room: `job:${job.id}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Plugin install failed';
    res.status(mutationErrorStatus(err)).json({ error: message });
  }
});

export default router;
