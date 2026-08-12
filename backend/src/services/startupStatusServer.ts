import { createServer, type Server } from 'http';
import { PORTAL_VERSION } from '../version';

// Long blocking startup phases (legacy-project-retirement, secret encryption,
// runtime reconciliation) intentionally run before the real listener opens, so
// an updater probing /health cannot tell "still migrating" from "dead" and
// rolls back working updates. This bootstrap listener closes that
// gap: it binds the portal port immediately, reports only startup status, and
// fails closed for every other path. No request is processed, no route logic
// is reachable, and the socket is released before the real server binds.

let statusServer: Server | null = null;
let currentPhase = 'initializing';
let startedAtIso = '';
let failureHold = false;

export const PROJECT_DEPENDENCY_PROMOTION_QUARANTINE_CODE =
  'PROJECT_DEPENDENCY_PROMOTION_QUARANTINED' as const;
export const PROJECT_DEPENDENCY_PROMOTION_RECOVERY_PHASE =
  'project-dependency-promotion-recovery' as const;

export class StartupStatusServerFailureHoldError extends Error {
  constructor() {
    super('The startup status listener is held by an irreversible startup failure');
    this.name = 'StartupStatusServerFailureHoldError';
  }
}

export function setStartupPhase(phase: string): void {
  if (failureHold) return;
  currentPhase = phase;
}

export function getStartupPhase(): string {
  return currentPhase;
}

/**
 * Permanently hold this process in a sanitized status-only quarantine. The
 * state has no reset API: only explicit process shutdown may close the held
 * listener. No caller-controlled detail is accepted or reflected.
 */
export function holdStartupStatusServerForProjectDependencyPromotionQuarantine(): void {
  if (!failureHold) {
    failureHold = true;
    currentPhase = PROJECT_DEPENDENCY_PROMOTION_RECOVERY_PHASE;
  }
  // The bootstrap listener is normally unref'd so ordinary startup failures
  // can exit. Quarantine is an intentional operator-visible hold and must keep
  // the process alive until a shutdown signal arrives.
  statusServer?.ref();
}

export async function startStartupStatusServer(port: number, host: string): Promise<void> {
  if (statusServer) return;
  startedAtIso = new Date().toISOString();
  const server = createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (failureHold) {
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        connection: 'close',
        'retry-after': '60',
      });
      res.end(JSON.stringify({
        status: 'unavailable',
        code: PROJECT_DEPENDENCY_PROMOTION_QUARANTINE_CODE,
        phase: PROJECT_DEPENDENCY_PROMOTION_RECOVERY_PHASE,
        version: PORTAL_VERSION,
        startedAt: startedAtIso,
        timestamp: new Date().toISOString(),
      }));
      return;
    }
    const payload = {
      status: 'starting',
      phase: currentPhase,
      version: PORTAL_VERSION,
      startedAt: startedAtIso,
      timestamp: new Date().toISOString(),
    };
    const isHealth = req.method === 'GET' && (url === '/health' || url === '/health/update-ready');
    res.writeHead(isHealth ? 200 : 503, {
      'content-type': 'application/json',
      connection: 'close',
      'retry-after': '5',
    });
    res.end(JSON.stringify(payload));
  });
  if (failureHold) server.ref();
  else server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  statusServer = server;
  if (failureHold) server.ref();
}

export async function stopStartupStatusServer(): Promise<void> {
  if (failureHold) throw new StartupStatusServerFailureHoldError();
  await closeStartupStatusServer();
}

/** Process-shutdown-only close; deliberately does not clear the failure hold. */
export async function stopStartupStatusServerForShutdown(): Promise<void> {
  await closeStartupStatusServer();
}

async function closeStartupStatusServer(): Promise<void> {
  const server = statusServer;
  statusServer = null;
  if (!server) return;
  await new Promise<void>((resolve) => {
    // closeAllConnections ends keep-alive sockets so the port frees at once
    // and the real listener can bind without a lingering TIME_WAIT handle.
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
