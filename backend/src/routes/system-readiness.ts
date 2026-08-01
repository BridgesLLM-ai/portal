import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import { buildFeatureReadinessReport } from '../config/featureReadiness';

const router = Router();
const READINESS_CACHE_TTL_MS = 60_000;
let readinessCache: { at: number; settingsKey: string; report: Awaited<ReturnType<typeof buildFeatureReadinessReport>> } | null = null;
let readinessRefreshInFlight: Promise<void> | null = null;
let readinessLastRefreshError: string | null = null;

router.use(authenticateToken);
router.use(requireAdmin);

function settingsFingerprint(settings: Record<string, string>): string {
  return Object.keys(settings).sort().map((key) => `${key}\u0000${settings[key]}`).join('\u0001');
}

function queueReadinessRefresh(settings: Record<string, string>, settingsKey: string): void {
  if (readinessRefreshInFlight) return;
  readinessRefreshInFlight = buildFeatureReadinessReport(settings)
    .then((report) => {
      readinessCache = { at: Date.now(), settingsKey, report };
      readinessLastRefreshError = null;
    })
    .catch((error) => {
      readinessLastRefreshError = error?.message || 'Feature readiness refresh failed';
      console.error('[system-readiness] background refresh failed:', error);
    })
    .finally(() => {
      readinessRefreshInFlight = null;
    });
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const settingsRows = await prisma.systemSetting.findMany({
      where: { key: { in: ['remoteDesktop.url', 'remoteDesktop.allowedPathPrefixes', 'ollama.localEnabled'] } },
    });

    const settings = settingsRows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    const settingsKey = settingsFingerprint(settings);
    const force = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
    const cached = readinessCache;

    if (cached) {
      const cacheAgeMs = Date.now() - cached.at;
      const settingsChanged = cached.settingsKey !== settingsKey;
      const shouldRefresh = force || settingsChanged || cacheAgeMs >= READINESS_CACHE_TTL_MS;
      if (shouldRefresh) queueReadinessRefresh(settings, settingsKey);
      res.json({
        ...cached.report,
        ready: true,
        checkedAt: new Date(cached.at).toISOString(),
        cached: true,
        cacheAgeMs,
        refreshing: shouldRefresh || !!readinessRefreshInFlight,
        settingsChanged,
        refreshError: readinessLastRefreshError,
      });
      return;
    }

    queueReadinessRefresh(settings, settingsKey);
    res.status(202).json({
      ready: false,
      checkedAt: null,
      cached: false,
      refreshing: true,
      settingsChanged: false,
      refreshError: readinessLastRefreshError,
      overall: 'partial',
      features: [],
      suggestedNextActions: [],
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to compute feature readiness' });
  }
});

export default router;
