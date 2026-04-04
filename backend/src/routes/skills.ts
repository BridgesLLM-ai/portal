import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { spawn } from 'child_process';

const router = Router();

router.use(authenticateToken, requireAdmin);

/* ─── Helpers ────────────────────────────────────────────── */

function runCli(command: string, args: string[], timeout = 15000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const child = spawn(command, args, {
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => errChunks.push(d));
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} timed out after ${timeout}ms`)); }, timeout);
    child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf-8');
      const stderr = Buffer.concat(errChunks).toString('utf-8');
      if (code && code !== 0) {
        reject(new Error(stderr || stdout || `${command} ${args.join(' ')} failed with code ${code}`));
      } else {
        resolve({ stdout, stderr });
      }
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

async function enrichMarketplaceResults(results: any[], inspectLimit = 8): Promise<any[]> {
  const enriched = await Promise.all(results.map(async (item, index) => {
    const normalized = normalizeMarketplaceItem(item);
    if ((normalized.description && normalized.author) || !normalized.slug || index >= inspectLimit) {
      return normalized;
    }
    try {
      const raw = await runClawHub(['inspect', normalized.slug, '--json'], 15000);
      const parsed = parseJson(raw);
      const enrichedItem = normalizeMarketplaceItem(parsed);
      return {
        ...normalized,
        ...enrichedItem,
        score: normalized.score ?? enrichedItem.score,
      };
    } catch {
      return normalized;
    }
  }));
  return enriched.filter(item => item.name);
}

function getExploreFallbackQueries(sort: string): string[] {
  const key = String(sort || 'trending').toLowerCase();
  if (key === 'downloads' || key === 'installs' || key === 'installsalltime') {
    return ['popular', 'trending', 'automation', 'github', 'productivity', 'weather'];
  }
  if (key === 'newest') {
    return ['latest', 'new', 'recent', 'automation', 'ai'];
  }
  return ['trending', 'automation', 'weather', 'github', 'docker', 'ai'];
}

function sortMarketplaceFallback(results: any[], sort: string): any[] {
  const key = String(sort || 'trending').toLowerCase();
  const copy = [...results];
  if (key === 'downloads' || key === 'installs' || key === 'installsalltime') {
    return copy.sort((a: any, b: any) => Number(b?.downloads || 0) - Number(a?.downloads || 0));
  }
  if (key === 'newest') {
    return copy.sort((a: any, b: any) => {
      const aTs = Date.parse(String(a?.updatedAt || '')) || 0;
      const bTs = Date.parse(String(b?.updatedAt || '')) || 0;
      return bTs - aTs;
    });
  }
  return copy.sort((a: any, b: any) => Number(b?.score || 0) - Number(a?.score || 0));
}

/* ─── Routes ─────────────────────────────────────────────── */

/** GET /api/skills — list all locally available skills (openclaw skills list --json) */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const raw = await runOpenClaw(['skills', 'list', '--json']);
    const parsed = parseJson(raw);
    const skills = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.skills) ? parsed.skills : []);
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

    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 50);
    const raw = await runClawHub(['search', query, '--limit', String(limit)]);
    const results = await enrichMarketplaceResults(parseSearchOutput(raw), Math.min(limit, 10));
    res.json({ available: true, results });
  } catch (err) {
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
    let source: 'explore' | 'search-fallback' = 'explore';

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

    // Fallback: clawhub explore may be unavailable depending on server auth/state.
    // Use search-derived browsing but keep sort semantics deterministic.
    if (results.length === 0) {
      source = 'search-fallback';
      const fallbackQueries = getExploreFallbackQueries(safeSort);
      const seen = new Set<string>();
      for (const q of fallbackQueries) {
        if (results.length >= limit) break;
        try {
          const raw = await runClawHub(['search', q, '--limit', '10']);
          for (const item of parseSearchOutput(raw)) {
            if (!seen.has(item.name)) {
              seen.add(item.name);
              results.push(item);
            }
          }
        } catch {
          // skip failed queries
        }
      }
      results = results.slice(0, limit);
    }

    const enriched = await enrichMarketplaceResults(results, Math.min(limit, 10));
    const sorted = source === 'search-fallback' ? sortMarketplaceFallback(enriched, safeSort) : enriched;

    res.json({
      results: sorted.slice(0, limit),
      source,
      sort: safeSort,
      fallback: source === 'search-fallback',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Marketplace explore failed';
    res.status(500).json({ error: message });
  }
});

/** GET /api/skills/inspect/:slug — get detailed marketplace info (clawhub inspect --json) */
router.get('/inspect/:slug', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug;
    if (!slug || !/^[a-z0-9_-]+$/i.test(slug)) {
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
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Skill name required' });
      return;
    }

    // Sanitize: only allow slug-like names
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      res.status(400).json({ error: 'Invalid skill name' });
      return;
    }

    const result = await runClawHub(['install', name], 60000);
    res.json({ ok: true, output: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Install failed';
    res.status(500).json({ error: message });
  }
});

/** POST /api/skills/uninstall — uninstall a clawhub skill */
router.post('/uninstall', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Skill name required' });
      return;
    }

    if (!/^[a-z0-9_-]+$/i.test(name)) {
      res.status(400).json({ error: 'Invalid skill name' });
      return;
    }

    const result = await runClawHub(['uninstall', name], 30000);
    res.json({ ok: true, output: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Uninstall failed';
    res.status(500).json({ error: message });
  }
});

/** GET /api/skills/plugins — list installed plugins (openclaw plugins list --json) */
router.get('/plugins', async (_req: Request, res: Response) => {
  try {
    const raw = await runOpenClaw(['plugins', 'list', '--json']);
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
    if (!spec || typeof spec !== 'string') {
      res.status(400).json({ error: 'Plugin spec required' });
      return;
    }

    const result = await runOpenClaw(['plugins', 'install', spec], 120000);
    res.json({ ok: true, output: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Plugin install failed';
    res.status(500).json({ error: message });
  }
});

export default router;
