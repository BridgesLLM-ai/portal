import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { PROJECT_RUNTIME_IMAGE } from './project-lifecycle.service';
import { PORTAL_VERSION } from '../version';

const execFileAsync = promisify(execFile);
const SYSTEMD_RUN = '/usr/bin/systemd-run';
const SYSTEMCTL = '/usr/bin/systemctl';
const DOCKER = '/usr/bin/docker';
const REPAIR_UNIT = 'bridgesllm-project-runtime-image-repair';
const INSTALLED_REPAIR_SCRIPT = '/opt/bridgesllm/portal/installer/install.sh';
const INSTALLED_REPAIR_LAUNCHER = '/opt/bridgesllm/portal/installer/project-runtime-image-repair-launcher.py';
const REPAIR_LOG_DIR = '/opt/bridgesllm/logs';

export const PROJECT_RUNTIME_IMAGE_REPAIR_CONFIRMATION = 'REPAIR PROJECT RUNTIME IMAGE';

function repairLaunchArgs(logPath: string): readonly string[] {
  return [
    `--unit=${REPAIR_UNIT}`,
    '--no-block',
    '--quiet',
    '--setenv=HOME=/root',
    '/usr/bin/python3',
    '-I',
    '-S',
    INSTALLED_REPAIR_LAUNCHER,
    PORTAL_VERSION,
    logPath,
  ];
}

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<{ stdout?: string } | void>;

type RepairDependencies = {
  execFileImpl?: ExecFileLike;
  imageReady?: () => Promise<boolean>;
  imageReadiness?: () => Promise<'ready' | 'missing' | 'unknown'>;
  now?: () => Date;
  randomSuffix?: () => string;
  logPathFactory?: () => string;
  allowFailedRetry?: boolean;
};

export type ProjectRuntimeImageRepairStatus = Readonly<{
  state: 'ready' | 'running' | 'failed' | 'unavailable';
  unavailableReason?: 'image-missing' | 'image-state-unknown' | 'unit-state-unknown';
  confirmationPhrase: typeof PROJECT_RUNTIME_IMAGE_REPAIR_CONFIRMATION;
  ownerOnly: true;
  changesSystem: true;
  restartExpected: true;
}>;

export class ProjectRuntimeImageRepairLaunchError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 409 | 500,
    public readonly code: 'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY' | 'PROJECT_RUNTIME_IMAGE_REPAIR_LAUNCH_FAILED',
  ) {
    super(message);
    this.name = 'ProjectRuntimeImageRepairLaunchError';
  }
}

let registrationInFlight = false;

function unitAlreadyExists(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const diagnostic = `${String(record.message || '')}\n${String(record.stderr || '')}`;
  return /(?:unit\s+[^\n]*\s+(?:already exists|already loaded|is active)|already exists)/i.test(diagnostic);
}

function isExplicitMissingImage(error: unknown): boolean {
  const record = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  if (record.killed === true || record.signal || Number(record.code) !== 1) return false;
  const diagnostic = String(record.stderr || '').trim();
  return /^(?:error response from daemon:\s*)?(?:error:\s*)?no such image:\s+\S+$/i.test(diagnostic);
}

async function defaultImageReadiness(
  execFileImpl: ExecFileLike,
): Promise<'ready' | 'missing' | 'unknown'> {
  try {
    const result = await execFileImpl(DOCKER, [
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      PROJECT_RUNTIME_IMAGE,
    ], {
      timeout: 5_000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    });
    const imageId = String(result && 'stdout' in result ? result.stdout || '' : '').trim();
    return /^sha256:[a-f0-9]{64}$/i.test(imageId) ? 'ready' : 'unknown';
  } catch (error) {
    // Only Docker's explicit missing-image response proves absence. Timeouts,
    // daemon/socket errors, executable drift, and malformed output remain
    // unknown so a status read cannot authorize a second root repair.
    return isExplicitMissingImage(error) ? 'missing' : 'unknown';
  }
}

async function imageReadiness(
  dependencies: RepairDependencies,
  execFileImpl: ExecFileLike,
): Promise<'ready' | 'missing' | 'unknown'> {
  if (dependencies.imageReadiness) return dependencies.imageReadiness();
  if (dependencies.imageReady) return await dependencies.imageReady() ? 'ready' : 'missing';
  return defaultImageReadiness(execFileImpl);
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
): Promise<{ stdout?: string }> {
  return execFileAsync(file, [...args], options) as Promise<{ stdout?: string }>;
}

