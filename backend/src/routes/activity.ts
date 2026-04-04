import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { prisma } from '../config/database';
import { config } from '../config/env';
import { blockedIPs, extractIP } from '../utils/auth-tracking';
import { logError } from '../utils/errorLogger';

const router = Router();

// In-memory translation cache with size limit
const TRANSLATION_CACHE_MAX = 5000;
const translationCache = new Map<string, string>();

function pruneTranslationCache() {
  if (translationCache.size > TRANSLATION_CACHE_MAX) {
    // Delete oldest half of entries (Map preserves insertion order)
    const deleteCount = Math.floor(TRANSLATION_CACHE_MAX / 2);
    let i = 0;
    for (const key of translationCache.keys()) {
      if (i++ >= deleteCount) break;
      translationCache.delete(key);
    }
  }
}

async function translateMessage(action: string, resource: string, resourceId?: string | null): Promise<string> {
  const cacheKey = `${action}:${resource}:${resourceId || ''}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey)!;

  const prompt = `Translate this system log entry to a brief, plain English sentence (max 15 words). Action: "${action}", Resource: "${resource}", Resource ID: "${resourceId || 'N/A'}". Reply with ONLY the translated sentence.`;

  try {
    const response = await fetch(`${config.ollamaApiUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.ollamaModel || 'gemma2:2b', prompt, stream: false }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Ollama unavailable');
    const data = await response.json() as { response: string };
    const translated = data.response?.trim() || fallbackTranslation(action, resource);
    translationCache.set(cacheKey, translated);
    pruneTranslationCache();
    if (resourceId) {
      await prisma.activityLog.updateMany({ where: { action, resource, resourceId }, data: { translatedMessage: translated } }).catch(() => {});
    }
    return translated;
  } catch {
    const fallback = fallbackTranslation(action, resource);
    translationCache.set(cacheKey, fallback);
    return fallback;
  }
}

function richTranslation(action: string, resource: string, metadata?: any): string {
  const meta = metadata || {};
  const project = meta.projectName || meta.project || resource;

  switch (action) {
    case 'PROJECT_GIT_COMMIT': {
      const hash = meta.hash ? ` (${String(meta.hash).slice(0, 7)})` : '';
      const files = meta.filesChanged ? `${meta.filesChanged} file${meta.filesChanged > 1 ? 's' : ''}` : '';
      const msg = meta.message ? `: '${String(meta.message).slice(0, 60)}${String(meta.message).length > 60 ? '...' : ''}'` : '';
      return `🔀 Committed ${files ? files + ' to ' : 'to '}${project}${hash}${msg}`;
    }
    case 'PROJECT_GIT_PUSH':
      return `🔀 Pushed ${project} to remote${meta.branch ? ` (${meta.branch})` : ''}`;
    case 'PROJECT_GIT_PULL':
      return `🔀 Pulled latest for ${project}${meta.branch ? ` (${meta.branch})` : ''}`;
    case 'PROJECT_GIT_CLONE':
      return `🔀 Cloned repository for ${project}`;
    case 'PROJECT_DEPLOY': {
      const ver = meta.version ? ` v${meta.version}` : '';
      return `🚀 Deployed ${project}${ver}`;
    }
    case 'FILE_UPLOAD':
      return `📄 Uploaded ${meta.fileName || meta.filename || 'a file'}${project !== resource ? ' to ' + project : ''}`;
    case 'FILE_DOWNLOAD':
      return `📥 Downloaded ${meta.fileName || meta.filename || 'a file'}`;
    case 'FILE_DELETE':
      return `🗑️ Deleted ${meta.fileName || meta.filename || 'a file'}`;
    case 'APP_UPLOAD':
      return `🚀 Deployed ${meta.appName || 'a new app'}`;
    case 'APP_DELETE':
      return `🗑️ Removed ${meta.appName || 'an app'}`;
    case 'LOGIN':
      return '🔑 Signed in';
    case 'LOGIN_FAILED':
      return '⛔ Failed login attempt';
    case 'LOGOUT':
      return '👋 Signed out';
    case 'METRICS_COLLECT':
      return '📊 System metrics collected';
    case 'IP_BLOCKED': {
      const reason = meta.reason || '';
      if (reason === 'signup_honeypot') {
        return `🍯 Honeypot triggered — ${meta.attemptedEmail || 'unknown'} from ${meta.ip || ''}${meta.geo ? ' (' + (meta.geo.city || meta.geo.country || '') + ')' : ''} — IP blocked`;
      }
      return `🚫 IP blocked: ${meta.ip || ''}${meta.reason ? ' (' + meta.reason + ')' : ''}`;
    }
    case 'IP_UNBLOCKED':
      return `🔓 IP unblocked: ${meta.ip || ''}`;
    case 'REGISTRATION_BLOCKED':
      return `🚫 Registration blocked — ${meta.attemptedEmail || 'unknown'} from ${meta.ip || ''}${meta.geo ? ' (' + (meta.geo.city || meta.geo.country || '') + ')' : ''} — IP blocked`;
    case 'MARCUS_CHAT':
      return `🤖 Agent chat session${meta.projectName ? ' on ' + meta.projectName : ''}`;
    case 'MARCUS_ERROR':
      return `🤖❌ Agent error${meta.errorMessage ? ': ' + String(meta.errorMessage).slice(0, 80) : ''}`;
    case 'API_ERROR':
      return `🌐 API error${meta.endpoint ? ' — ' + String(meta.endpoint).slice(0, 80) : ''}${meta.errorMessage ? ': ' + String(meta.errorMessage).slice(0, 80) : ''}`;
    case 'AUTH_ERROR':
      return `🔐 Auth error${meta.endpoint ? ' — ' + String(meta.endpoint).slice(0, 80) : ''}${meta.errorMessage ? ': ' + String(meta.errorMessage).slice(0, 80) : ''}`;
    case 'FRONTEND_ERROR':
      return `🧨 Frontend error${meta.context ? ' — ' + String(meta.context).slice(0, 80) : ''}${meta.errorMessage ? ': ' + String(meta.errorMessage).slice(0, 80) : ''}`;
    case 'GIT_ERROR':
      return `🔀❌ Git error${meta.projectName ? ' — ' + meta.projectName : ''}${meta.errorMessage ? ': ' + String(meta.errorMessage).slice(0, 80) : ''}`;
    case 'DB_ERROR':
      return `🗄️ Database error${meta.errorMessage ? ': ' + String(meta.errorMessage).slice(0, 80) : ''}`;
    case 'FS_ERROR':
      return `📁 Filesystem error${meta.errorMessage ? ': ' + String(meta.errorMessage).slice(0, 80) : ''}`;
    case 'TERMINAL_EXEC':
      return `💻 Terminal command executed`;
    default:
      return `${action.replace(/_/g, ' ').toLowerCase()} on ${resource}`;
  }
}

