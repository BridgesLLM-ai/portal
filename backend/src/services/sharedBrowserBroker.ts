import fs from 'fs';
import http from 'http';
import path from 'path';
import net from 'net';
import { SharedBrowserError, SHARED_BROWSER_OWNER_DIR, SHARED_BROWSER_SOCKET, sharedInteractiveBrowser, type BrowserCaller } from './sharedInteractiveBrowser';

export function sharedBrowserEnabled(): boolean {
  return process.env.SHARED_INTERACTIVE_BROWSER_ENABLED === '1';
}
let brokerReady = false;
export function sharedBrowserOwnerId(): string | null {
  const value = process.env.SHARED_INTERACTIVE_BROWSER_OWNER_ID || '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
}
export const sharedBrowserRuntimeReady = () => sharedBrowserEnabled() && brokerReady;
export async function startSharedBrowserBroker(authorize: (caller: BrowserCaller) => Promise<void>): Promise<http.Server | null> {
  if (!sharedBrowserEnabled()) return null;
  const ownerId = sharedBrowserOwnerId();
  if (!ownerId) throw new Error('An explicit Portal owner is required for the persistent shared browser');
  const directory = path.dirname(SHARED_BROWSER_SOCKET);
  // Provisioning owns directory creation. Do not silently repair unsafe socket custody.
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o7777) !== 0o700) {
    throw new Error('Shared browser broker requires a root-owned 0700 directory');
  }
  // Release never transfers persistent cookies to a different Portal principal.
  const ownershipDirectory = SHARED_BROWSER_OWNER_DIR;
  const ownershipStat = fs.lstatSync(ownershipDirectory);
  if (!ownershipStat.isDirectory() || ownershipStat.isSymbolicLink() || ownershipStat.uid !== 0 || (ownershipStat.mode & 0o7777) !== 0o700) throw new Error('Unsafe persistent profile-owner directory');
  const ownerFile = path.join(ownershipDirectory, 'profile-owner.json');
  if (fs.existsSync(ownerFile)) {
    const ownerStat = fs.lstatSync(ownerFile);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.uid !== 0 || (ownerStat.mode & 0o7777) !== 0o600 || ownerStat.size > 128
      || JSON.parse(fs.readFileSync(ownerFile, 'utf8')) !== ownerId) throw new Error('Shared profile owner differs or custody is unsafe; explicit dedicated-profile reset required');
  } else {
    throw new Error('Shared browser profile owner has not been explicitly commissioned');
  }
  if (fs.existsSync(SHARED_BROWSER_SOCKET)) {
    const existing = fs.lstatSync(SHARED_BROWSER_SOCKET);
    if (!existing.isSocket() || existing.uid !== 0 || (existing.mode & 0o7777) !== 0o600) throw new Error('Unsafe shared browser socket');
    await new Promise<void>((resolve, reject) => {
      const probe = net.createConnection(SHARED_BROWSER_SOCKET);
      probe.once('connect', () => { probe.destroy(); reject(new Error('Shared browser broker already running')); });
      probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('Shared browser socket state unconfirmed')); });
      probe.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNREFUSED') { reject(error); return; }
        try {
          const current = fs.lstatSync(SHARED_BROWSER_SOCKET);
          if (current.ino !== existing.ino || current.dev !== existing.dev) { reject(new Error('Shared browser socket changed')); return; }
          fs.unlinkSync(SHARED_BROWSER_SOCKET); resolve();
        } catch (failure) { reject(failure); }
      });
    });
  }
  const pendingFile = path.join(directory, 'inflight.json');
  let pending: string | null = null;
  if (fs.existsSync(pendingFile)) {
    const pendingStat = fs.lstatSync(pendingFile);
    if (!pendingStat.isFile() || pendingStat.isSymbolicLink() || pendingStat.uid !== 0 || (pendingStat.mode & 0o7777) !== 0o600 || pendingStat.size > 4096) throw new Error('Unsafe browser inflight marker');
    pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    if (typeof pending !== 'string' || pending.length > 2048) throw new Error('Invalid browser inflight marker');
  }
  browserPersistence(pendingFile, pending);
  const server = http.createServer(async (req, res) => {
    try {
      if (!sharedBrowserEnabled() || req.method !== 'POST' || req.url !== '/v1/browser') throw new SharedBrowserError(404, 'Unavailable');
      let raw = ''; for await (const chunk of req) { raw += chunk.toString(); if (Buffer.byteLength(raw) > 4096) throw new SharedBrowserError(413, 'Request too large'); }
      const body = JSON.parse(raw);
      const caller = body.caller as BrowserCaller;
      if (!caller || typeof caller.agentId !== 'string' || typeof caller.sessionKey !== 'string'
        || caller.sessionKey.length > 512 || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(caller.agentId)) throw new SharedBrowserError(403, 'Trusted caller missing');
      // Finish remains available after revocation, but cannot confer any new control.
      if (body.action === 'finish') sharedInteractiveBrowser.finish(caller);
      else {
        await authorize(caller);
        if (body.action === 'begin') sharedInteractiveBrowser.begin(caller);
        else if (body.action === 'handover') sharedInteractiveBrowser.requestHandover(caller);
        else if (body.action === 'select') sharedInteractiveBrowser.ownsCaller(caller);
        else throw new SharedBrowserError(400, 'Unknown action');
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(error instanceof SharedBrowserError ? error.status : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: error instanceof SharedBrowserError ? error.message : 'Shared browser admission unavailable' }));
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(SHARED_BROWSER_SOCKET, () => { server.off('error', reject); resolve(); }); });
  fs.chmodSync(SHARED_BROWSER_SOCKET, 0o600);
  brokerReady = true;
  server.on('error', () => { brokerReady = false; sharedInteractiveBrowser.revoke(ownerId); });
  server.on('close', () => { brokerReady = false; try { fs.unlinkSync(SHARED_BROWSER_SOCKET); } catch { /* already removed */ } });
  return server;
}

function browserPersistence(file: string, pending: string | null): void {
  sharedInteractiveBrowser.restoreCall(pending, key => {
    if (key === null) { fs.unlinkSync(file); return; }
    // Persist before granting the call. A backend crash cannot grant human input over a still-running action.
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(key)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
  });
}
