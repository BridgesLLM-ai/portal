export const TRANSIENT_PROJECT_STATE_FILES = new Set([
  '.agent-session.json',
  '.assistant-session.json',
  '.marcus-session.json',
  '.agent-history.json',
  '.assistant-history.json',
  '.marcus-history.json',
  '.agent-memory.md',
  '.assistant-memory.md',
  '.marcus-memory.md',
  '.marcus-pending-commit',
]);

export function isTransientProjectStatePath(filePath: string): boolean {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return TRANSIENT_PROJECT_STATE_FILES.has(basename)
    || normalized === '.portal/attachments'
    || normalized.startsWith('.portal/attachments/');
}

export function projectGitAddAllArgs(): string[] {
  const exclusions = Array.from(TRANSIENT_PROJECT_STATE_FILES).flatMap((fileName) => [
    `:(exclude)${fileName}`,
    `:(glob,exclude)**/${fileName}`,
  ]);
  exclusions.push(':(exclude).portal/attachments', ':(glob,exclude).portal/attachments/**');
  return ['add', '-A', '--', '.', ...exclusions];
}

export async function shelveTransientProjectState(
  git: (args: string[]) => Promise<string>,
  transientPaths: string[],
  stashMessage = 'portal-transient-project-state',
): Promise<boolean> {
  const uniquePaths = Array.from(new Set(transientPaths.filter(isTransientProjectStatePath)));
  if (uniquePaths.length === 0) return false;
  // A failed shelf is a hard checkpoint failure. Continuing would allow the
  // later index operation to capture credentials, attachments, or agent state.
  await git(['stash', 'push', '-u', '-m', stashMessage, '--', ...uniquePaths]);
  return true;
}

export function assertNoTransientProjectStateStaged(stagedPaths: string[]): void {
  const transientPaths = Array.from(new Set(stagedPaths.filter(isTransientProjectStatePath)));
  if (transientPaths.length === 0) return;
  const preview = transientPaths.slice(0, 6).join(', ');
  const suffix = transientPaths.length > 6 ? ` (+${transientPaths.length - 6} more)` : '';
  throw new Error(`Transient Project state reached the Git index: ${preview}${suffix}`);
}

export interface ProjectCheckpointCommitResult {
  commit: {
    hash: string;
    message: string;
    filesChanged: number;
  } | null;
  attempts: number;
}

export interface ProjectCheckpointBoundaryResult<T extends ProjectCheckpointCommitResult> {
  checkpoint: T | null;
  checkpointError: unknown | null;
  noticePersisted: boolean;
}

/**
 * Runs the single server-owned post-turn checkpoint boundary.
 *
 * Checkpoint creation may retry internally before it returns. Notice
 * persistence is intentionally separate: losing a transcript notice must
 * never reinterpret a successful provider turn or a successful Git commit as
 * failed, and it must never invoke the commit boundary a second time.
 */
export async function runProjectCheckpointBoundary<T extends ProjectCheckpointCommitResult>(input: {
  createCheckpoint: () => Promise<T>;
  persistNotice: (content: string) => Promise<void>;
  successNotice: (checkpoint: T) => string;
  failureNotice: string;
  logError?: (message: string, error: unknown) => void;
}): Promise<ProjectCheckpointBoundaryResult<T>> {
  const logError = input.logError || (() => undefined);
  let checkpoint: T;
  try {
    checkpoint = await input.createCheckpoint();
  } catch (checkpointError) {
    logError('Project checkpoint failed after retry', checkpointError);
    let noticePersisted = false;
    try {
      await input.persistNotice(input.failureNotice);
      noticePersisted = true;
    } catch (noticeError) {
      logError('Project checkpoint failure notice could not be persisted', noticeError);
    }
    return { checkpoint: null, checkpointError, noticePersisted };
  }

  if (!checkpoint.commit) {
    return { checkpoint, checkpointError: null, noticePersisted: false };
  }

  let noticePersisted = false;
  try {
    await input.persistNotice(input.successNotice(checkpoint));
    noticePersisted = true;
  } catch (noticeError) {
    logError('Project checkpoint success notice could not be persisted', noticeError);
  }
  return { checkpoint, checkpointError: null, noticePersisted };
}
