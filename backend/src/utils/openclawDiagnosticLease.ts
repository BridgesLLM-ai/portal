import fs from 'fs';
import path from 'path';

// One stable inode, shared by Portal CLI readers and exclusively held by the
// installer before native maintenance. Never unlink it when releasing a lease.
export const OPENCLAW_DIAGNOSTIC_LOCK =
  '/var/lib/bridgesllm-installer/openclaw-diagnostic-readers.lock';
// Published by bridgesllm-toolctl for a whole OpenClaw core update (L3). It
// pauses diagnostics only; chat keeps running until the maintenance marker
// below marks the restart window (openClawExecutionAdmission.ts).
export const OPENCLAW_DIAGNOSTICS_QUIESCE_MARKER =
  '/var/lib/bridgesllm/tools/openclaw-diagnostics-quiesce.v1.json';
export const OPENCLAW_DIAGNOSTIC_BLOCKERS = Object.freeze([
  '/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1',
  OPENCLAW_DIAGNOSTICS_QUIESCE_MARKER,
  '/var/lib/bridgesllm-installer/openclaw-mutation-maintenance-v1.json',
  '/var/lib/bridgesllm-installer/openclaw-2026.9.1-migration-v2',
  '/var/lib/bridgesllm-installer/host-mutations/active-host-mutation.json',
  '/var/lib/bridgesllm-installer/host-mutations/npm-cli-v1/active.json',
  '/var/lib/bridgesllm-installer/host-mutations/native-binary-v1/active.json',
]);

export class OpenClawDiagnosticMaintenanceError extends Error {
  readonly code = 'OPENCLAW_DIAGNOSTICS_PAUSED';
  readonly statusCode = 503;
  constructor() {
    super('OpenClaw diagnostics are paused during maintenance or recovery.');
    this.name = 'OpenClawDiagnosticMaintenanceError';
  }
}

export function assertOpenClawDiagnosticsAdmitted(
  blockers: readonly string[] = OPENCLAW_DIAGNOSTIC_BLOCKERS,
): void {
  for (const blocker of blockers) {
    try {
      // lstat intentionally counts dangling links and malformed evidence as
      // blocked; a diagnostic must not interpret or repair recovery ownership.
      fs.lstatSync(blocker);
    } catch (error: any) {
      if (error?.code === 'ENOENT') continue;
      throw new OpenClawDiagnosticMaintenanceError();
    }
    throw new OpenClawDiagnosticMaintenanceError();
  }
}

export function isOpenClawDiagnosticsPausedError(error: unknown): boolean {
  return error instanceof OpenClawDiagnosticMaintenanceError
    || (error as any)?.code === 'OPENCLAW_DIAGNOSTICS_PAUSED';
}

/** The plain-words pause reason while maintenance holds diagnostics, else null. */
export function openClawDiagnosticsPausedReason(): string | null {
  try {
    assertOpenClawDiagnosticsAdmitted();
    return null;
  } catch (error) {
    if (isOpenClawDiagnosticsPausedError(error)) return (error as Error).message;
    throw error;
  }
}

export function openClawDiagnosticCommand(
  command: string,
  args: readonly string[],
): [string, string[]] {
  if (path.basename(command) !== 'openclaw') return [command, [...args]];
  assertOpenClawDiagnosticsAdmitted();
  // The lock lives outside user state. Reject an unsafe existing inode rather
  // than letting flock follow a link to a different lease domain.
  try {
    const lock = fs.lstatSync(OPENCLAW_DIAGNOSTIC_LOCK);
    if (!lock.isFile() || lock.isSymbolicLink() || lock.uid !== 0
      || lock.nlink !== 1 || (lock.mode & 0o022) !== 0) {
      throw new OpenClawDiagnosticMaintenanceError();
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw new OpenClawDiagnosticMaintenanceError();
  }
  // --no-fork makes the CLI itself own the lease, so timeout/exit releases it.
  // The exclusive installer lease closes the check-to-spawn race. Nonblocking
  // readers never queue behind maintenance and unexpectedly open databases later.
  return ['/usr/bin/flock', [
    '--shared', '--nonblock', '--no-fork', OPENCLAW_DIAGNOSTIC_LOCK, command, ...args,
  ]];
}
