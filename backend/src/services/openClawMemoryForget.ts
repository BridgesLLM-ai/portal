import { execFile } from 'child_process';
import { buildOpenClawCliEnv, extractJsonFromCliOutput } from '../utils/openclawCli';
import { openClawDiagnosticCommand } from '../utils/openclawDiagnosticLease';

/**
 * Result of `openclaw memory forget` for one retired session (DESIGN §e.3 H0).
 * Deleting a session does not remove memory derived from it; OpenClaw 9.9 and
 * 10.9 document `memory forget` as the way to remove indexed memories of
 * deleted sessions and exclude them from re-ingestion. It never reports
 * "complete deletion": OpenClaw documents that zero counts do not prove that
 * nothing related remains.
 */
export type OpenClawMemoryForgetOutcome = Readonly<{
  status: 'forgotten' | 'forgotten-residual' | 'failed' | 'unavailable';
  failedStep?: 'preview' | 'apply' | 'verify';
  detail?: string;
  previewArtifacts?: number;
  remainingArtifacts?: number;
}>;

export type OpenClawMemoryForgetTarget = Readonly<{
  agentId: string;
  sessionId: string;
  sessionKey: string;
}>;

export type OpenClawCliRunResult = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}>;

export type OpenClawCliRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<OpenClawCliRunResult>;

// Bounded so preview + apply + verify fit inside one renewed 5 min retirement lease.
const PREVIEW_TIMEOUT_MS = 45_000;
const APPLY_TIMEOUT_MS = 120_000;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
// A non-empty forget clears the agent's whole embedding cache, so this counter
// is agent-wide and says nothing about the selected sessions.
const AGENT_WIDE_COUNTERS = new Set(['embeddingCacheRows']);
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const MISSING_SUBCOMMAND = /unknown (?:command|option)/i;

function boundedDetail(value: unknown): string {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 240);
}

export const runOpenClawCli: OpenClawCliRunner = (args, timeoutMs) => new Promise((resolve) => {
  let command: [string, string[]];
  try {
    // Same quiesce lease and environment as every Portal OpenClaw CLI call:
    // refused (not queued) while installer maintenance holds the lease.
    command = openClawDiagnosticCommand('openclaw', args);
  } catch (error: any) {
    resolve({ exitCode: null, stdout: '', stderr: '', error: boundedDetail(error?.message || error) });
    return;
  }
  execFile(command[0], command[1], {
    encoding: 'utf8',
    env: buildOpenClawCliEnv(),
    timeout: timeoutMs,
    maxBuffer: MAX_REPORT_BYTES,
  }, (error, stdout, stderr) => {
    const code = (error as any)?.code;
    resolve({
      exitCode: error ? (typeof code === 'number' ? code : null) : 0,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
      ...(error ? { error: boundedDetail((error as any)?.message || error) } : {}),
    });
  });
});

function sessionArtifactCount(raw: string, agentId: string, dryRun: boolean): number | null {
  let report: any;
  try {
    report = JSON.parse(extractJsonFromCliOutput(raw));
  } catch {
    return null;
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  if (report.agentId !== agentId || report.dryRun !== dryRun) return null;
  const artifacts = report.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) return null;
  let total = 0;
  for (const [name, value] of Object.entries(artifacts)) {
    if (!Number.isSafeInteger(value) || (value as number) < 0) return null;
    if (!AGENT_WIDE_COUNTERS.has(name)) total += value as number;
  }
  return total;
}

function stepFailure(result: OpenClawCliRunResult, fallback: string): string {
  return boundedDetail(result.error || result.stderr || fallback) || fallback;
}

/**
 * Preview, apply, and re-preview `memory forget` for one session. Selectors
 * are the sealed transcript ID and the session key (the key also resolves
 * retained archives of earlier generations; an unresolved value is recorded
 * by OpenClaw as excluded). Never throws: a failure is reported as an
 * outcome so retirement can finish and show the failed sub-step.
 */
export async function forgetOpenClawSessionMemory(
  target: OpenClawMemoryForgetTarget,
  run: OpenClawCliRunner = runOpenClawCli,
): Promise<OpenClawMemoryForgetOutcome> {
  const agentId = String(target.agentId || '');
  const sessionId = String(target.sessionId || '');
  const sessionKey = String(target.sessionKey || '');
  if (
    !SAFE_AGENT_ID.test(agentId)
    || !SAFE_SESSION_ID.test(sessionId)
    || !sessionKey
    || sessionKey.startsWith('-')
    || sessionKey.length > 2048
    || /[\u0000-\u001f\u007f\s]/.test(sessionKey)
  ) {
    return { status: 'failed', failedStep: 'preview', detail: 'invalid session identity' };
  }
  const base = ['memory', 'forget', '--agent', agentId, '--session', sessionId, '--session', sessionKey];
  const invoke = async (dryRun: boolean) => {
    const result = await run(
      [...base, ...(dryRun ? ['--dry-run'] : []), '--json'],
      dryRun ? PREVIEW_TIMEOUT_MS : APPLY_TIMEOUT_MS,
    ).catch((error: any): OpenClawCliRunResult => ({
      exitCode: null,
      stdout: '',
      stderr: '',
      error: boundedDetail(error?.message || error),
    }));
    const count = result.exitCode === 0 ? sessionArtifactCount(result.stdout, agentId, dryRun) : null;
    return { result, count };
  };

  const preview = await invoke(true);
  if (preview.count === null) {
    if (preview.result.exitCode !== 0 && MISSING_SUBCOMMAND.test(preview.result.stderr)) {
      return { status: 'unavailable', detail: 'this OpenClaw has no memory forget command' };
    }
    return {
      status: 'failed',
      failedStep: 'preview',
      detail: stepFailure(preview.result, 'unrecognized memory forget report'),
    };
  }
  const apply = await invoke(false);
  if (apply.count === null) {
    return {
      status: 'failed',
      failedStep: 'apply',
      previewArtifacts: preview.count,
      detail: stepFailure(apply.result, 'unrecognized memory forget report'),
    };
  }
  const verify = await invoke(true);
  if (verify.count === null) {
    return {
      status: 'failed',
      failedStep: 'verify',
      previewArtifacts: preview.count,
      detail: stepFailure(verify.result, 'unrecognized memory forget report'),
    };
  }
  return {
    status: verify.count === 0 ? 'forgotten' : 'forgotten-residual',
    previewArtifacts: preview.count,
    remainingArtifacts: verify.count,
  };
}
