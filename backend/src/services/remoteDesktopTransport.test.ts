import fs from 'fs';
import { desktopSocketMetadataIsPrivate } from './remoteDesktopTransport';

const metadata = (kind: 'directory' | 'socket' | 'symlink', uid: number, gid: number, mode: number) => ({
  uid, gid, mode,
  isDirectory: () => kind === 'directory',
  isSocket: () => kind === 'socket',
  isSymbolicLink: () => kind === 'symlink',
} as fs.Stats);
const identity = { uid: 990, gid: 976 };
const parent = metadata('directory', 0, 0, 0o755);
const directory = metadata('directory', 990, 976, 0o700);
const socket = metadata('socket', 990, 976, 0o600);

describe('private desktop transport custody', () => {
  test('accepts only the desktop account private directory and socket under protected root state', () => {
    expect(desktopSocketMetadataIsPrivate(parent, directory, socket, identity)).toBe(true);
  });
  test.each([
    ['world-traversable directory', parent, metadata('directory', 990, 976, 0o755), socket],
    ['writable parent', metadata('directory', 0, 0, 0o777), directory, socket],
    ['foreign parent', metadata('directory', 1000, 0, 0o755), directory, socket],
    ['linked directory', parent, metadata('symlink', 990, 976, 0o700), socket],
    ['foreign socket', parent, directory, metadata('socket', 1000, 976, 0o600)],
    ['permissive socket', parent, directory, metadata('socket', 990, 976, 0o666)],
    ['linked socket', parent, directory, metadata('symlink', 990, 976, 0o600)],
  ])('refuses %s', (_label, p, d, s) => {
    expect(desktopSocketMetadataIsPrivate(p as fs.Stats, d as fs.Stats, s as fs.Stats, identity)).toBe(false);
  });
});


// Exercise the actual proxy upgrade over real Unix sockets, not a mocked HTTP
// adapter. This catches target options which look valid but fail in Node.
test.each([true, false])('private HTTP upgrade has available target=%s and settles without hanging', async (available) => {
  const http = await import('http');
  const os = await import('os');
  const path = await import('path');
  const { WebSocket, WebSocketServer } = await import('ws');
  const { createDesktopWebSocketProxy } = await import('./remoteDesktopTransport');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ws-proof-'));
  const target = http.createServer();
  const entry = http.createServer();
  const wss = new WebSocketServer({ server: target });
  let client: InstanceType<typeof WebSocket> | undefined;
  const connections = new Set<import('net').Socket>();
  entry.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  try {
    const listen = (server: typeof entry, file: string) => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(file, resolve);
    });
    wss.on('connection', socket => socket.on('message', payload => socket.send(payload)));
    if (available) await listen(target, path.join(root, 'target.sock'));
    const proxy = createDesktopWebSocketProxy(path.join(root, 'target.sock'));
    entry.on('upgrade', (req, socket, head) => proxy.upgrade!(req, socket as import('net').Socket, head));
    await listen(entry, path.join(root, 'entry.sock'));
    const payload = Buffer.from([0, 1, 2, 128, 255]);
    const exchange = new Promise<Buffer>((resolve, reject) => {
      client = new WebSocket(`ws+unix:${path.join(root, 'entry.sock')}:/novnc/websockify`, { handshakeTimeout: 2000 });
      client.once('error', reject);
      client.once('open', () => client!.send(payload));
      client.once('message', frame => resolve(Buffer.from(frame as Buffer)));
    });
    if (available) expect(await exchange).toEqual(payload);
    else await expect(exchange).rejects.toMatchObject({ code: 'ECONNRESET' });
  } finally {
    client?.terminate();
    for (const socket of connections) socket.destroy();
    for (const socket of wss.clients) socket.terminate();
    await Promise.all([
      new Promise<void>(resolve => wss.close(() => resolve())),
      new Promise<void>(resolve => target.close(() => resolve())),
      new Promise<void>(resolve => entry.close(() => resolve())),
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);