async function readUnitState(
  execFileImpl: ExecFileLike,
): Promise<'running' | 'failed' | 'idle' | 'unknown'> {
  try {
    const result = await execFileImpl(SYSTEMCTL, [
      'show',
      `${REPAIR_UNIT}.service`,
      '--property=ActiveState',
      '--value',
    ], {
      timeout: 5_000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    });
    const activeState = String(result && 'stdout' in result ? result.stdout || '' : '')
      .trim()
      .toLowerCase();
    if (activeState === 'active' || activeState === 'activating' || activeState === 'deactivating') {
      return 'running';
    }
    if (activeState === 'failed') return 'failed';
    if (activeState === 'inactive') return 'idle';
    return 'unknown';
  } catch (error) {
    const record = error && typeof error === 'object'
      ? error as Record<string, unknown>
      : {};
    const diagnostic = `${String(record.message || '')}\n${String(record.stderr || '')}`;
    // A fixed unit that has never run is the only failed lookup equivalent to
    // an idle lane. Timeouts, D-Bus errors, permissions failures, and malformed
    // responses leave ownership unknown and must never authorize a launch.
    return /unit\s+[^\n]*\s+(?:could not be found|not found|not loaded)/i.test(diagnostic)
      ? 'idle'
      : 'unknown';
  }
}

export async function getProjectRuntimeImageRepairStatus(
  dependencies: RepairDependencies = {},
): Promise<ProjectRuntimeImageRepairStatus> {
  // The installer publishes the new immutable pin before restarting Portal
  // and completing its post-commit health checks. The restarted process can
  // therefore resolve the image while the repair unit still owns rollback.
  // Unit ownership must win until that transaction has actually settled.
  const execFileImpl = dependencies.execFileImpl || defaultExecFile;
  const unitState = registrationInFlight
    ? 'running'
    : await readUnitState(execFileImpl);
  if (unitState === 'running' || unitState === 'failed') {
    return {
      state: unitState,
      confirmationPhrase: PROJECT_RUNTIME_IMAGE_REPAIR_CONFIRMATION,
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    };
  }
  if (unitState === 'unknown') {
    return {
      state: 'unavailable',
      unavailableReason: 'unit-state-unknown',
      confirmationPhrase: PROJECT_RUNTIME_IMAGE_REPAIR_CONFIRMATION,
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    };
  }
  const readiness = await imageReadiness(dependencies, execFileImpl);
  if (readiness === 'ready') {
    return {
      state: 'ready',
      confirmationPhrase: PROJECT_RUNTIME_IMAGE_REPAIR_CONFIRMATION,
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    };
  }
  return {
    state: 'unavailable',
    unavailableReason: readiness === 'missing' ? 'image-missing' : 'image-state-unknown',
    confirmationPhrase: PROJECT_RUNTIME_IMAGE_REPAIR_CONFIRMATION,
    ownerOnly: true,
    changesSystem: true,
    restartExpected: true,
  };
}

