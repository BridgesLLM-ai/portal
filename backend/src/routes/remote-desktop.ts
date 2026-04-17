import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { createHash } from 'crypto';
import { exec as cpExec } from 'child_process';

const router = Router();
router.use(authenticateToken, requireAdmin);

type RemoteDesktopStatus = 'ready' | 'degraded' | 'unavailable';

const RD_DEFAULT_URL = '/novnc/vnc_portal.html?reconnect=1&resize=smart&path=novnc/websockify';
const PORTAL_VISIBLE_AGENT_ID = 'main';
const PORTAL_VISIBLE_AGENT_NAME = 'Assistant';
const PORTAL_VISIBLE_AGENT_EMOJI = '🖥️';
const OPENCLAW_WORKSPACE = process.env.OPENCLAW_WORKSPACE || '/root/.openclaw/workspace-main';
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(process.env.HOME || '/root', '.openclaw/openclaw.json');
const PORTAL_STATIC_NOVNC_DIR = path.resolve(process.cwd(), '../static/novnc');
const SYSTEM_NOVNC_DIR = '/usr/share/novnc';

function hashDirectoryContents(root: string): string | null {
  try {
    if (!fs.existsSync(root)) return null;
    const hash = createHash('sha256');

    const walk = (dir: string, relative = '') => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        const relPath = relative ? `${relative}/${entry.name}` : entry.name;
        const fullPath = path.join(dir, entry.name);
        hash.update(relPath);
        hash.update(entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file');
        if (entry.isDirectory()) {
          walk(fullPath, relPath);
        } else if (entry.isFile()) {
          hash.update(fs.readFileSync(fullPath));
        } else if (entry.isSymbolicLink()) {
          hash.update(fs.readlinkSync(fullPath));
        }
      }
    };

    walk(root);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function normalizeRemoteDesktopUrl(raw: string): string {
  const value = (raw || '').trim();
  if (!value) return '';

  if (value === '/novnc' || value === '/guacamole' || value === '/vnc') {
    return RD_DEFAULT_URL;
  }

  // Normalize old vnc.html URLs to the portal page
  if (value.startsWith('/novnc/vnc.html')) {
    return RD_DEFAULT_URL;
  }

  if (value.startsWith('/novnc/vnc_portal.html')) {
    let next = value;
    if (!/[?&]path=/.test(next)) {
      next += (next.includes('?') ? '&' : '?') + 'path=novnc/websockify';
    }
    if (/[?&]resize=remote\b/.test(next)) {
      next = next.replace('resize=remote', 'resize=smart');
    } else if (/[?&]resize=scale\b/.test(next)) {
      next = next.replace('resize=scale', 'resize=smart');
    } else if (!/[?&]resize=/.test(next)) {
      next += (next.includes('?') ? '&' : '?') + 'resize=smart';
    }
    return next;
  }

  return value;
}



type RecoveryState = {
  inProgress: boolean;
  attempt: number;
  lastAttemptAt: number;
  nextAllowedAt: number;
  lastError: string | null;
};

const recoveryState: RecoveryState = {
  inProgress: false,
  attempt: 0,
  lastAttemptAt: 0,
  nextAllowedAt: 0,
  lastError: null,
};

function nextBackoffMs(attempt: number): number {
  const base = 5000;
  return Math.min(60000, base * Math.pow(2, Math.max(0, attempt - 1)));
}

function runShell(cmd: string, timeoutMs = 60000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    cpExec(cmd, { timeout: timeoutMs, shell: '/bin/bash' }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

function getPortalNovncHtml(): string {
  const candidate = path.resolve(__dirname, '../../../static/novnc/vnc_portal.html');
  try {
    return fs.readFileSync(candidate, 'utf8');
  } catch {
    return fs.readFileSync(path.join(PORTAL_STATIC_NOVNC_DIR, 'vnc_portal.html'), 'utf8');
  }
}


function ensureNovncStaticBundle(): { changed: boolean; ok: boolean; note: string } {
  try {
    const portalHtmlPath = path.join(PORTAL_STATIC_NOVNC_DIR, 'vnc_portal.html');
    const coreRfbPath = path.join(PORTAL_STATIC_NOVNC_DIR, 'core', 'rfb.js');
    const appUiPath = path.join(PORTAL_STATIC_NOVNC_DIR, 'app', 'ui.js');
    const hasBundle = fs.existsSync(coreRfbPath) && fs.existsSync(appUiPath);
    const hasPortalHtml = fs.existsSync(portalHtmlPath);

    let changed = false;
    if (!hasBundle) {
      if (!fs.existsSync(SYSTEM_NOVNC_DIR)) {
        return { changed: false, ok: false, note: `System noVNC package missing at ${SYSTEM_NOVNC_DIR}` };
      }
      fs.mkdirSync(path.dirname(PORTAL_STATIC_NOVNC_DIR), { recursive: true });
      fs.rmSync(PORTAL_STATIC_NOVNC_DIR, { recursive: true, force: true });
      fs.cpSync(SYSTEM_NOVNC_DIR, PORTAL_STATIC_NOVNC_DIR, { recursive: true, force: true });
      changed = true;
    }

    const desiredPortalHtml = getPortalNovncHtml();
    const currentPortalHtml = fs.existsSync(portalHtmlPath) ? fs.readFileSync(portalHtmlPath, 'utf8') : '';
    if (currentPortalHtml !== desiredPortalHtml) {
      fs.mkdirSync(PORTAL_STATIC_NOVNC_DIR, { recursive: true });
      fs.writeFileSync(portalHtmlPath, desiredPortalHtml, 'utf8');
      changed = true;
    }

    const finalOk = fs.existsSync(coreRfbPath) && fs.existsSync(appUiPath) && fs.existsSync(portalHtmlPath);
    return {
      changed,
      ok: finalOk,
      note: finalOk
        ? (changed ? `Repaired noVNC static bundle at ${PORTAL_STATIC_NOVNC_DIR}` : `noVNC static bundle present at ${PORTAL_STATIC_NOVNC_DIR}`)
        : `Incomplete noVNC static bundle at ${PORTAL_STATIC_NOVNC_DIR}`,
    };
  } catch (err: any) {
    return { changed: false, ok: false, note: `Failed to ensure noVNC static bundle: ${err?.message || 'unknown error'}` };
  }
}

function ensurePortalSkillInstalled(): { changed: boolean; note: string } {
  try {
    const portalSkillSrc = path.resolve(__dirname, '../../..', 'skills/bridgesllm-portal');
    const skillDest = path.join(OPENCLAW_WORKSPACE, 'skills/bridgesllm-portal');
    if (!fs.existsSync(path.join(portalSkillSrc, 'SKILL.md'))) {
      return { changed: false, note: `Skill source not found at ${portalSkillSrc}` };
    }

    const oldSkill = path.join(OPENCLAW_WORKSPACE, 'skills/shared-browser');
    const oldSkillExists = fs.existsSync(oldSkill);
    const sourceHash = hashDirectoryContents(portalSkillSrc);
    const destHash = hashDirectoryContents(skillDest);

    if (sourceHash && destHash && sourceHash === destHash && !oldSkillExists) {
      return { changed: false, note: `Managed skill already current at ${skillDest}` };
    }

    const needsCopy = !fs.existsSync(path.join(skillDest, 'SKILL.md'));
    fs.mkdirSync(path.dirname(skillDest), { recursive: true });
    fs.rmSync(skillDest, { recursive: true, force: true });
    fs.cpSync(portalSkillSrc, skillDest, { recursive: true, force: true });
    if (oldSkillExists) fs.rmSync(oldSkill, { recursive: true, force: true });
    return { changed: true, note: needsCopy ? `Installed managed skill to ${skillDest}` : `Refreshed managed skill at ${skillDest}` };
  } catch (err: any) {
    return { changed: false, note: `Failed to install managed skill: ${err?.message || 'unknown error'}` };
  }
}

function ensurePortalVisibleBrowserAgentConfig(): { changed: boolean; created: boolean; note: string } {
  try {
    if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) {
      return { changed: false, created: false, note: `OpenClaw config not found at ${OPENCLAW_CONFIG_PATH}` };
    }
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
    const config = JSON.parse(raw || '{}');
    if (!config.agents || typeof config.agents !== 'object') config.agents = {};
    if (!Array.isArray(config.agents.list)) config.agents.list = [];

    const desiredTools = {
      deny: ['browser'],
      exec: { security: 'full' },
    };

    const managedAgents = [
      {
        id: PORTAL_VISIBLE_AGENT_ID,
        name: PORTAL_VISIBLE_AGENT_NAME,
        workspace: OPENCLAW_WORKSPACE,
        identity: { emoji: PORTAL_VISIBLE_AGENT_EMOJI },
        tools: desiredTools,
      },
    ];

    let created = false;
    let changed = false;
    const notes: string[] = [];

    for (const desiredAgent of managedAgents) {
      const idx = config.agents.list.findIndex((agent: any) => String(agent?.id || '') === desiredAgent.id);
      if (idx === -1) {
        config.agents.list.push(desiredAgent);
        created = true;
        changed = true;
        notes.push(`created ${desiredAgent.id}`);
        continue;
      }

      const existing = config.agents.list[idx] || {};
      const next = { ...existing };
      if (!next.name && desiredAgent.name) { next.name = desiredAgent.name; changed = true; }
      if (!next.workspace) { next.workspace = desiredAgent.workspace; changed = true; }
      if (!next.identity || typeof next.identity !== 'object') {
        next.identity = { ...desiredAgent.identity };
        changed = true;
      } else if (!next.identity.emoji) {
        next.identity.emoji = desiredAgent.identity.emoji;
        changed = true;
      }
      if (!next.tools || typeof next.tools !== 'object') {
        next.tools = { ...desiredTools };
        changed = true;
      } else {
        const deny = Array.isArray(next.tools.deny) ? [...next.tools.deny] : [];
        if (!deny.includes('browser')) {
          deny.push('browser');
          next.tools.deny = deny;
          changed = true;
        }
        if (!next.tools.exec || typeof next.tools.exec !== 'object') {
          next.tools.exec = { security: 'full' };
          changed = true;
        } else if (!next.tools.exec.security) {
          next.tools.exec.security = 'full';
          changed = true;
        }
      }
      config.agents.list[idx] = next;
      if (changed) notes.push(`reconciled ${desiredAgent.id}`);
    }

    if (!changed) {
      return { changed: false, created: false, note: `${PORTAL_VISIBLE_AGENT_ID} agent already configured` };
    }

    fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return {
      changed: true,
      created,
      note: `Managed OpenClaw browser policy agents updated (${notes.join(', ')}) — hidden browser denied`,
    };
  } catch (err: any) {
    return { changed: false, created: false, note: `Failed to reconcile OpenClaw agent: ${err?.message || 'unknown error'}` };
  }
}

async function ensurePortalVisibleBrowserDefaults(): Promise<{ changed: boolean; note: string }> {
  const skillResult = ensurePortalSkillInstalled();
  const agentResult = ensurePortalVisibleBrowserAgentConfig();
  const notes: string[] = [];
  if (skillResult.note) notes.push(skillResult.note);
  if (agentResult.note) notes.push(agentResult.note);
  let dbChanged = false;
  try {
    const keys = ['agent.defaultOpenClawAgentId', 'agent.visibleBrowserOpenClawAgentId'];
    const existing = await prisma.systemSetting.findMany({ where: { key: { in: keys } } });
    const map = new Map(existing.map((row) => [row.key, row.value] as const));

    if (map.get('agent.defaultOpenClawAgentId') !== 'main') {
      await prisma.systemSetting.upsert({
        where: { key: 'agent.defaultOpenClawAgentId' },
        update: { value: 'main' },
        create: { key: 'agent.defaultOpenClawAgentId', value: 'main' },
      });
      dbChanged = true;
    }
    if (map.get('agent.visibleBrowserOpenClawAgentId') !== 'main') {
      await prisma.systemSetting.upsert({
        where: { key: 'agent.visibleBrowserOpenClawAgentId' },
        update: { value: 'main' },
        create: { key: 'agent.visibleBrowserOpenClawAgentId', value: 'main' },
      });
      dbChanged = true;
    }
  } catch {}

  const changed = skillResult.changed || agentResult.changed || dbChanged;
  notes.push(dbChanged ? 'DB defaults updated' : 'DB defaults already current');
  return { changed, note: notes.join('; ') };
}

export async function reconcilePortalVisibleBrowserDefaults(): Promise<void> {
  try {
    const settings = await prisma.systemSetting.findMany({
      where: { key: { in: ['remoteDesktop.url', 'agent.defaultOpenClawAgentId', 'agent.visibleBrowserOpenClawAgentId'] } },
    });
    const map = new Map(settings.map((row) => [row.key, row.value] as const));
    const wantsVisibleAgent = Boolean((map.get('remoteDesktop.url') || '').trim())
      || map.get('agent.defaultOpenClawAgentId') === PORTAL_VISIBLE_AGENT_ID
      || map.get('agent.visibleBrowserOpenClawAgentId') === PORTAL_VISIBLE_AGENT_ID;
    if (!wantsVisibleAgent) return;
    const result = await ensurePortalVisibleBrowserDefaults();
    if (result.changed) {
      await runShell('openclaw gateway restart', 20000);
      console.log('[remote-desktop] Reconciled visible-browser agent defaults and restarted gateway');
    }
  } catch (err: any) {
    console.warn('[remote-desktop] best-effort reconcile failed:', err?.message || err);
  }
}

async function attemptSelfHeal(reason: string): Promise<{ attempted: boolean; ok: boolean; note: string }> {
  const now = Date.now();
  if (recoveryState.inProgress) {
    return { attempted: false, ok: false, note: 'Recovery already in progress.' };
  }
  if (now < recoveryState.nextAllowedAt) {
    const waitSec = Math.ceil((recoveryState.nextAllowedAt - now) / 1000);
    return { attempted: false, ok: false, note: `Next recovery attempt in ${waitSec}s.` };
  }

  recoveryState.inProgress = true;
  recoveryState.attempt += 1;
  recoveryState.lastAttemptAt = now;

  try {
    const cmd = 'systemctl restart bridges-rd-xtigervnc.service bridges-rd-websockify.service';
    const result = await runShell(cmd, 20000);
    const backoff = nextBackoffMs(recoveryState.attempt);
    recoveryState.nextAllowedAt = Date.now() + backoff;

    if (result.ok) {
      recoveryState.lastError = null;
      return { attempted: true, ok: true, note: `Recovery attempt ${recoveryState.attempt} started (${reason}).` };
    }

    recoveryState.lastError = result.stderr || 'systemctl restart failed';
    return { attempted: true, ok: false, note: `Recovery attempt ${recoveryState.attempt} failed: ${recoveryState.lastError}` };
  } finally {
    recoveryState.inProgress = false;
  }
}

async function checkTcpPort(port: number, host = '127.0.0.1', timeoutMs = 1200): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const keys = ['remoteDesktop.url', 'remoteDesktop.allowedPathPrefixes'];
    const rows = await prisma.systemSetting.findMany({ where: { key: { in: keys } } });
    const settings = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    const configuredUrl = normalizeRemoteDesktopUrl(settings['remoteDesktop.url'] || '');
    const allowedPrefixes = (settings['remoteDesktop.allowedPathPrefixes'] || '/novnc,/vnc')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

    const novncPortOpen = await checkTcpPort(6080);
    const vncPortOpen = await checkTcpPort(5901);
    const sharedChromeDebugPortOpen = await checkTcpPort(18801);

    // websockify no longer serves static files (March 2026) — Express serves them directly.
    // HTTP check removed; only TCP port checks matter now.

    const systemdServiceHints = {
      vnc: '/etc/systemd/system/bridges-rd-xtigervnc.service',
      websockify: '/etc/systemd/system/bridges-rd-websockify.service',
    };
    const sharedChromeLauncher = '/usr/local/bin/bridges-rd-shared-chrome.sh';
    const sharedChromeDesktopEntry = '/home/bridgesrd/Desktop/Shared Chrome.desktop';
    const novncPortalHtml = path.join(PORTAL_STATIC_NOVNC_DIR, 'vnc_portal.html');
    const novncCoreRfb = path.join(PORTAL_STATIC_NOVNC_DIR, 'core', 'rfb.js');

    const vncServiceUnitPresent = fs.existsSync(systemdServiceHints.vnc);
    const websockifyUnitPresent = fs.existsSync(systemdServiceHints.websockify);
    const sharedChromeLauncherPresent = fs.existsSync(sharedChromeLauncher);
    const sharedChromeDesktopEntryPresent = fs.existsSync(sharedChromeDesktopEntry);
    const novncPortalHtmlPresent = fs.existsSync(novncPortalHtml);
    const novncCoreBundlePresent = fs.existsSync(novncCoreRfb);

    const hasConfiguredUrl = configuredUrl.length > 0;

    const diagnostics = {
      configuredUrl,
      allowedPrefixes,
      checks: {
        hasConfiguredUrl,
        novncPortOpen,
        vncPortOpen,
        sharedChromeDebugPortOpen,
        vncServiceUnitPresent,
        websockifyUnitPresent,
        sharedChromeLauncherPresent,
        sharedChromeDesktopEntryPresent,
        novncPortalHtmlPresent,
        novncCoreBundlePresent,
      },
      remediation: [
        'Check systemd units: bridges-rd-xtigervnc.service and bridges-rd-websockify.service.',
        'Verify host ports: 5901 (VNC), 6080 (websockify), and 18801 (shared Chrome debug).',
        'Verify portal noVNC assets exist: static/novnc/vnc_portal.html and static/novnc/core/rfb.js.',
        'Re-run Remote Desktop setup if Shared Chrome launcher/desktop entry or noVNC assets are missing.',
        'Use POST /api/remote-desktop/recover to attempt automatic recovery.',
      ],
    };

    let status: RemoteDesktopStatus = 'unavailable';
    let message = 'Remote Desktop is not available.';

    const desktopUnhealthyReason = [
      !vncPortOpen ? 'VNC 5901 down' : null,
      !novncPortOpen ? 'noVNC 6080 down' : null,
      !novncPortalHtmlPresent ? 'noVNC portal HTML missing' : null,
      !novncCoreBundlePresent ? 'noVNC static bundle missing' : null,
    ].filter(Boolean).join(', ');
    const sharedChromeReason = [
      !sharedChromeLauncherPresent ? 'Shared Chrome launcher missing' : null,
      !sharedChromeDesktopEntryPresent ? 'Shared Chrome desktop entry missing' : null,
      !sharedChromeDebugPortOpen ? 'Shared Chrome 18801 down' : null,
    ].filter(Boolean).join(', ');

    // Status reporting only — no automatic self-heal on poll.
    // Auto-restart was removed (March 2026) because it caused a restart-thrash
    // loop that freed port 6080 for the Docker container to grab, triggering
    // version mismatch crashes. Recovery is now admin-initiated only.

    if (hasConfiguredUrl && novncPortOpen && vncPortOpen && novncPortalHtmlPresent && novncCoreBundlePresent) {
      status = 'ready';
      message = sharedChromeReason
        ? `Remote Desktop is ready. Shared Chrome needs attention: ${sharedChromeReason}.`
        : 'Remote Desktop is ready, including the shared Chrome browser path.';
    } else if (hasConfiguredUrl && (novncPortOpen || vncPortOpen)) {
      status = 'degraded';
      message = `Remote Desktop is partially available: ${desktopUnhealthyReason || 'desktop setup incomplete'}. Use POST /api/remote-desktop/recover to attempt recovery.`;
    } else if (hasConfiguredUrl) {
      message = `Remote Desktop is unavailable: ${desktopUnhealthyReason || 'services not running'}. Use POST /api/remote-desktop/recover to attempt recovery.`;
    }

    res.json({
      status,
      message,
      diagnostics: {
        ...diagnostics,
        recovery: {
          ...recoveryState,
          lastAttemptAt: recoveryState.lastAttemptAt ? new Date(recoveryState.lastAttemptAt).toISOString() : null,
          nextAllowedAt: recoveryState.nextAllowedAt ? new Date(recoveryState.nextAllowedAt).toISOString() : null,
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'unavailable',
      message: error?.message || 'Failed to check Remote Desktop status',
      diagnostics: null,
      timestamp: new Date().toISOString(),
    });
  }
});

// ── Manual recovery endpoint ─────────────────────────────────────────
// POST /api/remote-desktop/recover
// Admin-only. Deliberately restart RD services (replaces the old auto-restart-on-poll).
router.post('/recover', async (_req: Request, res: Response) => {
  try {
    const result = await attemptSelfHeal('admin-initiated recovery');
    res.json({
      ...result,
      recovery: {
        ...recoveryState,
        lastAttemptAt: recoveryState.lastAttemptAt ? new Date(recoveryState.lastAttemptAt).toISOString() : null,
        nextAllowedAt: recoveryState.nextAllowedAt ? new Date(recoveryState.nextAllowedAt).toISOString() : null,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ ok: false, message: error?.message || 'Recovery failed' });
  }
});

// ── Auto-setup endpoint ──────────────────────────────────────────────
// POST /api/remote-desktop/auto-setup
// Admin-only. Idempotently provisions Remote Desktop services and
// sets the remoteDesktop.url setting if not already configured.


/**
 * Core auto-setup logic — extracted so it can be called from both
 * the admin route (authenticated) and the setup wizard route (setup-token).
 */
export async function runRemoteDesktopAutoSetup(): Promise<{ ok: boolean; steps: Array<{ step: string; ok: boolean; message: string }>; message: string }> {
  const steps: Array<{ step: string; ok: boolean; message: string }> = [];

  try {
    // Step 0: Check for dpkg lock — if another apt is running, bail early
    const lockCheck = await runShell('fuser /var/lib/dpkg/lock-frontend 2>/dev/null', 3000);
    if (lockCheck.ok && lockCheck.stdout.trim()) {
      steps.push({ step: 'Check package lock', ok: false, message: 'Another package installation is in progress. Wait a few minutes and try again.' });
      return { ok: false, steps, message: 'Another package installation is already running. Please wait and try again.' };
    }

    // Step 1: Install packages if missing (idempotent — apt skips already-installed)
    // Matches production setup: full XFCE desktop + goodies, x11-utils for xdpyinfo, Google Chrome for browsing
    const requiredPkgs = ['tigervnc-standalone-server', 'novnc', 'websockify', 'xfce4', 'xfce4-goodies', 'xfce4-terminal', 'dbus-x11', 'x11-utils', 'xterm', 'firefox', 'pulseaudio', 'pulseaudio-utils', 'librsvg2-common'];
    // Check each package individually — count-based check was unreliable because
    // meta-packages (xfce4-goodies) inflate the count, masking missing packages
    const missingCheck = await runShell(`for pkg in ${requiredPkgs.join(' ')}; do dpkg -s "$pkg" &>/dev/null || echo "$pkg"; done`);
    const missingPkgs = missingCheck.stdout.trim();
    if (missingPkgs.length > 0) {
      const install = await runShell(
        `DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${requiredPkgs.join(' ')}`,
        600000, // 10 minutes — xfce4 + firefox can take 3-5 min on fresh servers
      );
      steps.push({ step: 'Install RD packages', ok: install.ok, message: install.ok ? 'Packages installed' : install.stderr.slice(0, 300) });
      if (!install.ok) {
        return { ok: false, steps, message: 'Package installation failed. Check apt sources.' };
      }
    } else {
      steps.push({ step: 'Install RD packages', ok: true, message: 'All required packages already installed' });
    }

    // Step 1a: Ensure portal noVNC static bundle exists (repairs missing static/novnc on upgraded installs)
    const novncStatic = ensureNovncStaticBundle();
    steps.push({ step: 'Ensure portal noVNC static bundle', ok: novncStatic.ok, message: novncStatic.note });
    if (!novncStatic.ok) {
      return { ok: false, steps, message: 'noVNC static bundle missing or invalid' };
    }

    // Step 1b: Install Google Chrome (separate — needs its own repo)
    const chromeCheck = await runShell('dpkg -s google-chrome-stable 2>/dev/null | grep "Status: install ok installed"', 3000);
    if (!chromeCheck.ok) {
      const chromeInstall = await runShell(
        `wget -q -O /tmp/google-chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" && DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/google-chrome.deb && rm -f /tmp/google-chrome.deb`,
        120000,
      );
      steps.push({ step: 'Install Google Chrome', ok: chromeInstall.ok, message: chromeInstall.ok ? 'Chrome installed' : `Chrome install failed (non-fatal): ${chromeInstall.stderr.slice(0, 200)}` });
    } else {
      steps.push({ step: 'Install Google Chrome', ok: true, message: 'Already installed' });
    }

    // Step 1c: Install Greybird theme + elementary icons (matches production look)
    const themeCheck = await runShell('dpkg -s greybird-gtk-theme elementary-xfce-icon-theme 2>/dev/null | grep -c "Status: install ok installed"', 3000);
    const themeCount = parseInt(themeCheck.stdout, 10) || 0;
    if (themeCount < 2) {
      const themeInstall = await runShell(
        'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends greybird-gtk-theme elementary-xfce-icon-theme numix-gtk-theme gnome-themes-extra',
        120000,
      );
      steps.push({ step: 'Install desktop themes', ok: themeInstall.ok, message: themeInstall.ok ? 'Themes installed' : `Theme install failed (non-fatal): ${themeInstall.stderr.slice(0, 200)}` });
    } else {
      steps.push({ step: 'Install desktop themes', ok: true, message: 'Already installed' });
    }

    // Step 2: Create RD user if missing
    const userCheck = await runShell('id -u bridgesrd 2>/dev/null');
    if (!userCheck.ok) {
      const userCreate = await runShell('useradd -m -s /bin/bash bridgesrd');
      steps.push({ step: 'Create bridgesrd user', ok: userCreate.ok, message: userCreate.ok ? 'User created' : userCreate.stderr.slice(0, 200) });
    } else {
      steps.push({ step: 'Create bridgesrd user', ok: true, message: 'User already exists' });
    }

    // Step 2a: Write the canonical desktop environment file (sourced by all launch paths)
    try {
      const { writeDesktopEnvFile } = require('../utils/desktopEnv');
      writeDesktopEnvFile();
      steps.push({ step: 'Write desktop env file', ok: true, message: 'Written to /home/bridgesrd/.bridges-rd-env' });
    } catch (err: any) {
      steps.push({ step: 'Write desktop env file', ok: false, message: `Non-fatal: ${err?.message?.slice(0, 200)}` });
    }

    // Step 2b: Configure XFCE theme for bridgesrd user (Greybird + elementary-dark icons)
    const xfceConfigDir = '/home/bridgesrd/.config/xfce4/xfconf/xfce-perchannel-xml';
    try {
      fs.mkdirSync(xfceConfigDir, { recursive: true });

      // GTK theme + icon theme
      const xsettingsXml = `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xsettings" version="1.0">
  <property name="Net" type="empty">
    <property name="ThemeName" type="string" value="Greybird"/>
    <property name="IconThemeName" type="string" value="elementary-xfce-dark"/>
    <property name="SoundThemeName" type="string" value="default"/>
  </property>
  <property name="Gtk" type="empty">
    <property name="CursorThemeName" type="string" value="Adwaita"/>
    <property name="FontName" type="string" value="Sans 10"/>
  </property>
</channel>
`;
      fs.writeFileSync(path.join(xfceConfigDir, 'xsettings.xml'), xsettingsXml);

      // Window manager theme
      const xfwm4Xml = `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="theme" type="string" value="Greybird"/>
    <property name="title_font" type="string" value="Sans Bold 9"/>
  </property>
</channel>
`;
      fs.writeFileSync(path.join(xfceConfigDir, 'xfwm4.xml'), xfwm4Xml);

      // Fix ownership
      await runShell(`chown -R bridgesrd:bridgesrd /home/bridgesrd/.config`, 5000);
      steps.push({ step: 'Configure desktop theme', ok: true, message: 'Greybird theme + elementary-dark icons' });
    } catch (err: any) {
      steps.push({ step: 'Configure desktop theme', ok: false, message: `Non-fatal: ${err?.message?.slice(0, 200)}` });
    }

    // Step 3: VNC auth — Xtigervnc runs with -SecurityTypes None on localhost only.
    // Portal authentication (httpOnly cookie) gates all noVNC access, so no VNC-level password is needed.
    steps.push({ step: 'VNC auth mode', ok: true, message: 'Portal-authenticated noVNC (Xtigervnc localhost-only, no VNC password needed)' });

    // Step 4: Write launcher scripts (Xtigervnc managed directly by systemd + shared Chrome)
    const webLauncher = '/usr/local/bin/bridges-rd-websockify-launcher.sh';
    const webScript = '#!/usr/bin/env bash\nset -euo pipefail\n# WebSocket-only mode — static files served by Express\n# Bind loopback only so raw websockify never bypasses portal auth.\nexec websockify 127.0.0.1:6080 127.0.0.1:5901\n';
    fs.writeFileSync(webLauncher, webScript, { mode: 0o755 });

    const sharedChromeLauncher = '/usr/local/bin/bridges-rd-shared-chrome.sh';
    // Copy the launcher from the portal's bundled skill (includes warm-up logic)
    const bundledLauncher = path.resolve(__dirname, '../../..', 'skills/bridgesllm-portal/scripts/bridges-rd-shared-chrome.sh');
    if (fs.existsSync(bundledLauncher)) {
      fs.copyFileSync(bundledLauncher, sharedChromeLauncher);
      fs.chmodSync(sharedChromeLauncher, 0o755);
    } else {
      // Fallback: write minimal launcher if bundled version not found
      const sharedChromeScript = `#!/usr/bin/env bash
set -euo pipefail
# Source canonical desktop env (written by VNC launcher / RD setup)
ENV_FILE="/home/bridgesrd/.bridges-rd-env"
if [ -f "$ENV_FILE" ]; then
  . "$ENV_FILE"
else
  # Fallback for older installs
  export DISPLAY=:1
  export XDG_RUNTIME_DIR=/tmp/bridges-rd-runtime
  export PULSE_SERVER=unix:/tmp/bridges-rd-runtime/pulse/native
  export SDL_AUDIODRIVER=pulseaudio
fi
PROFILE_DIR="/home/bridgesrd/.config/bridges-agent-browser"
mkdir -p "$PROFILE_DIR"
CHROME_BIN="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium-browser || command -v chromium)"
if [ -z "$CHROME_BIN" ]; then
  echo "No Chrome/Chromium binary found" >&2
  exit 1
fi
exec "$CHROME_BIN" \\
  --new-window \\
  --no-first-run \\
  --no-default-browser-check \\
  --no-sandbox \\
  --disable-gpu-sandbox \\
  --disable-setuid-sandbox \\
  --user-data-dir="$PROFILE_DIR" \\
  --remote-debugging-address=127.0.0.1 \\
  --remote-debugging-port=18801 \\
  "$@"
`;
      fs.writeFileSync(sharedChromeLauncher, sharedChromeScript, { mode: 0o755 });
    }
    steps.push({ step: 'Launcher scripts', ok: true, message: 'Written (websockify + shared Chrome)' });

    try {
      const desktopDir = '/home/bridgesrd/Desktop';
      fs.mkdirSync(desktopDir, { recursive: true });
      const sharedChromeDesktopEntry = `[Desktop Entry]
Version=1.0
Type=Application
Name=Shared Chrome
Comment=Shared browser used by the agent and the user inside Remote Desktop
Exec=/usr/local/bin/bridges-rd-shared-chrome.sh
Icon=google-chrome
Terminal=false
Categories=Network;WebBrowser;
StartupNotify=true
`;
      fs.writeFileSync(path.join(desktopDir, 'Shared Chrome.desktop'), sharedChromeDesktopEntry, { mode: 0o755 });
      await runShell('chown -R bridgesrd:bridgesrd /home/bridgesrd/Desktop', 5000);
      steps.push({ step: 'Shared Chrome desktop entry', ok: true, message: 'Desktop shortcut created' });
    } catch (err: any) {
      steps.push({ step: 'Shared Chrome desktop entry', ok: false, message: `Non-fatal: ${err?.message?.slice(0, 200)}` });
    }

    // Step 5: Write systemd units (Xtigervnc + websockify)
    // This is the PRODUCTION launcher — runs Xtigervnc as root, XFCE as bridgesrd user,
    // uses xdpyinfo to wait for display, disables screensaver, proper logging.
    const vncLauncher = '/usr/local/bin/bridges-rd-xtigervnc-start.sh';
    fs.writeFileSync(vncLauncher, `#!/bin/bash
set -euo pipefail

# Bridges Remote Desktop — Xtigervnc + XFCE wrapper
# Starts Xtigervnc on :1 with no VNC auth (portal JWT handles auth)
# Then launches XFCE desktop as bridgesrd user

DISPLAY_NUM=:1
VNC_PORT=5901
GEOMETRY=1280x1024
DEPTH=24
RD_USER=bridgesrd
XDG_DIR="/tmp/bridges-rd-runtime"
LOG_DIR="/var/log/bridges-rd"
ENV_FILE="/home/$RD_USER/.bridges-rd-env"

# Create log directory (not in /tmp, avoids protected_regular issues)
mkdir -p "$LOG_DIR"
chown "$RD_USER:$RD_USER" "$LOG_DIR"

# Clean up stale lock files
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true

# Clean up stale Xvfb/display :99 remnants
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
pkill -u "$RD_USER" -f "Xvfb" 2>/dev/null || true

# Kill any leftover XFCE sessions from this user before starting fresh
pkill -u "$RD_USER" -f "xfce4-session" 2>/dev/null || true

# Clear saved session cache so fresh configs always apply on restart
rm -rf /home/"$RD_USER"/.cache/sessions/* 2>/dev/null || true

# Ensure XDG_RUNTIME_DIR exists for the desktop user
mkdir -p "$XDG_DIR"
chown "$RD_USER:$RD_USER" "$XDG_DIR"
chmod 700 "$XDG_DIR"

# Write canonical desktop env file (sourced by projects, Chrome, agent browser)
cat > "$ENV_FILE" <<ENVEOF
# Auto-generated by BridgesLLM VNC launcher — do not edit manually.
export DISPLAY=$DISPLAY_NUM
export XDG_RUNTIME_DIR=$XDG_DIR
export PULSE_SERVER=unix:$XDG_DIR/pulse/native
export SDL_AUDIODRIVER=pulseaudio
export DEBIAN_FRONTEND=noninteractive
ENVEOF
chown "$RD_USER:$RD_USER" "$ENV_FILE"

# Start Xtigervnc as root (it manages its own display)
/usr/bin/Xtigervnc "$DISPLAY_NUM" \\
  -UseBlacklist=0 \\
  -localhost=1 \\
  -AcceptSetDesktopSize=1 \\
  -desktop "BridgesLLM Remote Desktop" \\
  -rfbport "$VNC_PORT" \\
  -SecurityTypes None \\
  -geometry "$GEOMETRY" \\
  -depth "$DEPTH" \\
  -ac &

VNC_PID=$!

# Wait for the display to become available
for i in $(seq 1 20); do
  if DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1; then
    echo "Display $DISPLAY_NUM is ready (attempt $i)"
    break
  fi
  sleep 0.5
done

# Start PulseAudio for audio support (virtual null sink → browser WebSocket)
su - "$RD_USER" -c "
  export XDG_RUNTIME_DIR=$XDG_DIR
  pulseaudio --kill 2>/dev/null || true
  sleep 0.5
  # Retry loop — PulseAudio can fail on cold boot if XDG_RUNTIME_DIR isn't ready
  for attempt in 1 2 3 4 5; do
    if pulseaudio --start --exit-idle-time=-1 2>>$LOG_DIR/pulseaudio.log; then
      echo \\"PulseAudio started on attempt \\\$attempt\\"
      break
    fi
    echo \\"PulseAudio start failed (attempt \\\$attempt), retrying...\\" >>$LOG_DIR/pulseaudio.log
    sleep 2
  done
  sleep 1
  export PULSE_SERVER=unix:$XDG_DIR/pulse/native
  pactl set-default-sink auto_null 2>/dev/null || true
  pactl unload-module module-suspend-on-idle 2>/dev/null || true
  echo 'PulseAudio configured (suspend-on-idle disabled)'
" &
PA_PID=$!
wait $PA_PID 2>/dev/null || true
echo "PulseAudio initialized"

# Start XFCE as bridgesrd user on display :1
# Note: redirect is inside su -c to avoid fs.protected_regular issues with /tmp
su - "$RD_USER" -c "
  export DISPLAY=$DISPLAY_NUM
  export XDG_RUNTIME_DIR=$XDG_DIR
  export PULSE_SERVER=unix:$XDG_DIR/pulse/native
  dbus-launch --exit-with-session startxfce4 >>$LOG_DIR/xfce.log 2>&1
" &

XFCE_PID=$!
echo "Xtigervnc PID=$VNC_PID, XFCE PID=$XFCE_PID"

# Wait for XFCE to start, then disable screensaver/blanking
sleep 5
DISPLAY="$DISPLAY_NUM" xset s off 2>/dev/null || true
DISPLAY="$DISPLAY_NUM" xset s noblank 2>/dev/null || true
# Kill screensaver if auto-started by XFCE
pkill -f xfce4-screensaver 2>/dev/null || true
echo "Screensaver disabled"

# Wait for VNC (main process). If it dies, everything should stop.
wait $VNC_PID
`, { mode: 0o755 });
    steps.push({ step: 'VNC launcher', ok: true, message: 'Written (production launcher)' });

    const vncUnit = `[Unit]
Description=Bridges Remote Desktop Xtigervnc :1
After=network.target
Before=bridges-rd-websockify.service

[Service]
Type=simple
User=root
ExecStartPre=-/bin/bash -c 'rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true'
ExecStart=${vncLauncher}
ExecStopPost=-/bin/bash -c 'pkill -f "Xtigervnc :1" 2>/dev/null || true'
Restart=always
RestartSec=3
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
`;
    const wsUnit = `[Unit]
Description=Bridges Remote Desktop noVNC Websockify
After=network.target bridges-rd-xtigervnc.service
Requires=bridges-rd-xtigervnc.service

[Service]
Type=simple
ExecStart=${webLauncher}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

    fs.writeFileSync('/etc/systemd/system/bridges-rd-xtigervnc.service', vncUnit);
    fs.writeFileSync('/etc/systemd/system/bridges-rd-websockify.service', wsUnit);
    steps.push({ step: 'Systemd units', ok: true, message: 'Written (bridges-rd-xtigervnc + bridges-rd-websockify)' });

    // Step 6: Reload systemd and start/restart services
    const reload = await runShell('systemctl daemon-reload');
    steps.push({ step: 'systemctl daemon-reload', ok: reload.ok, message: reload.ok ? 'OK' : reload.stderr.slice(0, 200) });

    // Disable old legacy service if present
    await runShell('systemctl disable --now bridges-rd-vnc.service 2>/dev/null || true');

    // Disable stock TigerVNC template — it races with our service for display :1.
    // On fresh installs, vncserver@1 can win the race and launch a bare VNC session
    // with no XFCE theme, no PulseAudio, no desktop environment — wrong product.
    await runShell('systemctl disable --now vncserver@1.service 2>/dev/null || true');
    await runShell('systemctl mask vncserver@1.service 2>/dev/null || true');
    await runShell('systemctl mask vncserver@.service 2>/dev/null || true');

    const enableSvc = await runShell('systemctl enable bridges-rd-xtigervnc.service bridges-rd-websockify.service');
    steps.push({ step: 'Enable services', ok: enableSvc.ok, message: enableSvc.ok ? 'Enabled' : enableSvc.stderr.slice(0, 200) });

    const restartVnc = await runShell('systemctl restart bridges-rd-xtigervnc.service', 15000);
    steps.push({ step: 'Start VNC service', ok: restartVnc.ok, message: restartVnc.ok ? 'Started' : restartVnc.stderr.slice(0, 200) });

    // Wait briefly for VNC to be ready before starting websockify
    await new Promise((r) => setTimeout(r, 2000));

    const restartWs = await runShell('systemctl restart bridges-rd-websockify.service', 15000);
    steps.push({ step: 'Start websockify service', ok: restartWs.ok, message: restartWs.ok ? 'Started' : restartWs.stderr.slice(0, 200) });

    // Step 7: Set or repair remoteDesktop.url
    const urlRow = await prisma.systemSetting.findUnique({ where: { key: 'remoteDesktop.url' } });
    const currentUrl = (urlRow?.value || '').trim();
    const normalizedUrl = normalizeRemoteDesktopUrl(currentUrl);

    if (!currentUrl || normalizedUrl !== currentUrl) {
      await prisma.systemSetting.upsert({
        where: { key: 'remoteDesktop.url' },
        update: { value: normalizedUrl || RD_DEFAULT_URL },
        create: { key: 'remoteDesktop.url', value: normalizedUrl || RD_DEFAULT_URL },
      });
      steps.push({ step: 'Set remoteDesktop.url', ok: true, message: `Set to ${normalizedUrl || RD_DEFAULT_URL}` });
    } else {
      steps.push({ step: 'Set remoteDesktop.url', ok: true, message: 'Already configured: ' + currentUrl });
    }

    const prefixesRow = await prisma.systemSetting.findUnique({ where: { key: 'remoteDesktop.allowedPathPrefixes' } });
    const currentPrefixes = (prefixesRow?.value || '').trim();
    if (!currentPrefixes) {
      await prisma.systemSetting.upsert({
        where: { key: 'remoteDesktop.allowedPathPrefixes' },
        update: { value: '/novnc,/vnc' },
        create: { key: 'remoteDesktop.allowedPathPrefixes', value: '/novnc,/vnc' },
      });
      steps.push({ step: 'Set allowed path prefixes', ok: true, message: 'Set to /novnc,/vnc' });
    } else {
      steps.push({ step: 'Set allowed path prefixes', ok: true, message: 'Already configured: ' + currentPrefixes });
    }

    // Step 8: Install bridgesllm-portal skill into OpenClaw workspace
    try {
      const portalSkillSrc = path.resolve(__dirname, '../../..', 'skills/bridgesllm-portal');
      const openclawWorkspace = process.env.OPENCLAW_WORKSPACE || '/root/.openclaw/workspace-main';
      const skillDest = path.join(openclawWorkspace, 'skills/bridgesllm-portal');

      if (fs.existsSync(path.join(portalSkillSrc, 'SKILL.md'))) {
        // Copy full skill directory (SKILL.md + scripts + references) to OpenClaw workspace
        await runShell(`mkdir -p "${skillDest}" && cp -r "${portalSkillSrc}/"* "${skillDest}/" && chmod +x "${skillDest}/scripts/"*.sh "${skillDest}/scripts/"*.mjs 2>/dev/null || true`, 10000);
        // Remove old shared-browser skill if it exists (superseded)
        const oldSkill = path.join(openclawWorkspace, 'skills/shared-browser');
        if (fs.existsSync(oldSkill)) {
          await runShell(`rm -rf "${oldSkill}"`, 5000);
        }
        steps.push({ step: 'Install bridgesllm-portal skill', ok: true, message: `Installed to ${skillDest}` });
      } else {
        steps.push({ step: 'Install bridgesllm-portal skill', ok: false, message: `Skill source not found at ${portalSkillSrc}` });
      }
    } catch (err: any) {
      steps.push({ step: 'Install bridgesllm-portal skill', ok: false, message: `Non-fatal: ${err?.message?.slice(0, 200)}` });
    }

    // Step 9: Reconcile dedicated visible-browser OpenClaw agent and portal defaults
    let gatewayRestartNeeded = false;
    try {
      const reconcile = await ensurePortalVisibleBrowserDefaults();
      gatewayRestartNeeded = reconcile.changed;
      steps.push({ step: 'Reconcile visible-browser OpenClaw agent', ok: true, message: reconcile.note });
    } catch (err: any) {
      steps.push({ step: 'Reconcile visible-browser OpenClaw agent', ok: false, message: `Non-fatal: ${err?.message?.slice(0, 200)}` });
    }

    // Step 10: Restart OpenClaw gateway if needed so the managed skill/agent are loaded for new sessions
    if (gatewayRestartNeeded) {
      const restart = await runShell('openclaw gateway restart', 30000);
      steps.push({
        step: 'Restart OpenClaw gateway',
        ok: restart.ok,
        message: restart.ok ? 'Restarted so managed skill/agent defaults are live for new sessions' : (restart.stderr || 'Restart command failed'),
      });
    } else {
      steps.push({ step: 'Restart OpenClaw gateway', ok: true, message: 'Not needed — managed skill/agent already current' });
    }

    // Step 11: Verify core ports and Shared Chrome contract
    await new Promise((r) => setTimeout(r, 3000));
    const vncOk = await checkTcpPort(5901);
    const novncOk = await checkTcpPort(6080);
    steps.push({ step: 'Verify VNC port 5901', ok: vncOk, message: vncOk ? 'Listening' : 'Not listening — check bridges-rd-xtigervnc.service logs' });
    steps.push({ step: 'Verify noVNC port 6080', ok: novncOk, message: novncOk ? 'Listening' : 'Not listening — check bridges-rd-websockify.service logs' });

    const chromeBinaryOk = (await runShell('command -v google-chrome-stable || command -v google-chrome || command -v chromium-browser || command -v chromium', 5000)).ok;
    steps.push({ step: 'Verify Chrome/Chromium binary', ok: chromeBinaryOk, message: chromeBinaryOk ? 'Found browser binary' : 'No Chrome/Chromium binary found' });

    const launcherOk = fs.existsSync('/usr/local/bin/bridges-rd-shared-chrome.sh');
    const desktopEntryOk = fs.existsSync('/home/bridgesrd/Desktop/Shared Chrome.desktop');
    const novncPortalOk = fs.existsSync(path.join(PORTAL_STATIC_NOVNC_DIR, 'vnc_portal.html'));
    const novncCoreOk = fs.existsSync(path.join(PORTAL_STATIC_NOVNC_DIR, 'core', 'rfb.js'));
    steps.push({ step: 'Verify Shared Chrome launcher', ok: launcherOk, message: launcherOk ? 'Present' : 'Missing launcher script' });
    steps.push({ step: 'Verify Shared Chrome desktop entry', ok: desktopEntryOk, message: desktopEntryOk ? 'Present' : 'Missing desktop shortcut' });
    steps.push({ step: 'Verify noVNC portal HTML', ok: novncPortalOk, message: novncPortalOk ? 'Present' : 'Missing static/novnc/vnc_portal.html' });
    steps.push({ step: 'Verify noVNC core bundle', ok: novncCoreOk, message: novncCoreOk ? 'Present' : 'Missing static/novnc/core/rfb.js' });

    const allOk = steps.every((s) => s.ok);
    return {
      ok: allOk,
      steps,
      message: allOk ? 'Remote Desktop setup complete and verified.' : 'Setup completed with warnings — review steps above.',
    };
  } catch (error: any) {
    steps.push({ step: 'Unexpected error', ok: false, message: error?.message || 'Unknown error' });
    return { ok: false, steps, message: error?.message || 'Auto-setup failed' };
  }
}

router.post('/auto-setup', async (_req: Request, res: Response) => {
  const result = await runRemoteDesktopAutoSetup();
  res.status(result.ok ? 200 : 500).json(result);
});

export default router;
