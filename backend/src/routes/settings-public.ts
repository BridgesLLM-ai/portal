import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { APPEARANCE_DEFAULTS, REMOTE_DESKTOP_DEFAULTS } from '../config/settings.schema';

function normalizeAllowedPathPrefixes(value?: string | null): string {
  const raw = (value || REMOTE_DESKTOP_DEFAULTS.allowedPathPrefixes).trim();
  const prefixes = raw
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .filter(v => v !== '/guacamole');
  return prefixes.length ? prefixes.join(',') : REMOTE_DESKTOP_DEFAULTS.allowedPathPrefixes;
}

const router = Router();

/**
 * GET /api/settings/public
 * Returns only appearance settings (theme, accentColor, portalName, logoUrl).
 * No authentication required — needed for login page theming.
 */
router.get('/public', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const keys = ['appearance.theme', 'appearance.accentColor', 'appearance.portalName', 'appearance.logoUrl', 'appearance.assistantName', 'appearance.agentAvatar.OPENCLAW', 'appearance.agentAvatar.CLAUDE_CODE', 'appearance.agentAvatar.CODEX', 'appearance.agentAvatar.AGENT_ZERO', 'appearance.agentAvatar.GEMINI', 'appearance.agentAvatar.OLLAMA', 'remoteDesktop.url', 'remoteDesktop.allowedPathPrefixes'];
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: keys } },
    });

    // Also fetch sub-agent avatars (dynamic keys)
    const subAgentRows = await prisma.systemSetting.findMany({
      where: { key: { startsWith: 'appearance.subAgentAvatar.' } },
    });

    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }

    // Build sub-agent avatars map: { agentId: url }
    const subAgentAvatars: Record<string, string> = {};
    for (const row of subAgentRows) {
      const agentId = row.key.replace('appearance.subAgentAvatar.', '');
      if (agentId && row.value) {
        subAgentAvatars[agentId] = row.value;
      }
    }

    res.json({
      theme: map['appearance.theme'] || APPEARANCE_DEFAULTS.theme,
      accentColor: map['appearance.accentColor'] || APPEARANCE_DEFAULTS.accentColor,
      portalName: map['appearance.portalName'] || APPEARANCE_DEFAULTS.portalName,
      logoUrl: map['appearance.logoUrl'] || APPEARANCE_DEFAULTS.logoUrl,
      assistantName: map['appearance.assistantName'] || 'Assistant',
      agentAvatars: {
        OPENCLAW: map['appearance.agentAvatar.OPENCLAW'] || '',
        CLAUDE_CODE: map['appearance.agentAvatar.CLAUDE_CODE'] || '',
        CODEX: map['appearance.agentAvatar.CODEX'] || '',
        AGENT_ZERO: map['appearance.agentAvatar.AGENT_ZERO'] || '',
        GEMINI: map['appearance.agentAvatar.GEMINI'] || '',
        OLLAMA: map['appearance.agentAvatar.OLLAMA'] || '',
      },
      subAgentAvatars,
      remoteDesktopUrl: map['remoteDesktop.url'] || REMOTE_DESKTOP_DEFAULTS.url,
      remoteDesktopAllowedPathPrefixes: normalizeAllowedPathPrefixes(map['remoteDesktop.allowedPathPrefixes']),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
