import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// These floors must stay in parity with the signed installer's native tuple.
export const COMPATIBLE_AI_NODE_RANGE = '>=24.22.1 <25 || >=26.12.1';

export type CompatibleAiPrerequisites = {
  ready: boolean;
  code: 'READY' | 'NODE_VERSION_UNSUPPORTED' | 'NODE_RUNTIME_UNSAFE' | 'NODE_CHECK_UNAVAILABLE';
  nodeVersion: string | null;
  requiredNodeRange: string;
  message: string;
};

export function compatibleAiNodeVersion(version: string): boolean {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return (major === 24 && (minor > 22 || (minor === 22 && patch >= 1)))
    || major > 26 || (major === 26 && (minor > 12 || (minor === 12 && patch >= 1)));
}

type NodeProbe = {
  nodePath: string;
  npmPath: string;
  version: string;
  safeNode: boolean;
  npmExecutable: boolean;
};

async function probeNodeRuntime(): Promise<NodeProbe> {
  const { stdout: paths } = await execFileAsync('/bin/bash', [
    '-c', 'command -v node && command -v npm',
  ], { timeout: 3_000, maxBuffer: 4096, env: process.env });
  const [nodePath, npmPath] = paths.trim().split('\n');
  const stat = await fs.promises.lstat('/usr/bin/node');
  const [nodeExecutable, npmExecutable] = await Promise.all(
    ['/usr/bin/node', '/usr/bin/npm'].map(async (file) => {
      try { await fs.promises.access(file, fs.constants.X_OK); return true; } catch { return false; }
    }),
  );
  const safeNode = stat.isFile() && !stat.isSymbolicLink()
    && stat.uid === 0 && (stat.mode & 0o022) === 0 && nodeExecutable;
  // Never execute a shadowed or unsafe interpreter just to diagnose it.
  if (!safeNode || nodePath !== '/usr/bin/node' || npmPath !== '/usr/bin/npm' || !npmExecutable) {
    return { nodePath, npmPath, version: '', safeNode, npmExecutable };
  }
  const { stdout } = await execFileAsync('/usr/bin/node', ['--version'], {
    timeout: 3_000, maxBuffer: 4096, env: process.env,
  });
  return { nodePath, npmPath, version: stdout.trim(), safeNode, npmExecutable };
}

/** Advisory before launch; the installer repeats its authoritative admission. */
export async function getCompatibleAiPrerequisites(
  probe: () => Promise<NodeProbe> = probeNodeRuntime,
): Promise<CompatibleAiPrerequisites> {
  const result = (code: CompatibleAiPrerequisites['code'], nodeVersion: string | null, message: string) => ({
    ready: code === 'READY', code, nodeVersion, requiredNodeRange: COMPATIBLE_AI_NODE_RANGE, message,
  });
  try {
    const observed = await probe();
    if (!observed.safeNode || !observed.npmExecutable
      || observed.nodePath !== '/usr/bin/node' || observed.npmPath !== '/usr/bin/npm') {
      return result('NODE_RUNTIME_UNSAFE', null,
        'AI tool updates require the managed Node.js and npm installation. Have the server administrator repair the system Node.js installation first; no update job was started.');
    }
    if (!compatibleAiNodeVersion(observed.version)) {
      // Do not relay arbitrary executable output into the maintenance response.
      const version = /^v?\d+\.\d+\.\d+$/.test(observed.version) ? observed.version : null;
      return result('NODE_VERSION_UNSUPPORTED', version,
        `Node.js ${version || 'version unknown'} cannot run the qualified AI tools. Update system Node.js to ${COMPATIBLE_AI_NODE_RANGE} in a separate host-maintenance window, then refresh this check. No update job was started.`);
    }
    return result('READY', observed.version,
      'Node.js meets the AI tool requirement. The installer will recheck it before making changes.');
  } catch {
    return result('NODE_CHECK_UNAVAILABLE', null,
      'The Node.js prerequisite check could not complete. Refresh the maintenance check before starting an AI tool update; no update job was started.');
  }
}
