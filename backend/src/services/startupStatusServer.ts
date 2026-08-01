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

export function setStartupPhase(phase: string): void {
  currentPhase = phase;
}

export function getStartupPhase(): string {
  return currentPhase;
}

export async function startStartupStatusServer(port: number, host: string): Promise<void> {
  if (statusServer) return;
  startedAtIso = new Date().toISOString();
  const server = createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
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
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  statusServer = server;
}

export async function stopStartupStatusServer(): Promise<void> {
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
