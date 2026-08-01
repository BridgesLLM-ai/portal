import crypto from 'crypto';
import path from 'path';
import type { NativeCliInvocation } from '../types';
import type { ProjectEgressCommandExecutor } from '../../../../services/projectEgressPlane';

const PRODUCTION_MARKER_ROOT = '/run';
const RUN_TOKEN_BYTES = 32;
const RUN_MARKER_SCHEMA = 1;

export interface ExactNativeCliProjectRuntimeHandle {
  readonly containerId: string;
  readonly startedAt: string;
}

export interface ExactNativeCliProjectRunIdentity {
  readonly markerPath: string;
  readonly runHash: string;
  readonly runToken: string;
}

export interface BuildExactNativeCliProjectInvocationInput {
  readonly runtime: ExactNativeCliProjectRuntimeHandle;
  readonly containerUser: string;
  readonly containerRoot: string;
  readonly markerNamespace: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly runId: string;
  readonly executor: ProjectEgressCommandExecutor;
  readonly hostCwd?: string;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly containerEnvironment?: Readonly<Record<string, string>>;
}

interface ExactRuntimeInspect {
  Id?: string;
  State?: {
    Running?: boolean;
    StartedAt?: string;
  };
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requiredRunId(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('Native CLI Project run identity is invalid');
  }
  return normalized;
}

function requiredNamespace(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(normalized)) {
    throw new Error('Native CLI Project run namespace is invalid');
  }
  return normalized;
}

function assertRuntime(runtime: ExactNativeCliProjectRuntimeHandle): void {
  if (!/^[a-f0-9]{64}$/i.test(String(runtime.containerId || ''))) {
    throw new Error('Native CLI Project runtime ID is invalid at run-control boundary');
  }
  if (!String(runtime.startedAt || '').trim() || /[\u0000\r\n]/.test(runtime.startedAt)) {
    throw new Error('Native CLI Project runtime start identity is invalid');
  }
}

function assertControlTarget(input: {
  containerUser: string;
  containerRoot: string;
  identity?: ExactNativeCliProjectRunIdentity;
}): void {
  if (!/^\d+:\d+$/.test(input.containerUser)) {
    throw new Error('Native CLI Project run-control user is invalid');
  }
  if (!path.posix.isAbsolute(input.containerRoot) || /[\u0000\r\n]/.test(input.containerRoot)) {
    throw new Error('Native CLI Project run-control root is invalid');
  }
  if (input.identity) {
    const { markerPath, runHash, runToken } = input.identity;
    if (
      !/^\/run\/portal-project-run-[a-z0-9][a-z0-9-]{0,31}-[a-f0-9]{32}\.json$/.test(markerPath)
      || !/^[a-f0-9]{64}$/.test(runHash)
      || !/^[a-f0-9]{64}$/.test(runToken)
      || !markerPath.endsWith(`-${runHash.slice(0, 32)}.json`)
    ) {
      throw new Error('Native CLI Project run-control abort identity is invalid');
    }
  }
}

function assertInvocationInput(input: BuildExactNativeCliProjectInvocationInput): void {
  assertRuntime(input.runtime);
  if (!/^\d+:\d+$/.test(input.containerUser)) {
    throw new Error('Native CLI Project container user is invalid');
  }
  if (!path.posix.isAbsolute(input.containerRoot) || /[\u0000\r\n]/.test(input.containerRoot)) {
    throw new Error('Native CLI Project container root is invalid');
  }
  if (!path.posix.isAbsolute(input.command) || /[\u0000\r\n]/.test(input.command)) {
    throw new Error('Native CLI Project command is invalid');
  }
  if (input.args.length > 512 || input.args.some((entry) => /[\u0000]/.test(entry))) {
    throw new Error('Native CLI Project invocation arguments are invalid');
  }
  for (const [key, value] of Object.entries(input.containerEnvironment || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\u0000\r\n]/.test(value)) {
      throw new Error('Native CLI Project container environment is invalid');
    }
  }
}

function markerIdentity(markerRoot: string, namespace: string, runId: string): ExactNativeCliProjectRunIdentity {
  const runHash = stableHash({ namespace, runId });
  return Object.freeze({
    markerPath: path.posix.join(markerRoot, `portal-project-run-${namespace}-${runHash.slice(0, 32)}.json`),
    runHash,
    runToken: crypto.randomBytes(RUN_TOKEN_BYTES).toString('hex'),
  });
}