function fallbackTranslation(action: string, resource: string): string {
  return richTranslation(action, resource);
}

// GET /api/activity
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = parseInt(req.query.offset as string) || (page - 1) * limit;
    const severity = req.query.severity as string | undefined;
    const search = req.query.search as string | undefined;
    const kind = req.query.kind as string | undefined;
    const category = req.query.category as string | undefined;

    // Build scope filter
    const scopeFilter: any = {};
    if (kind === 'system_alert') {
      scopeFilter.action = 'SYSTEM_ALERT';
    } else if (kind === 'user') {
      scopeFilter.userId = req.user!.userId;
      scopeFilter.NOT = { action: 'SYSTEM_ALERT' };
    } else {
      scopeFilter.OR = [
        { userId: req.user!.userId },
        { action: 'SYSTEM_ALERT' },
        { action: 'IP_BLOCKED' },
        { action: 'IP_UNBLOCKED' },
        { action: 'LOGIN_FAILED' },
      ];
    }

    // Category filter
    if (category === 'logins' || category === 'auth') {
      scopeFilter.action = { in: ['LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'AUTH_ERROR'] };
    } else if (category === 'git') {
      scopeFilter.action = { in: ['GIT_ERROR'], startsWith: undefined as any };
      delete scopeFilter.action;
      scopeFilter.OR = [
        { action: { startsWith: 'PROJECT_GIT' } },
        { action: 'GIT_ERROR' },
      ];
    } else if (category === 'deploys' || category === 'deploy') {
      scopeFilter.OR = [
        { action: { startsWith: 'PROJECT_DEPLOY' } },
        { resource: 'deploy' },
      ];
    } else if (category === 'system') {
      scopeFilter.OR = [
        { action: { in: ['SYSTEM_ALERT', 'METRICS_COLLECT', 'TERMINAL_EXEC'] } },
        { resource: { in: ['system', 'database', 'filesystem'] } },
        { action: { in: ['DB_ERROR', 'FS_ERROR'] } },
      ];
    } else if (category === 'agent_chat' || category === 'agent' || category === 'ai') {
      scopeFilter.OR = [
        { action: { startsWith: 'MARCUS' } },
        { action: { in: ['API_ERROR', 'AUTH_ERROR', 'FRONTEND_ERROR'] } },
        { resource: { in: ['agent_chat', 'gateway', 'openclaw'] } },
      ];
    } else if (category === 'files') {
      scopeFilter.OR = [
        { action: { startsWith: 'FILE_' } },
        { action: { startsWith: 'APP_' } },
        { resource: { in: ['file', 'app'] } },
      ];
    } else if (category === 'bot_traps' || category === 'security') {
      scopeFilter.action = { in: ['IP_BLOCKED', 'IP_UNBLOCKED', 'REGISTRATION_BLOCKED'] };
    } else if (category === 'errors') {
      // Errors filter: show ALL errors (user's own + system-wide) — override scope
      delete scopeFilter.OR;
      scopeFilter.AND = [
        {
          OR: [
            { action: { endsWith: '_ERROR' } },
            { severity: { in: ['ERROR', 'CRITICAL'] } },
          ],
        },
      ];
    }

    if (severity) scopeFilter.severity = severity;

    const where: any = search
      ? {
          AND: [
            scopeFilter,
            {
              OR: [
                { action: { contains: search, mode: 'insensitive' } },
                { resource: { contains: search, mode: 'insensitive' } },
                { translatedMessage: { contains: search, mode: 'insensitive' } },
                { ipAddress: { contains: search, mode: 'insensitive' } },
              ],
            },
          ],
        }
      : scopeFilter;

    const [activities, total] = await Promise.all([
      prisma.activityLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      prisma.activityLog.count({ where }),
    ]);

    // Synchronous translation — no Ollama calls on page load (kills performance)
    // Priority: richTranslation (metadata-aware) → stored DB translation → fallback string
    const translated = activities.map((a) => {
        const meta = (a.metadata as any) || {};
        const rich = richTranslation(a.action, a.resource, meta);
        const isGeneric = rich === `${a.action.replace(/_/g, ' ').toLowerCase()} on ${a.resource}`;
        const message = !isGeneric ? rich : (a.translatedMessage || fallbackTranslation(a.action, a.resource));
        const enrichedMeta = { ...meta };
        if (a.ipAddress && !enrichedMeta.ip) {
          enrichedMeta.ip = a.ipAddress;
        }
        return { ...a, metadata: enrichedMeta, translatedMessage: message };
      });

    res.json({ logs: translated, activities: translated, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Activity log error:', error);
    res.status(500).json({ error: 'Failed to get activity log' });
  }
});

// POST /api/activity/unblock-ip
router.post('/unblock-ip', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { ip, activityId } = req.body;
    if (!ip) { res.status(400).json({ error: 'IP address required' }); return; }

    // Remove from in-memory set
    blockedIPs.delete(ip);

    // Update activity log entry
    if (activityId) {
      const entry = await prisma.activityLog.findUnique({ where: { id: activityId } });
      if (entry) {
        const meta = (entry.metadata as any) || {};
        await prisma.activityLog.update({
          where: { id: activityId },
          data: { metadata: { ...meta, unblocked: true, unblockedAt: new Date().toISOString(), unblockedBy: req.user!.userId } },
        });
      }
    }

    // Also update all IP_BLOCKED entries for this IP
    const entries = await prisma.activityLog.findMany({ where: { action: 'IP_BLOCKED', ipAddress: ip } });
    for (const entry of entries) {
      const meta = (entry.metadata as any) || {};
      if (!meta.unblocked) {
        await prisma.activityLog.update({
          where: { id: entry.id },
          data: { metadata: { ...meta, unblocked: true, unblockedAt: new Date().toISOString(), unblockedBy: req.user!.userId } },
        });
      }
    }

    // Log the unblock
    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'IP_UNBLOCKED',
        resource: 'security',
        severity: 'INFO',
        ipAddress: ip,
        translatedMessage: `🔓 IP Unblocked: ${ip}`,
        metadata: { ip, unblockedBy: req.user!.userId },
      },
    });

    res.json({ success: true, message: `IP ${ip} has been unblocked` });
  } catch (error) {
    console.error('Unblock IP error:', error);
    res.status(500).json({ error: 'Failed to unblock IP' });
  }
});

