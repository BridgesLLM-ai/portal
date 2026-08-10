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
import {
  getPortalSelfUpdateProgress,
  readPortalSelfUpdateUnitIdentity,
  type PortalSelfUpdateUnitIdentity,
} from './portalSelfUpdateProgress';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

export const UPDATE_BACKUP_MAX_AGE_HOURS = 24;
const UPDATE_BACKUP_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const execFileAsync = promisify(execFile);
const PORTAL_SELF_UPDATE_UNIT = 'bridgesllm-portal-self-update';
const SYSTEMD_RUN = '/usr/bin/systemd-run';
const BACKUP_VERIFY_TIMEOUT_MS = 120_000;
const PORTAL_SELF_UPDATE_PROGRESS_SOURCE_HELPER =
  '/opt/bridgesllm/portal/installer/dashboard-update-progress.py';
const PORTAL_SELF_UPDATE_PROGRESS_STABLE_HELPER =
  '/var/lib/bridgesllm-installer/dashboard-update-progress.py';
// Domain-origin installs pass their attested domain through; Tailnet and
// local origins launch a plain --update so the installer reloads only the
// attested installed-origin state instead of being forced into domain mode.
const PORTAL_SELF_UPDATE_SCRIPT = [
  'set -Eeuo pipefail',
  'umask 077',
  'export BRIDGESLLM_DASHBOARD_UPDATE_ID="$5"',
  '/usr/bin/python3 "$7" update --operation-id "$5" --status running --percent 5 --phase installer-download --label "Downloading versioned installer" --detail "Step 1 of 13 · Fetching the reviewed installer over pinned HTTPS."',
  'installer_file="$(/usr/bin/mktemp /var/lib/bridgesllm-installer/dashboard-update-installer.XXXXXX)"',
  'trap \'/bin/rm -f -- "$installer_file"\' EXIT',
  'set +e',
  '/usr/bin/curl -fsSL --proto "=https" --tlsv1.2 --connect-timeout 15 --max-time 120 --retry 3 --retry-delay 2 --retry-max-time 300 --retry-all-errors --max-filesize 2097152 -o "$installer_file" "https://bridgesllm.ai/releases/$3/install.sh" >> "$2" 2>&1',
  'update_rc=$?',
  'if [ "$update_rc" -eq 0 ]; then',
  '  /bin/chmod 0600 "$installer_file"',
  '  if [ "$4" = "domain" ]; then',
  '    /bin/bash "$installer_file" --update --domain "$1" >> "$2" 2>&1',
  '    update_rc=$?',
  '  else',
  '    /bin/bash "$installer_file" --update >> "$2" 2>&1',
  '    update_rc=$?',
  '  fi',
  'else',
  '  /usr/bin/python3 "$7" update --operation-id "$5" --status running --percent 5 --phase installer-download --label "Installer download stopped" --detail "Step 1 of 13 · The bounded HTTPS download failed; systemd is recording the terminal result." || true',
  'fi',
  // Terminal state is deliberately absent here. systemd invokes the stable
  // helper from ExecStopPost only after it has recorded how this main process
  // died; success also requires install.sh's durable 99% checkpoint, which is
  // published only after its authenticated canonical update-ready proof.
  '/bin/sync -f "$2" || true',
  'exit "$update_rc"',
].join('\n');