function renderTurnWrapperScript(markerRoot: string): string {
  return String.raw`
const fs = require('fs');
const { spawn } = require('child_process');
const MARKER_ROOT = ${JSON.stringify(markerRoot)};
const SCHEMA = ${RUN_MARKER_SCHEMA};
const [markerPath, runHash, runToken, command, ...args] = process.argv.slice(1);
const markerPattern = new RegExp('^' + MARKER_ROOT.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&') + '/portal-project-run-[a-z0-9][a-z0-9-]{0,31}-[a-f0-9]{32}\\.json$');
if (!markerPattern.test(markerPath || '') || !/^[a-f0-9]{64}$/.test(runHash || '') || !/^[a-f0-9]{64}$/.test(runToken || '') || !/^\/[^\0\r\n]+$/.test(command || '') || args.some((entry) => /\0/.test(entry))) process.exit(125);
if (!markerPath.endsWith('-' + runHash.slice(0, 32) + '.json')) process.exit(125);

const markerMatches = (value) => value && value.schema === SCHEMA && value.runHash === runHash && value.runToken === runToken;
const readMarker = () => {
  try {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch { return null; }
};
const unlinkExact = () => {
  const current = readMarker();
  if (markerMatches(current)) { try { fs.unlinkSync(markerPath); } catch {} }
};
const writeMarker = (value, flag = 'w') => {
  const serialized = JSON.stringify(value) + '\n';
  if (flag === 'wx') {
    fs.writeFileSync(markerPath, serialized, { encoding: 'utf8', mode: 0o600, flag });
    return;
  }
  if (!markerMatches(readMarker())) throw new Error('run marker identity changed');
  const temporary = markerPath + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, markerPath);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
};
const procIdentity = (pid) => {
  try {
    const value = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const close = value.lastIndexOf(')');
    const fields = close > 0 ? value.slice(close + 2).trim().split(/\s+/) : [];
    return { state: String(fields[0] || ''), pgid: Number(fields[2]), startTime: String(fields[19] || '') };
  } catch { return { state: '', pgid: 0, startTime: '' }; }
};
const procStartTime = (pid) => procIdentity(pid).startTime;
const groupAlive = (pgid) => {
  try { process.kill(-pgid, 0); }
  catch (error) { if (error && error.code === 'ESRCH') return false; throw error; }
  try {
    return fs.readdirSync('/proc').some((entry) => {
      if (!/^\d+$/.test(entry)) return false;
      const identity = procIdentity(entry);
      return identity.pgid === pgid && identity.state !== 'Z' && identity.state !== 'X';
    });
  } catch { return true; }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const terminateRemnants = async (pgid, startTime) => {
  if (!Number.isSafeInteger(pgid) || pgid < 2 || !groupAlive(pgid)) return true;
  const currentStart = procStartTime(pgid);
  if (currentStart && currentStart !== startTime) return false;
  try { process.kill(-pgid, 'SIGTERM'); } catch {}
  const termDeadline = Date.now() + 500;
  while (groupAlive(pgid) && Date.now() < termDeadline) await sleep(20);
  if (!groupAlive(pgid)) return true;
  const beforeKill = procStartTime(pgid);
  if (beforeKill && beforeKill !== startTime) return false;
  try { process.kill(-pgid, 'SIGKILL'); } catch {}
  const killDeadline = Date.now() + 250;
  while (groupAlive(pgid) && Date.now() < killDeadline) await sleep(20);
  return !groupAlive(pgid);
};

let marker;
try {
  marker = { schema: SCHEMA, runHash, runToken, state: 'starting', wrapperPid: process.pid };
  writeMarker(marker, 'wx');
} catch (error) {
  const current = readMarker();
  if (markerMatches(current) && current.state === 'cancelled') {
    unlinkExact();
    process.exit(130);
  }
  process.exit(126);
}

let child;
let settled = false;
let pendingSignal = null;
const finish = async (code, signal) => {
  if (settled) return;
  settled = true;
  const pid = Number(child && child.pid);
  const startTime = String(marker && marker.startTime || '');
  let clean = true;
  try { clean = await terminateRemnants(pid, startTime); } catch { clean = false; }
  if (clean) unlinkExact();
  if (!clean) process.exit(125);
  if (signal && ['SIGTERM', 'SIGINT', 'SIGHUP'].includes(signal)) {
    try { process.kill(process.pid, signal); } catch { process.exit(1); }
    return;
  }
  process.exit(code == null ? 1 : code);
};
const forward = (signal) => {
  pendingSignal = signal;
  const pid = Number(child && child.pid);
  if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(-pid, signal); } catch {} }
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => forward(signal));

try {
  child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, PORTAL_PROJECT_RUN_HASH: runHash, PORTAL_PROJECT_RUN_TOKEN: runToken },
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once('error', () => { void finish(125, null); });
  child.once('spawn', () => {
    const startTime = procStartTime(child.pid);
    if (!startTime) { void finish(125, null); return; }
    marker = { schema: SCHEMA, runHash, runToken, state: 'running', wrapperPid: process.pid, pid: child.pid, pgid: child.pid, startTime };
    try { writeMarker(marker); }
    catch { void finish(125, null); return; }
    if (pendingSignal) forward(pendingSignal);
  });
  child.once('close', (code, signal) => { void finish(code, signal); });
} catch {
  unlinkExact();
  process.exit(125);
}
`;
}