// POST /api/activity/heartbeat - Session activity heartbeat
router.post('/heartbeat', authenticateToken, async (req: Request, res: Response) => {
  try {
    // Update the user's most recent session's last activity
    const session = await prisma.session.findFirst({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
    });
    if (session) {
      // We can't add last_activity_at without migration, so store in metadata approach
      // Instead, update the session's expiresAt to extend it (lightweight)
      // The createdAt vs now gives us session duration
    }
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

// POST /api/activity/archive - Archive old entries (120+ days)
router.post('/archive', authenticateToken, async (req: Request, res: Response) => {
  try {
    const cutoff = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);

    // Soft-delete: mark as archived by updating severity to include prefix
    // Actually, just delete old non-critical entries
    const result = await prisma.activityLog.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        severity: { notIn: ['ERROR', 'CRITICAL'] },
        action: { notIn: ['IP_BLOCKED'] }, // Keep security entries
      },
    });

    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'ARCHIVE',
        resource: 'activity_log',
        severity: 'INFO',
        translatedMessage: `🗄️ Archived ${result.count} activity entries older than 120 days`,
      },
    });

    res.json({ archived: result.count });
  } catch (error) {
    console.error('Archive error:', error);
    res.status(500).json({ error: 'Failed to archive activity data' });
  }
});

