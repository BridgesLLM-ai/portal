/**
 * App Process Manager
 * Manages full-stack app deployments in locked-down project runtime containers.
 * Project package scripts never execute in the root Portal backend process.
 */

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  bridgeContainerLoopbackPort,
  inspectProjectAppContainer,
  projectAppContainerName,
  readProjectAppLogs,
  runProjectLifecycleCommand,
  startProjectAppContainer,
  stopProjectAppContainer,
  type ProjectAppRuntimeIdentity,
} from './project-lifecycle.service';
import type { PortalProjectWorkloadPlan } from './projectWorkloadRuntime';
import { PROJECT_METADATA_MAX_BYTES, readProjectTextFile } from './projectSurfacePolicy';

const prisma = new PrismaClient();

// Port range for full-stack apps: 5001-5099
const PORT_RANGE_START = 5001;
const PORT_RANGE_END = 5099;
const PORT_LEASE_PREFIX = 'portal.app-process.port-lease.';
const APP_STATE_PREFIX = 'portal.app-process.state.';
const PORT_LEASE_TTL_MS = 15 * 60 * 1000;
const STARTUP_PROBE_DELAY_MS = 1500;
const STARTUP_TIMEOUT_MS = 15_000;
const MAX_RESTART_ATTEMPTS = 3;
const portalInstanceId = `${process.pid}-${crypto.randomUUID()}`;
type ReadinessProbe = (networkAddress: string, port: number) => Promise<boolean>;

type AppProcessStatus = 'starting' | 'running' | 'stopped' | 'error';

interface ManagedApp {
  appId: string;
  deployId: string;
  port: number;
  containerName: string;
  loopbackBridgeAttempted?: boolean;
  containerId: string;
  networkAddress: string;
  status: AppProcessStatus;
  restartCount: number;
  containerRestartCount: number;
  lastError?: string;
  deployPath: string;
  desiredStatus: 'running' | 'stopped' | 'error';
  startupDeadlineAt: number;
  startupTimer?: NodeJS.Timeout;
  operationId: string;
  runtimeIdentity: ProjectAppRuntimeIdentity;
  runtimePlan: PortalProjectWorkloadPlan;
}

interface PortLease {
  token: string;
  portalInstanceId: string;
  pid: number;
  processStartTime: string | null;
  port: number;
  createdAt: string;
  expiresAt: string;
  appId?: string;
  deployId?: string;
  serialized: string;
}

interface PersistedAppState {
  version: 2;
  appId: string;
  deployId: string;
  port: number;
  containerName: string;
  containerId: string;
  deployPath: string;
  status: AppProcessStatus;
  desiredStatus: 'running' | 'stopped' | 'error';
  restartCount: number;
  containerRestartCount: number;
  lastError?: string;
  updatedAt: string;
  actorId: string;
  projectId: string;
  workloadId: string;
}

// In-memory registry of running app processes
const runningApps: Map<string, ManagedApp> = new Map();
const portLeases = new Map<number, PortLease>();
const deployOperations = new Map<string, Promise<void>>();
const appStatusWrites = new Map<string, Promise<void>>();
const appStateWrites = new Map<string, Promise<void>>();
let portAllocationQueue: Promise<void> = Promise.resolve();
let startupPromise: Promise<void> | null = null;
let shutdownPromise: Promise<void> | null = null;
let shuttingDown = false;

function probeRuntimeHttp(networkAddress: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };
    const request = http.request({
      host: networkAddress,
      port,
      path: '/',
      method: 'GET',
      headers: {
        Host: 'localhost',
        Connection: 'close',
      },
      timeout: 750,
    }, (response) => {
      response.resume();
      response.once('end', () => finish(true));
      response.once('error', () => finish(false));
    });
    request.once('timeout', () => {
      request.destroy();
      finish(false);
    });
    request.once('error', () => finish(false));
    request.end();
  });
}

let readinessProbe: ReadinessProbe = probeRuntimeHttp;