function renderRunControlScript(markerRoot: string): string {
  return String.raw`
const fs = require('fs');
const MARKER_ROOT = ${JSON.stringify(markerRoot)};
const SCHEMA = ${RUN_MARKER_SCHEMA};
const [mode, markerPath, expectedHash, expectedToken, namespace] = process.argv.slice(1);
const escape = (value) => value.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
const markerPattern = new RegExp('^' + escape(MARKER_ROOT) + '/portal-project-run-[a-z0-9][a-z0-9-]{0,31}-[a-f0-9]{32}\\.json$');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const procIdentity = (pid) => {
  try {
    const value = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const close = value.lastIndexOf(')');
    const fields = close > 0 ? value.slice(close + 2).trim().split(/\s+/) : [];
    return { state: String(fields[0] || ''), pgid: Number(fields[2]), startTime: String(fields[19] || '') };
  } catch { return { state: '', pgid: 0, startTime: '' }; }
};
const procStartTime = (pid) => procIdentity(pid).startTime;
const groupAlive = (pgid) => {
  try { process.kill(-pgid, 0); }
  catch (error) { if (error && error.code === 'ESRCH') return false; throw error; }
  try {
    return fs.readdirSync('/proc').some((entry) => {
      if (!/^\d+$/.test(entry)) return false;
      const identity = procIdentity(entry);
      return identity.pgid === pgid && identity.state !== 'Z' && identity.state !== 'X';
    });
  } catch { return true; }
};
const readMarker = (file) => {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Object.assign(new Error('unsafe marker'), { exitCode: 42 });
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.schema !== SCHEMA) throw Object.assign(new Error('invalid marker'), { exitCode: 42 });
    return value;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    if (error && error.exitCode) throw error;
    throw Object.assign(new Error('invalid marker'), { exitCode: 42 });
  }
};
const matches = (value, hash, token) => value && value.runHash === hash && value.runToken === token;
const unlinkExact = (file, hash, token) => {
  const current = readMarker(file);
  if (matches(current, hash, token)) { try { fs.unlinkSync(file); } catch {} }
};
const reserveCancellation = (file, hash, token) => {
  try {
    fs.writeFileSync(file, JSON.stringify({ schema: SCHEMA, runHash: hash, runToken: token, state: 'cancelled' }) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
};
const terminate = async (file, hash, token, reserveMissing) => {
  if (!markerPattern.test(file || '') || !/^[a-f0-9]{64}$/.test(hash || '') || !/^[a-f0-9]{64}$/.test(token || '') || !file.endsWith('-' + hash.slice(0, 32) + '.json')) throw Object.assign(new Error('invalid identity'), { exitCode: 41 });
  let marker = readMarker(file);
  if (!marker) {
    if (!reserveMissing || reserveCancellation(file, hash, token)) return;
    marker = readMarker(file);
    if (!marker) throw Object.assign(new Error('run marker changed during cancellation'), { exitCode: 43 });
  }
  if (!matches(marker, hash, token)) throw Object.assign(new Error('stale run identity'), { exitCode: 43 });
  if (marker.state === 'cancelled') {
    if (!reserveMissing) unlinkExact(file, hash, token);
    return;
  }
  const startDeadline = Date.now() + 2000;
  while (marker.state === 'starting' && Date.now() < startDeadline) {
    await sleep(20);
    marker = readMarker(file);
    if (!marker) {
      if (!reserveMissing || reserveCancellation(file, hash, token)) return;
      marker = readMarker(file);
      if (!marker) throw Object.assign(new Error('run marker changed during cancellation'), { exitCode: 43 });
    }
    if (!matches(marker, hash, token)) throw Object.assign(new Error('stale run identity'), { exitCode: 43 });
  }
  if (marker.state === 'cancelled') {
    if (!reserveMissing) unlinkExact(file, hash, token);
    return;
  }
  if (marker.state !== 'running') throw Object.assign(new Error('run marker never became active'), { exitCode: 44 });
  const pid = Number(marker.pid);
  const pgid = Number(marker.pgid);
  const startTime = String(marker.startTime || '');
  if (!Number.isSafeInteger(pid) || pid < 2 || pgid !== pid || !/^\d+$/.test(startTime)) throw Object.assign(new Error('invalid process identity'), { exitCode: 44 });
  const actualStart = procStartTime(pid);
  if (!actualStart) {
    if (groupAlive(pgid)) throw Object.assign(new Error('unverifiable process group'), { exitCode: 45 });
    unlinkExact(file, hash, token);
    return;
  }
  if (actualStart !== startTime) throw Object.assign(new Error('stale process identity'), { exitCode: 45 });
  try { process.kill(-pgid, 'SIGTERM'); } catch {}
  const termDeadline = Date.now() + 1500;
  while (groupAlive(pgid) && Date.now() < termDeadline) await sleep(25);
  if (groupAlive(pgid)) {
    const beforeKill = procStartTime(pid);
    if (beforeKill && beforeKill !== startTime) throw Object.assign(new Error('process identity changed before hard stop'), { exitCode: 45 });
    try { process.kill(-pgid, 'SIGKILL'); } catch {}
    const killDeadline = Date.now() + 500;
    while (groupAlive(pgid) && Date.now() < killDeadline) await sleep(25);
  }
  if (groupAlive(pgid)) throw Object.assign(new Error('process group survived hard stop'), { exitCode: 46 });
  unlinkExact(file, hash, token);
};

(async () => {
  if (mode === 'abort') {
    await terminate(markerPath, expectedHash, expectedToken, true);
    return;
  }
  if (mode === 'sweep') {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(namespace || '')) throw Object.assign(new Error('invalid namespace'), { exitCode: 41 });
    const prefix = 'portal-project-run-' + namespace + '-';
    const files = fs.readdirSync(MARKER_ROOT).filter((name) => name.startsWith(prefix) && /^[a-z0-9-]+-[a-f0-9]{32}\.json$/.test(name.slice('portal-project-run-'.length)));
    for (const name of files) {
      const file = MARKER_ROOT + '/' + name;
      const marker = readMarker(file);
      if (!marker || !/^[a-f0-9]{64}$/.test(marker.runHash || '') || !/^[a-f0-9]{64}$/.test(marker.runToken || '')) throw Object.assign(new Error('invalid orphan marker'), { exitCode: 42 });
      await terminate(file, marker.runHash, marker.runToken, false);
    }
    return;
  }
  throw Object.assign(new Error('invalid mode'), { exitCode: 41 });
})().catch((error) => {
  try { process.stderr.write(String(error && error.message || error) + '\n'); } catch {}
  process.exit(Number(error && error.exitCode) || 47);
});
`;
}

