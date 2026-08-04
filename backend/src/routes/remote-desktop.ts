import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { createHash } from 'crypto';
import { exec as cpExec, execFile, spawn } from 'child_process';
import { getGatewayToken } from '../utils/gatewayToken';
import { PRIVILEGED_CONFIRMATION, isTypedConfirmationMatch } from '../utils/privilegedConfirmation';
import {
  MAX_REMOTE_DESKTOP_CLIPBOARD_BYTES,
  normalizeAudioProxyPort,
  normalizeRemoteDesktopAllowedPrefixes,
  remoteDesktopPathMatchesPrefix,
  utf8ByteLength,
} from '../services/remoteDesktopPolicy';
import {
  acquireRemoteDesktopMutationLock,
  RemoteDesktopMutationBusyError,
  type RemoteDesktopMutationLease,
} from '../services/remoteDesktopMutationLock';
import { assertOpenClawGatewayAuthorizationFenceReleased } from '../services/openClawGatewayAuthorizationFence';
import {
  openRemoteDesktopPath,
  RemoteDesktopOpenPathError,
  selectOpenClawAgentWorkspace,
  type RemoteDesktopAgentAuthority,
  type RemoteDesktopProjectAuthority,
} from '../services/remoteDesktopOpenPath';
import {
  ProjectIdentityLifecycleError,
  ProjectIdentityMismatchError,
  readProjectIdentity,
} from '../services/projectIdentity';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';

const router = Router();
router.use(authenticateToken, requireAdmin);

type RemoteDesktopStatus = 'ready' | 'degraded' | 'unavailable';

const RD_DEFAULT_URL = '/novnc/vnc_portal.html?reconnect=1&resize=smart';
const PORTAL_VISIBLE_AGENT_ID = 'main';
const PORTAL_VISIBLE_AGENT_NAME = 'Assistant';
const PORTAL_VISIBLE_AGENT_EMOJI = '🖥️';
const OPENCLAW_WORKSPACE = process.env.OPENCLAW_WORKSPACE || '/root/.openclaw/workspace-main';
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(process.env.HOME || '/root', '.openclaw/openclaw.json');
const PORTAL_STATIC_DIR = path.resolve(process.cwd(), '../static');
const PORTAL_STATIC_NOVNC_DIR = path.resolve(process.cwd(), '../static/novnc');
const SYSTEM_NOVNC_DIR = '/usr/share/novnc';
const SHARED_BROWSER_ICON_PATH = '/usr/local/share/pixmaps/bridges-shared-browser.svg';
const OPENCLAW_UI_ICON_PATH = '/usr/local/share/pixmaps/bridges-openclaw-ui.svg';
const AI_PROVIDER_LAUNCHER_PATH = '/usr/local/bin/bridges-rd-ai-launchers.sh';
const AI_PROVIDER_LAUNCHER_MANIFEST = '/var/lib/bridgesllm/remote-desktop-ai-launchers/manifest.tsv';
const OPENCLAW_UI_PROFILE_DIR = '/home/bridgesrd/.config/openclaw-control-ui-browser';
const OPENCLAW_UI_DASHBOARD_URL_FILE = `${OPENCLAW_UI_PROFILE_DIR}/dashboard-url`;
const OPENCLAW_UI_LAUNCH_HTML_FILE = `${OPENCLAW_UI_PROFILE_DIR}/launch.html`;
const SHARED_BROWSER_DESKTOP_ENTRY = '/home/bridgesrd/Desktop/Shared Chrome.desktop';
const OPENCLAW_UI_DESKTOP_ENTRY = '/home/bridgesrd/Desktop/OpenClaw Web UI.desktop';
const SHARED_BROWSER_STATE_DIR = '/home/bridgesrd/.config/bridges-agent-browser';
const SHARED_BROWSER_LOG_DIR = `${SHARED_BROWSER_STATE_DIR}/logs`;
const REMOTE_DESKTOP_SESSION_GUARD = '/usr/local/bin/bridges-rd-session-guard.sh';
const REMOTE_DESKTOP_HEALTHCHECK = '/usr/local/bin/bridges-rd-healthcheck.sh';
const REMOTE_DESKTOP_HEALTHCHECK_SERVICE = 'bridges-rd-healthcheck.service';
const REMOTE_DESKTOP_HEALTHCHECK_TIMER = 'bridges-rd-healthcheck.timer';
const REMOTE_DESKTOP_HEALTHCHECK_SERVICE_FILE = `/etc/systemd/system/${REMOTE_DESKTOP_HEALTHCHECK_SERVICE}`;
const REMOTE_DESKTOP_HEALTHCHECK_TIMER_FILE = `/etc/systemd/system/${REMOTE_DESKTOP_HEALTHCHECK_TIMER}`;
const REMOTE_DESKTOP_HEALTH_STATE_ROOT = '/run/bridges-rd';
const REMOTE_DESKTOP_HEALTH_STATE_FILE = `${REMOTE_DESKTOP_HEALTH_STATE_ROOT}/health-state.json`;
const REMOTE_DESKTOP_HEALTH_STATE_MAX_BYTES = 4096;
const REMOTE_DESKTOP_HEALTH_STATE_FRESH_SECONDS = 180;

type RemoteDesktopAutomaticHealthStatus = 'healthy' | 'recovered' | 'busy' | 'recovering' | 'unhealthy' | 'suppressed';

export type RemoteDesktopAutomaticHealthState = {
  status: RemoteDesktopAutomaticHealthStatus;
  note: string;
  checkedAt: string;
  lastRecoveryAt: string | null;
  suppressedUntil: string | null;
  fresh: boolean;
  suppressed: boolean;
};

function sanitizeRemoteDesktopHealthNote(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
    : '';
}

function parseRemoteDesktopHealthEpoch(value: unknown, nowSeconds: number, required: boolean): number | null {
  if (value === null || value === undefined) return required ? null : 0;
  if (!Number.isSafeInteger(value) || (value as number) < 1_577_836_800 || (value as number) > nowSeconds + 86_400) {
    return null;
  }
  return value as number;
}

export function readRemoteDesktopHealthState(
  filePath = REMOTE_DESKTOP_HEALTH_STATE_FILE,
  nowMs = Date.now(),
  expectedOwnerUid = 0,
): RemoteDesktopAutomaticHealthState | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()
      || stat.uid !== expectedOwnerUid
      || (stat.mode & 0o022) !== 0
      || stat.size < 2
      || stat.size > REMOTE_DESKTOP_HEALTH_STATE_MAX_BYTES) {
      return null;
    }

    const raw = Buffer.alloc(stat.size);
    const bytesRead = fs.readSync(fd, raw, 0, stat.size, 0);
    if (bytesRead !== stat.size) return null;
    const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    if (!parsed || Array.isArray(parsed) || parsed.schema !== 1) return null;

    const allowedStatuses: RemoteDesktopAutomaticHealthStatus[] = [
      'healthy',
      'recovered',
      'busy',
      'recovering',
      'unhealthy',
      'suppressed',
    ];
    if (!allowedStatuses.includes(parsed.status as RemoteDesktopAutomaticHealthStatus)) return null;

    const nowSeconds = Math.floor(nowMs / 1000);
    const checkedAt = parseRemoteDesktopHealthEpoch(parsed.checkedAt, nowSeconds, true);
    const lastRecoveryAt = parseRemoteDesktopHealthEpoch(parsed.lastRecoveryAt, nowSeconds, false);
    const suppressedUntil = parseRemoteDesktopHealthEpoch(parsed.suppressedUntil, nowSeconds, false);
    if (checkedAt === null || lastRecoveryAt === null || suppressedUntil === null) return null;

    const status = parsed.status as RemoteDesktopAutomaticHealthStatus;
    const suppressionActive = Boolean(suppressedUntil && suppressedUntil > nowSeconds);
    return {
      status,
      note: sanitizeRemoteDesktopHealthNote(parsed.note),
      checkedAt: new Date(checkedAt * 1000).toISOString(),
      lastRecoveryAt: lastRecoveryAt ? new Date(lastRecoveryAt * 1000).toISOString() : null,
      suppressedUntil: suppressedUntil ? new Date(suppressedUntil * 1000).toISOString() : null,
      fresh: checkedAt <= nowSeconds + 60 && nowSeconds - checkedAt <= REMOTE_DESKTOP_HEALTH_STATE_FRESH_SECONDS,
      suppressed: status === 'suppressed' || suppressionActive,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function clearRemoteDesktopAutomaticRecoveryLimits(): { ok: boolean; note: string } {
  try {
    if (!fs.existsSync(REMOTE_DESKTOP_HEALTH_STATE_ROOT)) {
      fs.mkdirSync(REMOTE_DESKTOP_HEALTH_STATE_ROOT, { mode: 0o755 });
    }
    const rootStat = fs.lstatSync(REMOTE_DESKTOP_HEALTH_STATE_ROOT);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== 0 || (rootStat.mode & 0o022) !== 0) {
      return { ok: false, note: 'automatic recovery state directory is not an attested root-owned directory' };
    }
    for (const name of ['restart-history', 'suppressed-until']) {
      const target = path.join(REMOTE_DESKTOP_HEALTH_STATE_ROOT, name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(target);
      } catch (error: any) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        return { ok: false, note: `${name} is not a removable state file` };
      }
      fs.unlinkSync(target);
    }
    return { ok: true, note: 'automatic recovery restart limits reset' };
  } catch (error: any) {
    return { ok: false, note: error?.message || String(error) };
  }
}

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
    const parsed = new URL(value, 'http://portal.invalid');
    // The embedded client deliberately connects only to the exact same-origin
    // Portal bridge. Remove legacy endpoint override parameters during repair.
    parsed.searchParams.delete('host');
    parsed.searchParams.delete('port');
    parsed.searchParams.delete('path');
    if (!parsed.searchParams.has('resize') || ['remote', 'scale'].includes(parsed.searchParams.get('resize') || '')) {
      parsed.searchParams.set('resize', 'smart');
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
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

async function restartOpenClawGatewaySystemUnit(timeoutMs = 60000): Promise<void> {
  await assertOpenClawGatewayAuthorizationFenceReleased();
  if (!fs.existsSync('/run/systemd/system') || !fs.existsSync('/usr/bin/systemctl')) {
    throw new Error('OpenClaw gateway restart requires the installed systemd system service.');
  }
  await new Promise<void>((resolve, reject) => {
    execFile(
      '/usr/bin/systemctl',
      ['restart', 'openclaw-gateway.service'],
      { timeout: timeoutMs, encoding: 'utf8' },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = (stderr || error.message || '').trim();
        reject(new Error(`OpenClaw gateway system service restart failed${detail ? `: ${detail}` : '.'}`));
      },
    );
  });
}


type DesktopClipboardSelection = 'clipboard' | 'primary';
type DesktopClipboardTool = { name: 'xclip' | 'xsel'; path: string };

const DESKTOP_DISPLAY = process.env.REMOTE_DESKTOP_DISPLAY || ':1';
const DESKTOP_RUNTIME_DIR = process.env.REMOTE_DESKTOP_RUNTIME_DIR || '/tmp/bridges-rd-runtime';
const RD_AUDIO_PORT = normalizeAudioProxyPort(process.env.RD_AUDIO_PORT);

function normalizeDesktopClipboardSelection(raw: unknown): DesktopClipboardSelection {
  return raw === 'primary' ? 'primary' : 'clipboard';
}

function desktopClipboardEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: process.env.LANG || 'C.UTF-8',
        DISPLAY: DESKTOP_DISPLAY,
        HOME: '/home/bridgesrd',
        XAUTHORITY: '/home/bridgesrd/.Xauthority',
    XDG_RUNTIME_DIR: DESKTOP_RUNTIME_DIR,
  };
}

function desktopClipboardIdentity(): { uid: number; gid: number } {
  try {
    const account = fs.readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .find((line) => line.startsWith('bridgesrd:'));
    const fields = account?.split(':') || [];
    const uid = Number(fields[2]);
    const gid = Number(fields[3]);
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {
      throw new Error('invalid uid/gid');
    }
    return { uid, gid };
  } catch {
    throw new Error('Remote Desktop user is unavailable. Re-run Remote Desktop setup.');
  }
}

function privateDesktopDirectoryIsCurrent(directory: string): boolean {
  try {
    const identity = desktopClipboardIdentity();
    const stat = fs.lstatSync(directory);
    return stat.isDirectory()
      && !stat.isSymbolicLink()
      && stat.uid === identity.uid
      && stat.gid === identity.gid
      && (stat.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

function commandExists(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/env', ['bash', '-lc', `command -v ${command}`], { timeout: 2000, encoding: 'utf8' }, (error, stdout) => {
      if (error) return resolve(null);
      const value = String(stdout || '').trim().split('\n')[0]?.trim();
      resolve(value || null);
    });
  });
}

async function resolveDesktopClipboardTool(): Promise<DesktopClipboardTool | null> {
  const xclip = await commandExists('xclip');
  if (xclip) return { name: 'xclip', path: xclip };
  const xsel = await commandExists('xsel');
  if (xsel) return { name: 'xsel', path: xsel };
  return null;
}

