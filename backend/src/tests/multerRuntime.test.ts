import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import multer from 'multer';

function multipart(parts: Array<{ field: string; value: string; filename?: string; type?: string }>, end = true) {
  return parts.map(({ field, value, filename, type }) => `--fixture\r\nContent-Disposition: form-data; name="${field}"${filename ? `; filename="${filename}"` : ''}\r\n${type ? `Content-Type: ${type}\r\n` : ''}\r\n${value}\r\n`).join('') + (end ? '--fixture--\r\n' : '');
}

describe('Multer 2 actual multipart storage and error lifecycle', () => {
  let root: string; let server: http.Server; let url: string;
  const previousAvatars = process.env.PORTAL_AVATARS_ROOT;
  const previousBranding = process.env.PORTAL_BRANDING_ROOT;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-multipart-'));
    process.env.PORTAL_AVATARS_ROOT = path.join(root, 'avatars');
    process.env.PORTAL_BRANDING_ROOT = path.join(root, 'branding');
    jest.resetModules();
    const { createImageUpload } = require('../services/imageAssets');
    const app = express();
    const disk = multer({ storage: multer.diskStorage({ destination: root }), limits: { fileSize: 8, files: 2, fields: 1, fieldSize: 16 } });
    const memory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8, files: 1, fields: 1, parts: 2 } });
    app.post('/disk', disk.array('attachments', 2), (req, res) => res.json({ data: req.body, files: (req.files as Express.Multer.File[]).map(file => ({ name: file.originalname, text: fs.readFileSync(file.path, 'utf8'), size: file.size })) }));
    app.post('/memory', memory.single('logo'), (req, res) => res.json({ text: req.file?.buffer.toString(), size: req.file?.size }));
    app.post('/image', createImageUpload(), (req, res) => res.json({ stored: Boolean(req.file), name: req.file?.originalname }));
    app.use((error: any, _req: any, res: any, _next: any) => res.status(400).json({ code: error.code || 'MALFORMED', multer: error instanceof multer.MulterError }));
    server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    if (previousAvatars === undefined) delete process.env.PORTAL_AVATARS_ROOT; else process.env.PORTAL_AVATARS_ROOT = previousAvatars;
    if (previousBranding === undefined) delete process.env.PORTAL_BRANDING_ROOT; else process.env.PORTAL_BRANDING_ROOT = previousBranding;
  });
  async function post(route: string, body: string) {
    const result = await fetch(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=fixture' }, body });
    return { status: result.status, body: await result.json() as any };
  }
  test('disk attachments retain fields, names and bytes; memory logos retain buffers', async () => {
    expect(await post('/disk', multipart([{ field: 'data', value: '{"ok":true}' }, { field: 'attachments', filename: 'note.txt', value: '12345678' }]))).toMatchObject({ status: 200, body: { data: { data: '{"ok":true}' }, files: [{ name: 'note.txt', text: '12345678', size: 8 }] } });
    expect(await post('/memory', multipart([{ field: 'logo', filename: 'logo.png', value: 'png' }]))).toMatchObject({ status: 200, body: { text: 'png', size: 3 } });
  });
  test.each([
    ['oversize', [{ field: 'attachments', filename: 'large', value: '123456789' }], true, 'LIMIT_FILE_SIZE'],
    ['unexpected field', [{ field: 'wrong', filename: 'note', value: 'x' }], true, 'LIMIT_UNEXPECTED_FILE'],
    ['too many files', [1, 2, 3].map(i => ({ field: 'attachments', filename: String(i), value: 'x' })), true, 'LIMIT_FILE_COUNT'],
    ['oversize field', [{ field: 'data', value: 'x'.repeat(17) }], true, 'LIMIT_FIELD_VALUE'],
    ['malformed trailing boundary', [{ field: 'attachments', filename: 'note', value: 'x' }], false, 'MALFORMED'],
  ])('rejects %s and removes partial disk files', async (_label, parts, end, code) => {
    const result = await post('/disk', multipart(parts, end));
    expect(result).toMatchObject({ status: 400, body: { code } });
    if (code !== 'MALFORMED') expect(result.body.multer).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  });
  test('shipping image upload stores accepted raster files and skips disallowed MIME', async () => {
    expect(await post('/image', multipart([{ field: 'image', filename: 'photo.png', type: 'image/png', value: 'png' }]))).toMatchObject({ status: 200, body: { stored: true, name: 'photo.png' } });
    expect(fs.readdirSync(path.join(root, 'avatars'))).toHaveLength(1);
    expect(await post('/image', multipart([{ field: 'image', filename: 'script.svg', type: 'image/svg+xml', value: '<svg/>' }]))).toMatchObject({ status: 200, body: { stored: false } });
    expect(fs.readdirSync(path.join(root, 'avatars'))).toHaveLength(1);
  });
  test('aborted upload releases partial files and the server accepts a subsequent request', async () => {
    let sawPartial = false;
    await new Promise<void>((resolve) => {
      const req = http.request(`${url}/disk`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=fixture', 'transfer-encoding': 'chunked' } });
      req.on('error', () => resolve());
      req.write('--fixture\r\nContent-Disposition: form-data; name="attachments"; filename="partial"\r\n\r\n123');
      const deadline = Date.now() + 2000;
      const abortAfterDiskWrite = () => {
        sawPartial = fs.readdirSync(root).length > 0;
        if (sawPartial || Date.now() >= deadline) req.destroy();
        else setTimeout(abortAfterDiskWrite, 10);
      };
      abortAfterDiskWrite();
    });
    expect(sawPartial).toBe(true);
    const deadline = Date.now() + 2000;
    while (fs.readdirSync(root).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(fs.readdirSync(root)).toEqual([]);
    expect(await post('/memory', multipart([{ field: 'logo', filename: 'ok.png', value: 'ok' }]))).toMatchObject({ status: 200, body: { text: 'ok' } });
  });
});
