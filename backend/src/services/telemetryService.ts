import crypto from 'crypto';
import { execSync } from 'child_process';
import axios from 'axios';
import { prisma } from '../config/database';
import { PORTAL_VERSION } from '../version';

function describeTelemetryError(error: any): { level: 'warn' | 'info'; message: string } {
  const status = Number(error?.response?.status || 0);
  if (status === 429) {
    return {
      level: 'info',
      message: 'Ping rate-limited by telemetry endpoint; keeping cached version state and retrying on the next scheduled check.',
    };
  }

  const message = String(error?.message || error || 'Unknown telemetry error').trim();
  return {
    level: 'warn',
    message,
  };
}

const TELEMETRY_URL = 'https://bridgesllm.ai/api/telemetry/ping';
const STARTUP_DELAY_MS = 30_000;
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

let telemetryInterval: NodeJS.Timeout | null = null;
let startupTimeout: NodeJS.Timeout | null = null;
let started = false;

interface DependencyVersions {
  openclaw?: string;
  ollama?: string;
  caddy?: string;
  postgres?: string;
  docker?: string;
  codexCli?: string;
  claudeCode?: string;
  geminiCli?: string;
}

const DETECTION_EXEC_OPTIONS = {
  encoding: 'utf-8' as const,
  timeout: 3000,
  stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
};

let cachedDeps: DependencyVersions = {};