async function waitForRuntimeReadiness(app: ManagedApp): Promise<void> {
  while (Date.now() < app.startupDeadlineAt) {
    if (
      runningApps.get(app.deployId) !== app
      || app.desiredStatus !== 'running'
    ) {
      throw new Error('App startup was superseded before readiness');
    }
    const container = inspectProjectAppContainer(app.containerName);
    if (
      container
      && !container.running
      && container.status !== 'created'
      && container.status !== 'restarting'
    ) {
      throw new Error(
        container.error
          || `App container exited before readiness (code ${container.exitCode})`,
      );
    }
    if (await readinessProbe(app.networkAddress, app.port)) {
      app.status = 'running';
      app.lastError = undefined;
      await updateAppStatus(app.appId, 'running');
      await persistManagedApp(app);
      return;
    }
    // Halfway through the budget, assume the app bound loopback only — the
    // shape every pre-4.0 fullstack app had, because the Portal used to proxy
    // to 127.0.0.1 — and bridge the container address to it. Cheap, done once,
    // and a no-op for apps that already listen on all interfaces.
    if (!app.loopbackBridgeAttempted && Date.now() > app.startupDeadlineAt - STARTUP_TIMEOUT_MS / 2) {
      app.loopbackBridgeAttempted = true;
      bridgeContainerLoopbackPort(app.containerName, app.networkAddress, app.port);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `App did not answer HTTP on its isolated runtime at ${app.networkAddress}:${app.port} within ${STARTUP_TIMEOUT_MS}ms. `
    + 'Confirm the app listens on the port the Portal assigned (use process.env.PORT) and on all interfaces '
    + `(for example listen(process.env.PORT, '0.0.0.0')) rather than only on localhost.`,
  );
}

/**
 * Detect project deploy type:
 * - 'runtime': Python, C++, or Node CLI apps that run on the VNC desktop
 * - 'fullstack': Node.js apps with a start script (web servers)
 * - 'static': HTML/React apps served as static files
 */
export function detectDeployType(projectDir: string): 'static' | 'fullstack' | 'runtime' {
  const files = fs.readdirSync(projectDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const hasPackageJson = files.includes('package.json');
  const hasIndexHtml = files.includes('index.html');
  const hasMainPy = files.includes('main.py');
  const hasRequirementsTxt = files.includes('requirements.txt');
  const hasMainCpp = files.includes('main.cpp');
  const hasMakefile = files.includes('Makefile');

  // Python runtime: has main.py or requirements.txt (and no package.json)
  if ((hasMainPy || hasRequirementsTxt) && !hasPackageJson) {
    return 'runtime';
  }

  // C++ runtime: has main.cpp or Makefile with g++ (and no package.json, no index.html)
  if ((hasMainCpp || hasMakefile) && !hasPackageJson && !hasIndexHtml) {
    // Verify Makefile contains g++ references if it exists
    if (hasMakefile) {
      try {
        const makefileContent = readProjectTextFile(projectDir, 'Makefile', {
          maxBytes: PROJECT_METADATA_MAX_BYTES,
        }) || '';
        if (makefileContent.includes('g++') || makefileContent.includes('CXX') || hasMainCpp) {
          return 'runtime';
        }
      } catch {}
    }
    if (hasMainCpp) return 'runtime';
  }

  // Node.js detection
  if (hasPackageJson) {
    try {
      const packageJson = readProjectTextFile(projectDir, 'package.json', {
        maxBytes: PROJECT_METADATA_MAX_BYTES,
      });
      const pkg = JSON.parse(packageJson || '{}');

      // Node CLI runtime: has package.json but NO start script and NO index.html
      if (!pkg.scripts?.start && !hasIndexHtml) {
        return 'runtime';
      }

      // Fullstack: has start script (web server)
      if (pkg.scripts?.start) return 'fullstack';

      // Static: has build script
      if (pkg.scripts?.build) return 'static';
    } catch {}
  }

  // Default to static (HTML apps)
  return 'static';
}

/**
 * Allocate an unused port from the range
 */
export async function allocatePort(): Promise<number> {
  return serializePortAllocation(async () => {
    const usedPorts = await prisma.app.findMany({
      where: { port: { not: null } },
      select: { port: true },
    });

    const usedSet = new Set(usedPorts.map(a => a.port).filter((port): port is number => port !== null));

    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (usedSet.has(port) || isPortInUseByProcess(port) || portLeases.has(port)) continue;
      if (!(await canBindPort(port))) continue;

      const lease = await tryAcquirePortLease(port);
      if (lease) return port;
    }

    throw new Error('No available ports in range 5001-5099');
  });
}

function isPortInUseByProcess(port: number): boolean {
  for (const app of runningApps.values()) {
    if (app.port === port) return true;
  }
  return false;
}

function serializePortAllocation<T>(work: () => Promise<T>): Promise<T> {
  const result = portAllocationQueue.then(work, work);
  portAllocationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function withDeployLock<T>(deployId: string, work: () => Promise<T>): Promise<T> {
  const previous = deployOperations.get(deployId) || Promise.resolve();
  const result = previous.catch(() => undefined).then(work);
  const tail = result.then(() => undefined, () => undefined);
  deployOperations.set(deployId, tail);
  return result.finally(() => {
    if (deployOperations.get(deployId) === tail) deployOperations.delete(deployId);
  });
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      if (server.listening) {
        server.close(() => resolve(available));
      } else {
        resolve(available);
      }
    };
    server.once('error', () => finish(false));
    server.once('listening', () => finish(true));
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

function portLeaseKey(port: number): string {
  return `${PORT_LEASE_PREFIX}${port}`;
}

function appStateKey(appId: string): string {
  return `${APP_STATE_PREFIX}${appId}`;
}

function readProcessStartTime(pid: number): string | null {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 1) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(') ');
    if (commandEnd < 0) return null;
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTime = fieldsAfterCommand[19];
    return /^\d+$/.test(startTime || '') ? startTime : null;
  } catch {
    return null;
  }
}

