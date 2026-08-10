import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { authenticateToken, requireAdmin } from '../middleware/auth';
import { APPEARANCE_DEFAULTS } from '../config/settings.schema';
import { normalizeRegistrationMode } from '../utils/registrationMode';
import { getPortalFeatureCapabilities } from '../utils/portalFeatureCapabilities';
import {
  normalizePortalAccentColor,
  normalizePortalBrandingAssetUrl,
} from '../services/portalBranding';

function normalizeBoolean(value?: string | null): boolean {
  const raw = String(value || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

const router = Router();

/**
 * GET /api/settings/public
 * Returns the small, non-sensitive configuration needed by the public shell.
 * No authentication required — needed for login branding and registration UX.
 */
router.get('/public', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Branding changes during setup and administration must be observable on
    // the next request; do not let an intermediary preserve bootstrap defaults.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    const keys = ['appearance.theme', 'appearance.accentColor', 'appearance.portalName', 'appearance.logoUrl', 'appearance.assistantName', 'appearance.agentAvatar.OPENCLAW', 'appearance.agentAvatar.CLAUDE_CODE', 'appearance.agentAvatar.CODEX', 'appearance.agentAvatar.GROK', 'appearance.agentAvatar.AGENT_ZERO', 'appearance.agentAvatar.GEMINI', 'appearance.agentAvatar.OLLAMA', 'security.registrationMode', 'registrationMode'];
    const rows = await prisma.systemSetting.findMany({ where: { key: { in: keys } } });

    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }

    res.json({
      theme: map['appearance.theme'] || APPEARANCE_DEFAULTS.theme,
      accentColor: normalizePortalAccentColor(
        map['appearance.accentColor'],
        APPEARANCE_DEFAULTS.accentColor,
      ),
      portalName: map['appearance.portalName'] || APPEARANCE_DEFAULTS.portalName,
      logoUrl: normalizePortalBrandingAssetUrl(map['appearance.logoUrl']) || APPEARANCE_DEFAULTS.logoUrl,
      assistantName: map['appearance.assistantName'] || 'Assistant',
      registrationMode: normalizeRegistrationMode(map['security.registrationMode'] || map.registrationMode),
      agentAvatars: {
        OPENCLAW: map['appearance.agentAvatar.OPENCLAW'] || '',
        CLAUDE_CODE: map['appearance.agentAvatar.CLAUDE_CODE'] || '',
        CODEX: map['appearance.agentAvatar.CODEX'] || '',
        GROK: map['appearance.agentAvatar.GROK'] || '',
        AGENT_ZERO: map['appearance.agentAvatar.AGENT_ZERO'] || '',
        GEMINI: map['appearance.agentAvatar.GEMINI'] || '',
        OLLAMA: map['appearance.agentAvatar.OLLAMA'] || '',
      },
      useDirectGateway: normalizeBoolean(process.env.USE_DIRECT_GATEWAY || process.env.VITE_USE_DIRECT_GATEWAY),
      ...getPortalFeatureCapabilities(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/settings/client
 * Returns authenticated operational settings needed inside the app shell.
 */
router.get('/client', authenticateToken, requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
    const keys = ['agent.defaultOpenClawAgentId', 'agent.visibleBrowserOpenClawAgentId'];
    const [rows, subAgentRows] = await Promise.all([
      prisma.systemSetting.findMany({ where: { key: { in: keys } } }),
      prisma.systemSetting.findMany({
        where: { key: { startsWith: 'appearance.subAgentAvatar.' } },
      }),
    ]);

    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }

    const subAgentAvatars = Object.create(null) as Record<string, string>;
    for (const row of subAgentRows) {
      const agentId = row.key.replace('appearance.subAgentAvatar.', '');
      if (agentId && row.value) subAgentAvatars[agentId] = row.value;
    }

    res.json({
      defaultOpenClawAgentId: map['agent.defaultOpenClawAgentId'] || 'main',
      visibleBrowserOpenClawAgentId: map['agent.visibleBrowserOpenClawAgentId'] || '',
      subAgentAvatars,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