function readDesktopClipboardWithTool(tool: DesktopClipboardTool, selection: DesktopClipboardSelection, timeoutMs = 3000): Promise<string> {
  const args = tool.name === 'xclip'
    ? ['-selection', selection, '-out']
    : [selection === 'clipboard' ? '--clipboard' : '--primary', '--output'];

  return new Promise((resolve, reject) => {
    const identity = desktopClipboardIdentity();
    execFile(tool.path, args, {
      env: desktopClipboardEnv(),
      uid: identity.uid,
      gid: identity.gid,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: MAX_REMOTE_DESKTOP_CLIPBOARD_BYTES,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve(String(stdout || ''));
        return;
      }

      const message = String(stderr || error.message || 'Desktop clipboard read failed');
      if (/target .* not available|unable to open display|could not open display|no owner/i.test(message)) {
        resolve('');
        return;
      }
      reject(new Error(message.trim()));
    });
  });
}

async function readDesktopClipboard(selection: DesktopClipboardSelection): Promise<{ text: string; tool: DesktopClipboardTool }> {
  const tool = await resolveDesktopClipboardTool();
  if (!tool) throw new Error('No desktop clipboard tool installed. Install xclip or xsel.');

  const text = await readDesktopClipboardWithTool(tool, selection);
  return { text, tool };
}

