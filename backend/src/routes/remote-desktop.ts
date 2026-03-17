import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { exec as cpExec } from 'child_process';

const router = Router();
router.use(authenticateToken, requireAdmin);

type RemoteDesktopStatus = 'ready' | 'degraded' | 'unavailable';

const RD_DEFAULT_URL = '/novnc/vnc_portal.html?reconnect=1&resize=remote&path=novnc/websockify';

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

  if (value.startsWith('/novnc/vnc_portal.html') && !value.includes('path=')) {
    return value + (value.includes('?') ? '&' : '?') + 'path=novnc/websockify';
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

    // websockify no longer serves static files (March 2026) — Express serves them directly.
    // HTTP check removed; only TCP port checks matter now.

    const systemdServiceHints = {
      vnc: '/etc/systemd/system/bridges-rd-xtigervnc.service',
      websockify: '/etc/systemd/system/bridges-rd-websockify.service',
    };

    const vncServiceUnitPresent = fs.existsSync(systemdServiceHints.vnc);
    const websockifyUnitPresent = fs.existsSync(systemdServiceHints.websockify);

    const hasConfiguredUrl = configuredUrl.length > 0;

    const diagnostics = {
      configuredUrl,
      allowedPrefixes,
      checks: {
        hasConfiguredUrl,
        novncPortOpen,
        vncPortOpen,
        vncServiceUnitPresent,
        websockifyUnitPresent,
      },
      remediation: [
        'Check systemd units: bridges-rd-xtigervnc.service and bridges-rd-websockify.service.',
        'Verify host ports: 5901 (VNC) and 6080 (websockify).',
        'Use POST /api/remote-desktop/recover to attempt automatic recovery.',
      ],
    };

    let status: RemoteDesktopStatus = 'unavailable';
    let message = 'Remote Desktop is not available.';

    const unhealthyReason = [
      !vncPortOpen ? 'VNC 5901 down' : null,
      !novncPortOpen ? 'noVNC 6080 down' : null,
    ].filter(Boolean).join(', ');

    // Status reporting only — no automatic self-heal on poll.
    // Auto-restart was removed (March 2026) because it caused a restart-thrash
    // loop that freed port 6080 for the Docker container to grab, triggering
    // version mismatch crashes. Recovery is now admin-initiated only.

    if (hasConfiguredUrl && novncPortOpen && vncPortOpen) {
      status = 'ready';
      message = 'Remote Desktop is ready.';
    } else if (hasConfiguredUrl && (novncPortOpen || vncPortOpen)) {
      status = 'degraded';
      message = `Remote Desktop is partially available: ${unhealthyReason}. Use POST /api/remote-desktop/recover to attempt recovery.`;
    } else if (hasConfiguredUrl) {
      message = `Remote Desktop is unavailable: ${unhealthyReason || 'services not running'}. Use POST /api/remote-desktop/recover to attempt recovery.`;
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
    const requiredPkgs = ['tigervnc-standalone-server', 'novnc', 'websockify', 'xfce4', 'xfce4-goodies', 'xfce4-terminal', 'dbus-x11', 'x11-utils', 'firefox'];
    const pkgCheck = await runShell(`dpkg -s ${requiredPkgs.join(' ')} 2>/dev/null | grep -c "Status: install ok installed"`);
    const installedCount = parseInt(pkgCheck.stdout, 10) || 0;
    if (installedCount < requiredPkgs.length) {
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

    // Step 4: Write websockify launcher script (Xtigervnc managed directly by systemd)
    const webLauncher = '/usr/local/bin/bridges-rd-websockify-launcher.sh';
    const webScript = '#!/usr/bin/env bash\nset -euo pipefail\n# WebSocket-only mode — static files served by Express\nexec websockify 6080 127.0.0.1:5901\n';
    fs.writeFileSync(webLauncher, webScript, { mode: 0o755 });
    steps.push({ step: 'Launcher scripts', ok: true, message: 'Written' });

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
GEOMETRY=1920x1080
DEPTH=24
RD_USER=bridgesrd
XDG_DIR="/tmp/bridges-rd-runtime"
LOG_DIR="/var/log/bridges-rd"

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

# Ensure XDG_RUNTIME_DIR exists for the desktop user
mkdir -p "$XDG_DIR"
chown "$RD_USER:$RD_USER" "$XDG_DIR"
chmod 700 "$XDG_DIR"

# Start Xtigervnc as root (it manages its own display)
/usr/bin/Xtigervnc "$DISPLAY_NUM" \\
  -UseBlacklist=0 \\
  -localhost=1 \\
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

# Start XFCE as bridgesrd user on display :1
# Note: redirect is inside su -c to avoid fs.protected_regular issues with /tmp
su - "$RD_USER" -c "
  export DISPLAY=$DISPLAY_NUM
  export XDG_RUNTIME_DIR=$XDG_DIR
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

    // Step 8: Wait for ports to come up and verify
    await new Promise((r) => setTimeout(r, 3000));
    const vncOk = await checkTcpPort(5901);
    const novncOk = await checkTcpPort(6080);
    steps.push({ step: 'Verify VNC port 5901', ok: vncOk, message: vncOk ? 'Listening' : 'Not listening — check bridges-rd-xtigervnc.service logs' });
    steps.push({ step: 'Verify noVNC port 6080', ok: novncOk, message: novncOk ? 'Listening' : 'Not listening — check bridges-rd-websockify.service logs' });

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