function leaseOwnerIsGone(lease: Omit<PortLease, 'serialized'>): boolean {
  if (lease.portalInstanceId === portalInstanceId) return false;
  if (typeof lease.processStartTime !== 'string' || !lease.processStartTime) return false;
  return readProcessStartTime(lease.pid) !== lease.processStartTime;
}

function parseLease(value: string): Omit<PortLease, 'serialized'> | null {
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed?.token !== 'string'
      || typeof parsed?.portalInstanceId !== 'string'
      || !Number.isInteger(parsed?.port)
      || typeof parsed?.expiresAt !== 'string'
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function createLease(port: number, owner: { appId?: string; deployId?: string } = {}): PortLease {
  const createdAt = new Date();
  const leaseWithoutSerialized = {
    token: crypto.randomUUID(),
    portalInstanceId,
    pid: process.pid,
    processStartTime: readProcessStartTime(process.pid),
    port,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + PORT_LEASE_TTL_MS).toISOString(),
    ...owner,
  };
  return {
    ...leaseWithoutSerialized,
    serialized: JSON.stringify(leaseWithoutSerialized),
  };
}

async function conditionallyReplaceLease(port: number, previousValue: string, lease: PortLease): Promise<boolean> {
  const result = await prisma.systemSetting.updateMany({
    where: { key: portLeaseKey(port), value: previousValue },
    data: { value: lease.serialized },
  });
  if (result.count !== 1) return false;
  portLeases.set(port, lease);
  return true;
}

async function tryAcquirePortLease(
  port: number,
  owner: { appId?: string; deployId?: string } = {},
): Promise<PortLease | null> {
  const lease = createLease(port, owner);
  try {
    await prisma.systemSetting.create({
      data: { key: portLeaseKey(port), value: lease.serialized },
    });
    portLeases.set(port, lease);
    return lease;
  } catch (error: any) {
    if (error?.code !== 'P2002') throw error;
    const existing = await prisma.systemSetting.findUnique({ where: { key: portLeaseKey(port) } }).catch(() => null);
    if (!existing) return null;
    const parsed = parseLease(existing.value);
    const reclaimable = !parsed || Date.parse(parsed.expiresAt) <= Date.now() || leaseOwnerIsGone(parsed);
    const sameOwner = parsed?.appId === owner.appId
      && parsed?.deployId === owner.deployId
      && parsed?.portalInstanceId === portalInstanceId
      && owner.appId !== undefined;
    if (!reclaimable && !sameOwner) return null;
    return (await conditionallyReplaceLease(port, existing.value, lease)) ? lease : null;
  }
}

