import {
  type BackupFile,
  type BackupStatus,
  getConfiguredBackupRoot,
  listBackupFiles,
  readBackupStatus,
} from './backup.service';
import { PRIVILEGED_CONFIRMATION, isTypedConfirmationMatch } from '../utils/privilegedConfirmation';
import type { PortalOriginMode } from '../utils/portalFeatureCapabilities';
import { isReleaseVersion } from './releaseUpdateDetails';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

export const UPDATE_BACKUP_MAX_AGE_HOURS = 24;
const UPDATE_BACKUP_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const execFileAsync = promisify(execFile);
const PORTAL_SELF_UPDATE_UNIT = 'bridgesllm-portal-self-update';
const SYSTEMD_RUN = '/usr/bin/systemd-run';
const BACKUP_VERIFY_TIMEOUT_MS = 120_000;
// Domain-origin installs pass their attested domain through; Tailnet and
// local origins launch a plain --update so the installer reloads only the
// attested installed-origin state instead of being forced into domain mode.
const PORTAL_SELF_UPDATE_SCRIPT = [
  'set -o pipefail',
  'if [ "$4" = "domain" ]; then',
  '  /usr/bin/curl -fsSL --proto "=https" --tlsv1.2 "https://bridgesllm.ai/releases/$3/install.sh" | /bin/bash -s -- --update --domain "$1" >> "$2" 2>&1',
  'else',
  '  /usr/bin/curl -fsSL --proto "=https" --tlsv1.2 "https://bridgesllm.ai/releases/$3/install.sh" | /bin/bash -s -- --update >> "$2" 2>&1',
  'fi',
].join('\n');

let portalSelfUpdateRegistrationInFlight = false;

export type UpdateBackupState = 'fresh' | 'stale' | 'missing' | 'running' | 'unavailable';
export type UpdateBackupReadiness = {
  state: UpdateBackupState;
  maxAgeHours: number;
  newestCreatedAt: string | null;
  ageHours: number | null;
  activeStatus: 'queued' | 'running' | null;
};

export type PortalUpdatePreparation = {
  confirmationPhrase: string;
  backup: UpdateBackupReadiness;
};

export type PortalUpdateBackupDecision = 'use-current' | 'proceed-without-fresh';

export type PortalUpdateAdmission =
  | { ok: true; backupDecision: PortalUpdateBackupDecision }
  | { ok: false; status: number; code: string; error: string };

export type PortalUpdateReleaseStatus = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  details: {
    version: string;
    provenance: string;
  } | null;
  detailsStatus: 'verified' | 'unavailable';
};

export type PortalUpdateReleaseAdmission =
  | { ok: true; expectedVersion: string }
  | { ok: false; status: number; code: string; error: string };

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<unknown>;

export class PortalSelfUpdateLaunchError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 409 | 500,
    public readonly code: 'PORTAL_UPDATE_BUSY' | 'PORTAL_UPDATE_LAUNCH_FAILED',
  ) {
    super(message);
    this.name = 'PortalSelfUpdateLaunchError';
  }
}

function unitAlreadyExists(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const diagnostic = `${String(record.message || '')}\n${String(record.stderr || '')}`;
  return /(?:unit\s+[^\n]*\s+(?:already exists|already loaded|is active)|already exists)/i.test(diagnostic);
}

/**
 * Register the genuine updater as one fixed transient systemd service. The
 * module guard closes the short race before systemd owns the unit name; the
 * fixed unit then enforces host-wide single-flight while the Portal stops and
 * replaces itself.
 */
