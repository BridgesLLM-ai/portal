import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { desktopExecDetachedArgv, getDesktopEnvVars } from '../utils/desktopEnv';
import { buildProjectDesktopRuntimeIdentity, ensureSecureProjectDesktopRuntimeRoot, PROJECT_DESKTOP_RUNTIME_ROOT } from './projectDesktopRuntime';
import { readDesktopBuildReceipt, type DesktopBuildReceipt } from './projectDesktopBuild';
import { DESKTOP_ELECTRON_PARENT, DESKTOP_RUNTIME_PARENT, desktopElectronRoot } from './projectDesktopToolchain';
import { parseDesktopProjectDescriptor } from './projectDesktopContract';
import { readProjectTextFile } from './projectSurfacePolicy';

const exec = promisify(execFile);
export const DESKTOP_PROJECT_STATE_ROOT = '/var/lib/bridgesllm/desktop-project-state';
const GENERATION_RE = /^[a-f0-9-]{36}$/;
const activePromotions = new Set<string>();
const SYSTEM_ENV = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
export interface DesktopDeployment {
  version: 1; projectId: string; generation: string; previousGeneration: string | null;
  sourceDigest: string; sourceRevision?: string; builtAt: string; receipt: DesktopBuildReceipt;
}
export interface DesktopProcessState {
  status: 'running' | 'stopped' | 'completed' | 'error' | 'unknown';
  statusSource: 'desktop-unit'; exitCode: number | null; logs: string[]; lastError?: string;
}

/** Executed as bridgesrd with a clean environment by the existing systemd launcher. */
export const DESKTOP_CHILD_SUPERVISOR = String.raw`
const fs=require('fs'),cp=require('child_process');
const input=JSON.parse(Buffer.from(process.argv[1],'base64url').toString());
const env={...process.env,...input.environment};
let bytes=0,finished=false;
const log=fs.openSync(input.log,fs.constants.O_CREAT|fs.constants.O_WRONLY|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW,0o600);
function output(chunk,stream){stream.write(chunk);if(bytes<8*1024*1024){const value=Buffer.from(chunk).subarray(0,8*1024*1024-bytes);fs.writeSync(log,value);bytes+=value.length;}}
const child=cp.spawn(input.executable,input.args,{cwd:input.cwd,env,stdio:['inherit','pipe','pipe']});
child.stdout.on('data',value=>output(value,process.stdout));child.stderr.on('data',value=>output(value,process.stderr));
function finish(code,signal,error){
 if(finished)return;finished=true;fs.closeSync(log);
 const result={generation:input.generation,exitCode:code,signal,error:error||null,finishedAt:new Date().toISOString()};
 const fd=fs.openSync(input.exit,fs.constants.O_CREAT|fs.constants.O_WRONLY|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW,0o600);
 fs.writeFileSync(fd,JSON.stringify(result));fs.closeSync(fd);process.exit(Number.isInteger(code)?code:1);
}
child.once('error',error=>finish(126,null,error.message));child.once('exit',(code,signal)=>finish(code,signal));
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>{try{child.kill(signal)}catch{}});
`;

export class DesktopLaunchCancelledError extends Error {
  readonly code = 'DESKTOP_LAUNCH_CANCELLED';
  readonly statusCode = 403;
  constructor() { super('Desktop launch cancelled: authorization ended before the app started'); this.name = 'DesktopLaunchCancelledError'; }
}
/** Runs the bounded, synchronous host launch under the caller's durable authority. */
export type DesktopDispatchGate = (launch: () => void) => Promise<void>;
/** Authority can end during any await; callers re-check at every launch boundary. */
function assertLaunchAuthorized(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DesktopLaunchCancelledError();
}

function stateDirectory(projectId: string): string {
  buildProjectDesktopRuntimeIdentity(projectId, 'Project');
  return path.join(DESKTOP_PROJECT_STATE_ROOT, projectId);
}
function safeDirectory(directory: string, mode: number, owner?: { uid: number; gid: number }): void {
  fs.mkdirSync(directory, { recursive: true, mode });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('Desktop storage is not a real managed directory');
  if (owner) fs.chownSync(directory, owner.uid, owner.gid);
  else if (process.getuid?.() === 0) fs.chownSync(directory, 0, 0);
  fs.chmodSync(directory, mode);
}
async function desktopAccount(): Promise<{ uid: number; gid: number }> {
  const [user, group] = await Promise.all([
    exec('/usr/bin/id', ['-u', 'bridgesrd'], { env: SYSTEM_ENV }),
    exec('/usr/bin/id', ['-g', 'bridgesrd'], { env: SYSTEM_ENV }),
  ]);
  const uid = Number(user.stdout.trim()), gid = Number(group.stdout.trim());
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) throw new Error('Remote Desktop user is unavailable');
  return { uid, gid };
}

