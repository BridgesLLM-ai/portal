import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getGatewayToken } from '../utils/gatewayToken';
import { buildOpenClawCliEnv, extractJsonFromCliOutput } from '../utils/openclawCli';
import { OPENCLAW_CODEX_PLUGIN_VERSION } from './openclawConfigManager';

const execFileAsync = promisify(execFile);

export const TESTED_OPENCLAW_CORE_PACKAGE_VERSION = process.env.PORTAL_OPENCLAW_CORE_PACKAGE_VERSION || '2026.7.1-2';
export const TESTED_OPENCLAW_RUNTIME_VERSION = process.env.PORTAL_OPENCLAW_RUNTIME_VERSION || '2026.7.1';

interface OpenClawCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

interface OpenClawPackageMetadata {
  packageDir: string;
  version: string;
}

export interface OpenClawSetupReadinessBlocker {
  code:
    | 'not-installed'
    | 'core-package-mismatch'
    | 'cli-runtime-mismatch'
    | 'gateway-rpc-unavailable'
    | 'gateway-runtime-mismatch'
    | 'gateway-token-missing'
    | 'gateway-token-mismatch'
    | 'codex-plugin-mismatch'
    | 'auth-store-unavailable'
    | 'credential-store-not-writable';
  message: string;
}

export interface OpenClawSetupReadiness {
  installed: boolean;
  version: string | null;
  corePackageVersion: string | null;
  runningVersion: string | null;
  gatewayRunning: boolean;
  authenticatedRpc: boolean;
  gatewayProbeOk: boolean;
  gatewayProbeError: string | null;
  gatewayUrl: string;
  hasToken: boolean;
  tokenParity: boolean;
  codexPluginVersion: string | null;
  codexPluginInstallSpec: string | null;
  credentialStoreReady: boolean;
  credentialStoreWritable: boolean;
  testedCorePackageVersion: string;
  testedRuntimeVersion: string;
  testedCodexPluginVersion: string;
  testedPairReady: boolean;
  ready: boolean;
  blockers: OpenClawSetupReadinessBlocker[];
  description: string;
}

export interface OpenClawSetupReadinessDependencies {
  runOpenClawCli: (args: string[], timeoutMs?: number) => Promise<OpenClawCliResult>;
  resolvePackageMetadata: () => Promise<OpenClawPackageMetadata | null>;
  readGatewayToken: () => string | null;
  credentialStoreWritable: () => boolean;
}

export interface OpenClawSetupReadinessOptions {
  force?: boolean;
  useSharedCache?: boolean;
}