async function writeDesktopClipboard(selection: DesktopClipboardSelection, text: string): Promise<{ tool: DesktopClipboardTool }> {
  const tool = await resolveDesktopClipboardTool();
  if (!tool) {
    throw new Error('No desktop clipboard tool installed. Install xclip or xsel.');
  }

  return new Promise((resolve, reject) => {

    const args = tool.name === 'xclip'
      ? ['-selection', selection, '-in']
      : [selection === 'clipboard' ? '--clipboard' : '--primary', '--input'];

    const identity = desktopClipboardIdentity();
    const child = spawn(tool.path, args, {
      env: desktopClipboardEnv(),
      uid: identity.uid,
      gid: identity.gid,
      detached: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve({ tool });
    };

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length);
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (settled) return;
      if (code && code !== 0) finish(new Error(stderr.trim() || `Desktop clipboard write failed with exit code ${code}`));
    });
    child.stdin?.end(text);
    child.unref();
    // xclip/xsel may stay alive as the selection owner. That is success, not a hang.
    setTimeout(() => finish(), 350);
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

function resolveBundledStaticPath(relativePath: string): string | null {
  const candidates = [
    path.resolve(__dirname, '../../..', relativePath),
    path.join(PORTAL_STATIC_DIR, relativePath.replace(/^static\//, '')),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function copyBundledStaticFile(relativePath: string, destPath: string, mode: number): boolean {
  const source = resolveBundledStaticPath(relativePath);
  if (!source) return false;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(source, destPath);
  fs.chmodSync(destPath, mode);
  return true;
}

function getOpenClawDashboardUrl(): string {
  const configured = process.env.OPENCLAW_DASHBOARD_URL?.trim();
  if (configured) return configured;
  const token = getGatewayToken().trim();
  const baseUrl = 'http://127.0.0.1:18789/';
  return token ? `${baseUrl}#token=${encodeURIComponent(token)}` : baseUrl;
}

function getOpenClawLaunchHtml(dashboardUrl = getOpenClawDashboardUrl()): string {
  const urlJson = JSON.stringify(dashboardUrl);
  const escapedRefreshUrl = dashboardUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Opening OpenClaw Web UI…</title>
  <meta http-equiv="refresh" content="0; url=${escapedRefreshUrl}" />
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background: #070b14; color: #d9f6ff; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; }
    main { text-align: center; padding: 24px; }
    .mark { font-size: 52px; line-height: 1; margin-bottom: 14px; }
    p { margin: 0; opacity: .78; }
  </style>
</head>
<body>
  <main><div class="mark">🦞</div><p>Opening OpenClaw Web UI…</p></main>
  <script>window.location.replace(${urlJson});</script>
</body>
</html>
`;
}

function writeFileIfChanged(filePath: string, content: string, mode: number): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  const changed = existing !== content;
  if (changed) fs.writeFileSync(filePath, content, { mode });
  fs.chmodSync(filePath, mode);
  return changed;
}

function getRemoteDesktopHealthcheckServiceUnit(): string {
  return `[Unit]
Description=Bridges Remote Desktop semantic health recovery
After=bridges-rd-xtigervnc.service bridges-rd-websockify.service

[Service]
Type=oneshot
User=root
ExecStart=${REMOTE_DESKTOP_HEALTHCHECK}
TimeoutStartSec=150
UMask=0077
`;
}

function getRemoteDesktopHealthcheckTimerUnit(): string {
  return `[Unit]
Description=Check and recover Bridges Remote Desktop

[Timer]
OnBootSec=45s
OnUnitActiveSec=30s
AccuracySec=5s
Unit=${REMOTE_DESKTOP_HEALTHCHECK_SERVICE}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function writeRemoteDesktopHealthcheckUnits(): { changed: boolean; ok: boolean; note: string } {
  try {
    if (!bundledStaticFileIsCurrent('installer/scripts/bridges-rd-healthcheck.sh', REMOTE_DESKTOP_HEALTHCHECK)) {
      return { changed: false, ok: false, note: 'signed Remote Desktop healthcheck is missing or stale' };
    }
    const serviceChanged = writeFileIfChanged(
      REMOTE_DESKTOP_HEALTHCHECK_SERVICE_FILE,
      getRemoteDesktopHealthcheckServiceUnit(),
      0o644,
    );
    const timerChanged = writeFileIfChanged(
      REMOTE_DESKTOP_HEALTHCHECK_TIMER_FILE,
      getRemoteDesktopHealthcheckTimerUnit(),
      0o644,
    );
    return {
      changed: serviceChanged || timerChanged,
      ok: true,
      note: serviceChanged || timerChanged ? 'automatic recovery units refreshed' : 'automatic recovery units already current',
    };
  } catch (error: any) {
    return { changed: false, ok: false, note: error?.message || String(error) };
  }
}

function copyBundledStaticFileIfChanged(relativePaths: string[], destPath: string, mode: number): { ok: boolean; changed: boolean; source?: string } {
  const source = relativePaths.map(resolveBundledStaticPath).find((candidate): candidate is string => Boolean(candidate));
  if (!source) return { ok: false, changed: false };
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const src = fs.readFileSync(source);
  const changed = !fs.existsSync(destPath) || !fs.readFileSync(destPath).equals(src);
  if (changed) fs.copyFileSync(source, destPath);
  fs.chmodSync(destPath, mode);
  return { ok: true, changed, source };
}

function bundledStaticFileIsCurrent(relativePath: string, destPath: string): boolean {
  return bundledStaticCandidatesAreCurrent([relativePath], destPath);
}

function bundledStaticCandidatesAreCurrent(relativePaths: string[], destPath: string): boolean {
  try {
    const source = relativePaths.map(resolveBundledStaticPath).find((candidate): candidate is string => Boolean(candidate));
    return Boolean(source && fs.existsSync(destPath) && fs.readFileSync(source).equals(fs.readFileSync(destPath)));
  } catch {
    return false;
  }
}

function openClawDashboardUrlFileIsCurrent(): boolean {
  try {
    return fs.readFileSync(OPENCLAW_UI_DASHBOARD_URL_FILE, 'utf8').trim() === getOpenClawDashboardUrl();
  } catch {
    return false;
  }
}

function openClawLaunchHtmlIsCurrent(): boolean {
  try {
    return fs.readFileSync(OPENCLAW_UI_LAUNCH_HTML_FILE, 'utf8') === getOpenClawLaunchHtml();
  } catch {
    return false;
  }
}

async function ensureRemoteDesktopLauncherAssets(options: {
  reloadDesktop?: boolean;
  terminateStaleOpenClawUi?: boolean;
} = {}): Promise<{ ok: boolean; changed: boolean; note: string }> {
  const userCheck = await runShell('id bridgesrd >/dev/null 2>&1', 3000);
  if (!userCheck.ok) return { ok: true, changed: false, note: 'bridgesrd user absent; launcher reconcile skipped' };

  const notes: string[] = [];
  let changed = false;
  let ok = true;

  try {
    const stateDirectories = await runShell(
      `runuser -u bridgesrd -- install -d -m 0700 ${JSON.stringify(SHARED_BROWSER_STATE_DIR)} ${JSON.stringify(SHARED_BROWSER_LOG_DIR)} ${JSON.stringify(OPENCLAW_UI_PROFILE_DIR)}`,
      5000,
    );
    if (!stateDirectories.ok) {
      ok = false;
      notes.push(`private browser state directories unavailable: ${stateDirectories.stderr || 'unknown error'}`);
    }
    const sharedScript = copyBundledStaticFileIfChanged([
      'static/scripts/bridges-rd-shared-chrome.sh',
    ], '/usr/local/bin/bridges-rd-shared-chrome.sh', 0o755);
    const openclawScript = copyBundledStaticFileIfChanged([
      'static/scripts/bridges-rd-openclaw-ui.sh',
    ], '/usr/local/bin/bridges-rd-openclaw-ui.sh', 0o755);
    const aiProviderScript = copyBundledStaticFileIfChanged([
      'static/scripts/bridges-rd-ai-launchers.sh',
    ], AI_PROVIDER_LAUNCHER_PATH, 0o755);
    const vncLauncher = copyBundledStaticFileIfChanged([
      'installer/scripts/bridges-rd-xtigervnc-start.sh',
    ], '/usr/local/bin/bridges-rd-xtigervnc-start.sh', 0o755);
    const sessionGuard = copyBundledStaticFileIfChanged([
      'installer/scripts/bridges-rd-session-guard.sh',
    ], REMOTE_DESKTOP_SESSION_GUARD, 0o755);
    const healthcheck = copyBundledStaticFileIfChanged([
      'installer/scripts/bridges-rd-healthcheck.sh',
    ], REMOTE_DESKTOP_HEALTHCHECK, 0o755);
    const windowFit = copyBundledStaticFileIfChanged([
      'installer/scripts/bridges-rd-window-fit.sh',
    ], '/usr/local/bin/bridges-rd-window-fit.sh', 0o755);
    const sharedIcon = copyBundledStaticFileIfChanged(['static/icons/bridges-shared-browser.svg'], SHARED_BROWSER_ICON_PATH, 0o644);
    const openclawIcon = copyBundledStaticFileIfChanged(['static/icons/bridges-openclaw-ui.svg'], OPENCLAW_UI_ICON_PATH, 0o644);
    const sharedPng = copyBundledStaticFileIfChanged(['static/icons/bridges-shared-browser.png'], '/usr/local/share/pixmaps/bridges-shared-browser.png', 0o644);
    const openclawPng = copyBundledStaticFileIfChanged(['static/icons/bridges-openclaw-ui.png'], '/usr/local/share/pixmaps/bridges-openclaw-ui.png', 0o644);

    for (const [label, result] of Object.entries({ sharedScript, openclawScript, aiProviderScript, vncLauncher, sessionGuard, healthcheck, windowFit, sharedIcon, openclawIcon })) {
      ok = ok && result.ok;
      changed = changed || result.changed;
      if (!result.ok) notes.push(`${label} missing from bundled assets`);
    }
    for (const [label, result] of Object.entries({ sharedPng, openclawPng })) {
      changed = changed || result.changed;
      if (!result.ok) notes.push(`${label} optional PNG missing from bundled assets`);
    }

    const dashboardUrl = getOpenClawDashboardUrl();
    changed = writeFileIfChanged(OPENCLAW_UI_DASHBOARD_URL_FILE, `${dashboardUrl}\n`, 0o600) || changed;
    changed = writeFileIfChanged(OPENCLAW_UI_LAUNCH_HTML_FILE, getOpenClawLaunchHtml(dashboardUrl), 0o600) || changed;

    const sharedDesktopEntry = `[Desktop Entry]
Version=1.0
Type=Application
Name=Shared Browser
Comment=Shared browser used by the agent and the user inside Remote Desktop
Exec=/usr/local/bin/bridges-rd-shared-chrome.sh
Icon=${SHARED_BROWSER_ICON_PATH}
Terminal=false
Categories=Network;WebBrowser;
StartupNotify=true
`;
    const openclawDesktopEntry = `[Desktop Entry]
Version=1.0
Type=Application
Name=OpenClaw Web UI
Comment=Open native OpenClaw Control UI in a dedicated browser profile
Exec=/usr/local/bin/bridges-rd-openclaw-ui.sh
Icon=${OPENCLAW_UI_ICON_PATH}
Terminal=false
Categories=Development;Network;WebBrowser;
StartupNotify=true
`;
    changed = writeFileIfChanged(SHARED_BROWSER_DESKTOP_ENTRY, sharedDesktopEntry, 0o755) || changed;
    changed = writeFileIfChanged(OPENCLAW_UI_DESKTOP_ENTRY, openclawDesktopEntry, 0o755) || changed;

    if (aiProviderScript.ok) {
      const aiProviderInstall = await runShell(
        `${JSON.stringify(AI_PROVIDER_LAUNCHER_PATH)} install --assets-dir ${JSON.stringify(path.join(PORTAL_STATIC_DIR, 'icons'))}`,
        15_000,
      );
      if (!aiProviderInstall.ok) {
        ok = false;
        notes.push(`AI runtime launchers unavailable: ${aiProviderInstall.stderr || 'installer failed'}`);
      } else if (aiProviderInstall.stdout.trim() === 'changed') {
        changed = true;
      }
    }

    await runShell(`chown -R bridgesrd:bridgesrd /home/bridgesrd/Desktop ${OPENCLAW_UI_PROFILE_DIR}`, 5000);
    await runShell(`chmod 755 ${JSON.stringify(SHARED_BROWSER_DESKTOP_ENTRY)} ${JSON.stringify(OPENCLAW_UI_DESKTOP_ENTRY)}; chmod 600 ${JSON.stringify(OPENCLAW_UI_DASHBOARD_URL_FILE)} ${JSON.stringify(OPENCLAW_UI_LAUNCH_HTML_FILE)}`, 5000);
    await runShell(`runuser -u bridgesrd -- bash -lc 'command -v gio >/dev/null 2>&1 && gio set ${JSON.stringify(SHARED_BROWSER_DESKTOP_ENTRY)} metadata::trusted true || true; command -v gio >/dev/null 2>&1 && gio set ${JSON.stringify(OPENCLAW_UI_DESKTOP_ENTRY)} metadata::trusted true || true'`, 5000);
    if (options.terminateStaleOpenClawUi) {
      await runShell(`ps -eo pid=,args= | awk '/[O]penClawControlUI/ && /[#]token=/ {print $1}' | xargs -r kill`, 5000);
    }

    if (options.reloadDesktop) {
      await runShell(`pgrep -u bridgesrd xfdesktop >/dev/null 2>&1 && runuser -u bridgesrd -- bash -lc 'DISPLAY=:1 XDG_RUNTIME_DIR=/tmp/bridges-rd-runtime xfdesktop --reload' || true`, 5000);
    }
  } catch (err: any) {
    ok = false;
    notes.push(err?.message || String(err));
  }

  if (ok && !notes.length) notes.push(changed ? 'launcher assets refreshed' : 'launcher assets already current');
  return { ok, changed, note: notes.join('; ') };
}

async function writeOpenClawDashboardUrlFile(): Promise<boolean> {
  const result = await ensureRemoteDesktopLauncherAssets({ terminateStaleOpenClawUi: true });
  return result.ok;
}

function ensureNovncStaticBundle(): { changed: boolean; ok: boolean; note: string } {
  try {
    const portalHtmlPath = path.join(PORTAL_STATIC_NOVNC_DIR, 'vnc_portal.html');
    const coreRfbPath = path.join(PORTAL_STATIC_NOVNC_DIR, 'core', 'rfb.js');
    const appUiPath = path.join(PORTAL_STATIC_NOVNC_DIR, 'app', 'ui.js');
    const hasBundle = fs.existsSync(coreRfbPath) && fs.existsSync(appUiPath);

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

export async function reconcileRemoteDesktopLauncherAssets(): Promise<void> {
  try {
    const result = await ensureRemoteDesktopLauncherAssets({ reloadDesktop: true });
    if (result.changed) {
      console.log(`[remote-desktop] Reconciled browser launchers/icons: ${result.note}`);
    } else if (!result.ok) {
      console.warn(`[remote-desktop] Launcher/icon reconcile incomplete: ${result.note}`);
    }
  } catch (err: any) {
    console.warn('[remote-desktop] best-effort launcher/icon reconcile failed:', err?.message || err);
  }
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
      await restartOpenClawGatewaySystemUnit(20000);
      console.log('[remote-desktop] Reconciled visible-browser agent defaults and restarted gateway');
    }
  } catch (err: any) {
    console.warn('[remote-desktop] best-effort reconcile failed:', err?.message || err);
  }
}

type RemoteDesktopRecoveryResult = {
  attempted: boolean;
  ok: boolean;
  note: string;
  mode: 'in-place' | 'restart' | 'none';
  disrupted: boolean;
  restartRequired?: boolean;
};

async function attemptSelfHeal(reason: string, allowRestart = false): Promise<RemoteDesktopRecoveryResult> {
  if (recoveryState.inProgress) {
    return { attempted: false, ok: false, note: 'Recovery already in progress.', mode: 'none', disrupted: false };
  }

  let lease: RemoteDesktopMutationLease;
  try {
    lease = acquireRemoteDesktopMutationLock('recover Remote Desktop services');
  } catch (error) {
    if (error instanceof RemoteDesktopMutationBusyError) {
      return { attempted: false, ok: false, note: error.message, mode: 'none', disrupted: false };
    }
    throw error;
  }

  recoveryState.inProgress = true;
  recoveryState.lastAttemptAt = Date.now();

  try {
    const attestRuntime = async () => {
      const [
        vncPortOpen,
        novncPortOpen,
        vncServiceActive,
        websockifyServiceActive,
        vncLoopbackOnly,
        novncLoopbackOnly,
        processPolicy,
        websockifyPolicy,
        desktopSessionPolicy,
        sessionGuardSupervised,
        healthcheckTimerActive,
      ] = await Promise.all([
        checkTcpPort(5901),
        checkTcpPort(6080),
        checkSystemdUnitActive('bridges-rd-xtigervnc.service'),
        checkSystemdUnitActive('bridges-rd-websockify.service'),
        checkLoopbackOnlyListeningPort(5901),
        checkLoopbackOnlyListeningPort(6080),
        inspectVncProcessPolicy(),
        inspectWebsockifyProcessPolicy(),
        inspectDesktopSessionPolicy(),
        inspectSessionGuardSupervision(),
        checkSystemdUnitActive(REMOTE_DESKTOP_HEALTHCHECK_TIMER),
      ]);
      const healthcheckScriptCurrent = bundledStaticFileIsCurrent(
        'installer/scripts/bridges-rd-healthcheck.sh',
        REMOTE_DESKTOP_HEALTHCHECK,
      );
      const automaticHealth = readRemoteDesktopHealthState();
      const automaticHealthReady = Boolean(
        automaticHealth
        && automaticHealth.fresh
        && !automaticHealth.suppressed
        && ['healthy', 'recovered'].includes(automaticHealth.status),
      );
      const ok = vncPortOpen && novncPortOpen && vncServiceActive && websockifyServiceActive
        && vncLoopbackOnly && novncLoopbackOnly && processPolicy.hardened
        && websockifyPolicy.hardened && desktopSessionPolicy.healthy && sessionGuardSupervised
        && healthcheckTimerActive && healthcheckScriptCurrent && automaticHealthReady;
      return {
        ok,
        failures: [
          !vncPortOpen ? 'VNC port 5901 is unavailable' : null,
          !novncPortOpen ? 'websockify port 6080 is unavailable' : null,
          !vncServiceActive ? 'VNC service is inactive' : null,
          !websockifyServiceActive ? 'websockify service is inactive' : null,
          !vncLoopbackOnly ? 'VNC listener is not loopback-only' : null,
          !novncLoopbackOnly ? 'websockify listener is not loopback-only' : null,
          !processPolicy.hardened ? 'live VNC process lacks Xauthority/access-control hardening' : null,
          !websockifyPolicy.hardened ? 'live websockify process does not match the loopback bridge policy' : null,
          !desktopSessionPolicy.healthy ? desktopSessionPolicy.note || 'desktop session policy is unhealthy' : null,
          !sessionGuardSupervised ? 'desktop session guard is not supervised by the VNC service' : null,
          !healthcheckTimerActive ? 'automatic Remote Desktop recovery timer is inactive' : null,
          !healthcheckScriptCurrent ? 'automatic Remote Desktop healthcheck differs from the signed bundle' : null,
          !automaticHealthReady ? automaticHealth?.suppressed
            ? 'automatic Remote Desktop recovery is rate-suppressed'
            : !automaticHealth?.fresh
              ? 'automatic Remote Desktop health state is stale or unavailable'
              : `automatic Remote Desktop health state is ${automaticHealth?.status || 'unavailable'}` : null,
        ].filter((value): value is string => Boolean(value)),
      };
    };

    // First try the safe repair lane. It only converges no-lock policy,
    // terminates known lockers, and restores X idle state. No service, browser,
    // or desktop process is restarted here.
    const inPlaceRepair = await repairDesktopSessionPolicy();
    if (bundledStaticFileIsCurrent('installer/scripts/bridges-rd-healthcheck.sh', REMOTE_DESKTOP_HEALTHCHECK)
      && await checkSystemdUnitActive(REMOTE_DESKTOP_HEALTHCHECK_TIMER)) {
      await runShell(`systemctl start ${REMOTE_DESKTOP_HEALTHCHECK_SERVICE}`, 150000);
    }
    const inPlaceRuntime = await attestRuntime();
    if (inPlaceRepair.ok && inPlaceRuntime.ok) {
      recoveryState.lastError = null;
      recoveryState.attempt = 0;
      recoveryState.nextAllowedAt = 0;
      return {
        attempted: true,
        ok: true,
        note: `Remote Desktop session policy was repaired without interrupting the desktop (${reason}).`,
        mode: 'in-place',
        disrupted: false,
      };
    }

    if (!allowRestart) {
      const note = [...inPlaceRuntime.failures, !inPlaceRepair.ok ? inPlaceRepair.note : null]
        .filter((value): value is string => Boolean(value))
        .join('; ') || 'structural Remote Desktop recovery is required';
      return {
        attempted: true,
        ok: false,
        note,
        mode: 'none',
        disrupted: false,
        restartRequired: true,
      };
    }

    const now = Date.now();
    if (now < recoveryState.nextAllowedAt) {
      const waitSec = Math.ceil((recoveryState.nextAllowedAt - now) / 1000);
      return { attempted: false, ok: false, note: `Next restart recovery attempt in ${waitSec}s.`, mode: 'none', disrupted: false };
    }

    recoveryState.attempt += 1;
    const assets = await ensureRemoteDesktopLauncherAssets();
    const healthcheckUnits = assets.ok
      ? writeRemoteDesktopHealthcheckUnits()
      : { changed: false, ok: false, note: 'Signed Remote Desktop launcher assets are unavailable' };
    const daemonReload = healthcheckUnits.ok && healthcheckUnits.changed
      ? await runShell('systemctl daemon-reload', 10000)
      : { ok: healthcheckUnits.ok, stdout: '', stderr: healthcheckUnits.ok ? '' : healthcheckUnits.note };
    const healthcheckTimerPrepared = daemonReload.ok
      ? await runShell(`systemctl enable ${REMOTE_DESKTOP_HEALTHCHECK_TIMER} && systemctl stop ${REMOTE_DESKTOP_HEALTHCHECK_TIMER} ${REMOTE_DESKTOP_HEALTHCHECK_SERVICE}`, 10000)
      : { ok: false, stdout: '', stderr: daemonReload.stderr || 'Automatic recovery units could not be loaded' };
    const resetFailed = assets.ok && healthcheckUnits.ok && daemonReload.ok && healthcheckTimerPrepared.ok
      ? await runShell('systemctl reset-failed bridges-rd-xtigervnc.service bridges-rd-websockify.service', 5000)
      : { ok: false, stdout: '', stderr: 'Signed Remote Desktop launcher assets are unavailable' };
    const vncRestart = assets.ok
      && resetFailed.ok
      ? await runShell('systemctl restart bridges-rd-xtigervnc.service', 140000)
      : { ok: false, stdout: '', stderr: 'Signed Remote Desktop launcher assets are unavailable; services were not restarted' };
    const websockifyRestart = vncRestart.ok
      ? await runShell('systemctl restart bridges-rd-websockify.service', 20000)
      : { ok: false, stdout: '', stderr: 'VNC restart failed; websockify restart was not attempted' };
    const recoveryLimits = websockifyRestart.ok
      ? clearRemoteDesktopAutomaticRecoveryLimits()
      : { ok: false, note: 'websockify restart failed; automatic recovery limits were not reset' };
    const healthcheckTimerStarted = recoveryLimits.ok
      ? await runShell(`systemctl start ${REMOTE_DESKTOP_HEALTHCHECK_TIMER}`, 10000)
      : { ok: false, stdout: '', stderr: 'automatic recovery state could not be reset; timer was not started' };
    const healthcheckSeed = healthcheckTimerStarted.ok
      ? await runShell(`systemctl start ${REMOTE_DESKTOP_HEALTHCHECK_SERVICE}`, 150000)
      : { ok: false, stdout: '', stderr: 'automatic recovery timer failed; healthcheck was not seeded' };
    const restartedRuntime = vncRestart.ok && websockifyRestart.ok && recoveryLimits.ok
      && healthcheckSeed.ok && healthcheckTimerStarted.ok
      ? await attestRuntime()
      : { ok: false, failures: [] as string[] };

    if (assets.ok && healthcheckUnits.ok && daemonReload.ok && healthcheckTimerPrepared.ok
      && resetFailed.ok && vncRestart.ok && websockifyRestart.ok && recoveryLimits.ok
      && healthcheckSeed.ok && healthcheckTimerStarted.ok && restartedRuntime.ok) {
      recoveryState.lastError = null;
      recoveryState.attempt = 0;
      recoveryState.nextAllowedAt = 0;
      return {
        attempted: true,
        ok: true,
        note: `Remote Desktop services restarted and the graphical session was verified (${reason}).`,
        mode: 'restart',
        disrupted: true,
      };
    }

    const failures = [
      !assets.ok ? assets.note : null,
      assets.ok && !healthcheckUnits.ok ? healthcheckUnits.note : null,
      healthcheckUnits.ok && !daemonReload.ok ? (daemonReload.stderr || 'systemd unit reload failed') : null,
      daemonReload.ok && !healthcheckTimerPrepared.ok ? (healthcheckTimerPrepared.stderr || 'automatic recovery timer could not be prepared') : null,
      assets.ok && !resetFailed.ok ? (resetFailed.stderr || 'systemd start limit could not be reset') : null,
      !vncRestart.ok ? (vncRestart.stderr || 'VNC restart failed') : null,
      !websockifyRestart.ok ? (websockifyRestart.stderr || 'websockify restart failed') : null,
      !healthcheckTimerStarted.ok ? (healthcheckTimerStarted.stderr || 'automatic recovery timer did not start') : null,
      !recoveryLimits.ok ? recoveryLimits.note : null,
      !healthcheckSeed.ok ? (healthcheckSeed.stderr || 'automatic healthcheck did not complete') : null,
      ...restartedRuntime.failures,
    ].filter(Boolean);
    recoveryState.lastError = failures.join('; ') || 'Remote Desktop recovery failed';
    const backoff = nextBackoffMs(recoveryState.attempt);
    recoveryState.nextAllowedAt = Date.now() + backoff;
    return {
      attempted: true,
      ok: false,
      note: `Recovery attempt ${recoveryState.attempt} failed: ${recoveryState.lastError}`,
      mode: 'restart',
      disrupted: true,
    };
  } finally {
    recoveryState.inProgress = false;
    lease.release();
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

async function checkSystemdUnitActive(unit: string): Promise<boolean> {
  const result = await runShell(`systemctl is-active --quiet ${unit}`, 2500);
  return result.ok;
}

async function inspectDesktopSessionPolicy(): Promise<{ healthy: boolean; note: string }> {
  if (!fs.existsSync(REMOTE_DESKTOP_SESSION_GUARD)) {
    return { healthy: false, note: 'semantic session guard is missing' };
  }
  const result = await runShell(`${REMOTE_DESKTOP_SESSION_GUARD} check`, 4000);
  return {
    healthy: result.ok,
    note: (result.ok ? result.stdout : result.stderr || result.stdout || 'desktop session policy check failed').slice(0, 1000),
  };
}

async function repairDesktopSessionPolicy(): Promise<{ ok: boolean; note: string }> {
  if (!fs.existsSync(REMOTE_DESKTOP_SESSION_GUARD)) {
    return { ok: false, note: 'semantic session guard is missing' };
  }
  const result = await runShell(`${REMOTE_DESKTOP_SESSION_GUARD} repair`, 5000);
  return {
    ok: result.ok,
    note: (result.ok ? result.stdout : result.stderr || result.stdout || 'desktop session repair failed').slice(0, 1000),
  };
}

async function inspectSessionGuardSupervision(): Promise<boolean> {
  const result = await runShell(
    `set -euo pipefail
control_group="$(systemctl show --property=ControlGroup --value bridges-rd-xtigervnc.service)"
test -n "$control_group"
test -r "/sys/fs/cgroup\${control_group}/cgroup.procs"
while IFS= read -r pid; do
  test -r "/proc/\${pid}/cmdline" || continue
  command_line="$(tr '\\0' ' ' < "/proc/\${pid}/cmdline")"
  if [[ "$command_line" =~ (^|[[:space:]])/usr/local/bin/bridges-rd-session-guard.sh[[:space:]]+watch[[:space:]]+[0-9]+[[:space:]]+[0-9]+([[:space:]]|$) ]]; then
    exit 0
  fi
done < "/sys/fs/cgroup\${control_group}/cgroup.procs"
exit 1`,
    4000,
  );
  return result.ok;
}

async function checkLoopbackOnlyListeningPort(port: number): Promise<boolean> {
  const result = await runShell(`ss -H -ltn 'sport = :${port}'`, 2500);
  if (!result.ok || !result.stdout) return false;
  const addresses = result.stdout.split('\n')
    .map((line) => line.trim().split(/\s+/)[3] || '')
    .filter(Boolean);
  return addresses.length > 0 && addresses.every((address) => (
    address.startsWith('127.0.0.1:') || address.startsWith('[::1]:') || address.startsWith('::1:')
  ));
}

async function inspectVncProcessPolicy(): Promise<{ command: string; hardened: boolean }> {
  const result = await runShell("ps -eo args= | grep '[X]tigervnc :1' | head -n 1", 2500);
  const command = result.ok ? result.stdout : '';
  const hardened = Boolean(command)
    && /(?:^|\s)-localhost=1(?:\s|$)/.test(command)
    && /(?:^|\s)-auth\s+\/home\/bridgesrd\/\.Xauthority(?:\s|$)/.test(command)
    && !/(?:^|\s)-ac(?:\s|$)/.test(command);
  return { command: command.slice(0, 1000), hardened };
}

async function inspectWebsockifyProcessPolicy(): Promise<{ command: string; hardened: boolean }> {
  const result = await runShell(
    "ps -eo user:64=,args= | awk '$1 == \"bridgesrd\" && $0 ~ /[w]ebsockify 127.0.0.1:6080 127.0.0.1:5901/ { $1=\"\"; sub(/^ +/, \"\"); print; exit }'",
    2500,
  );
  const command = result.ok ? result.stdout : '';
  return {
    command: command.slice(0, 1000),
    hardened: /(?:^|\s)127\.0\.0\.1:6080\s+127\.0\.0\.1:5901(?:\s|$)/.test(command),
  };
}

router.get('/status', async (_req: Request, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private');
    const keys = ['remoteDesktop.url', 'remoteDesktop.allowedPathPrefixes'];
    const rows = await prisma.systemSetting.findMany({ where: { key: { in: keys } } });
    const settings = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    const configuredUrl = normalizeRemoteDesktopUrl(settings['remoteDesktop.url'] || '');
    const allowedPrefixes = normalizeRemoteDesktopAllowedPrefixes(
      settings['remoteDesktop.allowedPathPrefixes'] || '/novnc,/vnc',
    );

    const [
      novncPortOpen,
      vncPortOpen,
      sharedChromeDebugPortOpen,
      audioProxyPortOpen,
      vncServiceActive,
      websockifyServiceActive,
      sharedChromeDebugLoopbackOnly,
      vncLoopbackOnly,
      novncLoopbackOnly,
      audioLoopbackOnly,
      vncProcessPolicy,
      websockifyProcessPolicy,
      desktopSessionPolicy,
      sessionGuardSupervised,
      healthcheckTimerActive,
      clipboardTool,
    ] = await Promise.all([
      checkTcpPort(6080),
      checkTcpPort(5901),
      checkTcpPort(18801),
      checkTcpPort(RD_AUDIO_PORT),
      checkSystemdUnitActive('bridges-rd-xtigervnc.service'),
      checkSystemdUnitActive('bridges-rd-websockify.service'),
      checkLoopbackOnlyListeningPort(18801),
      checkLoopbackOnlyListeningPort(5901),
      checkLoopbackOnlyListeningPort(6080),
      checkLoopbackOnlyListeningPort(RD_AUDIO_PORT),
      inspectVncProcessPolicy(),
      inspectWebsockifyProcessPolicy(),
      inspectDesktopSessionPolicy(),
      inspectSessionGuardSupervision(),
      checkSystemdUnitActive(REMOTE_DESKTOP_HEALTHCHECK_TIMER),
      resolveDesktopClipboardTool(),
    ]);
    const clipboardToolPresent = Boolean(clipboardTool);

    // websockify no longer serves static files (March 2026) — Express serves them directly.
    // HTTP check removed; only TCP port checks matter now.

    const systemdServiceHints = {
      vnc: '/etc/systemd/system/bridges-rd-xtigervnc.service',
      websockify: '/etc/systemd/system/bridges-rd-websockify.service',
      healthcheck: REMOTE_DESKTOP_HEALTHCHECK_SERVICE_FILE,
      healthcheckTimer: REMOTE_DESKTOP_HEALTHCHECK_TIMER_FILE,
    };
    const sharedChromeLauncher = '/usr/local/bin/bridges-rd-shared-chrome.sh';
    const sharedChromeDesktopEntry = '/home/bridgesrd/Desktop/Shared Chrome.desktop';
    const openclawUiLauncher = '/usr/local/bin/bridges-rd-openclaw-ui.sh';
    const openclawUiDesktopEntry = '/home/bridgesrd/Desktop/OpenClaw Web UI.desktop';
    const openclawUiDashboardUrlFile = OPENCLAW_UI_DASHBOARD_URL_FILE;
    const openclawUiLaunchHtmlFile = OPENCLAW_UI_LAUNCH_HTML_FILE;
    const novncPortalHtml = path.join(PORTAL_STATIC_NOVNC_DIR, 'vnc_portal.html');
    const novncCoreRfb = path.join(PORTAL_STATIC_NOVNC_DIR, 'core', 'rfb.js');
    const vncLauncher = '/usr/local/bin/bridges-rd-xtigervnc-start.sh';
    const sessionGuard = REMOTE_DESKTOP_SESSION_GUARD;
    const healthcheck = REMOTE_DESKTOP_HEALTHCHECK;
    const windowFitLauncher = '/usr/local/bin/bridges-rd-window-fit.sh';

    const vncServiceUnitPresent = fs.existsSync(systemdServiceHints.vnc);
    const websockifyUnitPresent = fs.existsSync(systemdServiceHints.websockify);
    const healthcheckServiceUnitPresent = fs.existsSync(systemdServiceHints.healthcheck);
    const healthcheckTimerUnitPresent = fs.existsSync(systemdServiceHints.healthcheckTimer);
    const sharedChromeLauncherPresent = fs.existsSync(sharedChromeLauncher);
    const sharedChromeLauncherCurrent = bundledStaticCandidatesAreCurrent([
      'static/scripts/bridges-rd-shared-chrome.sh',
    ], sharedChromeLauncher);
    const sharedChromeStatePrivate = privateDesktopDirectoryIsCurrent(SHARED_BROWSER_STATE_DIR)
      && privateDesktopDirectoryIsCurrent(SHARED_BROWSER_LOG_DIR);
    const sharedChromeDesktopEntryPresent = fs.existsSync(sharedChromeDesktopEntry);
    const sharedChromeIconPresent = fs.existsSync(SHARED_BROWSER_ICON_PATH);
    const sharedChromeIconCurrent = bundledStaticCandidatesAreCurrent(
      ['static/icons/bridges-shared-browser.svg'],
      SHARED_BROWSER_ICON_PATH,
    );
    const openclawUiLauncherPresent = fs.existsSync(openclawUiLauncher);
    const openclawUiLauncherCurrent = bundledStaticCandidatesAreCurrent([
      'static/scripts/bridges-rd-openclaw-ui.sh',
    ], openclawUiLauncher);
    const openclawUiDesktopEntryPresent = fs.existsSync(openclawUiDesktopEntry);
    const openclawUiDashboardUrlFilePresent = fs.existsSync(openclawUiDashboardUrlFile);
    const openclawUiDashboardUrlCurrent = openClawDashboardUrlFileIsCurrent();
    const openclawUiLaunchHtmlPresent = fs.existsSync(openclawUiLaunchHtmlFile);
    const openclawUiLaunchHtmlCurrent = openClawLaunchHtmlIsCurrent();
    const openclawUiIconPresent = fs.existsSync(OPENCLAW_UI_ICON_PATH);
    const openclawUiIconCurrent = bundledStaticCandidatesAreCurrent(
      ['static/icons/bridges-openclaw-ui.svg'],
      OPENCLAW_UI_ICON_PATH,
    );
    const novncPortalHtmlPresent = fs.existsSync(novncPortalHtml);
    const novncCoreBundlePresent = fs.existsSync(novncCoreRfb);
    const vncLauncherPresent = fs.existsSync(vncLauncher);
    const vncLauncherCurrent = bundledStaticFileIsCurrent('installer/scripts/bridges-rd-xtigervnc-start.sh', vncLauncher);
    const sessionGuardPresent = fs.existsSync(sessionGuard);
    const sessionGuardCurrent = bundledStaticFileIsCurrent('installer/scripts/bridges-rd-session-guard.sh', sessionGuard);
    const healthcheckPresent = fs.existsSync(healthcheck);
    const healthcheckCurrent = bundledStaticFileIsCurrent('installer/scripts/bridges-rd-healthcheck.sh', healthcheck);
    const automaticHealth = readRemoteDesktopHealthState();
    const automaticHealthReady = Boolean(
      automaticHealth
      && automaticHealth.fresh
      && !automaticHealth.suppressed
      && ['healthy', 'recovered'].includes(automaticHealth.status),
    );
    const windowFitLauncherPresent = fs.existsSync(windowFitLauncher);
    const windowFitLauncherCurrent = bundledStaticFileIsCurrent('installer/scripts/bridges-rd-window-fit.sh', windowFitLauncher);

    const hasConfiguredUrl = configuredUrl.length > 0;
    const portalManagedUrl = configuredUrl.startsWith('/') && !configuredUrl.startsWith('//');
    let externalUrlSafe = true;
    if (hasConfiguredUrl && !portalManagedUrl) {
      try {
        const externalUrl = new URL(configuredUrl);
        externalUrlSafe = ['http:', 'https:'].includes(externalUrl.protocol)
          && !externalUrl.username
          && !externalUrl.password;
      } catch {
        externalUrlSafe = false;
      }
    }
    const configuredPath = portalManagedUrl
      ? new URL(configuredUrl, 'http://portal.invalid').pathname
      : '';
    const configuredPathAllowed = !portalManagedUrl
      || allowedPrefixes.some((prefix) => remoteDesktopPathMatchesPrefix(configuredPath, prefix));

    const diagnostics = {
      configuredUrl,
      portalManagedUrl,
      allowedPrefixes,
      checks: {
        hasConfiguredUrl,
        configuredPathAllowed,
        externalUrlSafe,
        novncPortOpen,
        vncPortOpen,
        vncServiceActive,
        websockifyServiceActive,
        healthcheckTimerActive,
        vncLoopbackOnly,
        novncLoopbackOnly,
        audioLoopbackOnly,
        vncProcessHardened: vncProcessPolicy.hardened,
        websockifyProcessHardened: websockifyProcessPolicy.hardened,
        desktopSessionHealthy: desktopSessionPolicy.healthy,
        desktopSessionNote: desktopSessionPolicy.note,
        sessionGuardSupervised,
        healthcheckServiceUnitPresent,
        healthcheckTimerUnitPresent,
        healthcheckPresent,
        healthcheckCurrent,
        automaticHealthReady,
        sharedChromeDebugPortOpen,
        sharedChromeDebugLoopbackOnly: !sharedChromeDebugPortOpen || sharedChromeDebugLoopbackOnly,
        audioProxyPortOpen,
        clipboardToolPresent,
        clipboardTool: clipboardTool?.name || null,
        vncServiceUnitPresent,
        websockifyUnitPresent,
        sharedChromeLauncherPresent,
        sharedChromeLauncherCurrent,
        sharedChromeStatePrivate,
        sharedChromeDesktopEntryPresent,
        sharedChromeIconPresent,
        sharedChromeIconCurrent,
        openclawUiLauncherPresent,
        openclawUiLauncherCurrent,
        openclawUiDesktopEntryPresent,
        openclawUiDashboardUrlFilePresent,
        openclawUiDashboardUrlCurrent,
        openclawUiLaunchHtmlPresent,
        openclawUiLaunchHtmlCurrent,
        openclawUiIconPresent,
        openclawUiIconCurrent,
        novncPortalHtmlPresent,
        novncCoreBundlePresent,
        vncLauncherPresent,
        vncLauncherCurrent,
        sessionGuardPresent,
        sessionGuardCurrent,
        windowFitLauncherPresent,
        windowFitLauncherCurrent,
      },
      automaticRecovery: {
        timerActive: healthcheckTimerActive,
        serviceUnitPresent: healthcheckServiceUnitPresent,
        timerUnitPresent: healthcheckTimerUnitPresent,
        scriptPresent: healthcheckPresent,
        scriptCurrent: healthcheckCurrent,
        ready: automaticHealthReady,
        state: automaticHealth,
      },
      remediation: [
        'Check systemd units: bridges-rd-xtigervnc.service, bridges-rd-websockify.service, and bridges-rd-healthcheck.timer.',
        `Verify host ports: 5901 (VNC), 6080 (websockify), ${RD_AUDIO_PORT} (audio bridge), and 18801 (optional shared Chrome debug).`,
        'Verify portal noVNC assets exist: static/novnc/vnc_portal.html and static/novnc/core/rfb.js.',
        'Verify desktop clipboard bridge tools are installed: xclip or xsel.',
        'Re-run Remote Desktop setup if Shared Browser/OpenClaw Web UI launchers or noVNC assets are missing.',
        'Use POST /api/remote-desktop/recover to attempt automatic recovery.',
      ],
    };

    let status: RemoteDesktopStatus = 'unavailable';
    let message = 'Remote Desktop is not available.';

    const desktopUnhealthyReason = [
      !vncPortOpen ? 'VNC 5901 down' : null,
      !novncPortOpen ? 'noVNC 6080 down' : null,
      !vncServiceActive ? 'VNC service inactive' : null,
      !websockifyServiceActive ? 'websockify service inactive' : null,
      !vncLoopbackOnly ? 'VNC is not attested loopback-only' : null,
      !novncLoopbackOnly ? 'websockify is not attested loopback-only' : null,
      !vncProcessPolicy.hardened ? 'live VNC process lacks Xauthority/access-control hardening' : null,
      !websockifyProcessPolicy.hardened ? 'live websockify process does not match the loopback bridge policy' : null,
      !desktopSessionPolicy.healthy ? desktopSessionPolicy.note || 'desktop session is not semantically healthy' : null,
      !sessionGuardSupervised ? 'desktop session guard is not supervised by the VNC service' : null,
      !healthcheckTimerActive ? 'automatic recovery timer is inactive' : null,
      !novncPortalHtmlPresent ? 'noVNC portal HTML missing' : null,
      !novncCoreBundlePresent ? 'noVNC static bundle missing' : null,
      !vncLauncherPresent ? 'VNC launcher missing' : !vncLauncherCurrent ? 'VNC launcher differs from signed bundle' : null,
      !sessionGuardPresent ? 'desktop session guard missing' : !sessionGuardCurrent ? 'desktop session guard differs from signed bundle' : null,
      !healthcheckServiceUnitPresent ? 'automatic recovery service unit missing' : null,
      !healthcheckTimerUnitPresent ? 'automatic recovery timer unit missing' : null,
      !healthcheckPresent ? 'automatic healthcheck missing' : !healthcheckCurrent ? 'automatic healthcheck differs from signed bundle' : null,
      !automaticHealthReady ? automaticHealth?.suppressed
        ? `automatic recovery is suppressed${automaticHealth.suppressedUntil ? ` until ${automaticHealth.suppressedUntil}` : ''}`
        : !automaticHealth?.fresh
          ? 'automatic health state is stale or unavailable'
          : `automatic health state is ${automaticHealth?.status || 'unavailable'}` : null,
      !windowFitLauncherPresent ? 'window-fit helper missing' : !windowFitLauncherCurrent ? 'window-fit helper differs from signed bundle' : null,
    ].filter(Boolean).join(', ');
    const sharedChromeReason = [
      !sharedChromeLauncherPresent ? 'Shared Browser launcher missing' : null,
      sharedChromeLauncherPresent && !sharedChromeLauncherCurrent ? 'Shared Browser launcher differs from the signed bundle' : null,
      !sharedChromeStatePrivate ? 'Shared Browser state/log directories are not private bridgesrd-owned directories' : null,
      !sharedChromeDesktopEntryPresent ? 'Shared Browser desktop entry missing' : null,
      !sharedChromeIconPresent ? 'Shared Browser icon missing' : null,
      sharedChromeIconPresent && !sharedChromeIconCurrent ? 'Shared Browser icon differs from the signed bundle' : null,
    ].filter(Boolean).join(', ');
    const openclawUiReason = [
      !openclawUiLauncherPresent ? 'OpenClaw Web UI launcher missing' : null,
      openclawUiLauncherPresent && !openclawUiLauncherCurrent ? 'OpenClaw Web UI launcher differs from the signed bundle' : null,
      !openclawUiDesktopEntryPresent ? 'OpenClaw Web UI desktop entry missing' : null,
      !openclawUiDashboardUrlFilePresent ? 'OpenClaw Web UI tokenized URL file missing' : null,
      openclawUiDashboardUrlFilePresent && !openclawUiDashboardUrlCurrent ? 'OpenClaw Web UI tokenized URL stale' : null,
      !openclawUiLaunchHtmlPresent ? 'OpenClaw Web UI private launch page missing' : null,
      openclawUiLaunchHtmlPresent && !openclawUiLaunchHtmlCurrent ? 'OpenClaw Web UI private launch page stale' : null,
      !openclawUiIconPresent ? 'OpenClaw Web UI icon missing' : null,
      openclawUiIconPresent && !openclawUiIconCurrent ? 'OpenClaw Web UI icon differs from the signed bundle' : null,
    ].filter(Boolean).join(', ');

    // Status reporting never mutates the desktop. The independent, rate-limited
    // healthcheck timer owns automatic recovery so self-healing survives Portal
    // restarts without turning an API polling loop into a restart loop.

    if (hasConfiguredUrl && !portalManagedUrl && !externalUrlSafe) {
      message = 'Remote Desktop is unavailable because the external URL is invalid, uses an unsupported protocol, or contains embedded credentials.';
    } else if (hasConfiguredUrl && !portalManagedUrl) {
      status = 'degraded';
      message = 'An external Remote Desktop URL is configured. The Portal can load it, but cannot attest its VNC session, authentication, or availability.';
    } else if (hasConfiguredUrl && !configuredPathAllowed) {
      message = `Remote Desktop is unavailable because ${configuredPath || 'the configured path'} is outside the approved Remote Desktop path prefixes.`;
    } else if (hasConfiguredUrl && novncPortOpen && vncPortOpen && vncServiceActive && websockifyServiceActive
      && vncLoopbackOnly && novncLoopbackOnly && vncProcessPolicy.hardened
      && websockifyProcessPolicy.hardened
      && desktopSessionPolicy.healthy && sessionGuardSupervised
      && novncPortalHtmlPresent && novncCoreBundlePresent && vncLauncherCurrent
      && sessionGuardCurrent && healthcheckServiceUnitPresent && healthcheckTimerUnitPresent
      && healthcheckTimerActive && healthcheckCurrent
      && automaticHealthReady && windowFitLauncherCurrent) {
      const integratedReasons = [
        sharedChromeReason,
        openclawUiReason,
        !clipboardToolPresent ? 'desktop clipboard bridge tool missing' : null,
        !audioProxyPortOpen ? 'desktop audio bridge unavailable' : null,
        audioProxyPortOpen && !audioLoopbackOnly ? 'desktop audio bridge is not attested loopback-only' : null,
        sharedChromeDebugPortOpen && !sharedChromeDebugLoopbackOnly ? 'Shared Chrome debugging port is exposed beyond loopback' : null,
      ].filter(Boolean).join('; ');
      if (integratedReasons) {
        status = 'degraded';
        message = `The graphical desktop is available, but integrated features need attention: ${integratedReasons}.`;
      } else {
        status = 'ready';
        message = 'Remote Desktop is ready, including Shared Browser and OpenClaw Web UI launchers.';
      }
    } else if (hasConfiguredUrl && novncPortOpen && vncPortOpen
      && (!desktopSessionPolicy.healthy || !sessionGuardSupervised)) {
      message = `Remote Desktop transport is connected, but the graphical session is unusable: ${desktopUnhealthyReason || 'semantic desktop health failed'}. Use POST /api/remote-desktop/recover to repair it.`;
    } else if (hasConfiguredUrl && (novncPortOpen || vncPortOpen)) {
      status = 'degraded';
      message = `Remote Desktop is partially available: ${desktopUnhealthyReason || 'desktop setup incomplete'}. Use POST /api/remote-desktop/recover to attempt recovery.`;
    } else if (hasConfiguredUrl) {
      message = `Remote Desktop is unavailable: ${desktopUnhealthyReason || 'services not running'}. Use POST /api/remote-desktop/recover to attempt recovery.`;
    }

    res.json({
      status,
      message,
      actions: {
        setup: { ownerOnly: false, confirmationPhrase: PRIVILEGED_CONFIRMATION.remoteDesktopSetup },
        recover: { ownerOnly: false, confirmationPhrase: PRIVILEGED_CONFIRMATION.remoteDesktopRecovery },
      },
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


// ── Remote Desktop clipboard bridge ─────────────────────────────────
// Authenticated HTTP bridge for mobile clients and iframe clipboard-permission weirdness.
// noVNC clipboard events still run client-side; these endpoints pull from and write to the X11 desktop clipboard.
router.get('/clipboard', async (req: Request, res: Response) => {
  try {
    const selection = normalizeDesktopClipboardSelection(req.query.selection);
    const result = await readDesktopClipboard(selection);
    res.json({
      ok: true,
      text: result.text,
      selection,
      tool: result.tool.name,
      display: DESKTOP_DISPLAY,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    const message = error?.message || 'Failed to read desktop clipboard';
    const statusCode = /xclip|xsel|clipboard tool/i.test(message) ? 503 : 500;
    res.status(statusCode).json({ ok: false, error: message });
  }
});

// Open one chat-linked VPS file on the visible Remote Desktop. The browser
// never receives a host path: this endpoint validates an exact server-owned
// authority, snapshots the regular file for the unprivileged desktop user,
// and reports only whether the GUI launch was accepted.
async function readAgentWorkspaceSnapshot(rawAgentId: unknown) {
  const result = await gatewayRpcCall('agents.list', {}, 5_000);
  if (!result.ok) {
    throw new RemoteDesktopOpenPathError(
      503,
      'WORKSPACE_AUTHORITY_UNAVAILABLE',
      'The OpenClaw Agent workspace authority is unavailable',
    );
  }
  return selectOpenClawAgentWorkspace(result.data?.agents, rawAgentId);
}

router.post('/open-path', async (req: Request, res: Response) => {
  try {
    const source = req.body?.source;
    let agentAuthority: RemoteDesktopAgentAuthority | undefined;
    let projectAuthority: RemoteDesktopProjectAuthority | undefined;
    if (source === 'agent-workspace') {
      const rawAgentId = req.body?.agent;
      const authoritySnapshot = await readAgentWorkspaceSnapshot(rawAgentId);
      agentAuthority = {
        ...authoritySnapshot,
        isCurrent: async () => {
          try {
            const current = await readAgentWorkspaceSnapshot(rawAgentId);
            return current.agentId === authoritySnapshot.agentId
              && current.resolvedWorkspace === authoritySnapshot.resolvedWorkspace;
          } catch {
            return false;
          }
        },
      };
    } else if (source === 'project') {
      const projectName = req.body?.project;
      const actorUserId = req.user?.userId;
      if (
        !actorUserId
        || typeof projectName !== 'string'
        || !projectName
        || projectName.length > 255
        || projectName === '.'
        || projectName === '..'
        || path.basename(projectName) !== projectName
        || projectName.includes('\\')
        || /[\u0000-\u001f\u007f]/.test(projectName)
      ) {
        res.status(400).json({ ok: false, code: 'INVALID_PROJECT', error: 'An authorized Project is required' });
        return;
      }
      // Project Chat is actor-scoped even for unsandboxed elevated delegates.
      // Never resolve through getWorkspaceOwnerId(): that helper intentionally
      // maps a Sub-admin onto the owner's host-operator workspace.
      const workspaceOwnerId = actorUserId;
      const identity = await prisma.projectIdentity.findUnique({
        where: { workspaceOwnerId_projectName: { workspaceOwnerId, projectName } },
        select: { canonicalRoot: true },
      });
      if (!identity) {
        res.status(404).json({ ok: false, code: 'PROJECT_NOT_FOUND', error: 'The Project is unavailable' });
        return;
      }
      const attestedIdentity = await readProjectIdentity({
        workspaceOwnerId,
        projectName,
        projectRoot: identity.canonicalRoot,
      });
      if (!attestedIdentity) {
        res.status(404).json({ ok: false, code: 'PROJECT_NOT_FOUND', error: 'The Project is unavailable' });
        return;
      }
      const authoritySnapshot = {
        identityId: attestedIdentity.id,
        generation: attestedIdentity.generation,
        canonicalRoot: attestedIdentity.canonicalRoot,
        rootDevice: attestedIdentity.rootDevice,
        rootInode: attestedIdentity.rootInode,
        rootBirthtimeNs: attestedIdentity.rootBirthtimeNs,
      };
      projectAuthority = {
        ...authoritySnapshot,
        isCurrent: async () => {
          const current = await readProjectIdentity({
            workspaceOwnerId,
            projectName,
            projectRoot: authoritySnapshot.canonicalRoot,
          });
          return Boolean(
            current
            && current.id === authoritySnapshot.identityId
            && current.generation === authoritySnapshot.generation
            && current.canonicalRoot === authoritySnapshot.canonicalRoot
            && current.rootDevice === authoritySnapshot.rootDevice
            && current.rootInode === authoritySnapshot.rootInode
            && current.rootBirthtimeNs === authoritySnapshot.rootBirthtimeNs,
          );
        },
      };
    }

    const result = await openRemoteDesktopPath({
      source,
      path: req.body?.path,
      agent: req.body?.agent,
      line: req.body?.line,
      column: req.body?.column,
      agentAuthority,
      projectAuthority,
    });
    res.status(202).json(result);
  } catch (error: any) {
    if (error instanceof RemoteDesktopOpenPathError) {
      res.status(error.statusCode).json({ ok: false, code: error.code, error: error.message });
      return;
    }
    if (error instanceof ProjectIdentityMismatchError || error instanceof ProjectIdentityLifecycleError) {
      res.status(409).json({ ok: false, code: error.code, error: 'The Project authority changed; reload and try again' });
      return;
    }
    console.error('[Remote Desktop] open-path request failed before launch', error?.name || 'UnknownError');
    res.status(500).json({ ok: false, code: 'OPEN_PATH_FAILED', error: 'The linked file could not be opened safely' });
  }
});

router.post('/clipboard', async (req: Request, res: Response) => {
  try {
    // 'both' writes CLIPBOARD and PRIMARY so Ctrl+V and middle-click paste
    // agree — the portal "send clipboard" button uses it.
    const selection = req.body?.selection === 'both'
      ? 'both' as const
      : normalizeDesktopClipboardSelection(req.body?.selection);
    if (typeof req.body?.text !== 'string') {
      res.status(400).json({ ok: false, error: 'Clipboard text must be a string' });
      return;
    }
    const text = req.body.text;
    const bytes = utf8ByteLength(text);
    if (bytes > MAX_REMOTE_DESKTOP_CLIPBOARD_BYTES) {
      res.status(413).json({ ok: false, error: 'Clipboard text is too large' });
      return;
    }

    let result;
    if (selection === 'both') {
      await writeDesktopClipboard('primary', text);
      result = await writeDesktopClipboard('clipboard', text);
    } else {
      result = await writeDesktopClipboard(selection, text);
    }
    res.json({
      ok: true,
      selection,
      length: text.length,
      bytes,
      tool: result.tool.name,
      display: DESKTOP_DISPLAY,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    const message = error?.message || 'Failed to write desktop clipboard';
    const statusCode = /xclip|xsel|clipboard tool/i.test(message) ? 503 : 500;
    res.status(statusCode).json({ ok: false, error: message });
  }
});

// ── Manual recovery endpoint ─────────────────────────────────────────
// POST /api/remote-desktop/recover
// Admin-only. Always attempts the non-disruptive session-policy repair first;
// a typed phrase is required only when a service restart is still necessary.
router.post('/recover', async (req: Request, res: Response) => {
  try {
    const allowRestart = isTypedConfirmationMatch(
      PRIVILEGED_CONFIRMATION.remoteDesktopRecovery,
      req.body?.confirmation,
    );
    const result = await attemptSelfHeal('admin-initiated recovery', allowRestart);
    const statusCode = result.ok ? 200 : result.restartRequired || !result.attempted ? 409 : 503;
    res.status(statusCode).json({
      ...result,
      ...(result.restartRequired ? {
        confirmationPhrase: PRIVILEGED_CONFIRMATION.remoteDesktopRecovery,
        restartMessage: `Type ${PRIVILEGED_CONFIRMATION.remoteDesktopRecovery} to allow an interrupting service restart.`,
      } : {}),
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

async function retireLegacyRemoteDesktopRcLocal(): Promise<{ ok: boolean; changed: boolean; note: string }> {
  const rcLocal = '/etc/rc.local';
  const archive = '/etc/rc.local.bridgesllm-remote-desktop-legacy';
  const knownHashes = new Set([
    'd7a8d6a6c8fbea290be07ddb875d7f6ddc420009c279910286c8800ef21b6bc3',
    'bbbbe95647ab6fce54f3b0389830c88e9b6c29b5edf88c06cb58166556e09ca4',
  ]);

  if (!fs.existsSync(rcLocal)) {
    return { ok: true, changed: false, note: 'No legacy rc.local boot stack is present' };
  }
  const stat = fs.lstatSync(rcLocal);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { ok: true, changed: false, note: 'Preserved non-regular /etc/rc.local without modification' };
  }
  const content = fs.readFileSync(rcLocal);
  const hash = createHash('sha256').update(content).digest('hex');
  if (!knownHashes.has(hash)) {
    return { ok: true, changed: false, note: 'Preserved unrecognized /etc/rc.local without modification' };
  }

  if (fs.existsSync(archive)) {
    const archiveStat = fs.lstatSync(archive);
    const archiveHash = archiveStat.isFile() && !archiveStat.isSymbolicLink()
      ? createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
      : '';
    if (archiveHash !== hash) {
      return { ok: false, changed: false, note: 'Legacy rc.local archive exists with different content; preserved both files' };
    }
    fs.unlinkSync(rcLocal);
  } else {
    fs.renameSync(rcLocal, archive);
  }
  fs.chownSync(archive, 0, 0);
  fs.chmodSync(archive, 0o600);

  const stop = await runShell('systemctl stop rc-local.service', 20000);
  if (!stop.ok) {
    return { ok: false, changed: true, note: stop.stderr || 'Legacy rc.local cgroup could not be stopped' };
  }
  const state = await runShell("systemctl show --property=ActiveState --value rc-local.service | grep -Eq '^(inactive|failed)$'", 5000);
  return state.ok
    ? { ok: true, changed: true, note: 'Retired exact Portal-owned legacy rc.local boot stack and stopped its cgroup' }
    : { ok: false, changed: true, note: 'Legacy rc.local was archived, but its cgroup is still active' };
}

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
  let lease: RemoteDesktopMutationLease;

  try {
    lease = acquireRemoteDesktopMutationLock('set up Remote Desktop');
  } catch (error) {
    const busy = error instanceof RemoteDesktopMutationBusyError;
    const message = busy
      ? error.message
      : `Could not acquire the Remote Desktop mutation lock: ${error instanceof Error ? error.message : String(error)}`;
    steps.push({ step: busy ? 'Remote Desktop operation busy' : 'Acquire mutation lock', ok: false, message });
    return { ok: false, steps, message };
  }

  try {
    // Step 0: Check for dpkg lock — if another apt is running, bail early
    const lockCheck = await runShell('fuser /var/lib/dpkg/lock-frontend 2>/dev/null', 3000);
    if (lockCheck.ok && lockCheck.stdout.trim()) {
      steps.push({ step: 'Check package lock', ok: false, message: 'Another package installation is in progress. Wait a few minutes and try again.' });
      return { ok: false, steps, message: 'Another package installation is already running. Please wait and try again.' };
    }

    // Step 1: Install packages if missing (idempotent — apt skips already-installed)
    // Matches production setup: full XFCE desktop + goodies, x11-utils for xdpyinfo, Google Chrome for browsing
    const requiredPkgs = ['tigervnc-standalone-server', 'novnc', 'websockify', 'xfce4', 'xfce4-goodies', 'xfce4-terminal', 'dbus-x11', 'x11-utils', 'xauth', 'xclip', 'xsel', 'xterm', 'firefox', 'pulseaudio', 'pulseaudio-utils', 'librsvg2-common', 'wmctrl', 'xdotool'];
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
      const bundledXfceConfig = path.resolve(__dirname, '../../..', 'installer/xfce4-config');
      if (!fs.existsSync(path.join(bundledXfceConfig, 'xfconf/xfce-perchannel-xml/xfce4-session.xml'))) {
        throw new Error('Signed Remote Desktop XFCE policy is missing from the installed Portal bundle');
      }
      fs.cpSync(bundledXfceConfig, '/home/bridgesrd/.config/xfce4', { recursive: true, force: true });
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

      // Power manager: stop xfce4-power-manager from re-enabling X screensaver
      // blanking after the launcher disables it (the 10-minute black screen).
      const powerManagerXml = `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-power-manager" version="1.0">
  <property name="xfce4-power-manager" type="empty">
    <property name="dpms-enabled" type="bool" value="false"/>
    <property name="blank-on-ac" type="int" value="0"/>
    <property name="blank-on-battery" type="int" value="0"/>
    <property name="dpms-on-ac-sleep" type="uint" value="0"/>
    <property name="dpms-on-ac-off" type="uint" value="0"/>
    <property name="lock-screen-suspend-hibernate" type="bool" value="false"/>
    <property name="presentation-mode" type="bool" value="true"/>
  </property>
</channel>
`;
      fs.writeFileSync(path.join(xfceConfigDir, 'xfce4-power-manager.xml'), powerManagerXml);

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
      steps.push({ step: 'Configure desktop policy', ok: true, message: 'Signed XFCE theme, no-lock, no-blanking, and panel policy installed' });
    } catch (err: any) {
      steps.push({ step: 'Configure desktop theme', ok: false, message: `Non-fatal: ${err?.message?.slice(0, 200)}` });
    }

    // Step 3: VNC auth — Xtigervnc runs with -SecurityTypes None on localhost only.
    // Portal authentication (httpOnly cookie) gates all noVNC access, so no VNC-level password is needed.
    steps.push({ step: 'VNC auth mode', ok: true, message: 'Portal-authenticated noVNC (Xtigervnc localhost-only, no VNC password needed)' });

    // Step 4: Write launcher scripts, branded icons, and desktop entries.
    const webLauncher = '/usr/local/bin/bridges-rd-websockify-launcher.sh';
    const webScript = '#!/usr/bin/env bash\nset -euo pipefail\n# WebSocket-only mode — static files served by Express\n# Bind loopback only so raw websockify never bypasses portal auth.\nexec websockify 127.0.0.1:6080 127.0.0.1:5901\n';
    fs.writeFileSync(webLauncher, webScript, { mode: 0o755 });

    const sharedChromeLauncher = '/usr/local/bin/bridges-rd-shared-chrome.sh';
    const openclawUiLauncher = '/usr/local/bin/bridges-rd-openclaw-ui.sh';
    const copiedShared = copyBundledStaticFile('static/scripts/bridges-rd-shared-chrome.sh', sharedChromeLauncher, 0o755);
    const copiedOpenClawUi = copyBundledStaticFile('static/scripts/bridges-rd-openclaw-ui.sh', openclawUiLauncher, 0o755);
    if (!copiedShared || !copiedOpenClawUi) {
      throw new Error('Signed Remote Desktop browser launchers are missing from the installed Portal bundle');
    }

    const copiedSharedIcon = copyBundledStaticFile('static/icons/bridges-shared-browser.svg', SHARED_BROWSER_ICON_PATH, 0o644);
    const copiedOpenClawIcon = copyBundledStaticFile('static/icons/bridges-openclaw-ui.svg', OPENCLAW_UI_ICON_PATH, 0o644);
    const wroteOpenClawUrl = await writeOpenClawDashboardUrlFile();
    steps.push({
      step: 'Launcher scripts, icons, and OpenClaw URL',
      ok: copiedSharedIcon && copiedOpenClawIcon && wroteOpenClawUrl,
      message: `Written (Shared Browser + OpenClaw Web UI${copiedSharedIcon && copiedOpenClawIcon && wroteOpenClawUrl ? '' : '; icon or URL asset missing'})`,
    });

    try {
      const desktopDir = '/home/bridgesrd/Desktop';
      fs.mkdirSync(desktopDir, { recursive: true });
      const sharedBrowserDesktopEntry = `[Desktop Entry]
Version=1.0
Type=Application
Name=Shared Browser
Comment=Shared browser used by the agent and the user inside Remote Desktop
Exec=/usr/local/bin/bridges-rd-shared-chrome.sh
Icon=${SHARED_BROWSER_ICON_PATH}
Terminal=false
Categories=Network;WebBrowser;
StartupNotify=true
`;
      const openclawUiDesktopEntry = `[Desktop Entry]
Version=1.0
Type=Application
Name=OpenClaw Web UI
Comment=Open native OpenClaw Control UI in a dedicated browser profile
Exec=/usr/local/bin/bridges-rd-openclaw-ui.sh
Icon=${OPENCLAW_UI_ICON_PATH}
Terminal=false
Categories=Development;Network;WebBrowser;
StartupNotify=true
`;
      fs.writeFileSync(path.join(desktopDir, 'Shared Chrome.desktop'), sharedBrowserDesktopEntry, { mode: 0o755 });
      fs.writeFileSync(path.join(desktopDir, 'OpenClaw Web UI.desktop'), openclawUiDesktopEntry, { mode: 0o755 });
      await runShell('chown -R bridgesrd:bridgesrd /home/bridgesrd/Desktop', 5000);
      steps.push({ step: 'Desktop launchers', ok: true, message: 'Shared Browser and OpenClaw Web UI shortcuts created' });
    } catch (err: any) {
      steps.push({ step: 'Desktop launchers', ok: false, message: `Non-fatal: ${err?.message?.slice(0, 200)}` });
    }

    // Step 5: Write systemd units (Xtigervnc + websockify)
    // This is the PRODUCTION launcher — runs Xtigervnc as root, XFCE as bridgesrd user,
    // uses xdpyinfo to wait for display, disables screensaver, proper logging.
    // Window-fit watcher: clamps windows back into the visible desktop after
    // the client resizes the VNC screen (viewing from a different device left
    // windows stranded outside the new, smaller resolution).
    const windowFitScript = '/usr/local/bin/bridges-rd-window-fit.sh';
    if (!copyBundledStaticFile('installer/scripts/bridges-rd-window-fit.sh', windowFitScript, 0o755)) {
      throw new Error('Signed Remote Desktop window-fit helper is missing from the installed Portal bundle');
    }
    steps.push({ step: 'Window-fit watcher', ok: true, message: 'Installed from canonical bundled helper' });
    if (!copyBundledStaticFile('installer/scripts/bridges-rd-session-guard.sh', REMOTE_DESKTOP_SESSION_GUARD, 0o755)) {
      throw new Error('Signed Remote Desktop session guard is missing from the installed Portal bundle');
    }
    steps.push({ step: 'Session guard', ok: true, message: 'Installed from canonical bundled guard' });

    const vncLauncher = '/usr/local/bin/bridges-rd-xtigervnc-start.sh';
    if (!copyBundledStaticFile('installer/scripts/bridges-rd-xtigervnc-start.sh', vncLauncher, 0o755)) {
      throw new Error('Signed Remote Desktop VNC launcher is missing from the installed Portal bundle');
    }
    steps.push({ step: 'VNC launcher', ok: true, message: 'Installed from canonical bundled launcher' });
    if (!copyBundledStaticFile('installer/scripts/bridges-rd-healthcheck.sh', REMOTE_DESKTOP_HEALTHCHECK, 0o755)) {
      throw new Error('Signed Remote Desktop automatic healthcheck is missing from the installed Portal bundle');
    }
    steps.push({ step: 'Automatic healthcheck', ok: true, message: 'Installed from canonical bundled healthcheck' });

    const vncUnit = `[Unit]
Description=Bridges Remote Desktop Xtigervnc :1
After=network.target systemd-tmpfiles-setup.service systemd-user-sessions.service
Before=bridges-rd-websockify.service
Conflicts=tigervncserver@:1.service tigervncserver@1.service vncserver@:1.service vncserver@1.service
RequiresMountsFor=/home/bridgesrd /var/log/bridges-rd
StartLimitIntervalSec=600
StartLimitBurst=3

[Service]
Type=notify
NotifyAccess=main
User=root
ExecStart=${vncLauncher}
ExecStopPost=-/bin/bash -c 'pkill -f "Xtigervnc :1" 2>/dev/null || true'
Restart=on-failure
RestartSec=3
WatchdogSec=45
TimeoutStartSec=120
TimeoutStopSec=20
KillMode=control-group
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
User=bridgesrd
Group=bridgesrd
ExecStart=${webLauncher}
Restart=always
RestartSec=2
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
`;

    fs.writeFileSync('/etc/systemd/system/bridges-rd-xtigervnc.service', vncUnit);
    fs.writeFileSync('/etc/systemd/system/bridges-rd-websockify.service', wsUnit);
    const healthcheckUnits = writeRemoteDesktopHealthcheckUnits();
    steps.push({
      step: 'Systemd units',
      ok: healthcheckUnits.ok,
      message: healthcheckUnits.ok
        ? 'Written (VNC, websockify, and automatic health recovery)'
        : `Automatic recovery units failed: ${healthcheckUnits.note}`,
    });
    if (!healthcheckUnits.ok) {
      return { ok: false, steps, message: 'Remote Desktop automatic recovery units could not be installed safely.' };
    }

    // Step 6: Reload systemd and start/restart services
    const reload = await runShell('systemctl daemon-reload');
    steps.push({ step: 'systemctl daemon-reload', ok: reload.ok, message: reload.ok ? 'OK' : reload.stderr.slice(0, 200) });

    // Disable old legacy service if present
    await runShell('systemctl disable --now bridges-rd-vnc.service 2>/dev/null || true');

    // Disable every stock display-1 alias before the managed service starts.
    // Ubuntu ships tigervncserver@.service; older images used vncserver@.service.
    const stockVncUnits = [
      'tigervncserver@:1.service',
      'tigervncserver@1.service',
      'vncserver@:1.service',
      'vncserver@1.service',
    ];
    const stockUnitReconcile = await runShell(`set -euo pipefail
units=(${stockVncUnits.map((unit) => JSON.stringify(unit)).join(' ')})
systemctl disable --now "\${units[@]}" >/dev/null 2>&1 || true
for unit in "\${units[@]}"; do
  ! systemctl is-active --quiet "$unit"
  systemctl mask "$unit" >/dev/null
  test "$(systemctl is-enabled "$unit" 2>/dev/null || true)" = masked
done`, 30000);
    steps.push({
      step: 'Retire stock display-1 services',
      ok: stockUnitReconcile.ok,
      message: stockUnitReconcile.ok ? 'All known TigerVNC aliases are stopped and masked' : stockUnitReconcile.stderr.slice(0, 300),
    });
    if (!stockUnitReconcile.ok) {
      return { ok: false, steps, message: 'A conflicting stock TigerVNC service could not be retired safely.' };
    }

    const legacyRcLocal = await retireLegacyRemoteDesktopRcLocal();
    steps.push({ step: 'Retire legacy boot stack', ok: legacyRcLocal.ok, message: legacyRcLocal.note });
    if (!legacyRcLocal.ok) {
      return { ok: false, steps, message: 'The legacy Remote Desktop boot stack could not be retired safely.' };
    }

    const enableSvc = await runShell(`systemctl enable bridges-rd-xtigervnc.service bridges-rd-websockify.service ${REMOTE_DESKTOP_HEALTHCHECK_TIMER}`);
    steps.push({ step: 'Enable services', ok: enableSvc.ok, message: enableSvc.ok ? 'Enabled' : enableSvc.stderr.slice(0, 200) });
    const pauseHealthTimer = enableSvc.ok
      ? await runShell(`systemctl stop ${REMOTE_DESKTOP_HEALTHCHECK_TIMER} ${REMOTE_DESKTOP_HEALTHCHECK_SERVICE}`, 10000)
      : { ok: false, stdout: '', stderr: 'services were not enabled; automatic recovery could not be paused for setup' };
    steps.push({
      step: 'Pause automatic recovery during setup',
      ok: pauseHealthTimer.ok,
      message: pauseHealthTimer.ok ? 'Paused' : pauseHealthTimer.stderr.slice(0, 200),
    });
    if (!pauseHealthTimer.ok) {
      return { ok: false, steps, message: 'Automatic recovery could not be paused safely during Remote Desktop setup.' };
    }

    const resetFailed = await runShell('systemctl reset-failed bridges-rd-xtigervnc.service bridges-rd-websockify.service', 5000);
    steps.push({ step: 'Reset Remote Desktop start limits', ok: resetFailed.ok, message: resetFailed.ok ? 'Reset' : resetFailed.stderr.slice(0, 200) });
    const restartVnc = resetFailed.ok
      ? await runShell('systemctl restart bridges-rd-xtigervnc.service', 140000)
      : { ok: false, stdout: '', stderr: 'Systemd start limit could not be reset' };
    steps.push({ step: 'Start VNC service', ok: restartVnc.ok, message: restartVnc.ok ? 'Started' : restartVnc.stderr.slice(0, 200) });

    // Wait briefly for VNC to be ready before starting websockify
    await new Promise((r) => setTimeout(r, 2000));

    const restartWs = await runShell('systemctl restart bridges-rd-websockify.service', 15000);
    steps.push({ step: 'Start websockify service', ok: restartWs.ok, message: restartWs.ok ? 'Started' : restartWs.stderr.slice(0, 200) });
    const setupRecoveryLimits = restartWs.ok
      ? clearRemoteDesktopAutomaticRecoveryLimits()
      : { ok: false, note: 'websockify failed; automatic recovery limits were not reset' };
    steps.push({
      step: 'Reset automatic recovery limits',
      ok: setupRecoveryLimits.ok,
      message: setupRecoveryLimits.note,
    });
    const startHealthTimer = setupRecoveryLimits.ok
      ? await runShell(`systemctl start ${REMOTE_DESKTOP_HEALTHCHECK_TIMER}`, 10000)
      : { ok: false, stdout: '', stderr: 'automatic recovery state could not be reset; timer was not started' };
    steps.push({
      step: 'Start automatic recovery timer',
      ok: startHealthTimer.ok,
      message: startHealthTimer.ok ? 'Active' : startHealthTimer.stderr.slice(0, 200),
    });
    const seedHealthState = startHealthTimer.ok
      ? await runShell(`systemctl start ${REMOTE_DESKTOP_HEALTHCHECK_SERVICE}`, 150000)
      : { ok: false, stdout: '', stderr: 'automatic recovery timer failed; healthcheck was not seeded' };
    steps.push({
      step: 'Seed automatic health state',
      ok: seedHealthState.ok,
      message: seedHealthState.ok ? 'Graphical session checked' : seedHealthState.stderr.slice(0, 200),
    });

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
      await restartOpenClawGatewaySystemUnit(30000);
      steps.push({
        step: 'Restart OpenClaw gateway',
        ok: true,
        message: 'Restarted so managed skill/agent defaults are live for new sessions',
      });
    } else {
      steps.push({ step: 'Restart OpenClaw gateway', ok: true, message: 'Not needed — managed skill/agent already current' });
    }

    // Step 11: Verify core ports and Shared Chrome contract
    await new Promise((r) => setTimeout(r, 3000));
    const vncOk = await checkTcpPort(5901);
    const novncOk = await checkTcpPort(6080);
    const audioOk = await checkTcpPort(RD_AUDIO_PORT);
    const sharedChromeDebugOpen = await checkTcpPort(18801);
    const [vncLoopbackOnly, novncLoopbackOnly, audioLoopbackOnly, sharedChromeDebugLoopbackOnly, processPolicy, websockifyPolicy, desktopSessionPolicy, sessionGuardSupervised, healthcheckTimerActive, clipboardTool] = await Promise.all([
      checkLoopbackOnlyListeningPort(5901),
      checkLoopbackOnlyListeningPort(6080),
      checkLoopbackOnlyListeningPort(RD_AUDIO_PORT),
      checkLoopbackOnlyListeningPort(18801),
      inspectVncProcessPolicy(),
      inspectWebsockifyProcessPolicy(),
      inspectDesktopSessionPolicy(),
      inspectSessionGuardSupervision(),
      checkSystemdUnitActive(REMOTE_DESKTOP_HEALTHCHECK_TIMER),
      resolveDesktopClipboardTool(),
    ]);
    steps.push({ step: 'Verify VNC port 5901', ok: vncOk, message: vncOk ? 'Listening' : 'Not listening — check bridges-rd-xtigervnc.service logs' });
    steps.push({ step: 'Verify noVNC port 6080', ok: novncOk, message: novncOk ? 'Listening' : 'Not listening — check bridges-rd-websockify.service logs' });
    steps.push({ step: 'Verify VNC listener boundary', ok: vncLoopbackOnly, message: vncLoopbackOnly ? 'Loopback-only' : 'Missing or exposed beyond loopback' });
    steps.push({ step: 'Verify noVNC listener boundary', ok: novncLoopbackOnly, message: novncLoopbackOnly ? 'Loopback-only' : 'Missing or exposed beyond loopback' });
    steps.push({ step: 'Verify audio bridge', ok: audioOk && audioLoopbackOnly, message: !audioOk ? `Port ${RD_AUDIO_PORT} is not listening` : audioLoopbackOnly ? 'Listening on loopback only' : 'Exposed beyond loopback' });
    steps.push({ step: 'Verify clipboard bridge', ok: Boolean(clipboardTool), message: clipboardTool ? `${clipboardTool.name} is available` : 'xclip/xsel is unavailable' });
    steps.push({ step: 'Verify Shared Chrome debug boundary', ok: !sharedChromeDebugOpen || sharedChromeDebugLoopbackOnly, message: !sharedChromeDebugOpen ? 'Browser is idle; no debug listener expected' : sharedChromeDebugLoopbackOnly ? 'Loopback-only' : 'Exposed beyond loopback' });
    steps.push({ step: 'Verify live VNC X11 policy', ok: processPolicy.hardened, message: processPolicy.hardened ? 'Xauthority enforced; -ac absent' : 'Live process does not match the hardened policy' });
    steps.push({ step: 'Verify live websockify policy', ok: websockifyPolicy.hardened, message: websockifyPolicy.hardened ? 'Exact loopback VNC bridge' : 'Live process does not match the loopback bridge policy' });
    steps.push({ step: 'Verify graphical desktop session', ok: desktopSessionPolicy.healthy, message: desktopSessionPolicy.healthy ? 'XFCE session is usable and lock-free' : desktopSessionPolicy.note });
    steps.push({ step: 'Verify session-guard supervision', ok: sessionGuardSupervised, message: sessionGuardSupervised ? 'Guard is running inside the managed VNC service' : 'Guard is not supervised by the managed VNC service' });
    steps.push({ step: 'Verify automatic recovery timer', ok: healthcheckTimerActive, message: healthcheckTimerActive ? 'Active' : 'Inactive' });

    const chromeBinaryOk = (await runShell('command -v google-chrome-stable || command -v google-chrome || command -v chromium-browser || command -v chromium', 5000)).ok;
    steps.push({ step: 'Verify Chrome/Chromium binary', ok: chromeBinaryOk, message: chromeBinaryOk ? 'Found browser binary' : 'No Chrome/Chromium binary found' });

    const sharedLauncherOk = fs.existsSync('/usr/local/bin/bridges-rd-shared-chrome.sh');
    const sharedLauncherCurrent = bundledStaticCandidatesAreCurrent([
      'static/scripts/bridges-rd-shared-chrome.sh',
    ], '/usr/local/bin/bridges-rd-shared-chrome.sh');
    const sharedStatePrivate = privateDesktopDirectoryIsCurrent(SHARED_BROWSER_STATE_DIR)
      && privateDesktopDirectoryIsCurrent(SHARED_BROWSER_LOG_DIR);
    const sharedDesktopEntryOk = fs.existsSync('/home/bridgesrd/Desktop/Shared Chrome.desktop');
    const openclawUiLauncherOk = fs.existsSync('/usr/local/bin/bridges-rd-openclaw-ui.sh');
    const openclawUiLauncherCurrent = bundledStaticCandidatesAreCurrent([
      'static/scripts/bridges-rd-openclaw-ui.sh',
    ], '/usr/local/bin/bridges-rd-openclaw-ui.sh');
    const openclawUiDesktopEntryOk = fs.existsSync('/home/bridgesrd/Desktop/OpenClaw Web UI.desktop');
    const aiProviderLauncherOk = fs.existsSync(AI_PROVIDER_LAUNCHER_PATH);
    const aiProviderLauncherCurrent = bundledStaticCandidatesAreCurrent([
      'static/scripts/bridges-rd-ai-launchers.sh',
    ], AI_PROVIDER_LAUNCHER_PATH);
    const aiProviderManifestOk = fs.existsSync(AI_PROVIDER_LAUNCHER_MANIFEST);
    const aiProviderLaunchersVerified = aiProviderLauncherOk
      ? await runShell(`${JSON.stringify(AI_PROVIDER_LAUNCHER_PATH)} verify`, 10_000)
      : { ok: false, stdout: '', stderr: 'launcher missing' };
    const sharedIconOk = fs.existsSync(SHARED_BROWSER_ICON_PATH);
    const sharedIconCurrent = bundledStaticCandidatesAreCurrent(
      ['static/icons/bridges-shared-browser.svg'],
      SHARED_BROWSER_ICON_PATH,
    );
    const openclawUiIconOk = fs.existsSync(OPENCLAW_UI_ICON_PATH);
    const openclawUiIconCurrent = bundledStaticCandidatesAreCurrent(
      ['static/icons/bridges-openclaw-ui.svg'],
      OPENCLAW_UI_ICON_PATH,
    );
    const openclawUiUrlFileOk = fs.existsSync(OPENCLAW_UI_DASHBOARD_URL_FILE);
    const openclawUiUrlCurrentOk = openClawDashboardUrlFileIsCurrent();
    const openclawUiLaunchHtmlOk = fs.existsSync(OPENCLAW_UI_LAUNCH_HTML_FILE);
    const openclawUiLaunchHtmlCurrentOk = openClawLaunchHtmlIsCurrent();
    const novncPortalOk = fs.existsSync(path.join(PORTAL_STATIC_NOVNC_DIR, 'vnc_portal.html'));
    const novncCoreOk = fs.existsSync(path.join(PORTAL_STATIC_NOVNC_DIR, 'core', 'rfb.js'));
    const vncLauncherCurrent = bundledStaticFileIsCurrent(
      'installer/scripts/bridges-rd-xtigervnc-start.sh',
      '/usr/local/bin/bridges-rd-xtigervnc-start.sh',
    );
    const sessionGuardCurrent = bundledStaticFileIsCurrent(
      'installer/scripts/bridges-rd-session-guard.sh',
      REMOTE_DESKTOP_SESSION_GUARD,
    );
    const healthcheckCurrent = bundledStaticFileIsCurrent(
      'installer/scripts/bridges-rd-healthcheck.sh',
      REMOTE_DESKTOP_HEALTHCHECK,
    );
    const automaticHealth = readRemoteDesktopHealthState();
    const automaticHealthReady = Boolean(
      automaticHealth
      && automaticHealth.fresh
      && !automaticHealth.suppressed
      && ['healthy', 'recovered'].includes(automaticHealth.status),
    );
    const windowFitCurrent = bundledStaticFileIsCurrent(
      'installer/scripts/bridges-rd-window-fit.sh',
      '/usr/local/bin/bridges-rd-window-fit.sh',
    );
    steps.push({ step: 'Verify Shared Browser launcher', ok: sharedLauncherOk && sharedLauncherCurrent, message: !sharedLauncherOk ? 'Missing launcher script' : sharedLauncherCurrent ? 'Matches signed bundle' : 'Differs from signed bundle' });
    steps.push({ step: 'Verify Shared Browser private state', ok: sharedStatePrivate, message: sharedStatePrivate ? 'Profile and logs are bridgesrd-owned mode 0700' : 'State/log directories are missing, linked, misowned, or not mode 0700' });
    steps.push({ step: 'Verify Shared Browser desktop entry', ok: sharedDesktopEntryOk, message: sharedDesktopEntryOk ? 'Present' : 'Missing desktop shortcut' });
    steps.push({ step: 'Verify Shared Browser icon', ok: sharedIconOk && sharedIconCurrent, message: !sharedIconOk ? 'Missing icon' : sharedIconCurrent ? 'Matches signed bundle' : 'Differs from signed bundle' });
    steps.push({ step: 'Verify OpenClaw Web UI launcher', ok: openclawUiLauncherOk && openclawUiLauncherCurrent, message: !openclawUiLauncherOk ? 'Missing launcher script' : openclawUiLauncherCurrent ? 'Matches signed bundle' : 'Differs from signed bundle' });
    steps.push({ step: 'Verify OpenClaw Web UI desktop entry', ok: openclawUiDesktopEntryOk, message: openclawUiDesktopEntryOk ? 'Present' : 'Missing desktop shortcut' });
    steps.push({ step: 'Verify OpenClaw Web UI icon', ok: openclawUiIconOk && openclawUiIconCurrent, message: !openclawUiIconOk ? 'Missing icon' : openclawUiIconCurrent ? 'Matches signed bundle' : 'Differs from signed bundle' });
    steps.push({
      step: 'Verify AI runtime launchers',
      ok: aiProviderLauncherOk && aiProviderLauncherCurrent && aiProviderManifestOk && aiProviderLaunchersVerified.ok,
      message: !aiProviderLauncherOk
        ? 'Managed launcher missing'
        : !aiProviderLauncherCurrent
          ? 'Launcher differs from signed bundle'
          : !aiProviderManifestOk
            ? 'Provisioning manifest missing'
            : aiProviderLaunchersVerified.ok
              ? 'Applicable runtime shortcuts have current identity and mode attestations'
              : (aiProviderLaunchersVerified.stderr || 'Runtime shortcut verification failed'),
    });
    steps.push({
      step: 'Verify OpenClaw Web UI tokenized URL',
      ok: openclawUiUrlFileOk && openclawUiUrlCurrentOk,
      message: openclawUiUrlFileOk ? (openclawUiUrlCurrentOk ? 'Present/current' : 'Present but stale') : 'Missing dashboard URL file',
    });
    steps.push({
      step: 'Verify OpenClaw Web UI private launch page',
      ok: openclawUiLaunchHtmlOk && openclawUiLaunchHtmlCurrentOk,
      message: openclawUiLaunchHtmlOk ? (openclawUiLaunchHtmlCurrentOk ? 'Present/current' : 'Present but stale') : 'Missing private launch page',
    });
    steps.push({ step: 'Verify noVNC portal HTML', ok: novncPortalOk, message: novncPortalOk ? 'Present' : 'Missing static/novnc/vnc_portal.html' });
    steps.push({ step: 'Verify noVNC core bundle', ok: novncCoreOk, message: novncCoreOk ? 'Present' : 'Missing static/novnc/core/rfb.js' });
    steps.push({ step: 'Verify VNC launcher provenance', ok: vncLauncherCurrent, message: vncLauncherCurrent ? 'Matches signed bundle' : 'Missing or differs from signed bundle' });
    steps.push({ step: 'Verify session guard provenance', ok: sessionGuardCurrent, message: sessionGuardCurrent ? 'Matches signed bundle' : 'Missing or differs from signed bundle' });
    steps.push({ step: 'Verify automatic healthcheck provenance', ok: healthcheckCurrent, message: healthcheckCurrent ? 'Matches signed bundle' : 'Missing or differs from signed bundle' });
    steps.push({
      step: 'Verify automatic health state',
      ok: automaticHealthReady,
      message: automaticHealth
        ? `${automaticHealth.status}${automaticHealth.fresh ? '' : ' (stale)'}${automaticHealth.suppressed ? ' (suppressed)' : ''}`
        : 'Missing or invalid health state',
    });
    steps.push({ step: 'Verify window-fit helper provenance', ok: windowFitCurrent, message: windowFitCurrent ? 'Matches signed bundle' : 'Missing or differs from signed bundle' });

    const allOk = steps.every((s) => s.ok);
    return {
      ok: allOk,
      steps,
      message: allOk ? 'Remote Desktop setup complete and verified.' : 'Setup completed with warnings — review steps above.',
    };
  } catch (error: any) {
    steps.push({ step: 'Unexpected error', ok: false, message: error?.message || 'Unknown error' });
    return { ok: false, steps, message: error?.message || 'Auto-setup failed' };
  } finally {
    lease.release();
  }
}

router.post('/auto-setup', async (req: Request, res: Response) => {
  if (!isTypedConfirmationMatch(PRIVILEGED_CONFIRMATION.remoteDesktopSetup, req.body?.confirmation)) {
    res.status(400).json({
      ok: false,
      message: `Type ${PRIVILEGED_CONFIRMATION.remoteDesktopSetup} to confirm host package, service, and configuration changes.`,
      confirmationPhrase: PRIVILEGED_CONFIRMATION.remoteDesktopSetup,
      steps: [],
    });
    return;
  }
  const result = await runRemoteDesktopAutoSetup();
  const busy = result.steps.some((step) => step.step === 'Remote Desktop operation busy');
  res.status(result.ok ? 200 : busy ? 409 : 500).json(result);
});

export default router;