/**
 * Desktop code, logs and data live below the private, root-only state parent
 * (`/var/lib/bridgesllm`, 0700). The app runs as the Remote Desktop account, so
 * that account alone gets execute-only (search, never list) access to the
 * parent through a named ACL entry. The grant is refused while any other child
 * of the parent would become reachable by the account, so no private sibling is
 * widened; control records inside the Desktop roots stay 0600 root.
 */
// Root-owned launcher metadata the Remote Desktop account already reads by design
// (bridges-rd-ai-launchers.sh writes a 0644 manifest in a 0755 directory; secrets
// stay under /run). Every other child of the parent must stay private.
const DESKTOP_ACCOUNT_SHARED_SIBLINGS = new Set(['remote-desktop-ai-launchers']);
export async function ensureDesktopAccountTraversal(account: { uid: number; gid: number; groups?: readonly number[] },
  parents: ReadonlyArray<{ parent: string; desktopRoots: readonly string[] }> = desktopStateParents()): Promise<void> {
  // systemd starts the app with the account's supplementary groups as well.
  const groups = account.groups ?? (await exec('/usr/bin/id', ['-G', String(account.uid)], { env: SYSTEM_ENV, timeout: 5_000 })).stdout.trim().split(/\s+/).map(Number);
  if (!groups.length || groups.some(id => !Number.isSafeInteger(id) || id < 0)) throw new Error('Desktop account groups are unavailable');
  for (const { parent, desktopRoots } of parents) {
    const info = fs.lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw new Error('Desktop state parent is not a root-owned directory');
    if (info.mode & 0o001) continue; // Already traversable by every account; nothing to grant.
    const siblings = fs.readdirSync(parent).filter(name => !desktopRoots.includes(name));
    const exposed = siblings.filter((name) => {
      const child = fs.lstatSync(path.join(parent, name));
      if (DESKTOP_ACCOUNT_SHARED_SIBLINGS.has(name) && child.isDirectory() && child.uid === 0 && !(child.mode & 0o022)) return false;
      return child.uid === account.uid || (child.mode & 0o007) !== 0 || ((groups.includes(child.gid) || child.gid === account.gid) && (child.mode & 0o070) !== 0);
    });
    // Mode bits cannot show named ACL grants: any sibling with an extended ACL is refused.
    if (siblings.length) {
      const extended = (await exec('/usr/bin/getfacl', ['-spnE', '--', ...siblings.map(name => path.join(parent, name))], { env: SYSTEM_ENV, timeout: 5_000 })).stdout;
      for (const line of extended.split('\n')) if (line.startsWith('# file: ')) exposed.push(path.basename(line.slice(8)));
    }
    if (exposed.length) {
      throw new Error('Desktop apps cannot reach their files: granting the Desktop account search access to ' + parent
        + ' would also expose ' + exposed.slice(0, 5).join(', ') + '. Make those entries private (0700), then retry.');
    }
    // Never re-mask unrelated entries: only the base entries, the mask and this
    // account's own entry may exist. The mask keeps the owning group's effective
    // permissions and adds only search for the named Desktop account.
    const acl = (await exec('/usr/bin/getfacl', ['-cpnE', parent], { env: SYSTEM_ENV, timeout: 5_000 })).stdout.trim().split('\n').filter(Boolean);
    const own = `user:${account.uid}:`;
    if (acl.some(line => !/^(user|group|other)::[r-][w-][x-]$/.test(line) && !/^mask::[r-][w-][x-]$/.test(line) && !line.startsWith(own))) {
      throw new Error('Desktop state parent ' + parent + ' has other access-control entries; refusing to change its mask');
    }
    const group = (acl.find(line => line.startsWith('group::')) || 'group::---').slice(7);
    const oldMask = acl.find(line => line.startsWith('mask::'))?.slice(6);
    // A mask that currently hides owning-group bits must not be widened back.
    if (oldMask && [...group].some((bit, index) => bit !== '-' && oldMask[index] === '-')) {
      throw new Error('Desktop state parent ' + parent + ' masks its owning group; refusing to change its mask');
    }
    const mask = (group[0] === 'r' ? 'r' : '-') + '-x';
    if (acl.includes(own + '--x') && acl.includes('mask::' + mask)) continue;
    await exec('/usr/bin/setfacl', ['-n', '-m', `u:${account.uid}:--x,m::${mask}`, parent], { env: SYSTEM_ENV, timeout: 5_000 });
  }
}
function desktopStateParents(): Array<{ parent: string; desktopRoots: string[] }> {
  const groups = new Map<string, string[]>();
  for (const root of [PROJECT_DESKTOP_RUNTIME_ROOT, DESKTOP_PROJECT_STATE_ROOT]) {
    groups.set(path.dirname(root), [...(groups.get(path.dirname(root)) || []), path.basename(root)]);
  }
  return [...groups].map(([parent, desktopRoots]) => ({ parent, desktopRoots }));
}