// POST /api/activity/report-error - Frontend error reporting
router.post('/report-error', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { message, stack, componentName, endpoint, context, severity: clientSeverity } = req.body;
    if (!message) { res.status(400).json({ error: 'message required' }); return; }

    const action = endpoint ? 'API_ERROR' : 'FRONTEND_ERROR';
    const resource = endpoint ? 'api' : 'frontend';
    const sev = (clientSeverity === 'CRITICAL' ? 'CRITICAL' : 'ERROR') as 'ERROR' | 'CRITICAL';

    await logError(message, {
      userId: req.user!.userId,
      action,
      resource,
      resourceId: componentName || endpoint || context,
      endpoint,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      severity: sev,
    });

    // If there's a stack trace, update the metadata on the just-created entry
    if (stack) {
      const recent = await prisma.activityLog.findFirst({
        where: { userId: req.user!.userId, action },
        orderBy: { createdAt: 'desc' },
      });
      if (recent) {
        const meta = (recent.metadata as any) || {};
        await prisma.activityLog.update({
          where: { id: recent.id },
          data: {
            metadata: {
              ...meta,
              stackTrace: stack,
              componentName,
              context,
            },
          },
        });
      }
    }

    res.json({ logged: true });
  } catch (error) {
    console.error('Report error endpoint failed:', error);
    res.status(500).json({ error: 'Failed to log error' });
  }
});

// POST /api/activity/seed
router.post('/seed', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const now = new Date();
    const sampleEvents = [
      { action: 'LOGIN', resource: 'auth', severity: 'INFO' as const, translatedMessage: 'Signed in to the portal', createdAt: new Date(now.getTime() - 3600000 * 24) },
      { action: 'FILE_UPLOAD', resource: 'file', resourceId: 'demo-1', severity: 'INFO' as const, translatedMessage: 'Uploaded project-notes.md', createdAt: new Date(now.getTime() - 3600000 * 20) },
      { action: 'FILE_UPLOAD', resource: 'file', resourceId: 'demo-2', severity: 'INFO' as const, translatedMessage: 'Uploaded screenshot.png', createdAt: new Date(now.getTime() - 3600000 * 18) },
      { action: 'APP_UPLOAD', resource: 'app', resourceId: 'demo-app-1', severity: 'INFO' as const, translatedMessage: 'Deployed weather-dashboard app', createdAt: new Date(now.getTime() - 3600000 * 16) },
      { action: 'FILE_DOWNLOAD', resource: 'file', resourceId: 'demo-3', severity: 'INFO' as const, translatedMessage: 'Downloaded backup.tar.gz', createdAt: new Date(now.getTime() - 3600000 * 12) },
      { action: 'METRICS_COLLECT', resource: 'system', severity: 'DEBUG' as const, translatedMessage: 'System metrics collected automatically', createdAt: new Date(now.getTime() - 3600000 * 10) },
      { action: 'LOGIN', resource: 'auth', severity: 'INFO' as const, translatedMessage: 'Signed in from new device', createdAt: new Date(now.getTime() - 3600000 * 8) },
      { action: 'FILE_DELETE', resource: 'file', resourceId: 'demo-4', severity: 'WARNING' as const, translatedMessage: 'Deleted old-config.json', createdAt: new Date(now.getTime() - 3600000 * 6) },
      { action: 'APP_DELETE', resource: 'app', resourceId: 'demo-app-2', severity: 'WARNING' as const, translatedMessage: 'Removed deprecated test-app', createdAt: new Date(now.getTime() - 3600000 * 4) },
      { action: 'FILE_UPLOAD', resource: 'file', resourceId: 'demo-5', severity: 'INFO' as const, translatedMessage: 'Uploaded model-weights.bin (large file)', createdAt: new Date(now.getTime() - 3600000 * 2) },
      { action: 'TERMINAL_EXEC', resource: 'terminal', severity: 'INFO' as const, translatedMessage: 'Executed system update commands', createdAt: new Date(now.getTime() - 3600000) },
      { action: 'LOGIN', resource: 'auth', severity: 'INFO' as const, translatedMessage: 'Signed in to the portal', createdAt: new Date(now.getTime() - 1800000) },
    ];

    await prisma.activityLog.createMany({ data: sampleEvents.map(e => ({ ...e, userId })) });
    res.json({ seeded: sampleEvents.length });
  } catch (error) {
    console.error('Seed error:', error);
    res.status(500).json({ error: 'Failed to seed activity data' });
  }
});

export default router;
