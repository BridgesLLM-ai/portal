import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { buildProjectDesktopRuntimeIdentity } from './projectDesktopRuntime';
import { readProjectTextFile } from './projectSurfacePolicy';

export interface DesktopJob {
  id: string; projectId: string; actorId: string; action: 'check' | 'deploy' | 'build' | 'resolve';
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  phase: string; startedAt: string; finishedAt: string | null; output: string;
  result?: Record<string, unknown>; error?: string;
}
export const DESKTOP_BUILD_JOB_ROOT = '/var/lib/bridgesllm/desktop-build-jobs';
export function createDesktopJobStore(root = DESKTOP_BUILD_JOB_ROOT) {
const ROOT = root;
const active = new Map<string, { record: DesktopJob; controller: AbortController; lastWrite: number }>();
function directory(projectId: string): string {
  buildProjectDesktopRuntimeIdentity(projectId, 'Project');
  return path.join(ROOT, projectId);
}
function save(record: DesktopJob): void {
  const dir = directory(record.projectId);
  for (const root of [ROOT, dir]) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root
      || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Desktop job store permissions are unsafe');
  }
  const temporary = path.join(dir, '.job-' + crypto.randomUUID());
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, path.join(dir, 'latest.json'));
    const directoryFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function readDesktopJob(projectId: string, id?: string): DesktopJob | null {
  const inFlight = active.get(projectId);
  if (inFlight) return !id || inFlight.record.id === id ? { ...inFlight.record } : null;
  const dir = directory(projectId);
  if (!fs.existsSync(dir)) return null;
  const text = readProjectTextFile(dir, 'latest.json', { optional: true, maxBytes: 128 * 1024 });
  if (!text) return null;
  const record = JSON.parse(text) as DesktopJob;
  if (record.projectId !== projectId || !/^[a-f0-9-]{36}$/.test(record.id) || !['check', 'deploy', 'build', 'resolve'].includes(record.action)) throw new Error('Desktop job identity is invalid');
  if (id && record.id !== id) return null;
  if (record.status === 'running') {
    // A prior process's receipt cannot prove that its worker or promotion finished.
    record.status = 'interrupted'; record.phase = 'Interrupted by Portal restart';
    record.finishedAt = new Date().toISOString(); record.error = 'Portal restarted before recording the outcome. Inspect Desktop status before retrying.';
    save(record);
  }
  return record;
}
function beginDesktopJob(input: { projectId: string; actorId: string; action: DesktopJob['action']; controller: AbortController }): DesktopJob {
  if (active.has(input.projectId)) throw new Error('This Project already has an active Desktop build');
  if (active.size >= 2) throw Object.assign(new Error('Two Desktop builds are already active. Retry after one finishes.'), { statusCode: 429 });
  const record: DesktopJob = { id: crypto.randomUUID(), projectId: input.projectId, actorId: input.actorId,
    action: input.action, status: 'running', phase: 'Preparing Desktop build', startedAt: new Date().toISOString(), finishedAt: null, output: '' };
  save(record); active.set(input.projectId, { record, controller: input.controller, lastWrite: Date.now() });
  return { ...record };
}
function updateDesktopJob(projectId: string, phase?: string, chunk?: string): void {
  const item = active.get(projectId); if (!item) return;
  if (phase) item.record.phase = phase;
  if (chunk) item.record.output = (item.record.output + chunk).slice(-24 * 1024);
  if (phase || Date.now() - item.lastWrite >= 1000) { save(item.record); item.lastWrite = Date.now(); }
}
function finishDesktopJob(projectId: string, result?: Record<string, unknown>, error?: unknown): void {
  const item = active.get(projectId); if (!item) throw new Error('Desktop build lost its active identity');
  const cancelled = item.controller.signal.aborted;
  item.record.status = error ? cancelled ? 'cancelled' : 'failed' : 'succeeded';
  item.record.phase = error ? cancelled ? 'Cancelled' : 'Failed' : 'Complete';
  item.record.finishedAt = new Date().toISOString();
  if (error) item.record.error = String(error instanceof Error ? error.message : error).slice(-24 * 1024);
  else item.record.result = result;
  try { save(item.record); } finally { active.delete(projectId); }
}
function cancelDesktopJob(projectId: string, id: string): boolean {
  const item = active.get(projectId);
  if (!item || item.record.id !== id) return false;
  item.controller.abort(); updateDesktopJob(projectId, 'Cancelling'); return true;
}

return { readDesktopJob, beginDesktopJob, updateDesktopJob, finishDesktopJob, cancelDesktopJob };
}
export const { readDesktopJob, beginDesktopJob, updateDesktopJob, finishDesktopJob, cancelDesktopJob } = createDesktopJobStore();
