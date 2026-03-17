/**
 * App Process Manager
 * Manages full-stack app deployments — spawns/monitors/restarts Node.js backend processes
 * for projects that have a package.json with a "start" script.
 */

import { ChildProcess, spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Port range for full-stack apps: 5001-5099
const PORT_RANGE_START = 5001;
const PORT_RANGE_END = 5099;

interface ManagedApp {
  appId: string;
  deployId: string;
  port: number;
  process: ChildProcess;
  status: 'starting' | 'running' | 'stopped' | 'error';
  restartCount: number;
  lastError?: string;
  restartTimer?: NodeJS.Timeout;
  logs: string[];
  deployPath: string;
}

const MAX_LOG_LINES = 200;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_COOLDOWN_MS = 5000;

// In-memory registry of running app processes
const runningApps: Map<string, ManagedApp> = new Map();

/**
 * Detect if a project is full-stack (has package.json with start script)
 */
export function detectDeployType(projectDir: string): 'static' | 'fullstack' {
  const pkgPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'static';
  
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg.scripts?.start) return 'fullstack';
    if (pkg.scripts?.build) return 'static';
  } catch {}
  
  return 'static';
}

/**
 * Allocate an unused port from the range
 */
export async function allocatePort(): Promise<number> {
  const usedPorts = await prisma.app.findMany({
    where: { port: { not: null } },
    select: { port: true },
  });
  
  const usedSet = new Set(usedPorts.map(a => a.port));
  
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!usedSet.has(p) && !isPortInUseByProcess(p)) {
      return p;
    }
  }
  
  throw new Error('No available ports in range 5001-5099');
}

function isPortInUseByProcess(port: number): boolean {
  for (const app of runningApps.values()) {
    if (app.port === port) return true;
  }
  return false;
}

/**
 * Start a full-stack app process
 */
export async function startApp(appId: string, deployId: string, deployPath: string, port: number): Promise<ManagedApp> {
  // Kill existing if running
  await stopApp(deployId);
  
  // Install dependencies if needed
  const nmPath = path.join(deployPath, 'node_modules');
  if (!fs.existsSync(nmPath)) {
    console.log(`[AppProcess] Installing dependencies for ${deployId}...`);
    try {
      execSync('npm install --production 2>&1', { 
        cwd: deployPath, 
        timeout: 120000, 
        encoding: 'utf-8',
        env: { ...process.env, PORT: String(port) },
      });
    } catch (e: any) {
      console.error(`[AppProcess] npm install failed for ${deployId}:`, e.message);
      throw new Error(`Dependency install failed: ${e.message}`);
    }
  }
  
  console.log(`[AppProcess] Starting ${deployId} on port ${port}...`);
  
  // Kill any stale process on this port before starting
  try {
    const { execSync: es } = require('child_process');
    es(`fuser -k ${port}/tcp 2>/dev/null || true`, { shell: true });
    await new Promise(r => setTimeout(r, 500));
  } catch { /* ignore */ }

  const child = spawn('npm', ['start'], {
    cwd: deployPath,
    env: { 
      ...process.env, 
      PORT: String(port),
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  
  const managed: ManagedApp = {
    appId,
    deployId,
    port,
    process: child,
    status: 'starting',
    restartCount: 0,
    logs: [],
    deployPath,
  };
  
  child.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      managed.logs.push(`[out] ${line}`);
      if (managed.logs.length > MAX_LOG_LINES) managed.logs.shift();
      
      if (managed.status === 'starting' && /listen|started|ready|running/i.test(line)) {
        managed.status = 'running';
        updateAppStatus(appId, 'running').catch(() => {});
        console.log(`[AppProcess] ${deployId} is running on port ${port}`);
      }
    }
  });
  
  child.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      managed.logs.push(`[err] ${line}`);
      if (managed.logs.length > MAX_LOG_LINES) managed.logs.shift();
    }
  });
  
  child.on('exit', (code, signal) => {
    console.log(`[AppProcess] ${deployId} exited (code=${code}, signal=${signal})`);
    managed.status = 'stopped';
    
    if (code !== 0 && managed.restartCount < MAX_RESTART_ATTEMPTS) {
      managed.restartCount++;
      managed.lastError = `Exited with code ${code}`;
      console.log(`[AppProcess] Restarting ${deployId} (attempt ${managed.restartCount}/${MAX_RESTART_ATTEMPTS})...`);
      
      managed.restartTimer = setTimeout(() => {
        startApp(appId, deployId, deployPath, port).catch(err => {
          console.error(`[AppProcess] Restart failed for ${deployId}:`, err.message);
          updateAppStatus(appId, 'error').catch(() => {});
        });
      }, RESTART_COOLDOWN_MS);
    } else if (code !== 0) {
      managed.status = 'error';
      managed.lastError = `Crashed ${MAX_RESTART_ATTEMPTS} times, giving up`;
      updateAppStatus(appId, 'error').catch(() => {});
    }
  });
  
  child.on('error', (err) => {
    console.error(`[AppProcess] Spawn error for ${deployId}:`, err.message);
    managed.status = 'error';
    managed.lastError = err.message;
    updateAppStatus(appId, 'error').catch(() => {});
  });
  
  // Mark as running after 5s if no "listening" message detected
  const startupTimer = setTimeout(() => {
    if (managed.status === 'starting') {
      managed.status = 'running';
      updateAppStatus(appId, 'running').catch(() => {});
      console.log(`[AppProcess] ${deployId} assumed running (no listen message detected)`);
    }
  }, 5000);
  
  runningApps.set(deployId, managed);
  return managed;
}