function prepareRepairLog(now: Date, suffix: string): string {
  const logDirectory = fs.lstatSync(REPAIR_LOG_DIR);
  if (
    !logDirectory.isDirectory()
    || logDirectory.isSymbolicLink()
    || logDirectory.uid !== 0
    || logDirectory.gid !== 0
    || (logDirectory.mode & 0o022) !== 0
  ) {
    throw new Error('Project runtime repair log directory is unsafe');
  }
  const normalizedSuffix = /^[a-f0-9]{16,64}$/.test(suffix) ? suffix : '';
  if (!normalizedSuffix) throw new Error('Project runtime repair log identity is invalid');
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(REPAIR_LOG_DIR, `project-runtime-image-repair-${timestamp}-${normalizedSuffix}.log`);
  const descriptor = fs.openSync(
    logPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  fs.closeSync(descriptor);
  return logPath;
}

export async function launchProjectRuntimeImageRepair(
  dependencies: RepairDependencies = {},
): Promise<{ state: 'ready' | 'running'; started: boolean }> {
  if (registrationInFlight) return { state: 'running', started: false };

  // Own the whole read/ready/register decision. Two Owner requests arriving
  // before systemd has published the transient unit must not both observe an
  // idle lane and attempt registration.
  registrationInFlight = true;
  const execFileImpl = dependencies.execFileImpl || defaultExecFile;
  const readImageReadiness = () => imageReadiness(dependencies, execFileImpl);
  let logPath = '';
  let failedRetryAuthorized = false;
  try {
    const existingUnitState = await readUnitState(execFileImpl);
    if (existingUnitState === 'running') return { state: 'running', started: false };
    if (existingUnitState === 'failed' && dependencies.allowFailedRetry !== true) {
      throw new ProjectRuntimeImageRepairLaunchError(
        'The previous Project runtime image repair has failed. Refresh repair status before starting another repair.',
        409,
        'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY',
      );
    }
    failedRetryAuthorized = existingUnitState === 'failed';
    if (existingUnitState === 'unknown') {
      throw new ProjectRuntimeImageRepairLaunchError(
        'Portal could not verify whether a Project runtime image repair is already running. Check server maintenance, then retry.',
        409,
        'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY',
      );
    }

    // A failed unit remains authoritative even if its interrupted transaction
    // left a resolvable image behind. Route that state through the fixed-unit
    // reset/retry path below instead of declaring success prematurely.
    if (existingUnitState === 'idle') {
      const readiness = await readImageReadiness();
      if (readiness === 'ready') return { state: 'ready', started: false };
      if (readiness === 'unknown') {
        throw new ProjectRuntimeImageRepairLaunchError(
          'Portal could not verify Docker image state. Check server maintenance, then retry.',
          409,
          'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY',
        );
      }
    }

    logPath = dependencies.logPathFactory
      ? dependencies.logPathFactory()
      : prepareRepairLog(
          (dependencies.now || (() => new Date()))(),
          (dependencies.randomSuffix || (() => randomBytes(12).toString('hex')))(),
        );
    if (!/^\/opt\/bridgesllm\/logs\/project-runtime-image-repair-[A-Za-z0-9_.:-]+\.log$/.test(logPath)) {
      throw new Error('Project runtime repair log path is invalid');
    }
    const launchArgs = repairLaunchArgs(logPath);
    const launchOptions = {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    } as const;
    await execFileImpl(SYSTEMD_RUN, launchArgs, launchOptions);
    return { state: 'running', started: true };
  } catch (error) {
    if (error instanceof ProjectRuntimeImageRepairLaunchError) throw error;
    const unitState = await readUnitState(execFileImpl);
    if (unitState === 'running') {
      return { state: 'running', started: !unitAlreadyExists(error) };
    }
    if (unitState === 'failed' && failedRetryAuthorized && unitAlreadyExists(error)) {
      try {
        await execFileImpl(SYSTEMCTL, ['reset-failed', `${REPAIR_UNIT}.service`], {
          timeout: 5_000,
          maxBuffer: 16 * 1024,
          windowsHide: true,
        });
        await execFileImpl(SYSTEMD_RUN, repairLaunchArgs(logPath), {
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        });
        return { state: 'running', started: true };
      } catch {
        const retryState = await readUnitState(execFileImpl);
        if (retryState === 'running') return { state: 'running', started: true };
        if (retryState === 'idle') {
          const readiness = await readImageReadiness();
          if (readiness === 'ready') return { state: 'ready', started: true };
          if (readiness === 'unknown') {
            throw new ProjectRuntimeImageRepairLaunchError(
              'Portal could not verify whether the Project runtime image repair completed. Refresh repair status before retrying.',
              409,
              'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY',
            );
          }
        }
        if (retryState === 'failed' || retryState === 'unknown') {
          throw new ProjectRuntimeImageRepairLaunchError(
            'Portal could not confirm whether the Project runtime image repair completed registration. Refresh repair status before retrying.',
            409,
            'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY',
          );
        }
      }
    } else if (unitState === 'failed' || unitState === 'unknown') {
      throw new ProjectRuntimeImageRepairLaunchError(
        'Portal could not confirm whether the Project runtime image repair completed registration. Refresh repair status before retrying.',
        409,
        'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY',
      );
    }
    if (unitState === 'idle') {
      const readiness = await readImageReadiness();
      if (readiness === 'ready') return { state: 'ready', started: true };
      if (readiness === 'unknown') {
        throw new ProjectRuntimeImageRepairLaunchError(
          'Portal could not verify whether the Project runtime image repair completed. Refresh repair status before retrying.',
          409,
          'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY',
        );
      }
    }
    throw new ProjectRuntimeImageRepairLaunchError(
      'Portal could not start the Project runtime image repair. Check server maintenance logs before retrying.',
      500,
      'PROJECT_RUNTIME_IMAGE_REPAIR_LAUNCH_FAILED',
    );
  } finally {
    registrationInFlight = false;
  }
}

export function __resetProjectRuntimeImageRepairForTests(): void {
  registrationInFlight = false;
}

export const __projectRuntimeImageRepairTest = {
  REPAIR_UNIT,
  INSTALLED_REPAIR_SCRIPT,
  INSTALLED_REPAIR_LAUNCHER,
};