async function claimPortLease(port: number, appId: string, deployId: string): Promise<PortLease> {
  const localLease = portLeases.get(port);
  if (localLease) {
    const claimed = createLease(port, { appId, deployId });
    if (await conditionallyReplaceLease(port, localLease.serialized, claimed)) return claimed;
    portLeases.delete(port);
  }

  const claimed = await tryAcquirePortLease(port, { appId, deployId });
  if (!claimed) throw new Error(`Port ${port} is already leased by another app deployment`);
  return claimed;
}

async function releasePortLease(lease: PortLease | undefined): Promise<void> {
  if (!lease) return;
  portLeases.delete(lease.port);
  await prisma.systemSetting.deleteMany({
    where: { key: portLeaseKey(lease.port), value: lease.serialized },
  }).catch(() => undefined);
}

function persistedStateFromManaged(app: ManagedApp): PersistedAppState {
  return {
    version: 2,
    appId: app.appId,
    deployId: app.deployId,
    port: app.port,
    containerName: app.containerName,
    containerId: app.containerId,
    deployPath: app.deployPath,
    status: app.status,
    desiredStatus: app.desiredStatus,
    restartCount: app.restartCount,
    containerRestartCount: app.containerRestartCount,
    lastError: app.lastError,
    updatedAt: new Date().toISOString(),
    actorId: app.runtimeIdentity.actorId,
    projectId: app.runtimeIdentity.projectId,
    workloadId: app.runtimeIdentity.workloadId,
  };
}

async function persistManagedApp(app: ManagedApp): Promise<void> {
  await persistAppState(persistedStateFromManaged(app));
}

async function persistAppState(state: PersistedAppState): Promise<void> {
  const value = JSON.stringify(state);
  const previous = appStateWrites.get(state.appId) || Promise.resolve();
  const result = previous.catch(() => undefined).then(async () => {
    await prisma.systemSetting.upsert({
      where: { key: appStateKey(state.appId) },
      create: { key: appStateKey(state.appId), value },
      update: { value },
    });
  });
  const tail = result.then(() => undefined, () => undefined);
  appStateWrites.set(state.appId, tail);
  try {
    await result;
  } finally {
    if (appStateWrites.get(state.appId) === tail) appStateWrites.delete(state.appId);
  }
}

async function loadAppState(appId: string): Promise<PersistedAppState | null> {
  const record = await prisma.systemSetting.findUnique({ where: { key: appStateKey(appId) } }).catch(() => null);
  if (!record) return null;
  try {
    const state = JSON.parse(record.value) as PersistedAppState;
    if (
      state?.version !== 2
      || state.appId !== appId
      || typeof state.deployId !== 'string'
      || !Number.isInteger(state.port)
      || typeof state.containerName !== 'string'
      || typeof state.deployPath !== 'string'
      || typeof state.actorId !== 'string'
      || typeof state.projectId !== 'string'
      || state.workloadId !== appId
    ) return null;
    return state;
  } catch {
    return null;
  }
}

function clearStartupTimer(app: ManagedApp): void {
  if (!app.startupTimer) return;
  clearTimeout(app.startupTimer);
  app.startupTimer = undefined;
}