/**
 * Stop an app process
 */
export async function stopApp(deployId: string): Promise<void> {
  const app = runningApps.get(deployId);
  if (!app) return;
  
  console.log(`[AppProcess] Stopping ${deployId}...`);
  if (app.restartTimer) { clearTimeout(app.restartTimer); app.restartTimer = undefined; }
  
  try {
    app.process.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try { app.process.kill('SIGKILL'); } catch {}
        resolve();
      }, 5000);
      
      app.process.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  } catch {}
  
  runningApps.delete(deployId);
  
  if (app.appId) {
    await updateAppStatus(app.appId, 'stopped').catch(() => {});
  }
}

/**
 * Get status and logs for a running app
 */
export function getAppStatus(deployId: string): { status: string; port?: number; logs: string[]; lastError?: string; restartCount: number } | null {
  const app = runningApps.get(deployId);
  if (!app) return null;
  
  return {
    status: app.status,
    port: app.port,
    logs: app.logs.slice(-50),
    lastError: app.lastError,
    restartCount: app.restartCount,
  };
}

/**
 * List all running apps
 */
export function listRunningApps(): Array<{ deployId: string; port: number; status: string; appId: string }> {
  return Array.from(runningApps.entries()).map(([deployId, app]) => ({
    deployId,
    port: app.port,
    status: app.status,
    appId: app.appId,
  }));
}

/**
 * Get the port for a running app (used by proxy)
 */
export function getAppPort(deployId: string): number | null {
  const app = runningApps.get(deployId);
  if (!app || app.status === 'error') return null;
  return app.port;
}

async function updateAppStatus(appId: string, status: string): Promise<void> {
  try {
    await prisma.app.update({
      where: { id: appId },
      data: { processStatus: status },
    });
  } catch (e: any) {
    console.error(`[AppProcess] Failed to update DB status for ${appId}:`, e.message);
  }
}

/**
 * Restore running apps on server startup
 */
export async function restoreRunningApps(): Promise<void> {
  try {
    const apps = await prisma.app.findMany({
      where: { deployType: 'fullstack', processStatus: 'running' },
    });
    
    for (const app of apps) {
      if (!app.port || !app.zipPath || !fs.existsSync(app.zipPath)) {
        await updateAppStatus(app.id, 'stopped');
        continue;
      }
      
      const deployId = `${app.userId}-${app.name}`;
      console.log(`[AppProcess] Restoring ${deployId} on port ${app.port}...`);
      
      try {
        await startApp(app.id, deployId, app.zipPath, app.port);
      } catch (e: any) {
        console.error(`[AppProcess] Failed to restore ${deployId}:`, e.message);
        await updateAppStatus(app.id, 'error');
      }
    }
  } catch (e: any) {
    console.error('[AppProcess] Failed to restore running apps:', e.message);
  }
}

/**
 * Graceful shutdown — stop all running apps
 */
export async function shutdownAll(): Promise<void> {
  console.log(`[AppProcess] Shutting down ${runningApps.size} running app(s)...`);
  // Kill processes but DON'T update DB status — leave as 'running' for restore on restart
  for (const [id, app] of runningApps) {
    try {
      if (app.restartTimer) clearTimeout(app.restartTimer);
      app.process.kill('SIGTERM');
      console.log(`[AppProcess] Killed ${id}`);
    } catch (e: any) {
      console.error(`[AppProcess] Failed to kill ${id}:`, e.message);
    }
  }
  runningApps.clear();
}