export async function launchPortalSelfUpdate(
  input: { originMode: PortalOriginMode; domain: string; logFile: string; expectedVersion: string },
  dependencies: { execFileImpl?: ExecFileLike } = {},
): Promise<void> {
  if (!isReleaseVersion(input.expectedVersion)) {
    throw new PortalSelfUpdateLaunchError(
      'The reviewed Portal release version is invalid. Refresh update status before retrying.',
      409,
      'PORTAL_UPDATE_LAUNCH_FAILED',
    );
  }
  if (input.originMode !== 'domain' && input.originMode !== 'tailnet' && input.originMode !== 'local') {
    throw new PortalSelfUpdateLaunchError(
      'The Portal origin mode could not be established. Refresh update status before retrying.',
      500,
      'PORTAL_UPDATE_LAUNCH_FAILED',
    );
  }
  if (input.originMode === 'domain' && !input.domain) {
    throw new PortalSelfUpdateLaunchError(
      'No domain is configured for this Portal, so the updater cannot be launched in domain mode.',
      500,
      'PORTAL_UPDATE_LAUNCH_FAILED',
    );
  }
  if (portalSelfUpdateRegistrationInFlight) {
    throw new PortalSelfUpdateLaunchError(
      'A Portal update is already being started. Wait for it to finish before retrying.',
      409,
      'PORTAL_UPDATE_BUSY',
    );
  }

  portalSelfUpdateRegistrationInFlight = true;
  const execFileImpl = dependencies.execFileImpl || (async (file, args, options) => {
    await execFileAsync(file, [...args], options);
  });
  try {
    await execFileImpl(SYSTEMD_RUN, [
      `--unit=${PORTAL_SELF_UPDATE_UNIT}`,
      '--collect',
      '--no-block',
      '--quiet',
      '/bin/bash',
      '-c',
      PORTAL_SELF_UPDATE_SCRIPT,
      'portal-self-update',
      input.originMode === 'domain' ? input.domain : '',
      input.logFile,
      input.expectedVersion,
      input.originMode,
    ], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (unitAlreadyExists(error)) {
      throw new PortalSelfUpdateLaunchError(
        'A Portal update is already running. Wait for it to finish before retrying.',
        409,
        'PORTAL_UPDATE_BUSY',
      );
    }
    throw new PortalSelfUpdateLaunchError(
      'Portal could not start the signed updater. Check the Portal service log before retrying.',
      500,
      'PORTAL_UPDATE_LAUNCH_FAILED',
    );
  } finally {
    portalSelfUpdateRegistrationInFlight = false;
  }
}

export function __resetPortalSelfUpdateLaunchStateForTests(): void {
  portalSelfUpdateRegistrationInFlight = false;
}

type BackupCandidate = Pick<BackupFile, 'mtimeMs' | 'size'>;
type VerifiableBackupCandidate = Pick<BackupFile, 'filename' | 'fullPath' | 'mtimeMs' | 'size' | 'dev' | 'ino'>;
type BackupRun = Pick<BackupStatus, 'status'> | null;

type BackupVerificationDependencies = {
  execFileImpl?: ExecFileLike;
  backupScriptPath?: string;
};

export async function verifyUpdateBackupArchive(
  candidate: VerifiableBackupCandidate,
  dependencies: BackupVerificationDependencies = {},
): Promise<boolean> {
  if (candidate.size <= 0) return false;
  const backupScript = dependencies.backupScriptPath
    || process.env.BACKUP_SCRIPT_PATH
    || path.join(process.env.PORTAL_ROOT || '/opt/bridgesllm/portal', 'backup-full.sh');
  const execFileImpl = dependencies.execFileImpl || (async (file, args, options) => {
    await execFileAsync(file, [...args], options);
  });

  try {
    await execFileImpl('/bin/bash', [
      backupScript,
      '--verify-archive',
      candidate.fullPath,
    ], {
      timeout: BACKUP_VERIFY_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const stat = fs.lstatSync(candidate.fullPath);
    return stat.isFile()
      && !stat.isSymbolicLink()
      && stat.dev === candidate.dev
      && stat.ino === candidate.ino
      && stat.size === candidate.size
      && stat.mtimeMs === candidate.mtimeMs;
  } catch {
    return false;
  }
}

export async function findFreshVerifiedUpdateBackup(
  candidates: VerifiableBackupCandidate[],
  nowMs = Date.now(),
  verifyArchive: (candidate: VerifiableBackupCandidate) => Promise<boolean> = verifyUpdateBackupArchive,
): Promise<VerifiableBackupCandidate | null> {
  const maxAgeMs = UPDATE_BACKUP_MAX_AGE_HOURS * 3_600_000;
  const eligible = candidates
    .filter((candidate) => candidate.size > 0)
    .filter((candidate) => nowMs - candidate.mtimeMs <= maxAgeMs)
    .filter((candidate) => candidate.mtimeMs - nowMs <= UPDATE_BACKUP_MAX_FUTURE_SKEW_MS)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const newest = eligible[0];
  if (!newest) return null;
  return await verifyArchive(newest) ? newest : null;
}

function roundedHours(milliseconds: number): number {
  return Math.round((milliseconds / 3_600_000) * 10) / 10;
}

export function assessUpdateBackupReadiness(
  candidates: BackupCandidate[],
  runStatus: BackupRun,
  nowMs = Date.now(),
): UpdateBackupReadiness {
  const activeStatus = runStatus?.status === 'queued' || runStatus?.status === 'running'
    ? runStatus.status
    : null;
  const newest = candidates
    .filter((candidate) => Number.isFinite(candidate.mtimeMs) && candidate.size > 0)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0] || null;

  const newestCreatedAt = newest ? new Date(newest.mtimeMs).toISOString() : null;
  const ageMs = newest ? nowMs - newest.mtimeMs : null;
  const ageHours = ageMs === null ? null : Math.max(0, roundedHours(ageMs));

  if (activeStatus) {
    return {
      state: 'running',
      maxAgeHours: UPDATE_BACKUP_MAX_AGE_HOURS,
      newestCreatedAt,
      ageHours,
      activeStatus,
    };
  }

  if (!newest) {
    return {
      state: 'missing',
      maxAgeHours: UPDATE_BACKUP_MAX_AGE_HOURS,
      newestCreatedAt: null,
      ageHours: null,
      activeStatus: null,
    };
  }

  if (newest.mtimeMs - nowMs > UPDATE_BACKUP_MAX_FUTURE_SKEW_MS) {
    return {
      state: 'unavailable',
      maxAgeHours: UPDATE_BACKUP_MAX_AGE_HOURS,
      newestCreatedAt,
      ageHours: null,
      activeStatus: null,
    };
  }

  return {
    state: ageMs! <= UPDATE_BACKUP_MAX_AGE_HOURS * 3_600_000 ? 'fresh' : 'stale',
    maxAgeHours: UPDATE_BACKUP_MAX_AGE_HOURS,
    newestCreatedAt,
    ageHours,
    activeStatus: null,
  };
}

export function unavailableUpdatePreparation(): PortalUpdatePreparation {
  return {
    confirmationPhrase: PRIVILEGED_CONFIRMATION.portalUpdate,
    backup: {
      state: 'unavailable',
      maxAgeHours: UPDATE_BACKUP_MAX_AGE_HOURS,
      newestCreatedAt: null,
      ageHours: null,
      activeStatus: null,
    },
  };
}

export async function getPortalUpdatePreparation(
  nowMs = Date.now(),
  options: {
    verifyFreshArchive?: boolean;
    verifyArchive?: (candidate: VerifiableBackupCandidate) => Promise<boolean>;
  } = {},
): Promise<PortalUpdatePreparation> {
  try {
    const root = await getConfiguredBackupRoot({ syncFile: false });
    const candidates = listBackupFiles(root);
    const runStatus = readBackupStatus();
    let backup = assessUpdateBackupReadiness(candidates, runStatus, nowMs);
    if (options.verifyFreshArchive && backup.state === 'fresh') {
      const verified = await findFreshVerifiedUpdateBackup(
        candidates,
        nowMs,
        options.verifyArchive || verifyUpdateBackupArchive,
      );
      const postVerificationRunStatus = readBackupStatus();
      backup = verified
        ? assessUpdateBackupReadiness([verified], postVerificationRunStatus, nowMs)
        : assessUpdateBackupReadiness([], postVerificationRunStatus, nowMs).state === 'running'
          ? assessUpdateBackupReadiness([], postVerificationRunStatus, nowMs)
          : { ...backup, state: 'unavailable' };
    }
    return {
      confirmationPhrase: PRIVILEGED_CONFIRMATION.portalUpdate,
      backup,
    };
  } catch (error) {
    console.warn('[update-preparation] Backup readiness check failed:', String((error as Error)?.message || error));
    return unavailableUpdatePreparation();
  }
}

export function admitPortalUpdateRelease(
  status: PortalUpdateReleaseStatus,
  input: { expectedVersion?: unknown },
): PortalUpdateReleaseAdmission {
  const expectedVersion = typeof input.expectedVersion === 'string'
    ? input.expectedVersion.trim()
    : '';
  if (!isReleaseVersion(expectedVersion)) {
    return {
      ok: false,
      status: 400,
      code: 'UPDATE_EXPECTED_VERSION_REQUIRED',
      error: 'The reviewed Portal release version is missing or invalid. Refresh update status before retrying.',
    };
  }

  if (!status.updateAvailable || status.latest !== expectedVersion) {
    return {
      ok: false,
      status: 409,
      code: 'UPDATE_RELEASE_CHANGED',
      error: 'The available Portal release changed after it was reviewed. Refresh update status and review the release again.',
    };
  }

  if (status.detailsStatus !== 'verified'
    || status.details?.version !== expectedVersion
    || status.details?.provenance !== 'signed-release-manifest') {
    return {
      ok: false,
      status: 409,
      code: 'UPDATE_RELEASE_UNVERIFIED',
      error: 'The reviewed Portal release could not be matched to verified signed release details. Refresh update status before retrying.',
    };
  }

  return { ok: true, expectedVersion };
}

export function admitPortalUpdate(
  preparation: PortalUpdatePreparation,
  input: { confirmation?: unknown; backupDecision?: unknown },
): PortalUpdateAdmission {
  if (!isTypedConfirmationMatch(preparation.confirmationPhrase, input.confirmation)) {
    return {
      ok: false,
      status: 400,
      code: 'UPDATE_CONFIRMATION_REQUIRED',
      error: `Type ${preparation.confirmationPhrase} to confirm the Portal update.`,
    };
  }

  if (preparation.backup.state === 'running') {
    return {
      ok: false,
      status: 409,
      code: 'BACKUP_IN_PROGRESS',
      error: 'A backup is already in progress. Wait for it to finish before updating.',
    };
  }

  const decision = input.backupDecision;
  if (decision !== 'use-current' && decision !== 'proceed-without-fresh') {
    return {
      ok: false,
      status: 400,
      code: 'UPDATE_BACKUP_DECISION_REQUIRED',
      error: 'Choose whether to use a fresh backup or explicitly continue without one.',
    };
  }

  if (decision === 'use-current' && preparation.backup.state !== 'fresh') {
    return {
      ok: false,
      status: 409,
      code: 'FRESH_BACKUP_REQUIRED',
      error: `A Portal backup no older than ${preparation.backup.maxAgeHours} hours is required for this option.`,
    };
  }

  return { ok: true, backupDecision: decision };
}