function reconcileManagedApp(app: ManagedApp, persist = true): AppProcessStatus {
  const state = inspectProjectAppContainer(app.containerName);
  if (!state) {
    app.status = app.desiredStatus === 'running' ? 'error' : 'stopped';
    app.lastError = 'Project app container is not present';
  } else {
    const restartDelta = Math.max(0, state.restartCount - app.containerRestartCount);
    app.restartCount += restartDelta;
    app.containerRestartCount = state.restartCount;

    if (state.running) {
      app.status = 'running';
      app.lastError = undefined;
    } else if ((state.status === 'created' || state.status === 'restarting') && Date.now() < app.startupDeadlineAt) {
      app.status = 'starting';
      app.lastError = state.error || undefined;
    } else {
      app.status = 'error';
      app.desiredStatus = 'error';
      app.lastError = state.error
        || (app.restartCount >= MAX_RESTART_ATTEMPTS
          ? `Container crashed ${app.restartCount} times and exhausted its restart budget`
          : `Container exited with code ${state.exitCode}`);
    }
  }

  if (persist) {
    void updateAppStatus(app.appId, app.status);
    void persistManagedApp(app).catch((error: any) => {
      console.error(`[AppProcess] Failed to persist runtime state for ${app.deployId}:`, error?.message || error);
    });
  }
  return app.status;
}

function scheduleStartupProbe(app: ManagedApp): void {
  clearStartupTimer(app);
  const operationId = app.operationId;
  app.startupTimer = setTimeout(() => {
    if (
      runningApps.get(app.deployId) !== app
      || app.operationId !== operationId
      || app.desiredStatus !== 'running'
    ) return;
    app.startupTimer = undefined;
    const status = reconcileManagedApp(app);
    if (status === 'starting') scheduleStartupProbe(app);
  }, STARTUP_PROBE_DELAY_MS);
  app.startupTimer.unref?.();
}

async function stopAppUnlocked(
  deployId: string,
  options: { updateDatabase?: boolean; desiredStatus?: 'stopped' | 'error' } = {},
): Promise<void> {
  const app = runningApps.get(deployId);
  if (app) {
    clearStartupTimer(app);
    app.operationId = crypto.randomUUID();
    app.status = options.desiredStatus || 'stopped';
    app.desiredStatus = options.desiredStatus || 'stopped';
  }

  console.log(`[AppProcess] Stopping sandboxed ${deployId}...`);
  if (app) await stopProjectAppContainer(app.runtimePlan);
  if (runningApps.get(deployId) === app) runningApps.delete(deployId);

  if (app) {
    await persistManagedApp(app);
    if (options.updateDatabase !== false) {
      await updateAppStatus(app.appId, app.status);
    }
  }
}

async function startAppUnlocked(
  appId: string,
  deployId: string,
  deployPath: string,
  port: number,
  runtimeIdentity: ProjectAppRuntimeIdentity,
  restartCount = 0,
): Promise<ManagedApp> {
  if (shuttingDown) throw new Error('App process runtime is shutting down');
  await stopAppUnlocked(deployId);

  const lease = await claimPortLease(port, appId, deployId);
  try {
    if (shuttingDown) throw new Error('App process runtime is shutting down');
    const nmPath = path.join(deployPath, 'node_modules');
    if (!fs.existsSync(nmPath)) {
      console.log(`[AppProcess] Installing dependencies in project sandbox for ${deployId}...`);
      try {
        await runProjectLifecycleCommand({
          actorId: runtimeIdentity.actorId,
          projectId: runtimeIdentity.projectId,
          workspace: deployPath,
          command: 'npm',
          args: ['install', '--omit=dev', '--no-audit', '--no-fund'],
          timeoutMs: 180_000,
          nameHint: `${deployId}:install`,
          production: true,
          network: true,
        });
      } catch (e: any) {
        console.error(`[AppProcess] npm install failed for ${deployId}:`, e.message);
        await updateAppStatus(appId, 'error');
        throw new Error(`Dependency install failed: ${e.message}`);
      }
    }

    console.log(`[AppProcess] Starting sandboxed ${deployId} on port ${port}...`);
    const container = await startProjectAppContainer({
      actorId: runtimeIdentity.actorId,
      projectId: runtimeIdentity.projectId,
      workspace: deployPath,
      command: 'npm',
      args: ['start'],
      nameHint: deployId,
      port,
      production: true,
      mode: 'app',
      workloadId: runtimeIdentity.workloadId,
      network: true,
    });

    const managed: ManagedApp = {
      appId,
      deployId,
      port,
      containerName: container.containerName,
      containerId: container.containerId,
      networkAddress: container.networkAddress,
      status: 'starting',
      restartCount,
      containerRestartCount: 0,
      deployPath,
      desiredStatus: 'running',
      startupDeadlineAt: Date.now() + STARTUP_TIMEOUT_MS,
      operationId: crypto.randomUUID(),
      runtimeIdentity,
      runtimePlan: container.plan,
    };
    runningApps.set(deployId, managed);
    await updateAppStatus(appId, 'starting');
    await persistManagedApp(managed);
    await waitForRuntimeReadiness(managed);
    scheduleStartupProbe(managed);
    return managed;
  } catch (error) {
    const current = runningApps.get(deployId);
    if (current?.appId === appId) {
      clearStartupTimer(current);
      runningApps.delete(deployId);
    }
    await stopProjectAppContainer(runtimeIdentity);
    await updateAppStatus(appId, 'error');
    throw error;
  } finally {
    await releasePortLease(lease);
  }
}

