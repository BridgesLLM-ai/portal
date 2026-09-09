import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getGatewayToken } from '../utils/gatewayToken';
import { buildOpenClawCliEnv, extractJsonFromCliOutput } from '../utils/openclawCli';
import {
  LEGACY_OPENCLAW_CODEX_PLUGIN_VERSION,
  OPENCLAW_CODEX_PLUGIN_VERSION,
} from './openclawConfigManager';

const execFileAsync = promisify(execFile);

export const TESTED_OPENCLAW_CORE_PACKAGE_VERSION = process.env.PORTAL_OPENCLAW_CORE_PACKAGE_VERSION || '2026.9.3';
export const TESTED_OPENCLAW_RUNTIME_VERSION = process.env.PORTAL_OPENCLAW_RUNTIME_VERSION || '2026.9.3';
export const LEGACY_TESTED_OPENCLAW_CORE_PACKAGE_VERSION = '2026.7.1-2';
export const LEGACY_TESTED_OPENCLAW_RUNTIME_VERSION = '2026.7.1';

// The family names identify API contracts, not every compatible patch release.
export const QUALIFIED_OPENCLAW_NATIVE_PATCHES: readonly string[] = Object.freeze(['2026.9.1', '2026.9.2', '2026.9.3']);

export type OpenClawTestedRuntimeFamily = 'legacy-2026.7.1' | 'current-2026.9.1';

interface OpenClawTestedTuple {
  family: OpenClawTestedRuntimeFamily;
  corePackageVersion: string;
  runtimeVersions: readonly string[];
  codexPluginVersion: string;
}

const TESTED_OPENCLAW_TUPLES: readonly OpenClawTestedTuple[] = Object.freeze([
  Object.freeze({
    family: 'legacy-2026.7.1',
    corePackageVersion: LEGACY_TESTED_OPENCLAW_CORE_PACKAGE_VERSION,
    runtimeVersions: Object.freeze([
      LEGACY_TESTED_OPENCLAW_RUNTIME_VERSION,
      LEGACY_TESTED_OPENCLAW_CORE_PACKAGE_VERSION,
    ]),
    codexPluginVersion: LEGACY_OPENCLAW_CODEX_PLUGIN_VERSION,
  }),
  Object.freeze({
    family: 'current-2026.9.1',
    corePackageVersion: TESTED_OPENCLAW_CORE_PACKAGE_VERSION,
    runtimeVersions: Object.freeze(Array.from(new Set([
      TESTED_OPENCLAW_RUNTIME_VERSION,
      TESTED_OPENCLAW_CORE_PACKAGE_VERSION,
    ]))),
    codexPluginVersion: OPENCLAW_CODEX_PLUGIN_VERSION,
  }),
  ...QUALIFIED_OPENCLAW_NATIVE_PATCHES
    .filter((version) => version !== TESTED_OPENCLAW_CORE_PACKAGE_VERSION)
    .map((version): OpenClawTestedTuple => Object.freeze({
      family: 'current-2026.9.1',
      corePackageVersion: version,
      runtimeVersions: Object.freeze([version]),
      codexPluginVersion: version,
    })),
]);

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
  testedRuntimeFamily?: OpenClawTestedRuntimeFamily | null;
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

export function matchesTestedRuntime(version: string | null): boolean {
  if (!version) return false;
  return TESTED_OPENCLAW_TUPLES.some((tuple) => tuple.runtimeVersions.includes(version));
}

function testedTupleForCore(corePackageVersion: string | null): OpenClawTestedTuple | null {
  if (!corePackageVersion) return null;
  return TESTED_OPENCLAW_TUPLES.find(
    (tuple) => tuple.corePackageVersion === corePackageVersion,
  ) || null;
}