const TURN_WRAPPER_SCRIPT = renderTurnWrapperScript(PRODUCTION_MARKER_ROOT);
const RUN_CONTROL_SCRIPT = renderRunControlScript(PRODUCTION_MARKER_ROOT);

function parseInspect(output: string): ExactRuntimeInspect | null {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error('Native CLI Project runtime inspection returned invalid JSON'); }
  if (!Array.isArray(parsed)) throw new Error('Native CLI Project runtime inspection returned an invalid shape');
  if (parsed.length === 0) return null;
  if (parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') {
    throw new Error('Native CLI Project runtime inspection returned an invalid shape');
  }
  return parsed[0] as ExactRuntimeInspect;
}

async function inspectExactRuntime(
  runtime: ExactNativeCliProjectRuntimeHandle,
  executor: ProjectEgressCommandExecutor,
): Promise<ExactRuntimeInspect | null> {
  const result = await executor.run(
    'docker',
    ['container', 'inspect', runtime.containerId],
    { allowExitCodes: [0, 1] },
  );
  if (result.exitCode === 1) return null;
  const inspect = parseInspect(result.stdout);
  if (inspect && String(inspect.Id || '').toLowerCase() !== runtime.containerId.toLowerCase()) {
    throw new Error('Native CLI Project runtime changed during run control');
  }
  return inspect;
}