/**
 * Start a full-stack app process
 */
export async function startApp(
  appId: string,
  deployId: string,
  deployPath: string,
  port: number,
  identity: { actorId: string; projectId: string },
): Promise<ManagedApp> {
  const runtimeIdentity = { ...identity, workloadId: appId };
  return withDeployLock(deployId, () => startAppUnlocked(appId, deployId, deployPath, port, runtimeIdentity, 0));
}

/**
 * Restart a full-stack app without opening an interleaving start/stop window.
 */
export async function restartApp(
  appId: string,
  deployId: string,
  deployPath: string,
  port: number,
  identity: { actorId: string; projectId: string },
): Promise<ManagedApp> {
  const runtimeIdentity = { ...identity, workloadId: appId };
  return withDeployLock(deployId, async () => {
    await stopAppUnlocked(deployId);
    return startAppUnlocked(appId, deployId, deployPath, port, runtimeIdentity, 0);
  });
}

/**
 * Stop an app process
 */
export async function stopApp(deployId: string): Promise<void> {
  await withDeployLock(deployId, () => stopAppUnlocked(deployId));
}

/**
 * Remove all process-manager state for one immutable Project App. Callers must
 * separately remove the attested deployment directory and App database row.
 */
export async function forgetAppRuntime(
  appId: string,
  deployId: string,
  identity: { actorId: string; projectId: string },
): Promise<void> {
  await withDeployLock(deployId, async () => {
    await stopAppUnlocked(deployId);
    await stopProjectAppContainer({
      actorId: identity.actorId,
      projectId: identity.projectId,
      workloadId: appId,
    });
    await prisma.systemSetting.deleteMany({
      where: { key: appStateKey(appId) },
    });
  });
}

/**
 * Get status and logs for a running app
 */
export function getAppStatus(deployId: string): { status: string; port?: number; logs: string[]; lastError?: string; restartCount: number } | null {
  const app = runningApps.get(deployId);
  if (!app) return null;

  reconcileManagedApp(app);

  return {
    status: app.status,
    port: app.port,
    logs: readProjectAppLogs(app.containerName, 50),
    lastError: app.lastError,
    restartCount: app.restartCount,
  };
}

/**
 * List all running apps
 */
export function listRunningApps(): Array<{ deployId: string; port: number; status: string; appId: string }> {
  return Array.from(runningApps.entries()).map(([deployId, app]) => {
    reconcileManagedApp(app);
    return { deployId, port: app.port, status: app.status, appId: app.appId };
  });
}

/**
 * Return the server-attested internal upstream for a managed full-stack app.
 * This address comes from the exact Docker network attachment attested during
 * startup; no caller-controlled hostname or host port participates.
 */
export function getAppTarget(deployId: string): string | null {
  const app = runningApps.get(deployId);
  if (!app) return null;
  reconcileManagedApp(app);
  if (app.status === 'error' || app.status === 'stopped') return null;
  return `http://${app.networkAddress}:${app.port}`;
}