// systemd starts transient root units with USER set but HOME unset, and the
// installer runs under `set -u` while reading ${HOME} for root-owned state
// (~/.openclaw, ~/.codex). Hand HOME across explicitly rather than relying on
// an environment systemd never promised to provide.
const selfUpdateHomeDirectory = (): string => {
  const home = process.env.HOME?.trim();
  return home && path.isAbsolute(home) ? home : '/root';
};

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
    public readonly code:
      | 'PORTAL_UPDATE_BUSY'
      | 'PORTAL_UPDATE_ATTENTION_REQUIRED'
      | 'PORTAL_UPDATE_LAUNCH_FAILED',
    public readonly operationId?: string,
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
  input: {
    originMode: PortalOriginMode;
    domain: string;
    logFile: string;
    previousVersion: string;
    expectedVersion: string;
  },
  dependencies: {
    execFileImpl?: ExecFileLike;
    progressExecFileImpl?: ExecFileLike;
    readUnitIdentityImpl?: () => Promise<PortalSelfUpdateUnitIdentity>;
    readProgressImpl?: (operationId: string) => Promise<{ operationId: string | null; status: string }>;
  } = {},
): Promise<{ operationId: string }> {
  if (!isReleaseVersion(input.previousVersion) || !isReleaseVersion(input.expectedVersion)) {
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
  const operationId = randomBytes(16).toString('hex');
  const execFileImpl = dependencies.execFileImpl || (async (file, args, options) => {
    await execFileAsync(file, [...args], options);
  });
  const progressExecFileImpl = dependencies.progressExecFileImpl || (async (file, args, options) => {
    await execFileAsync(file, [...args], options);
  });
  const readUnitIdentityImpl = dependencies.readUnitIdentityImpl || readPortalSelfUpdateUnitIdentity;
  const readProgressImpl = dependencies.readProgressImpl || getPortalSelfUpdateProgress;
  try {
    try {
      await progressExecFileImpl('/usr/bin/python3', [
        PORTAL_SELF_UPDATE_PROGRESS_SOURCE_HELPER,
        'create',
        '--operation-id', operationId,
        '--previous-version', input.previousVersion,
        '--target-version', input.expectedVersion,
        '--log-file', input.logFile,
      ], {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      if (Number((error as { code?: unknown })?.code) === 2) {
        throw new PortalSelfUpdateLaunchError(
          'A Portal update is already running. Reopen its progress instead of starting another update.',
          409,
          'PORTAL_UPDATE_BUSY',
        );
      }
      if (Number((error as { code?: unknown })?.code) === 4) {
        throw new PortalSelfUpdateLaunchError(
          'A prior Portal update still needs operator attention. Reopen its durable result and repair that host state before starting another update.',
          409,
          'PORTAL_UPDATE_ATTENTION_REQUIRED',
        );
      }
      // The helper can lose its IPC reply after fsyncing both the record and
      // current pointer. Prove this generated identity before deciding that
      // admission never happened; if it exists, close the unchanged admission
      // durably and return its receipt instead of leaving a hidden busy wedge.
      let durable: { operationId: string | null; status: string } | null = null;
      try {
        durable = await readProgressImpl(operationId);
      } catch {}
      if (durable?.operationId === operationId && durable.status !== 'idle') {
        if (!['succeeded', 'failed', 'rolled_back', 'updated_with_errors', 'recovery_required']
          .includes(durable.status)) {
          try {
            await progressExecFileImpl('/usr/bin/python3', [
              PORTAL_SELF_UPDATE_PROGRESS_STABLE_HELPER,
              'fail-launch', '--operation-id', operationId,
            ], { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
          } catch {
            try {
              const finalized = await readProgressImpl(operationId);
              if (finalized.operationId === operationId
                && ['succeeded', 'failed', 'rolled_back', 'updated_with_errors', 'recovery_required']
                  .includes(finalized.status)) return { operationId };
            } catch {}
            durable = null;
          }
        }
        if (durable) {
          return { operationId };
        }
      }
      throw new PortalSelfUpdateLaunchError(
        'Portal could not create a durable update operation. No update was started.',
        500,
        'PORTAL_UPDATE_LAUNCH_FAILED',
      );
    }
    await execFileImpl(SYSTEMD_RUN, [
      `--unit=${PORTAL_SELF_UPDATE_UNIT}`,
      '--collect',
      '--no-block',
      '--quiet',
      '--property=RuntimeMaxSec=4h',
      '--property=TimeoutStartSec=4h',
      '--property=TimeoutStopSec=30min',
      `--property=ExecStopPost=/usr/bin/python3 ${PORTAL_SELF_UPDATE_PROGRESS_STABLE_HELPER} finalize-service --operation-id ${operationId}`,
      `--setenv=HOME=${selfUpdateHomeDirectory()}`,
      `--setenv=BRIDGESLLM_DASHBOARD_UPDATE_ID=${operationId}`,
      '/bin/bash',
      '-c',
      PORTAL_SELF_UPDATE_SCRIPT,
      'portal-self-update',
      input.originMode === 'domain' ? input.domain : '',
      input.logFile,
      input.expectedVersion,
      input.originMode,
      operationId,
      input.previousVersion,
      PORTAL_SELF_UPDATE_PROGRESS_STABLE_HELPER,
    ], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (error instanceof PortalSelfUpdateLaunchError) throw error;
    const explicitUnitConflict = unitAlreadyExists(error);
    // `systemd-run --no-block` can lose its D-Bus reply after systemd has
    // already queued the transient unit. Never terminalize the durable
    // receipt unless the fixed unit is provably absent/inactive; otherwise
    // attach the client to that receipt and let unit/finalizer reconciliation
    // establish the outcome. An explicit UnitExists response is different:
    // that proves this new operation never owned the fixed unit, even while
    // the previous operation's ExecStopPost is still deactivating.
    let unitIdentity: PortalSelfUpdateUnitIdentity = { activity: 'unknown', operationId: null };
    let foreignUnitConflict = false;
    if (!explicitUnitConflict) {
      try {
        unitIdentity = await readUnitIdentityImpl();
      } catch {}
      if (unitIdentity.activity !== 'inactive') {
        if (unitIdentity.operationId === operationId || unitIdentity.activity === 'unknown') {
          return { operationId };
        }
        foreignUnitConflict = true;
      }
    }
    try {
      await progressExecFileImpl('/usr/bin/python3', [
        PORTAL_SELF_UPDATE_PROGRESS_STABLE_HELPER,
        'fail-launch', '--operation-id', operationId,
      ], { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
    } catch {
      // A fast accepted unit can finish and be collected before the activity
      // query. In that case fail-launch correctly rejects its progressed or
      // terminal state; reattach if the durable exact operation is terminal.
      if (!explicitUnitConflict && !foreignUnitConflict) {
        try {
          const progress = await readProgressImpl(operationId);
          if (progress.operationId === operationId && progress.status !== 'idle') {
            return { operationId };
          }
        } catch {}
      }
    }
    if (explicitUnitConflict || foreignUnitConflict) {
      throw new PortalSelfUpdateLaunchError(
        'A Portal update is already running. Wait for it to finish before retrying.',
        409,
        'PORTAL_UPDATE_BUSY',
        operationId,
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
  return { operationId };
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