function buildControlDockerArgs(input: {
  runtime: ExactNativeCliProjectRuntimeHandle;
  containerUser: string;
  containerRoot: string;
  args: readonly string[];
}): string[] {
  return [
    'container', 'exec',
    '--user', input.containerUser,
    '--workdir', input.containerRoot,
    input.runtime.containerId,
    'node', '-e', RUN_CONTROL_SCRIPT,
    ...input.args,
  ];
}

export async function abortExactNativeCliProjectRun(input: {
  runtime: ExactNativeCliProjectRuntimeHandle;
  containerUser: string;
  containerRoot: string;
  identity: ExactNativeCliProjectRunIdentity;
  executor: ProjectEgressCommandExecutor;
}): Promise<void> {
  assertRuntime(input.runtime);
  assertControlTarget(input);
  const inspect = await inspectExactRuntime(input.runtime, input.executor);
  if (!inspect?.State?.Running) return;
  if (String(inspect.State.StartedAt || '') !== input.runtime.startedAt) {
    // A container restart is authoritative proof that the old PID namespace
    // and every process from the captured run are gone. Never target the new
    // namespace with a stale run identity.
    return;
  }
  await input.executor.run('docker', buildControlDockerArgs({
    runtime: input.runtime,
    containerUser: input.containerUser,
    containerRoot: input.containerRoot,
    args: ['abort', input.identity.markerPath, input.identity.runHash, input.identity.runToken],
  }));
}

export async function abortOrphanedExactNativeCliProjectRuns(input: {
  runtime: ExactNativeCliProjectRuntimeHandle;
  containerUser: string;
  containerRoot: string;
  markerNamespace: string;
  executor: ProjectEgressCommandExecutor;
}): Promise<void> {
  assertRuntime(input.runtime);
  assertControlTarget(input);
  const namespace = requiredNamespace(input.markerNamespace);
  const inspect = await inspectExactRuntime(input.runtime, input.executor);
  if (!inspect?.State?.Running || String(inspect.State.StartedAt || '') !== input.runtime.startedAt) return;
  await input.executor.run('docker', buildControlDockerArgs({
    runtime: input.runtime,
    containerUser: input.containerUser,
    containerRoot: input.containerRoot,
    args: ['sweep', '', '', '', namespace],
  }));
}

export function buildExactNativeCliProjectInvocation(
  input: BuildExactNativeCliProjectInvocationInput,
): NativeCliInvocation & { readonly runIdentity: ExactNativeCliProjectRunIdentity } {
  assertInvocationInput(input);
  const namespace = requiredNamespace(input.markerNamespace);
  const runId = requiredRunId(input.runId);
  const identity = markerIdentity(PRODUCTION_MARKER_ROOT, namespace, runId);
  const args = [
    'container', 'exec',
    '--user', input.containerUser,
    '--workdir', input.containerRoot,
  ];
  for (const [key, value] of Object.entries(input.containerEnvironment || {})) {
    args.push('--env', `${key}=${value}`);
  }
  args.push(
    input.runtime.containerId,
    'node', '-e', TURN_WRAPPER_SCRIPT,
    identity.markerPath,
    identity.runHash,
    identity.runToken,
    input.command,
    ...input.args,
  );
  return Object.assign({
    command: 'docker',
    args,
    options: {
      ...(input.hostCwd ? { cwd: input.hostCwd } : {}),
      env: input.hostEnvironment,
    },
    abort: () => abortExactNativeCliProjectRun({
      runtime: input.runtime,
      containerUser: input.containerUser,
      containerRoot: input.containerRoot,
      identity,
      executor: input.executor,
    }),
  }, { runIdentity: identity });
}

export const __nativeCliProjectRunControlTest = {
  PRODUCTION_MARKER_ROOT,
  RUN_CONTROL_SCRIPT,
  TURN_WRAPPER_SCRIPT,
  renderRunControlScript,
  renderTurnWrapperScript,
  markerIdentity,
};
