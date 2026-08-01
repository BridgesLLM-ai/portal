import crypto from 'crypto';
import { execSync } from 'child_process';
import axios from 'axios';
import { prisma } from '../config/database';
import { PORTAL_VERSION } from '../version';
import {
  fetchSignedReleaseDetails,
  isReleaseVersion,
  verifyStoredReleaseEvidence,
  type VerifiedReleaseDetails,
} from './releaseUpdateDetails';
import { requestConfiguredOllamaJson } from './ollamaBackendAuthority';

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
const OLLAMA_VERSION_MAX_RESPONSE_BYTES = 64 * 1024;
const LATEST_VERSION_SETTING = 'system.latestVersion';
const LATEST_RELEASE_EVIDENCE_SETTING = 'system.latestReleaseEvidence';

let telemetryInterval: NodeJS.Timeout | null = null;
let startupTimeout: NodeJS.Timeout | null = null;
let started = false;

export interface DependencyVersions {
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

export interface DependencyVersionDetectionDependencies {
  requestConfiguredImpl?: typeof requestConfiguredOllamaJson;
  detectCommandVersionImpl?: typeof detectCommandVersion;
}

export async function detectDependencyVersions(
  overrides: DependencyVersionDetectionDependencies = {},
): Promise<DependencyVersions> {
  const deps: DependencyVersions = {};
  const detectVersion = overrides.detectCommandVersionImpl ?? detectCommandVersion;
  const requestConfiguredImpl = overrides.requestConfiguredImpl ?? requestConfiguredOllamaJson;

  const openclaw = detectVersion('openclaw --version 2>/dev/null', /(\d{4}\.\d+\.\d+)/);
  if (openclaw) deps.openclaw = openclaw;

  try {
    const response = await requestConfiguredImpl<{ version?: unknown }>({
      path: '/api/version',
      method: 'GET',
      timeoutMs: 3_000,
      maxResponseBytes: OLLAMA_VERSION_MAX_RESPONSE_BYTES,
    });
    const ollama = typeof response.value.version === 'string' ? response.value.version.trim() : '';
    if (ollama) deps.ollama = ollama;
  } catch {
    // The configured authority is the only Ollama version source. Do not
    // bypass disabled/local/Tailnet policy with an unrelated CLI fallback.
  }

  const caddy = detectVersion('caddy version 2>/dev/null', /v?(\d+\.\d+\.\d+)/);
  if (caddy) deps.caddy = caddy;

  const postgres = detectVersion('psql --version 2>/dev/null', /(\d+\.\d+)/);
  if (postgres) deps.postgres = postgres;

  const docker = detectVersion('docker --version 2>/dev/null', /(\d+\.\d+\.\d+)/);
  if (docker) deps.docker = docker;

  const codexCli = detectVersion('codex --version 2>/dev/null', /(\d+\.\d+\.\d+)/);
  if (codexCli) deps.codexCli = codexCli;

  const claudeCode = detectVersion('claude --version 2>/dev/null', /(\d+\.\d+\.\d+)/);
  if (claudeCode) deps.claudeCode = claudeCode;

  const geminiCli = detectVersion('agy --version 2>/dev/null', /(\d+\.\d+\.\d+)/);
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

type UpdateStatus = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  details: VerifiedReleaseDetails | null;
  detailsStatus: 'verified' | 'unavailable';
};

function normalizeLatestVersion(value: unknown): string | null {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return isReleaseVersion(candidate) ? candidate : null;
}

async function cachedVerifiedReleaseDetails(version: string | null): Promise<VerifiedReleaseDetails | null> {
  if (!version) return null;
  const evidence = await getSettingValue(LATEST_RELEASE_EVIDENCE_SETTING);
  return verifyStoredReleaseEvidence(evidence, version);
}

async function refreshVerifiedReleaseDetails(version: string): Promise<VerifiedReleaseDetails | null> {
  const verified = await fetchSignedReleaseDetails(version);
  if (!verified) return cachedVerifiedReleaseDetails(version);
  await setSettingValue(LATEST_RELEASE_EVIDENCE_SETTING, verified.evidence);
  return verified.details;
}

function buildUpdateStatus(latest: string | null, details: VerifiedReleaseDetails | null): UpdateStatus {
  return {
    current: PORTAL_VERSION,
    latest,
    updateAvailable: compareVersions(PORTAL_VERSION, latest),
    details,
    detailsStatus: details ? 'verified' : 'unavailable',
  };
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

    const latestVersion = normalizeLatestVersion(response.data?.latestVersion);

    if (latestVersion) {
      await setSettingValue(LATEST_VERSION_SETTING, latestVersion);
      await refreshVerifiedReleaseDetails(latestVersion);
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

// Dashboard views must not re-execute the remote version check on every
// open. The live check runs at most once per cooldown window per
// process; explicit user refreshes pass force=true. Concurrent callers share
// one in-flight check.
const UPDATE_CHECK_COOLDOWN_MS = 15 * 60_000;
let lastUpdateCheckAt: number | null = null;
let inFlightUpdateCheck: Promise<UpdateStatus> | null = null;

export type CooldownUpdateStatus = UpdateStatus & {
  checkedAt: number | null;
  cached: boolean;
};

export async function checkForUpdatesWithCooldown(
  force = false,
  deps: {
    checkImpl?: () => Promise<UpdateStatus>;
    statusImpl?: () => Promise<UpdateStatus>;
    nowImpl?: () => number;
  } = {},
): Promise<CooldownUpdateStatus> {
  const check = deps.checkImpl ?? checkForUpdates;
  const cachedStatus = deps.statusImpl ?? getUpdateStatus;
  const now = deps.nowImpl ?? Date.now;
  const fresh = lastUpdateCheckAt !== null
    && now() - lastUpdateCheckAt < UPDATE_CHECK_COOLDOWN_MS;
  if (!force && fresh && !inFlightUpdateCheck) {
    const status = await cachedStatus();
    return { ...status, checkedAt: lastUpdateCheckAt, cached: true };
  }
  if (!inFlightUpdateCheck) {
    inFlightUpdateCheck = check().finally(() => {
      lastUpdateCheckAt = now();
      inFlightUpdateCheck = null;
    });
  }
  const status = await inFlightUpdateCheck.catch(() => cachedStatus());
  return { ...status, checkedAt: lastUpdateCheckAt ?? now(), cached: false };
}

export function resetUpdateCheckCooldownForTests(): void {
  lastUpdateCheckAt = null;
  inFlightUpdateCheck = null;
}

/**
 * Force-check for updates by querying the telemetry API for the latest version.
 * Works even if telemetry is disabled (only sends version, no usage data).
 */
export async function checkForUpdates(): Promise<UpdateStatus> {
  try {
    const response = await axios.get(TELEMETRY_URL.replace('/ping', '/version'), {
      timeout: 5_000,
    });
    const latestVersion = normalizeLatestVersion(response.data?.latestVersion);
    if (latestVersion) {
      await setSettingValue(LATEST_VERSION_SETTING, latestVersion);
    }
    const details = latestVersion ? await refreshVerifiedReleaseDetails(latestVersion) : null;
    return buildUpdateStatus(latestVersion, details);
  } catch {
    // Fall back to cached value
    const latest = normalizeLatestVersion(await getSettingValue(LATEST_VERSION_SETTING));
    return buildUpdateStatus(latest, await cachedVerifiedReleaseDetails(latest));
  }
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  const latest = normalizeLatestVersion(await getSettingValue(LATEST_VERSION_SETTING));
  return buildUpdateStatus(latest, await cachedVerifiedReleaseDetails(latest));
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