function parseOpenClawVersion(raw: unknown): string | null {
  const text = String(raw || '').trim();
  const match = text.match(/OpenClaw\s+v?(\d{4}\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/i)
    || text.match(/\bv?(\d{4}\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\b/);
  return match?.[1] || null;
}

// The CLI banner and the gateway probe both report the npm PACKAGE version
// (for example 2026.7.1-2), while the runtime pin is the unsuffixed release
// (2026.7.1). Both identify the same tested install; treating the packaging
// suffix as a mismatch falsely reports a healthy box as running an old build.
export function matchesTestedRuntime(version: string | null): boolean {
  if (!version) return false;
  return version === TESTED_OPENCLAW_RUNTIME_VERSION
    || version === TESTED_OPENCLAW_CORE_PACKAGE_VERSION;
}

function parseJsonOutput(raw: string): any | null {
  try {
    return JSON.parse(extractJsonFromCliOutput(raw));
  } catch {
    return null;
  }
}

async function runOpenClawCli(args: string[], timeoutMs = 10_000): Promise<OpenClawCliResult> {
  try {
    const result = await execFileAsync('openclaw', args, {
      encoding: 'utf8',
      env: buildOpenClawCliEnv(),
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
    };
  } catch (error: any) {
    return {
      ok: false,
      stdout: String(error?.stdout || '').trim(),
      stderr: String(error?.stderr || error?.message || '').trim(),
    };
  }
}

async function resolveOpenClawPackageMetadata(): Promise<OpenClawPackageMetadata | null> {
  const packageDirs = new Set<string>();
  if (process.env.PORTAL_OPENCLAW_PACKAGE_DIR) {
    packageDirs.add(path.resolve(process.env.PORTAL_OPENCLAW_PACKAGE_DIR));
  }

  try {
    const result = await execFileAsync('npm', ['root', '-g'], {
      encoding: 'utf8',
      env: buildOpenClawCliEnv(),
      timeout: 2500,
    });
    const npmRoot = String(result.stdout || '').trim();
    if (npmRoot) packageDirs.add(path.join(npmRoot, 'openclaw'));
  } catch {
    // Fall through to the common global package layouts.
  }

  packageDirs.add('/usr/lib/node_modules/openclaw');
  packageDirs.add('/usr/local/lib/node_modules/openclaw');

  for (const packageDir of packageDirs) {
    const packageJsonPath = path.join(packageDir, 'package.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (manifest?.name === 'openclaw' && typeof manifest?.version === 'string') {
        return { packageDir, version: manifest.version };
      }
    } catch {
      // Try the next supported global package layout.
    }
  }
  return null;
}

function existingPathChainIsSafeAndWritable(targetPath: string): boolean {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  const relativeParts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let nearestExisting = parsed.root;

  try {
    for (const part of relativeParts) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) break;
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return false;
      if (current !== absolute && !stat.isDirectory()) return false;
      nearestExisting = current;
    }

    const nearestStat = fs.lstatSync(nearestExisting);
    if (!nearestStat.isDirectory()) return false;
    fs.accessSync(nearestExisting, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);

    if (fs.existsSync(absolute)) {
      const targetStat = fs.lstatSync(absolute);
      if (targetStat.isSymbolicLink()) return false;
      if (targetStat.isDirectory()) {
        fs.accessSync(absolute, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
      } else if (targetStat.isFile()) {
        fs.accessSync(absolute, fs.constants.R_OK | fs.constants.W_OK);
      } else {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isOpenClawCredentialStoreWritable(): boolean {
  const homeDir = process.env.HOME || '/root';
  const openClawHome = process.env.OPENCLAW_HOME || path.join(homeDir, '.openclaw');
  const agentStoreDir = path.join(openClawHome, 'agents', 'main', 'agent');
  const configPath = path.join(openClawHome, 'openclaw.json');
  return existingPathChainIsSafeAndWritable(openClawHome)
    && existingPathChainIsSafeAndWritable(agentStoreDir)
    && existingPathChainIsSafeAndWritable(configPath);
}

const defaultDependencies: OpenClawSetupReadinessDependencies = {
  runOpenClawCli,
  resolvePackageMetadata: resolveOpenClawPackageMetadata,
  readGatewayToken: getGatewayToken,
  credentialStoreWritable: isOpenClawCredentialStoreWritable,
};

// Each CLI invocation boots a full Node process. Running five of them in
// parallel on every dashboard/readiness query causes multi-core CPU spikes
// and, under contention, RPC-probe timeouts that report a healthy gateway as
// offline. Serialize the probes and cache the result briefly.
const READINESS_CACHE_TTL_MS = 60_000;
let readinessCache: { at: number; value: OpenClawSetupReadiness } | null = null;
let readinessInFlight: Promise<OpenClawSetupReadiness> | null = null;

export function invalidateOpenClawSetupReadinessCache(): void {
  readinessCache = null;
}

export async function getOpenClawSetupReadiness(
  overrides: Partial<OpenClawSetupReadinessDependencies> = {},
  options: OpenClawSetupReadinessOptions = {},
): Promise<OpenClawSetupReadiness> {
  const usesSharedCache = Object.keys(overrides).length === 0 || options.useSharedCache === true;
  if (usesSharedCache) {
    if (!options.force && readinessCache && Date.now() - readinessCache.at < READINESS_CACHE_TTL_MS) {
      return readinessCache.value;
    }
    if (readinessInFlight) return readinessInFlight;
    // Production callers use the default dependency set. Tests may opt an
    // injected dependency set into the same cache/in-flight contract so the
    // dashboard+maintenance concurrency boundary can be proven without
    // spawning real OpenClaw processes.
    const sharedOverrides = options.useSharedCache === true ? overrides : {};
    readinessInFlight = collectOpenClawSetupReadinessUncached(sharedOverrides).then((value) => {
      readinessCache = { at: Date.now(), value };
      return value;
    }).finally(() => {
      readinessInFlight = null;
    });
    return readinessInFlight;
  }
  return collectOpenClawSetupReadinessUncached(overrides);
}

async function collectOpenClawSetupReadinessUncached(
  overrides: Partial<OpenClawSetupReadinessDependencies>,
): Promise<OpenClawSetupReadiness> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const cliVersionResult = await dependencies.runOpenClawCli(['--version'], 4000);
  const gatewayStatusResult = await dependencies.runOpenClawCli(['gateway', 'status', '--require-rpc', '--timeout', '10000', '--json'], 15_000);
  const gatewayProbeResult = await dependencies.runOpenClawCli(['gateway', 'probe', '--json'], 10_000);
  const codexPluginResult = await dependencies.runOpenClawCli(['plugins', 'inspect', 'codex', '--json'], 10_000);
  const authStoreResult = await dependencies.runOpenClawCli(['models', 'auth', '--agent', 'main', 'list', '--json'], 10_000);
  const packageMetadata = await dependencies.resolvePackageMetadata();

  const version = parseOpenClawVersion(cliVersionResult.stdout);
  const gatewayProbe = parseJsonOutput(gatewayProbeResult.stdout);
  const primaryGatewayTarget = Array.isArray(gatewayProbe?.targets) ? gatewayProbe.targets[0] : null;
  // The running gateway version must not come only from `gateway probe`. That
  // probe needs the `operator.read` scope, and on a stock install it answers
  // `missing scope: operator.read`, leaving self.version absent -- which the
  // Portal then reported to the operator as "detected unknown" on a host whose
  // gateway was healthy and correctly versioned. `gateway status --json`,
  // which this check already runs, reports the same version without that
  // scope, so it is the primary source and the probe is the fallback.
  const gatewayStatus = parseJsonOutput(gatewayStatusResult.stdout);
  const runningVersion = parseOpenClawVersion(
    gatewayStatus?.gateway?.version
    || gatewayStatus?.rpc?.server?.version
    || primaryGatewayTarget?.self?.version
    || gatewayProbe?.self?.version,
  );
  const gatewayProbeOk = gatewayProbeResult.ok && Boolean(gatewayProbe?.ok);
  const gatewayProbeReportedError = primaryGatewayTarget?.connect?.error || gatewayProbe?.warnings?.[0]?.message;
  const gatewayProbeStderr = String(gatewayProbeResult.stderr || '').trim();
  const gatewayProbeExecutionError = String(gatewayProbeResult.error || '').trim();
  const gatewayProbeError = typeof gatewayProbeReportedError === 'string' && gatewayProbeReportedError.trim()
    ? gatewayProbeReportedError.trim()
    : gatewayProbeStderr
      || gatewayProbeExecutionError
      || (gatewayProbeOk
      ? null
      : 'OpenClaw gateway RPC probe failed.');
  const codexPlugin = parseJsonOutput(codexPluginResult.stdout);
  const authStorePayload = parseJsonOutput(authStoreResult.stdout);
  const hasToken = Boolean(dependencies.readGatewayToken());
  const authenticatedRpc = gatewayStatusResult.ok && gatewayProbeOk;
  const tokenParity = hasToken && authenticatedRpc;
  const credentialStoreWritable = dependencies.credentialStoreWritable();
  const credentialStoreReady = authStoreResult.ok && authStorePayload !== null;
  const expectedCodexPluginSpec = `@openclaw/codex@${OPENCLAW_CODEX_PLUGIN_VERSION}`;
  const codexPluginVersion = typeof codexPlugin?.plugin?.version === 'string' ? codexPlugin.plugin.version : null;
  // What matters is the identity that was actually resolved and installed, not
  // the spec that was requested. The CLI records `spec: "@openclaw/codex"` for
  // an install that resolved to `@openclaw/codex@2026.7.1-1`, so comparing the
  // requested spec rejected a correctly pinned, integrity-verified official
  // install and told every operator their Codex plugin was wrong. Resolved
  // fields are preferred; the requested spec remains a fallback for older
  // record shapes. The version equality itself is unchanged.
  const codexPluginResolvedSpec = typeof codexPlugin?.install?.resolvedSpec === 'string'
    ? codexPlugin.install.resolvedSpec
    : null;
  const codexPluginRequestedSpec = typeof codexPlugin?.install?.spec === 'string'
    ? codexPlugin.install.spec
    : null;
  const codexPluginInstallSpec = codexPluginResolvedSpec || codexPluginRequestedSpec;
  const codexPluginInstalledVersion = typeof codexPlugin?.install?.resolvedVersion === 'string'
    ? codexPlugin.install.resolvedVersion
    : typeof codexPlugin?.install?.version === 'string'
      ? codexPlugin.install.version
      : null;
  const codexPluginExact = codexPluginResult.ok
    && codexPluginVersion === OPENCLAW_CODEX_PLUGIN_VERSION
    && codexPlugin?.install?.source === 'npm'
    && codexPluginInstallSpec === expectedCodexPluginSpec
    && codexPluginInstalledVersion === OPENCLAW_CODEX_PLUGIN_VERSION;
  const installed = cliVersionResult.ok && Boolean(version) && Boolean(packageMetadata);
  const blockers: OpenClawSetupReadinessBlocker[] = [];

  if (!installed) {
    blockers.push({ code: 'not-installed', message: 'OpenClaw is not installed as a verifiable global package.' });
  }
  if (packageMetadata?.version !== TESTED_OPENCLAW_CORE_PACKAGE_VERSION) {
    blockers.push({
      code: 'core-package-mismatch',
      message: `OpenClaw core must be ${TESTED_OPENCLAW_CORE_PACKAGE_VERSION}; detected ${packageMetadata?.version || 'unknown'}.`,
    });
  }
  if (!matchesTestedRuntime(version)) {
    blockers.push({
      code: 'cli-runtime-mismatch',
      message: `OpenClaw CLI runtime must be ${TESTED_OPENCLAW_RUNTIME_VERSION} (package ${TESTED_OPENCLAW_CORE_PACKAGE_VERSION}); detected ${version || 'unknown'}.`,
    });
  }
  if (!authenticatedRpc) {
    blockers.push({ code: 'gateway-rpc-unavailable', message: 'The OpenClaw gateway did not pass an authenticated RPC probe.' });
  }
  if (!matchesTestedRuntime(runningVersion)) {
    blockers.push({
      code: 'gateway-runtime-mismatch',
      message: `OpenClaw gateway runtime must be ${TESTED_OPENCLAW_RUNTIME_VERSION} (package ${TESTED_OPENCLAW_CORE_PACKAGE_VERSION}); detected ${runningVersion || 'unknown'}.`,
    });
  }
  if (!hasToken) {
    blockers.push({ code: 'gateway-token-missing', message: 'The OpenClaw gateway token is not configured.' });
  } else if (!tokenParity) {
    blockers.push({ code: 'gateway-token-mismatch', message: 'The configured gateway token did not authenticate to the running OpenClaw gateway.' });
  }
  if (!codexPluginExact) {
    blockers.push({
      code: 'codex-plugin-mismatch',
      message: `The Codex plugin must be the pinned npm install ${expectedCodexPluginSpec}; detected ${codexPluginInstallSpec || codexPluginVersion || 'unknown'}.`,
    });
  }
  if (!credentialStoreReady) {
    blockers.push({ code: 'auth-store-unavailable', message: 'OpenClaw could not verify its saved authentication store.' });
  }
  if (!credentialStoreWritable) {
    blockers.push({ code: 'credential-store-not-writable', message: 'OpenClaw credential storage is not safely writable.' });
  }

  const testedPairReady = installed
    && packageMetadata?.version === TESTED_OPENCLAW_CORE_PACKAGE_VERSION
    && matchesTestedRuntime(version)
    && matchesTestedRuntime(runningVersion)
    && authenticatedRpc
    && codexPluginExact;
  const ready = testedPairReady
    && tokenParity
    && credentialStoreReady
    && credentialStoreWritable
    && blockers.length === 0;

  return {
    installed,
    version,
    corePackageVersion: packageMetadata?.version || null,
    runningVersion,
    gatewayRunning: authenticatedRpc,
    authenticatedRpc,
    gatewayProbeOk,
    gatewayProbeError,
    gatewayUrl: process.env.OPENCLAW_API_URL || 'http://127.0.0.1:18789',
    hasToken,
    tokenParity,
    codexPluginVersion,
    codexPluginInstallSpec,
    credentialStoreReady,
    credentialStoreWritable,
    testedCorePackageVersion: TESTED_OPENCLAW_CORE_PACKAGE_VERSION,
    testedRuntimeVersion: TESTED_OPENCLAW_RUNTIME_VERSION,
    testedCodexPluginVersion: OPENCLAW_CODEX_PLUGIN_VERSION,
    testedPairReady,
    ready,
    blockers,
    description: 'OpenClaw is the AI agent framework that powers intelligent features like code generation, chat, and automation.',
  };
}
