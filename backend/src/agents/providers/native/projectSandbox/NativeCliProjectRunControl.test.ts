import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import type { ProjectEgressCommandExecutor } from '../../../../services/projectEgressPlane';
import {
  __nativeCliProjectRunControlTest,
  abortExactNativeCliProjectRun,
  type ExactNativeCliProjectRunIdentity,
} from './NativeCliProjectRunControl';

const CONTAINER_ID = 'd'.repeat(64);
const STARTED_AT = '2026-07-20T12:00:00.000000000Z';

function waitForExit(child: ChildProcess, timeoutMs = 6_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`process ${child.pid || '?'} did not exit`)), timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function waitForMarker(markerPath: string): Promise<any> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (marker?.state === 'running') return marker;
    } catch {
      // The wrapper reserves the marker before publishing the child identity.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run marker did not become active: ${markerPath}`);
}

async function waitForFile(filePath: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(filePath, 'utf8') === expected) return;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected file was not published: ${filePath}`);
}

function processState(pid: number): string | null {
  try {
    const value = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = value.lastIndexOf(')');
    return close > 0 ? String(value.slice(close + 2).trim().split(/\s+/)[0] || '') : null;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  const state = processState(pid);
  return state !== null && state !== 'Z' && state !== 'X';
}

describe('exact Native CLI Project in-container run control', () => {
  let root: string;
  const trackedPids = new Set<number>();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-project-run-control-'));
  });

  afterEach(() => {
    for (const pid of trackedPids) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    trackedPids.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function identity(namespace: string, runId: string): ExactNativeCliProjectRunIdentity {
    return __nativeCliProjectRunControlTest.markerIdentity(root, namespace, runId);
  }

  function startWrapper(
    runIdentity: ExactNativeCliProjectRunIdentity,
    childScript: string,
    childArgs: readonly string[] = [],
  ): ChildProcess {
    const child = spawn(process.execPath, [
      '-e', __nativeCliProjectRunControlTest.renderTurnWrapperScript(root),
      runIdentity.markerPath,
      runIdentity.runHash,
      runIdentity.runToken,
      process.execPath,
      '-e', childScript,
      ...childArgs,
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) trackedPids.add(child.pid);
    return child;
  }

  function runControl(args: readonly string[]): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, [
      '-e', __nativeCliProjectRunControlTest.renderRunControlScript(root),
      ...args,
    ], { cwd: root, encoding: 'utf8', timeout: 6_000 });
  }

  test('normal exit preserves output and removes the exact marker', async () => {
    const runIdentity = identity('codex', 'normal-exit');
    const wrapper = startWrapper(runIdentity, "process.stdout.write('complete'); process.exit(7)");
    let stdout = '';
    wrapper.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    const exit = await waitForExit(wrapper);

    expect(exit).toEqual({ code: 7, signal: null });
    expect(stdout).toBe('complete');
    expect(fs.existsSync(runIdentity.markerPath)).toBe(false);
  });

  test('sends TERM, escalates to KILL, waits for exit, and makes abort idempotent', async () => {
    const runIdentity = identity('codex', 'term-kill');
    const termEvidence = path.join(root, 'term-seen');
    const readyEvidence = path.join(root, 'term-handler-ready');
    const wrapper = startWrapper(
      runIdentity,
      "const fs=require('fs'); const termEvidence=process.argv[1]; const readyEvidence=process.argv[2]; process.on('SIGTERM',()=>fs.writeFileSync(termEvidence,'yes')); fs.writeFileSync(readyEvidence,'yes'); setInterval(()=>{},1000)",
      [termEvidence, readyEvidence],
    );
    const marker = await waitForMarker(runIdentity.markerPath);
    trackedPids.add(marker.pid);
    // The wrapper's running marker proves the OS child exists, not that its
    // JavaScript has installed a TERM handler. Wait for that separate
    // readiness boundary so this test exercises the intended TERM grace
    // period and KILL escalation instead of racing normal process startup.
    await waitForFile(readyEvidence, 'yes');

    const started = process.hrtime.bigint();
    const first = runControl(['abort', runIdentity.markerPath, runIdentity.runHash, runIdentity.runToken]);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe('');
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    expect(elapsedMs).toBeGreaterThanOrEqual(1_400);
    expect(fs.readFileSync(termEvidence, 'utf8')).toBe('yes');
    await waitForExit(wrapper);
    expect(processAlive(marker.pid)).toBe(false);
    expect(fs.existsSync(runIdentity.markerPath)).toBe(false);

    const repeated = runControl(['abort', runIdentity.markerPath, runIdentity.runHash, runIdentity.runToken]);
    expect(repeated.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(runIdentity.markerPath, 'utf8'))).toMatchObject({
      state: 'cancelled',
      runHash: runIdentity.runHash,
      runToken: runIdentity.runToken,
    });
    const repeatedAgain = runControl(['abort', runIdentity.markerPath, runIdentity.runHash, runIdentity.runToken]);
    expect(repeatedAgain.status).toBe(0);
  }, 12_000);

  test('rejects stale run tokens and process-reuse identities without touching the live run', async () => {
    const runIdentity = identity('codex', 'stale-identity');
    const wrapper = startWrapper(runIdentity, 'setInterval(()=>{},1000)');
    const marker = await waitForMarker(runIdentity.markerPath);
    trackedPids.add(marker.pid);

    const staleToken = runControl([
      'abort', runIdentity.markerPath, runIdentity.runHash, 'e'.repeat(64),
    ]);
    expect(staleToken.status).toBe(43);
    expect(staleToken.stderr).toContain('stale run identity');
    expect(processAlive(marker.pid)).toBe(true);

    fs.writeFileSync(runIdentity.markerPath, `${JSON.stringify({ ...marker, startTime: '1' })}\n`, { mode: 0o600 });
    const stalePid = runControl(['abort', runIdentity.markerPath, runIdentity.runHash, runIdentity.runToken]);
    expect(stalePid.status).toBe(45);
    expect(stalePid.stderr).toContain('stale process identity');
    expect(processAlive(marker.pid)).toBe(true);

    fs.writeFileSync(runIdentity.markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    expect(runControl(['abort', runIdentity.markerPath, runIdentity.runHash, runIdentity.runToken]).status).toBe(0);
    await waitForExit(wrapper);
  });

  test('local wrapper/client death is not authoritative while the detached in-container run lives', async () => {
    const runIdentity = identity('codex', 'client-died');
    const wrapper = startWrapper(runIdentity, 'setInterval(()=>{},1000)');
    const marker = await waitForMarker(runIdentity.markerPath);
    trackedPids.add(marker.pid);

    process.kill(wrapper.pid!, 'SIGKILL');
    await waitForExit(wrapper);
    expect(processAlive(marker.pid)).toBe(true);
    expect(fs.existsSync(runIdentity.markerPath)).toBe(true);

    const abort = runControl(['abort', runIdentity.markerPath, runIdentity.runHash, runIdentity.runToken]);
    expect(abort.status).toBe(0);
    // This Jest container deliberately has `sleep infinity` rather than a
    // subreaper at PID 1, so an exited orphan can remain observable as Z here.
    // Production Project runtimes require Docker `--init`; either absence or
    // a zombie state proves the process can no longer execute or reach egress.
    expect([null, 'Z', 'X']).toContain(processState(marker.pid));
    expect(processAlive(marker.pid)).toBe(false);
    expect(fs.existsSync(runIdentity.markerPath)).toBe(false);
  });

  test('a pre-spawn abort tombstone prevents the cancelled command from launching', async () => {
    const runIdentity = identity('codex', 'cancel-before-spawn');
    const sentinel = path.join(root, 'must-not-exist');
    expect(runControl(['abort', runIdentity.markerPath, runIdentity.runHash, runIdentity.runToken]).status).toBe(0);

    const wrapper = startWrapper(
      runIdentity,
      "require('fs').writeFileSync(process.argv[1], 'launched')",
      [sentinel],
    );
    const exit = await waitForExit(wrapper);
    expect(exit.code).toBe(130);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(runIdentity.markerPath)).toBe(false);
  });

  test('orphan sweep is namespace-scoped and does not terminate another provider run', async () => {
    const codexIdentity = identity('codex', 'orphan-codex');
    const claudeIdentity = identity('claude-code', 'live-claude');
    const codexWrapper = startWrapper(codexIdentity, 'setInterval(()=>{},1000)');
    const claudeWrapper = startWrapper(claudeIdentity, 'setInterval(()=>{},1000)');
    const codexMarker = await waitForMarker(codexIdentity.markerPath);
    const claudeMarker = await waitForMarker(claudeIdentity.markerPath);
    trackedPids.add(codexMarker.pid);
    trackedPids.add(claudeMarker.pid);

    const sweep = runControl(['sweep', '', '', '', 'codex']);
    expect(sweep.status).toBe(0);
    await waitForExit(codexWrapper);
    expect(processAlive(codexMarker.pid)).toBe(false);
    expect(processAlive(claudeMarker.pid)).toBe(true);
    expect(fs.existsSync(claudeIdentity.markerPath)).toBe(true);

    expect(runControl(['abort', claudeIdentity.markerPath, claudeIdentity.runHash, claudeIdentity.runToken]).status).toBe(0);
    await waitForExit(claudeWrapper);
  });

  test('host abort treats a missing or restarted exact container as proof, but propagates hard-stop failure', async () => {
    const runIdentity = __nativeCliProjectRunControlTest.markerIdentity('/run', 'codex', 'host-proof');
    const runtime = { containerId: CONTAINER_ID, startedAt: STARTED_AT };
    const missingExecutor = {
      run: jest.fn(async () => ({ stdout: '', stderr: '', exitCode: 1 })),
    } as unknown as ProjectEgressCommandExecutor;
    await expect(abortExactNativeCliProjectRun({
      runtime,
      containerUser: '1000:1000',
      containerRoot: '/workspace/project',
      identity: runIdentity,
      executor: missingExecutor,
    })).resolves.toBeUndefined();
    expect(missingExecutor.run).toHaveBeenCalledTimes(1);

    const restartedExecutor = {
      run: jest.fn(async () => ({
        stdout: JSON.stringify([{ Id: CONTAINER_ID, State: { Running: true, StartedAt: 'replacement' } }]),
        stderr: '',
        exitCode: 0,
      })),
    } as unknown as ProjectEgressCommandExecutor;
    await expect(abortExactNativeCliProjectRun({
      runtime,
      containerUser: '1000:1000',
      containerRoot: '/workspace/project',
      identity: runIdentity,
      executor: restartedExecutor,
    })).resolves.toBeUndefined();
    expect(restartedExecutor.run).toHaveBeenCalledTimes(1);

    const hardStopExecutor = {
      run: jest.fn(async (_command: string, args: readonly string[]) => {
        if (args[1] === 'inspect') {
          return {
            stdout: JSON.stringify([{ Id: CONTAINER_ID, State: { Running: true, StartedAt: STARTED_AT } }]),
            stderr: '',
            exitCode: 0,
          };
        }
        throw new Error('control exec failed');
      }),
    } as unknown as ProjectEgressCommandExecutor;
    await expect(abortExactNativeCliProjectRun({
      runtime,
      containerUser: '1000:1000',
      containerRoot: '/workspace/project',
      identity: runIdentity,
      executor: hardStopExecutor,
    })).rejects.toThrow('control exec failed');
    expect(hardStopExecutor.run).toHaveBeenCalledTimes(2);
  });
});
