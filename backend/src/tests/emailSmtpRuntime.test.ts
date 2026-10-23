import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import nodemailer from 'nodemailer';

const findMany = jest.fn();
jest.mock('../config/database', () => ({ prisma: { systemSetting: { findMany } } }));
jest.mock('../utils/authSecrets', () => ({ decryptSecret: (value: string) => value }));
import { sendEmail } from '../services/email';

// No outbound connection: a tiny SMTP peer records the actual envelope and MIME.
function smtpPeer(socket: net.Socket, commands: string[], messages: string[]) {
  let buffer = ''; let data = false; let message = '';
  socket.on('error', () => {});
  socket.write('220 fixture.example.test ESMTP\r\n');
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (data) {
        if (line === '.') { messages.push(message); data = false; message = ''; socket.write('250 queued\r\n'); }
        else message += `${line}\r\n`;
        continue;
      }
      commands.push(line);
      if (line.startsWith('EHLO')) socket.write('250-fixture\r\n250 AUTH PLAIN\r\n');
      else if (line.startsWith('AUTH')) socket.write('235 authenticated\r\n');
      else if (line.startsWith('RCPT TO:<refused@')) socket.write('550 no such recipient\r\n');
      else if (line === 'DATA') { data = true; socket.write('354 send message\r\n'); }
      else if (line === 'QUIT') socket.end('221 bye\r\n');
      else socket.write('250 ok\r\n');
    }
  });
}

describe('Nodemailer actual SMTP compatibility', () => {
  let server: net.Server;
  let sockets: Set<net.Socket>;
  let commands: string[];
  let messages: string[];
  let fixtureCertificate: Buffer;
  const original = { ORIGIN_MODE: process.env.ORIGIN_MODE, INSTALL_PROFILE: process.env.INSTALL_PROFILE };
  beforeEach(() => { sockets = new Set(); commands = []; messages = []; delete process.env.ORIGIN_MODE; process.env.INSTALL_PROFILE = 'server'; });
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  async function start(secure = false) {
    const handler = (socket: net.Socket) => { sockets.add(socket); smtpPeer(socket, commands, messages); };
    if (secure) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-smtp-tls-'));
      try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key'), '-out', path.join(root, 'cert'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
        fixtureCertificate = fs.readFileSync(path.join(root, 'cert'));
        server = tls.createServer({ key: fs.readFileSync(path.join(root, 'key')), cert: fixtureCertificate }, handler);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    } else server = net.createServer(handler);
    server.on('connection', (socket) => sockets.add(socket));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as net.AddressInfo).port;
    findMany.mockResolvedValue(Object.entries({ 'smtp.host': '127.0.0.1', 'smtp.port': String(port), 'smtp.secure': String(secure), 'smtp.user': 'sender@example.test', 'smtp.password': 'fixture-only', 'smtp.fromName': 'Portal Fixture', 'smtp.fromEmail': 'sender@example.test' }).map(([key, value]) => ({ key, value })));
    return port;
  }
  test('shipping mail service authenticates and delivers the intended envelope/body', async () => {
    await start();
    await sendEmail({ to: 'Owner <owner@example.test>', subject: 'SMTP fixture', text: 'fixture body', html: '<b>fixture body</b>' });
    expect(commands).toContain('MAIL FROM:<sender@example.test>');
    expect(commands).toContain('RCPT TO:<owner@example.test>');
    expect(commands.some((line) => line.startsWith('AUTH PLAIN '))).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Subject: SMTP fixture');
    expect(messages[0]).toContain('<b>fixture body</b>');
  });
  test('shipping mail service propagates rejected recipients without transmitting DATA', async () => {
    await start();
    await expect(sendEmail({ to: 'refused@example.test', subject: 'not delivered', text: 'body' })).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 550 });
    expect(commands).not.toContain('DATA'); expect(messages).toHaveLength(0);
  });
  test('shipping implicit-TLS path rejects an untrusted SMTP certificate before authentication', async () => {
    await start(true);
    await expect(sendEmail({ to: 'owner@example.test', subject: 'untrusted', text: 'body' })).rejects.toMatchObject({ code: 'ESOCKET' });
    expect(commands).toHaveLength(0); expect(messages).toHaveLength(0);
  });
  test('real implicit TLS authenticates with a fixture-only trusted CA and matching server name', async () => {
    const port = await start(true);
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port, secure: true, tls: { ca: fixtureCertificate, servername: 'localhost' }, auth: { user: 'sender@example.test', pass: 'fixture-only' } });
    await transport.sendMail({ from: 'sender@example.test', to: 'owner@example.test', subject: 'trusted fixture', text: 'TLS body' });
    expect(commands.some((line) => line.startsWith('AUTH PLAIN '))).toBe(true);
    expect(messages[0]).toContain('TLS body');
  });
  test('real MIME composition accepts buffered attachments but blocks filesystem access', async () => {
    const port = await start();
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false });
    await transport.sendMail({ from: 'sender@example.test', to: 'owner@example.test', subject: 'attachment', text: 'body', disableFileAccess: true, disableUrlAccess: true, attachments: [{ filename: 'fixture.txt', content: Buffer.from('fixture attachment') }] });
    expect(messages[0]).toContain('filename=fixture.txt');
    expect(messages[0]).toContain(Buffer.from('fixture attachment').toString('base64'));
    await expect(transport.sendMail({ from: 'sender@example.test', to: 'owner@example.test', subject: 'blocked', disableFileAccess: true, disableUrlAccess: true, attachments: [{ path: __filename }] })).rejects.toThrow(/access rejected/i);
    expect(messages).toHaveLength(1);
  });
});