function runtimeMatchesTuple(version: string | null, tuple: OpenClawTestedTuple | null): boolean {
  return Boolean(version && tuple?.runtimeVersions.includes(version));
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

    if (fs.existsSync(absolute)) {
      const targetStat = fs.lstatSync(absolute);
      if (targetStat.isSymbolicLink()) return false;
      if (targetStat.isDirectory()) {
        fs.accessSync(absolute, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
      } else if (targetStat.isFile()) {
        const parent = path.dirname(absolute);
        const parentStat = fs.lstatSync(parent);
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return false;
        fs.accessSync(parent, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
        fs.accessSync(absolute, fs.constants.R_OK | fs.constants.W_OK);
      } else {
        return false;
      }
    } else {
      const nearestStat = fs.lstatSync(nearestExisting);
      if (!nearestStat.isDirectory()) return false;
      fs.accessSync(nearestExisting, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export const __openClawSetupReadinessTest = Object.freeze({
  existingPathChainIsSafeAndWritable,
});

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

// Each CLI invocation boots a full Node process. Running all of them in
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
  const gatewayStatus = parseJsonOutput(gatewayStatusResult.stdout);
  // --require-rpc binds this response to the configured gateway's authenticated
  // RPC handshake. Discovery is not a second authentication authority: it can
  // exhaust its budget finding unrelated gateways while this one is healthy.
  const authenticatedRpc = gatewayStatusResult.ok && gatewayStatus?.rpc?.ok === true;
  const statusRunningVersion = parseOpenClawVersion(
    gatewayStatus?.gateway?.version || gatewayStatus?.rpc?.server?.version || gatewayStatus?.rpc?.version,
  );
  // Older status shapes may omit the server version. Only perform discovery
  // for that metadata gap, after authentication has already succeeded. A
  // discovery result can never rescue failed or missing RPC authentication.
  const gatewayProbeResult = authenticatedRpc && !statusRunningVersion
    ? await dependencies.runOpenClawCli(['gateway', 'probe', '--json'], 25_000)
    : null;
  const codexPluginResult = await dependencies.runOpenClawCli(['plugins', 'inspect', 'codex', '--json'], 10_000);
  const authStoreResult = await dependencies.runOpenClawCli(['models', 'auth', '--agent', 'main', 'list', '--json'], 10_000);
  const packageMetadata = await dependencies.resolvePackageMetadata();

  const version = parseOpenClawVersion(cliVersionResult.stdout);
  const gatewayProbe = gatewayProbeResult ? parseJsonOutput(gatewayProbeResult.stdout) : null;
  const endpointIdentity = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
      return url.href;
    } catch { return null; }
  };
  const authenticatedEndpoint = endpointIdentity(gatewayStatus?.rpc?.url || gatewayStatus?.gateway?.probeUrl);
  const matchingGatewayTargets = Array.isArray(gatewayProbe?.targets) && authenticatedEndpoint
    ? gatewayProbe.targets.filter((target: any) => target?.connect?.rpcOk === true
      && endpointIdentity(target?.url) === authenticatedEndpoint)
    : [];
  const primaryGatewayTarget = matchingGatewayTargets.length === 1 ? matchingGatewayTargets[0] : null;
  const runningVersion = statusRunningVersion || (gatewayProbeResult?.ok && gatewayProbe?.ok === true
    ? parseOpenClawVersion(primaryGatewayTarget?.self?.version)
    : null);
  // Keep the public field for existing clients; it now describes the required
  // configured-gateway RPC probe, not optional network discovery.
  const gatewayProbeOk = authenticatedRpc;
  const statusError = gatewayStatus?.rpc?.error;
  const gatewayProbeError = authenticatedRpc ? null
    : (typeof statusError === 'string' && statusError.trim())
      || String(gatewayStatusResult.stderr || gatewayStatusResult.error || '').trim()
      || 'OpenClaw gateway did not return a successful authenticated RPC handshake.';
  const authenticationRejected = !authenticatedRpc && /(?:AUTH_TOKEN_MISMATCH|token[_ -]mismatch|invalid (?:gateway )?token|authentication failed|unauthorized)/i.test(
    String(statusError || gatewayStatusResult.stderr || gatewayStatusResult.error || ''),
  );
  const codexPlugin = parseJsonOutput(codexPluginResult.stdout);
  const authStorePayload = parseJsonOutput(authStoreResult.stdout);
  const hasToken = Boolean(dependencies.readGatewayToken());
  const tokenParity = hasToken && authenticatedRpc;
  const credentialStoreWritable = dependencies.credentialStoreWritable();
  const credentialStoreReady = authStoreResult.ok && authStorePayload !== null;
  const testedTuple = testedTupleForCore(packageMetadata?.version || null);
  const expectedCodexPluginVersion = testedTuple?.codexPluginVersion || OPENCLAW_CODEX_PLUGIN_VERSION;
  const expectedCodexPluginSpec = `@openclaw/codex@${expectedCodexPluginVersion}`;
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
    && Boolean(testedTuple)
    && codexPluginVersion === expectedCodexPluginVersion
    && codexPlugin?.install?.source === 'npm'
    && codexPluginInstallSpec === expectedCodexPluginSpec
    && codexPluginInstalledVersion === expectedCodexPluginVersion;
  const installed = cliVersionResult.ok && Boolean(version) && Boolean(packageMetadata);
  const blockers: OpenClawSetupReadinessBlocker[] = [];

  if (!installed) {
    blockers.push({ code: 'not-installed', message: 'OpenClaw is not installed as a verifiable global package.' });
  }
  if (!testedTuple) {
    blockers.push({
      code: 'core-package-mismatch',
      message: `OpenClaw core must match a supported version (${TESTED_OPENCLAW_TUPLES.map((tuple) => tuple.corePackageVersion).join(', ')}); detected ${packageMetadata?.version || 'unknown'}.`,
    });
  }
  if (!runtimeMatchesTuple(version, testedTuple)) {
    blockers.push({
      code: 'cli-runtime-mismatch',
      message: `OpenClaw CLI runtime did not match the installed tested core family; detected ${version || 'unknown'} for core ${packageMetadata?.version || 'unknown'}.`,
    });
  }
  if (!authenticatedRpc) {
    blockers.push({ code: 'gateway-rpc-unavailable', message: 'The OpenClaw gateway did not pass an authenticated RPC probe.' });
  }
  if (!runtimeMatchesTuple(runningVersion, testedTuple)) {
    blockers.push({
      code: 'gateway-runtime-mismatch',
      message: `OpenClaw gateway runtime did not match the installed tested core family; detected ${runningVersion || 'unknown'} for core ${packageMetadata?.version || 'unknown'}.`,
    });
  }
  if (!hasToken) {
    blockers.push({ code: 'gateway-token-missing', message: 'The OpenClaw gateway token is not configured.' });
  } else if (authenticationRejected) {
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
    && Boolean(testedTuple)
    && runtimeMatchesTuple(version, testedTuple)
    && runtimeMatchesTuple(runningVersion, testedTuple)
    && authenticatedRpc
    && codexPluginExact;
  const ready = testedPairReady
    && tokenParity
    && credentialStoreReady
    && credentialStoreWritable
    && blockers.length === 0;
  // The Portal supports a retained 7.1 tuple during a Portal-only update as
  // well as the current 9.1 tuple. Report the tuple that actually admitted
  // this host; reporting the default 9.1 constants for a healthy retained
  // 7.1 host makes the dashboard contradict `testedPairReady`.
  const reportedTestedTuple = testedTuple || TESTED_OPENCLAW_TUPLES.find(
    (tuple) => tuple.corePackageVersion === TESTED_OPENCLAW_CORE_PACKAGE_VERSION,
  )!;

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
    testedCorePackageVersion: reportedTestedTuple.corePackageVersion,
    testedRuntimeVersion: reportedTestedTuple.runtimeVersions[0],
    testedCodexPluginVersion: reportedTestedTuple.codexPluginVersion,
    testedRuntimeFamily: testedTuple?.family || null,
    testedPairReady,
    ready,
    blockers,
    description: 'OpenClaw is the AI agent framework that powers intelligent features like code generation, chat, and automation.',
  };
}
