import { createProxyMiddleware } from '../utils/portalProxy';
import fs from 'fs';
import net from 'net';

export const DESKTOP_TRANSPORT_ROOT = '/run/bridges-rd/transport';
export const DESKTOP_VNC_SOCKET = `${DESKTOP_TRANSPORT_ROOT}/vnc.sock`;
export const DESKTOP_WEBSOCKET_SOCKET = `${DESKTOP_TRANSPORT_ROOT}/websockify.sock`;

export function desktopSocketMetadataIsPrivate(
  parent: fs.Stats, directory: fs.Stats, socket: fs.Stats,
  identity: { uid: number; gid: number },
): boolean {
  return identity.uid > 0 && identity.gid > 0
    && parent.isDirectory() && !parent.isSymbolicLink()
    && parent.uid === 0 && parent.gid === 0 && (parent.mode & 0o022) === 0
    && directory.isDirectory() && !directory.isSymbolicLink()
    && directory.uid === identity.uid && directory.gid === identity.gid
    && (directory.mode & 0o7777) === 0o700
    && socket.isSocket() && !socket.isSymbolicLink()
    && socket.uid === identity.uid && socket.gid === identity.gid
    && (socket.mode & 0o7777) === 0o600;
}

export function desktopSocketIsPrivate(kind: 'vnc' | 'websockify'): boolean {
  try {
    const fields = fs.readFileSync('/etc/passwd', 'utf8').split('\n')
      .find(line => line.startsWith('bridgesrd:'))?.split(':');
    const identity = { uid: Number(fields?.[2]), gid: Number(fields?.[3]) };
    if (!Number.isSafeInteger(identity.uid) || !Number.isSafeInteger(identity.gid)) return false;
    return desktopSocketMetadataIsPrivate(
      fs.lstatSync('/run/bridges-rd'), fs.lstatSync(DESKTOP_TRANSPORT_ROOT),
      fs.lstatSync(kind === 'vnc' ? DESKTOP_VNC_SOCKET : DESKTOP_WEBSOCKET_SOCKET), identity,
    );
  } catch { return false; }
}

export async function desktopSocketReady(kind: 'vnc' | 'websockify'): Promise<boolean> {
  if (!desktopSocketIsPrivate(kind)) return false;
  return new Promise(resolve => {
    const socket = net.createConnection(kind === 'vnc' ? DESKTOP_VNC_SOCKET : DESKTOP_WEBSOCKET_SOCKET);
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function createDesktopWebSocketProxy(socketPath = DESKTOP_WEBSOCKET_SOCKET): ReturnType<typeof createProxyMiddleware> {
  const novncWsTarget = { socketPath, protocol: 'http:', host: 'localhost' };
  return createProxyMiddleware({
    target: novncWsTarget,
    ws: true,
    changeOrigin: true,
    pathRewrite: { '^/novnc/websockify': '/' },
    on: {
      error: (err: Error, _req: any, res: any) => {
        console.error('[noVNC WS] Proxy error:', err.message);
        if (res && typeof res.writeHead === 'function') {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('noVNC websocket bridge unavailable');
        } else if (res && typeof res.destroy === 'function') {
          // Upgrade errors receive the raw socket, not ServerResponse. Close it
          // promptly so the client can reconnect instead of hanging indefinitely.
          res.destroy();
        }
      },
    },
  } as any);
}