export function readDesktopDeployment(projectId: string): DesktopDeployment | null {
  const root = buildProjectDesktopRuntimeIdentity(projectId, 'Project').runtimeDir;
  if (!fs.existsSync(root)) return null;
  const text = readProjectTextFile(root, 'deployment.json', { optional: true, maxBytes: 32 * 1024 });
  if (!text) return null;
  const value = JSON.parse(text) as DesktopDeployment;
  if (value.version !== 1 || value.projectId !== projectId || !GENERATION_RE.test(value.generation)
    || (value.previousGeneration !== null && !GENERATION_RE.test(value.previousGeneration))
    || !/^[a-f0-9]{64}$/.test(value.sourceDigest)
    || (value.sourceRevision !== undefined && !/^[a-f0-9]{64}$/.test(value.sourceRevision))) throw new Error('Desktop deployment identity is invalid');
  const generation = path.join(root, 'generations', value.generation);
  value.receipt = readDesktopBuildReceipt(generation, parseDesktopProjectDescriptor(value.receipt.descriptor));
  return value;
}

async function unitProperties(projectId: string): Promise<Record<string, string>> {
  const unit = buildProjectDesktopRuntimeIdentity(projectId, 'Project').systemdUnit;
  const result = await exec('/usr/bin/systemctl', ['show', unit, '--property=LoadState,ActiveState,SubState,ExecMainStatus,MainPID'], { env: SYSTEM_ENV, timeout: 5_000 });
  return Object.fromEntries(result.stdout.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
}

export async function desktopProcessStatus(projectId: string, includeLogs = false): Promise<DesktopProcessState> {
  if (hasInterruptedPromotion(projectId)) return { status: 'unknown', statusSource: 'desktop-unit', exitCode: null, logs: [], lastError: 'A Desktop promotion was interrupted. Start or rebuild to restore the retained generation.' };
  const deployment = readDesktopDeployment(projectId);
  if (!deployment) return { status: 'unknown', statusSource: 'desktop-unit', exitCode: null, logs: [], lastError: 'This legacy Desktop deployment needs one rebuild before managed controls are available.' };
  let properties: Record<string, string>;
  try { properties = await unitProperties(projectId); }
  catch { return { status: 'unknown', statusSource: 'desktop-unit', exitCode: null, logs: [], lastError: 'Could not read the managed Desktop unit' }; }
  const state = stateDirectory(projectId);
  let exit: any = null;
  try {
    const text = readProjectTextFile(state, 'logs/exit.json', { optional: true, maxBytes: 8 * 1024 });
    if (text) { const candidate = JSON.parse(text); if (candidate.generation === deployment.generation) exit = candidate; }
  } catch { /* Missing/malformed exit evidence never establishes a successful exit. */ }
  let logs: string[] = [];
  if (includeLogs) {
    try { logs = (readProjectTextFile(state, 'logs/output.log', { optional: true, maxBytes: 8 * 1024 * 1024 }) || '').split('\n').slice(-300); }
    catch { logs = ['Log file is unavailable or exceeds its limit.']; }
  }
  const running = ['active', 'activating'].includes(properties.ActiveState) && Number(properties.MainPID) > 0;
  const stopped = fs.existsSync(path.join(state, 'stopped'));
  const exitCode = Number.isInteger(exit?.exitCode) ? exit.exitCode : null;
  return { status: running ? 'running' : stopped || ['SIGTERM', 'SIGHUP', 'SIGINT'].includes(exit?.signal) ? 'stopped' : exit ? exitCode === 0 ? 'completed' : 'error' : 'unknown',
    statusSource: 'desktop-unit', exitCode, logs, ...(exit?.error ? { lastError: String(exit.error).slice(0, 2000) } : {}) };
}

export async function stopDesktopProject(projectId: string): Promise<void> {
  const identity = buildProjectDesktopRuntimeIdentity(projectId, 'Project');
  const properties = await unitProperties(projectId);
  if (properties.LoadState !== 'not-found') {
    await exec('/usr/bin/systemctl', ['stop', identity.systemdUnit], { env: SYSTEM_ENV, timeout: 20_000 });
    const stopped = await unitProperties(projectId);
    if (['active', 'activating', 'deactivating'].includes(stopped.ActiveState) || Number(stopped.MainPID) > 0) throw new Error('Desktop unit did not stop');
  }
  const directory = stateDirectory(projectId);
  safeDirectory(DESKTOP_PROJECT_STATE_ROOT, 0o755); safeDirectory(directory, 0o755);
  fs.writeFileSync(path.join(directory, 'stopped'), '', { mode: 0o600, flag: 'w' });
}

export async function focusDesktopProject(projectId: string, signal?: AbortSignal): Promise<boolean> {
  const unit = buildProjectDesktopRuntimeIdentity(projectId, 'Project').systemdUnit;
  const group = '/sys/fs/cgroup/system.slice/' + unit + '/cgroup.procs';
  let pids: string[];
  try { pids = (await fs.promises.readFile(group, 'utf8')).trim().split(/\s+/); }
  catch { return false; }
  if (pids.length > 128 || pids.some(pid => !/^[1-9][0-9]*$/.test(pid))) return false;
  const environment = { ...SYSTEM_ENV, ...getDesktopEnvVars() };
  const windows = await Promise.all(pids.map(async pid => {
    try { const result = await exec('/usr/bin/xdotool', ['search', '--onlyvisible', '--pid', pid], { env: environment, timeout: 1500, maxBuffer: 4096 });
      return result.stdout.trim().split(/\s+/).filter(id => /^[1-9][0-9]*$/.test(id)); }
    catch { return []; }
  }));
  const selected = windows.flat().pop(); if (!selected) return false;
  if (signal?.aborted) return false;
  try { await exec('/usr/bin/xdotool', ['windowactivate', '--sync', selected], { env: environment, timeout: 1500 }); return true; }
  catch { return false; }
}

/** `signal` carries the caller's authority: it is checked after every await and
 * immediately before the host launch, so a revoked session never starts code. */
export async function startDesktopProject(projectId: string, projectName: string, options: { signal?: AbortSignal; dispatch?: DesktopDispatchGate } = {}): Promise<DesktopProcessState> {
  const { signal, dispatch } = options;
  assertLaunchAuthorized(signal);
  if (hasInterruptedPromotion(projectId)) await recoverInterruptedPromotion(projectId);
  assertLaunchAuthorized(signal);
  const deployment = readDesktopDeployment(projectId);
  if (!deployment) throw new Error('Rebuild this Desktop Project before starting it');
  const existing = await desktopProcessStatus(projectId);
  assertLaunchAuthorized(signal);
  if (existing.status === 'running') { await focusDesktopProject(projectId, signal); return existing; }
  const identity = buildProjectDesktopRuntimeIdentity(projectId, projectName);
  const generation = path.join(identity.runtimeDir, 'generations', deployment.generation);
  const state = stateDirectory(projectId), account = await desktopAccount();
  await ensureDesktopAccountTraversal(account);
  assertLaunchAuthorized(signal);
  safeDirectory(DESKTOP_PROJECT_STATE_ROOT, 0o755); safeDirectory(state, 0o755);
  safeDirectory(path.join(state, 'data'), 0o700, account); safeDirectory(path.join(state, 'logs'), 0o700, account);
  for (const file of ['stopped', 'logs/exit.json']) {
    const target = path.join(state, file);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  const receipt = deployment.receipt;
  const environment: Record<string, string> = { BRIDGESLLM_APP_DATA: path.join(state, 'data'), LIBGL_ALWAYS_SOFTWARE: '1' };
  if (receipt.libraryPath) environment.LD_LIBRARY_PATH = path.join(generation, receipt.libraryPath);
  if (receipt.qtPluginPath) { environment.QT_QPA_PLATFORM_PLUGIN_PATH = path.join(generation, receipt.qtPluginPath); environment.QT_QPA_PLATFORM = 'xcb'; }
  let executable = receipt.node ? path.join(generation, '.desktop-out/node') : path.join(generation, receipt.executable);
  let args = receipt.node ? [receipt.executable, ...receipt.args] : receipt.args;
  if (receipt.runtime === 'electron-44.9.0') {
    const electronRoot = desktopElectronRoot();
    executable = path.join(electronRoot, 'electron');
    // The installer admits this root-owned runtime (and, where the host restricts
    // user namespaces, a path-scoped profile). Never setuid/chmod a Project
    // artifact or fall back to --no-sandbox.
    for (const target of [DESKTOP_RUNTIME_PARENT, DESKTOP_ELECTRON_PARENT, electronRoot, executable]) {
      const stat = fs.lstatSync(target);
      if (stat.uid !== 0 || (stat.mode & 0o022) || stat.isSymbolicLink()) throw new Error('Desktop Electron runtime is not securely installed');
      if ((stat.mode & 0o005) !== 0o005) throw new Error('The installed Desktop runtime is not accessible to the Desktop account. An administrator can repair it with install.sh --install-desktop-toolchain.');
    }
    environment.LD_LIBRARY_PATH = path.join(electronRoot, 'lib');
    environment.GIO_MODULE_DIR = path.join(electronRoot, 'gio-modules');
    environment.GSETTINGS_BACKEND = 'memory';
    environment.GTK_IM_MODULE = 'gtk-im-context-simple';
    args = ['--disable-setuid-sandbox', path.join(generation, receipt.executable)];
  }
  const payload = Buffer.from(JSON.stringify({
    generation: deployment.generation, cwd: generation,
    executable, args,
    environment, log: path.join(state, 'logs/output.log'), exit: path.join(state, 'logs/exit.json'),
  })).toString('base64url');
  const launch = () => {
    // Host-launch boundary: no await separates this check from the launch below.
    assertLaunchAuthorized(signal);
    if (receipt.descriptor.interface === 'terminal') {
      desktopExecDetachedArgv('/usr/bin/xterm', ['-name', identity.processMarker, '-title', identity.windowTitle,
        '-fa', 'Monospace', '-fs', '12', '-e', process.execPath, '-e', DESKTOP_CHILD_SUPERVISOR, payload], identity.systemdUnit);
    } else {
      desktopExecDetachedArgv(process.execPath, ['-e', DESKTOP_CHILD_SUPERVISOR, payload], identity.systemdUnit);
    }
  };
  assertLaunchAuthorized(signal);
  // All async preparation is done; the gate commits only the synchronous launch.
  if (dispatch) await dispatch(launch); else launch();
  // Bounded startup observation; a naturally completed terminal is not an error.
  await new Promise(resolve => setTimeout(resolve, 750));
  const status = await desktopProcessStatus(projectId, true);
  if (status.status === 'error' || status.status === 'unknown') throw new Error(status.lastError || status.logs.slice(-10).join('\n') || 'Desktop process did not start');
  return status;
}

/** Copy a completed, quiescent build only. Generated code is read-only to the desktop user.
 * Dependency symlinks are retained only when their complete target stays in the build. */
export async function copyDesktopBuildGeneration(source: string, destination: string, signal?: AbortSignal): Promise<string> {
  const omitted = new Set(['.git', '.venv', 'target', 'build', '.portal-build-cache', 'deployment.json']);
  const hash = crypto.createHash('sha256');
  let count = 0, bytes = 0;
  if (await fs.promises.realpath(source) !== source) throw new Error('Build root must be canonical');
  const visit = async (relative: string): Promise<void> => {
    const entries = await fs.promises.readdir(path.join(source, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (signal?.aborted) throw new Error('Desktop promotion cancelled');
      if (!relative && omitted.has(entry.name)) continue;
      if (++count > 100_000 || relative.split('/').length > 40) throw new Error('Desktop artifact inventory exceeds its limit');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const from = path.join(source, name), to = path.join(destination, name);
      if (entry.isSymbolicLink()) {
        const link = await fs.promises.readlink(from), target = await fs.promises.realpath(from);
        if (path.isAbsolute(link) || !target.startsWith(source + path.sep)
          || omitted.has(path.relative(source, target).split(path.sep)[0])) throw new Error('Build contains an escaping dependency link');
        hash.update(name + '\0link\0' + link); await fs.promises.symlink(link, to);
      } else if (entry.isDirectory()) { await fs.promises.mkdir(to, { mode: 0o755 }); await visit(name); }
      else if (entry.isFile()) {
        const stat = await fs.promises.lstat(from), mode = stat.mode & 0o111 ? 0o755 : 0o644;
        bytes += stat.size;
        if (stat.size > 512 * 1024 * 1024 || bytes > 2 * 1024 * 1024 * 1024) throw new Error('Desktop build exceeds the 2 GiB artifact limit');
        hash.update(name + '\0file\0' + mode + '\0');
        const handle = await fs.promises.open(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const output = await fs.promises.open(to, 'wx', mode);
        try {
          const buffer = Buffer.allocUnsafe(256 * 1024); let offset = 0;
          for (;;) {
            if (signal?.aborted) throw new Error('Desktop promotion cancelled');
            const read = await handle.read(buffer, 0, buffer.length, offset); if (!read.bytesRead) break;
            offset += read.bytesRead; if (offset > stat.size) throw new Error('Desktop artifact changed during promotion');
            const chunk = buffer.subarray(0, read.bytesRead); hash.update(chunk); await output.writeFile(chunk);
          }
          if (offset !== stat.size) throw new Error('Desktop artifact changed during promotion');
        } finally { await handle.close(); await output.close(); }
      } else throw new Error('Build contains a non-regular artifact');
    }
  };
  await fs.promises.mkdir(destination, { mode: 0o755 }); await visit(''); return hash.digest('hex');
}

function saveDeployment(root: string, deployment: DesktopDeployment): void {
  const temporary = path.join(root, '.deployment-' + crypto.randomUUID());
  fs.writeFileSync(temporary, JSON.stringify(deployment) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, path.join(root, 'deployment.json'));
}

interface PromotionJournal {
  version: 1; projectId: string; generation: string; previous: DesktopDeployment | null;
  legacyPreserved: string | null; previousRunning: boolean;
}
function journalPath(projectId: string): string { return path.join(stateDirectory(projectId), 'promotion.json'); }
function hasInterruptedPromotion(projectId: string): boolean {
  return !activePromotions.has(projectId) && fs.existsSync(journalPath(projectId));
}
function savePromotionJournal(journal: PromotionJournal): void {
  const target = journalPath(journal.projectId), temporary = target + '.' + crypto.randomUUID();
  fs.writeFileSync(temporary, JSON.stringify(journal), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, target);
}
/** Recovery never re-executes unknown legacy commands or auto-starts after a crash.
 * It preserves all user state and rolls code back before the next authorized mutation. */
async function recoverInterruptedPromotion(projectId: string): Promise<void> {
  const raw = readProjectTextFile(stateDirectory(projectId), 'promotion.json', { maxBytes: 64 * 1024 });
  const journal = JSON.parse(raw || '') as PromotionJournal;
  if (journal.version !== 1 || journal.projectId !== projectId || !GENERATION_RE.test(journal.generation)
    || (journal.legacyPreserved !== null && journal.legacyPreserved !== 'legacy-' + journal.generation)
    || (journal.previous && (journal.previous.projectId !== projectId || !GENERATION_RE.test(journal.previous.generation)))) {
    throw new Error('Interrupted Desktop promotion record requires administrator repair');
  }
  await stopDesktopProject(projectId);
  const root = buildProjectDesktopRuntimeIdentity(projectId, 'Project').runtimeDir;
  if (journal.legacyPreserved) {
    const preserved = path.join(stateDirectory(projectId), journal.legacyPreserved);
    if (fs.existsSync(preserved)) {
      // Keep the failed new code as bounded evidence until the next successful build.
      if (fs.existsSync(root)) fs.renameSync(root, path.join(stateDirectory(projectId), 'failed-' + journal.generation));
      fs.renameSync(preserved, root);
    }
  } else if (journal.previous) saveDeployment(root, journal.previous);
  else if (fs.existsSync(path.join(root, 'deployment.json'))) fs.unlinkSync(path.join(root, 'deployment.json'));
  const failed = path.join(root, 'generations', journal.generation);
  if (fs.existsSync(failed)) await fs.promises.rm(failed, { recursive: true, force: true });
  fs.unlinkSync(journalPath(projectId));
}

export async function promoteDesktopBuild(input: {
  projectId: string; projectName: string; workspace: string; receipt: DesktopBuildReceipt; sourceRevision?: string; signal?: AbortSignal;
  /** Durable-authority gate for every host launch this promotion makes, including rollback. */
  dispatch?: DesktopDispatchGate;
  beforePromotion(): Promise<void>;
  persist(deployment: DesktopDeployment, status: DesktopProcessState): Promise<void>;
}): Promise<{ deployment: DesktopDeployment; status: DesktopProcessState }> {
  const identity = buildProjectDesktopRuntimeIdentity(input.projectId, input.projectName);
  ensureSecureProjectDesktopRuntimeRoot();
  if (hasInterruptedPromotion(input.projectId)) await recoverInterruptedPromotion(input.projectId);
  const previous = readDesktopDeployment(input.projectId);
  const legacy = fs.existsSync(identity.runtimeDir) && !previous
    && !fs.existsSync(path.join(identity.runtimeDir, 'generations'));
  const generation = crypto.randomUUID(), staging = path.join(PROJECT_DESKTOP_RUNTIME_ROOT, '.stage-' + generation);
  const wasRunning = Boolean(previous && (await desktopProcessStatus(input.projectId)).status === 'running');
  let journaled = false, committed = false;
  try {
    const sourceDigest = await copyDesktopBuildGeneration(input.workspace, staging, input.signal);
    readDesktopBuildReceipt(staging, input.receipt.descriptor);
    await input.beforePromotion();
    if (input.signal?.aborted) throw new Error('Desktop promotion cancelled');
    safeDirectory(DESKTOP_PROJECT_STATE_ROOT, 0o755); safeDirectory(stateDirectory(input.projectId), 0o755);
    activePromotions.add(input.projectId);
    savePromotionJournal({ version: 1, projectId: input.projectId, generation, previous,
      legacyPreserved: legacy ? 'legacy-' + generation : null, previousRunning: wasRunning });
    journaled = true;
    await stopDesktopProject(input.projectId);
    // Authority may end while the old unit stops; roll back before any launch.
    assertLaunchAuthorized(input.signal);
    if (legacy) fs.renameSync(identity.runtimeDir, path.join(stateDirectory(input.projectId), 'legacy-' + generation));
    safeDirectory(identity.runtimeDir, 0o755); safeDirectory(path.join(identity.runtimeDir, 'generations'), 0o755);
    fs.renameSync(staging, path.join(identity.runtimeDir, 'generations', generation));
    const deployment: DesktopDeployment = { version: 1, projectId: input.projectId, generation,
      previousGeneration: previous?.generation || null, sourceDigest, ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}), builtAt: new Date().toISOString(), receipt: input.receipt };
    saveDeployment(identity.runtimeDir, deployment);
    const status = await startDesktopProject(input.projectId, input.projectName, { signal: input.signal, dispatch: input.dispatch });
    if (input.signal?.aborted) throw new Error('Desktop promotion cancelled');
    await input.persist(deployment, status);
    fs.unlinkSync(journalPath(input.projectId)); journaled = false; committed = true;
    if (previous?.previousGeneration && previous.previousGeneration !== previous.generation) {
      await fs.promises.rm(path.join(identity.runtimeDir, 'generations', previous.previousGeneration), { recursive: true, force: true })
        .catch(error => console.warn('Desktop old-generation cleanup deferred:', error.code));
    }
    return { deployment, status };
  } catch (error: any) {
    let restored = !journaled && Boolean(previous || legacy);
    if (journaled && !committed) {
      try {
        await recoverInterruptedPromotion(input.projectId); journaled = false; restored = Boolean(previous || legacy);
        // Restore the previous app only for a still-authorized caller; a revoked
        // session keeps the previous code and data but never restarts anything.
        if (previous && wasRunning && !input.signal?.aborted) {
          await startDesktopProject(input.projectId, input.projectName, { signal: input.signal, dispatch: input.dispatch }).catch((restartError) => {
            if (!(restartError instanceof DesktopLaunchCancelledError)) throw restartError;
          });
        }
      } catch (recoveryError: any) {
        throw Object.assign(new Error(error.message + '; retained generation requires recovery: ' + recoveryError.message),
          { previousDeploymentRetained: false, recoveryRequired: true });
      }
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { previousDeploymentRetained: restored });
  } finally {
    activePromotions.delete(input.projectId);
    if (fs.existsSync(staging)) await fs.promises.rm(staging, { recursive: true, force: true });
  }
}