function detectCommandVersion(command: string, regex: RegExp): string | undefined {
  try {
    const output = execSync(command, DETECTION_EXEC_OPTIONS);
    const match = output.match(regex);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function detectDependencyVersions(): Promise<DependencyVersions> {
  const deps: DependencyVersions = {};

  const openclaw = detectCommandVersion('openclaw --version 2>/dev/null', /(\d{4}\.\d+\.\d+)/);
  if (openclaw) deps.openclaw = openclaw;

  try {
    const response = await axios.get('http://localhost:11434/api/version', { timeout: 3000 });
    const ollama = typeof response.data?.version === 'string' ? response.data.version.trim() : '';
    if (ollama) deps.ollama = ollama;
  } catch {
    const ollama = detectCommandVersion('ollama --version 2>/dev/null', /(\d+\.\d+\.\d+)/);
    if (ollama) deps.ollama = ollama;
  }

  const caddy = detectCommandVersion('caddy version 2>/dev/null', /v?(\d+\.\d+\.\d+)/);
  if (caddy) deps.caddy = caddy;

  const postgres = detectCommandVersion('psql --version 2>/dev/null', /(\d+\.\d+)/);
  if (postgres) deps.postgres = postgres;

  const docker = detectCommandVersion('docker --version 2>/dev/null', /(\d+\.\d+\.\d+)/);
  if (docker) deps.docker = docker;

  const codexCli = detectCommandVersion('codex --version 2>/dev/null', /(\d+\.\d+\.\d+)/);
  if (codexCli) deps.codexCli = codexCli;

  const claudeCode = detectCommandVersion('claude --version 2>/dev/null', /(\d+\.\d+\.\d+)/);
  if (claudeCode) deps.claudeCode = claudeCode;

  const geminiCli = detectCommandVersion('gemini --version 2>/dev/null', /(\d+\.\d+\.\d+)/);
  if (geminiCli) deps.geminiCli = geminiCli;

  return deps;
}

async function refreshDependencyVersions(): Promise<void> {
  cachedDeps = await detectDependencyVersions();
}

async function getSettingValue(key: string): Promise<string | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function setSettingValue(key: string, value: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

async function isTelemetryEnabled(): Promise<boolean> {
  return (await getSettingValue('system.allowTelemetry')) === 'true';
}

async function getOrCreateInstallId(): Promise<string> {
  const envId = process.env.TELEMETRY_INSTALL_ID?.trim();
  if (envId) {
    const existing = await getSettingValue('system.installId');
    if (!existing) {
      await setSettingValue('system.installId', envId);
    }
    return envId;
  }

  const existing = await getSettingValue('system.installId');
  if (existing) return existing;

  const installId = crypto.randomUUID();
  await setSettingValue('system.installId', installId);
  return installId;
}

function compareVersions(current: string, latest: string | null): boolean {
  if (!latest) return false;
  const currentParts = current.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const latestParts = latest.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(currentParts.length, latestParts.length);

  for (let i = 0; i < length; i += 1) {
    const currentValue = currentParts[i] ?? 0;
    const latestValue = latestParts[i] ?? 0;
    if (latestValue > currentValue) return true;
    if (latestValue < currentValue) return false;
  }

  return false;
}

async function sendTelemetryPing(): Promise<void> {
  if (!(await isTelemetryEnabled())) return;

  const [installId, activeUsers] = await Promise.all([
    getOrCreateInstallId(),
    prisma.user.count(),
  ]);

  const payload = {
    installId,
    version: PORTAL_VERSION,
    activeUsers,
    uptime: Math.floor(process.uptime()),
    nodeVersion: process.version,
    os: process.platform,
    arch: process.arch,
    deps: cachedDeps,
  };

  try {
    const response = await axios.post(TELEMETRY_URL, payload, {
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });

    const latestVersion = typeof response.data?.latestVersion === 'string'
      ? response.data.latestVersion.trim()
      : '';

    if (latestVersion) {
      await setSettingValue('system.latestVersion', latestVersion);
    }
  } catch (error: any) {
    const details = describeTelemetryError(error);
    if (details.level === 'info') {
      console.info(`[telemetry] ${details.message}`);
    } else {
      console.warn('[telemetry] Ping failed:', details.message);
    }
  }
}

/**
 * Force-check for updates by querying the telemetry API for the latest version.
 * Works even if telemetry is disabled (only sends version, no usage data).
 */
export async function checkForUpdates(): Promise<{ current: string; latest: string | null; updateAvailable: boolean }> {
  try {
    const response = await axios.get(TELEMETRY_URL.replace('/ping', '/version'), {
      timeout: 5_000,
    });
    const latestVersion = typeof response.data?.latestVersion === 'string'
      ? response.data.latestVersion.trim()
      : '';
    if (latestVersion) {
      await setSettingValue('system.latestVersion', latestVersion);
    }
    return { current: PORTAL_VERSION, latest: latestVersion || null, updateAvailable: compareVersions(PORTAL_VERSION, latestVersion || null) };
  } catch {
    // Fall back to cached value
    const latest = await getSettingValue('system.latestVersion');
    return { current: PORTAL_VERSION, latest, updateAvailable: compareVersions(PORTAL_VERSION, latest) };
  }
}

export async function getUpdateStatus() {
  const latest = await getSettingValue('system.latestVersion');
  return {
    current: PORTAL_VERSION,
    latest,
    updateAvailable: compareVersions(PORTAL_VERSION, latest),
  };
}

export function startTelemetryService(): void {
  if (started) return;
  started = true;

  startupTimeout = setTimeout(() => {
    (async () => {
      try {
        await refreshDependencyVersions();
      } catch (error) {
        console.warn('[telemetry] Dependency detection failed:', error);
      }

      try {
        await sendTelemetryPing();
      } catch (error) {
        console.warn('[telemetry] Initial ping failed:', error);
      }
    })();
  }, STARTUP_DELAY_MS);

  telemetryInterval = setInterval(() => {
    (async () => {
      try {
        await refreshDependencyVersions();
      } catch (error) {
        console.warn('[telemetry] Dependency detection failed:', error);
      }

      try {
        await sendTelemetryPing();
      } catch (error) {
        console.warn('[telemetry] Scheduled ping failed:', error);
      }
    })();
  }, DAILY_INTERVAL_MS);
}

export function stopTelemetryService(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (telemetryInterval) {
    clearInterval(telemetryInterval);
    telemetryInterval = null;
  }
  started = false;
}