async function updateAppStatus(appId: string, status: string): Promise<void> {
  const previous = appStatusWrites.get(appId) || Promise.resolve();
  const result = previous.catch(() => undefined).then(async () => {
    try {
      await prisma.app.update({
        where: { id: appId },
        data: { processStatus: status },
      });
    } catch (e: any) {
      console.error(`[AppProcess] Failed to update DB status for ${appId}:`, e.message);
    }
  });
  const tail = result.then(() => undefined, () => undefined);
  appStatusWrites.set(appId, tail);
  try {
    await result;
  } finally {
    if (appStatusWrites.get(appId) === tail) appStatusWrites.delete(appId);
  }
}

/**
 * Restore running apps on server startup
 */
export async function restoreRunningApps(): Promise<void> {
  const apps = await prisma.app.findMany({
    where: { deployType: 'fullstack' },
  });

  // Resolve every persisted running intent before mutating any App status or
  // container. If continuity enrollment did not produce an exact immutable
  // Project association, startup must fail so the installer can roll back;
  // converting that intent to "error" would destroy the evidence needed to
  // retry the upgrade safely.
  const runtimeIdentities = new Map<string, ProjectAppRuntimeIdentity | null>();
  for (const app of apps) {
    // The immutable foreign key is the only authority to enter a Project
    // runtime. An owner/name coincidence may describe a standalone App and
    // must never borrow a same-named Project's container identity.
    const projectIdentity = app.projectIdentityId
      ? await prisma.projectIdentity.findUnique({
        where: { id: app.projectIdentityId },
        select: {
          id: true,
          workspaceOwnerId: true,
          projectName: true,
          lifecycleStatus: true,
        },
      }).catch(() => null)
      : null;
    const runtimeIdentity: ProjectAppRuntimeIdentity | null = (
      projectIdentity?.lifecycleStatus === 'ACTIVE'
      && projectIdentity.workspaceOwnerId === app.userId
      && projectIdentity.projectName === app.name
    )
      ? { actorId: app.userId, projectId: projectIdentity.id, workloadId: app.id }
      : null;
    if (
      (app.processStatus === 'running' || app.processStatus === 'starting')
      && !runtimeIdentity
    ) {
      throw new Error(
        'A persisted running full-stack App did not have an exact immutable Project association',
      );
    }
    runtimeIdentities.set(app.id, runtimeIdentity);
  }

  for (const app of apps) {
    const deployId = `${app.userId}-${app.name}`;
    const persisted = await loadAppState(app.id);
    const runtimeIdentity = runtimeIdentities.get(app.id) || null;
    const restartCount = persisted?.deployId === deployId ? Math.max(0, persisted.restartCount || 0) : 0;

    if (app.processStatus !== 'running' && app.processStatus !== 'starting') {
      // DB intent is authoritative for stopped/error apps. Remove any stale
      // container left behind by an ungraceful pre-hardening Portal shutdown.
      await stopProjectAppContainer(runtimeIdentity);
      if (persisted) {
        const status: 'error' | 'stopped' = app.processStatus === 'error' ? 'error' : 'stopped';
        await persistAppState({
          ...persisted,
          status,
          desiredStatus: status,
          updatedAt: new Date().toISOString(),
        });
      }
      continue;
    }

    if (!runtimeIdentity) {
      throw new Error(
        'A persisted running full-stack App lost its immutable Project association during startup',
      );
    }

    if (!app.port || !app.zipPath || !fs.existsSync(app.zipPath)) {
      const error = !app.port ? 'App has no persisted port' : 'App deployment path is unavailable';
      await updateAppStatus(app.id, 'error');
      if (persisted) {
        await persistAppState({ ...persisted, status: 'error', desiredStatus: 'error', lastError: error, updatedAt: new Date().toISOString() });
      }
      continue;
    }

    if (persisted?.desiredStatus === 'error') {
      await updateAppStatus(app.id, 'error');
      continue;
    }

    console.log(`[AppProcess] Reconciling ${deployId} on port ${app.port}...`);
    try {
      const existingState = inspectProjectAppContainer(projectAppContainerName(runtimeIdentity));

      if (persisted && existingState && !existingState.running) {
        const totalRestarts = restartCount + Math.max(0, existingState.restartCount - (persisted.containerRestartCount || 0));
        await updateAppStatus(app.id, 'error');
        await persistAppState({
          ...persisted,
          status: 'error',
          desiredStatus: 'error',
          restartCount: totalRestarts,
          containerRestartCount: existingState.restartCount,
          lastError: existingState.error || `Container exited with code ${existingState.exitCode}`,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      if (restartCount >= MAX_RESTART_ATTEMPTS) {
        await updateAppStatus(app.id, 'error');
        if (persisted) {
          await persistAppState({
            ...persisted,
            status: 'error',
            desiredStatus: 'error',
            lastError: `Container exhausted its durable restart budget (${restartCount})`,
            updatedAt: new Date().toISOString(),
          });
        }
        continue;
      }

      await withDeployLock(deployId, () => startAppUnlocked(
        app.id,
        deployId,
        app.zipPath,
        app.port as number,
        runtimeIdentity,
        restartCount,
      ));
    } catch (e: any) {
      console.error(`[AppProcess] Failed to reconcile ${deployId}:`, e.message);
      await updateAppStatus(app.id, 'error');
    }
  }
}

/**
 * Idempotent Portal-start hook. Call after the database health check and before
 * accepting HTTP traffic that proxies to hosted apps.
 */
export async function initializeAppProcessRuntime(): Promise<void> {
  shuttingDown = false;
  if (!startupPromise) {
    startupPromise = restoreRunningApps().catch((error) => {
      startupPromise = null;
      throw error;
    });
  }
  await startupPromise;
}

/**
 * Graceful shutdown — stop all running apps
 */
export function shutdownAll(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    // A start can be between dependency preparation and registry insertion.
    // Drain every already-admitted deploy operation after closing admission.
    await Promise.allSettled(Array.from(deployOperations.values()));
    console.log(`[AppProcess] Shutting down ${runningApps.size} running app(s)...`);
    // Keep running/starting DB intent intact so initializeAppProcessRuntime can
    // distinguish a graceful Portal restart from an admin stop.
    for (const [deployId, app] of Array.from(runningApps.entries())) {
      try {
        clearStartupTimer(app);
        reconcileManagedApp(app, false);
        app.desiredStatus = app.status === 'error' ? 'error' : 'running';
        if (app.desiredStatus === 'running') app.status = 'stopped';
        await persistManagedApp(app);
      } catch (e: any) {
        console.error(`[AppProcess] Failed to persist shutdown state for ${deployId}:`, e.message);
      }
      try {
        await stopProjectAppContainer(app.runtimePlan);
        if (runningApps.get(deployId) === app) runningApps.delete(deployId);
        console.log(`[AppProcess] Stopped sandboxed ${deployId}`);
      } catch (e: any) {
        console.error(`[AppProcess] Failed to stop ${deployId}:`, e.message);
      }
    }
    runningApps.clear();

    const leases = Array.from(portLeases.values());
    portLeases.clear();
    await Promise.all(leases.map((lease) => prisma.systemSetting.deleteMany({
      where: { key: portLeaseKey(lease.port), value: lease.serialized },
    }).catch(() => undefined)));
    await Promise.allSettled([
      ...Array.from(appStatusWrites.values()),
      ...Array.from(appStateWrites.values()),
    ]);
  })();
  return shutdownPromise;
}

export const __appProcessTest = {
  APP_STATE_PREFIX,
  PORT_LEASE_PREFIX,
  STARTUP_PROBE_DELAY_MS,
  STARTUP_TIMEOUT_MS,
  runningApps,
  portLeases,
  resetRuntimeState(): void {
    for (const app of runningApps.values()) clearStartupTimer(app);
    runningApps.clear();
    portLeases.clear();
    deployOperations.clear();
    appStatusWrites.clear();
    appStateWrites.clear();
    portAllocationQueue = Promise.resolve();
    startupPromise = null;
    shutdownPromise = null;
    shuttingDown = false;
    readinessProbe = probeRuntimeHttp;
  },
  setReadinessProbe(probe: ReadinessProbe): void {
    readinessProbe = probe;
  },
};
